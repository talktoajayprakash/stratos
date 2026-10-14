import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

import {snapshotCatalog, type ModelCatalog} from '../availability.js';

type CatalogOptions = {
  binary: string;
  env: Record<string, string>;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  shutdownMs?: number;
  provider?: string;
};
type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function deadline(
  work: Promise<void>,
  milliseconds: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Codex catalog process did not stop')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Metadata only: never starts a thread, turn, prompt, or MCP server. */
export async function readCodexCatalog({
  binary,
  env,
  cwd,
  signal,
  timeoutMs = 15_000,
  shutdownMs = 1_000,
  provider = 'openai',
}: CatalogOptions): Promise<ModelCatalog> {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(shutdownMs) ||
    shutdownMs <= 0
  ) {
    throw new TypeError(
      'Codex catalog deadlines must be positive finite milliseconds',
    );
  }
  signal?.throwIfAborted();
  const child = spawn(
    binary,
    [
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'cli_auth_credentials_store="file"',
      '-c',
      `model_provider=${JSON.stringify(provider)}`,
      '-c',
      'features.hooks=false',
      '-c',
      'features.apps=false',
      '-c',
      'mcp_servers={}',
      '-c',
      'otel.exporter="none"',
      '-c',
      'otel.trace_exporter="none"',
      '-c',
      'otel.metrics_exporter="none"',
    ],
    {env, cwd, stdio: ['pipe', 'pipe', 'pipe']},
  );
  let stopped = false;
  let closing = false;
  let hasFailure = false;
  let failure: unknown;
  let requestId = 0;
  const pending = new Map<number, PendingRequest>();
  function fail(error: unknown): void {
    if (!hasFailure) {
      failure = error;
      hasFailure = true;
    }
    for (const item of pending.values()) {
      item.reject(failure);
    }
    pending.clear();
  }
  const exited = new Promise<void>(resolve => {
    child.once('close', (code, exitSignal) => {
      stopped = true;
      if (!closing) {
        fail(
          new Error('Codex catalog process exited before discovery completed', {
            cause: {code, signal: exitSignal},
          }),
        );
      }
      resolve();
    });
  });
  const abort = () => fail(signal?.reason);
  const timer = setTimeout(() => {
    const error = new Error('Codex catalog discovery exceeded its deadline');
    error.name = 'TimeoutError';
    fail(error);
  }, timeoutMs);
  signal?.addEventListener('abort', abort, {once: true});
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stderr.on('error', fail);
  child.stderr.resume();
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
  lines.on('error', fail);
  lines.on('close', () => {
    if (!closing) {
      fail(
        new Error(
          'Codex catalog response stream ended before discovery completed',
        ),
      );
    }
  });
  lines.on('line', line => {
    if (hasFailure) {
      return;
    }
    try {
      receiveCatalogMessage(line, pending);
    } catch (error) {
      fail(error);
    }
  });
  function send(message: Record<string, unknown>): void {
    if (hasFailure) {
      throw failure;
    }
    signal?.throwIfAborted();
    child.stdin.write(JSON.stringify(message) + '\n', error => {
      if (error) {
        fail(error);
      }
    });
  }
  function request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      try {
        send({id, method, params});
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }
  let result: ModelCatalog | undefined;
  let originalError: unknown;
  let failed = false;
  try {
    const initialized = await request('initialize', {
      clientInfo: {name: 'stratos-catalog', version: '0.0.1'},
      capabilities: {experimentalApi: false},
    });
    if (!record(initialized)) {
      throw new Error('Invalid Codex initialize response', {
        cause: initialized,
      });
    }
    send({method: 'initialized', params: {}});
    const modelIds = await readModelPages(request);
    signal?.throwIfAborted();
    if (hasFailure) {
      throw failure;
    }
    result = snapshotCatalog({
      provider,
      source: 'codex-app-server/model/list',
      modelIds: [...modelIds],
      complete: provider === 'openai',
    });
  } catch (error) {
    failed = true;
    originalError = signal?.aborted ? signal.reason : error;
  } finally {
    closing = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    lines.close();
    child.stdout.resume();
    child.stdin.end();
    try {
      if (!stopped) {
        child.kill('SIGTERM');
      }
      try {
        await deadline(exited, shutdownMs);
      } catch {
        if (!stopped) {
          child.kill('SIGKILL');
        }
        await deadline(exited, shutdownMs);
      }
    } catch (error) {
      originalError = failed
        ? new AggregateError(
            [originalError, error],
            'Codex catalog discovery and cleanup failed',
          )
        : error;
      failed = true;
    }
  }
  if (failed) {
    throw originalError;
  }
  signal?.throwIfAborted();
  if (!result) {
    throw new Error('Codex catalog discovery produced no result');
  }
  return result;
}

function receiveCatalogMessage(
  line: string,
  pending: Map<number, PendingRequest>,
): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    throw new Error('Invalid Codex catalog JSON response');
  }
  if (!record(message)) {
    throw new Error('Invalid Codex catalog message', {cause: message});
  }
  if (!Object.hasOwn(message, 'id')) {
    if (typeof message.method !== 'string' || !message.method) {
      throw new Error('Invalid Codex catalog notification', {cause: message});
    }
    return;
  }
  if (typeof message.id !== 'number') {
    throw new Error('Uncorrelated Codex catalog response', {cause: message});
  }
  const item = pending.get(message.id);
  if (!item) {
    throw new Error('Uncorrelated Codex catalog response', {cause: message});
  }
  pending.delete(message.id);
  if (Object.hasOwn(message, 'error') && !Object.hasOwn(message, 'result')) {
    item.reject(new Error('Codex catalog RPC failed', {cause: message.error}));
  } else if (
    Object.hasOwn(message, 'result') &&
    !Object.hasOwn(message, 'error')
  ) {
    item.resolve(message.result);
  } else {
    item.reject(
      new Error('Invalid Codex catalog response envelope', {cause: message}),
    );
  }
}

async function readModelPages(
  request: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<Set<string>> {
  const modelIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await request('model/list', {
      cursor,
      limit: 100,
      includeHidden: true,
    });
    if (
      !record(page) ||
      !Array.isArray(page.data) ||
      !(
        page.nextCursor === null ||
        (typeof page.nextCursor === 'string' && page.nextCursor.length > 0)
      )
    ) {
      throw new Error('Invalid Codex model/list response', {cause: page});
    }
    for (const model of page.data) {
      if (
        !record(model) ||
        typeof model.model !== 'string' ||
        !model.model.trim()
      ) {
        throw new Error('Invalid Codex model/list response', {cause: page});
      }
      modelIds.add(model.model);
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (cursors.has(cursor)) {
        throw new Error('Codex model/list repeated a pagination cursor', {
          cause: page,
        });
      }
      cursors.add(cursor);
    }
  } while (cursor !== null);

  return modelIds;
}
