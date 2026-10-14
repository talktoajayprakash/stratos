import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir, mkdtemp, stat, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  createOpencodeClient,
  type Config,
  type OpencodeClient,
} from '@opencode-ai/sdk/v2';
import {z} from 'zod';

export type OpenCodeServerOptions = {
  workingDirectory: string;
  env?: Record<string, string>;
  binary?: string;
};

const configSchema = z.looseObject({
  provider: z.record(z.string(), z.unknown()).optional(),
  enabled_providers: z.array(z.string()).optional(),
  disabled_providers: z.array(z.string()).optional(),
});

/** Project/global configuration remains isolated; inline native configuration is shared by both phases. */
export function openCodeConfiguration(options: OpenCodeServerOptions): Config {
  const pure = options.env?.OPENCODE_PURE ?? process.env.OPENCODE_PURE;
  if (pure && ['true', '1'].includes(pure.toLowerCase())) {
    throw new Error(
      'OpenCode pure mode disables the required Stratos tool hooks',
    );
  }
  const content =
    options.env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
  if (!content) {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('Invalid OpenCode OPENCODE_CONFIG_CONTENT JSON');
  }
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Invalid OpenCode OPENCODE_CONFIG_CONTENT configuration', {
      cause: parsed.error,
    });
  }
  // The native server validates the remaining native configuration fields.
  return parsed.data as Config;
}

export function openCodeDirectory(
  options: OpenCodeServerOptions,
): Promise<string> {
  return mkdtemp(join(options.env?.TMPDIR ?? tmpdir(), 'stratos-opencode-'));
}

export type OwnedOpenCodeServer = {
  client: OpencodeClient;
  workingDirectory: string;
  close(): Promise<void>;
};

export async function startOpenCodeServer(
  options: OpenCodeServerOptions,
  directory: string,
  config: Config,
  signal: AbortSignal,
  preflight = false,
): Promise<OwnedOpenCodeServer> {
  signal.throwIfAborted();
  const info = await stat(options.workingDirectory).catch(error => {
    throw new Error('OpenCode working directory is unavailable', {
      cause: error,
    });
  });
  if (!info.isDirectory()) {
    throw new Error('OpenCode working directory is not a directory');
  }
  const workingDirectory = await realpath(options.workingDirectory);
  const configDirectory = join(directory, 'config');
  await mkdir(configDirectory, {recursive: true, mode: 0o700});
  signal.throwIfAborted();
  const password = randomBytes(32).toString('hex');
  const child = spawn(
    options.binary ?? 'opencode',
    ['serve', '--hostname=127.0.0.1', '--port=0'],
    {
      detached: process.platform !== 'win32',
      cwd: workingDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...options.env,
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
        XDG_CONFIG_HOME: configDirectory,
        OPENCODE_CONFIG_DIR: configDirectory,
        OPENCODE_CONFIG: '',
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        // Native project-config isolation does not exclude ~/.opencode. Keep auth in its
        // native XDG data path, but prevent config loading/dependency installs in user homes.
        OPENCODE_TEST_HOME: directory,
        OPENCODE_PURE: preflight ? 'true' : 'false',
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
        OPENCODE_SERVER_USERNAME: 'stratos',
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({...config, autoupdate: false}),
      },
    },
  );
  const exited = new Promise<void>(resolve => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= stopOwnedServer(child, exited));
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      let settled = false;
      const finish = (error?: unknown, url?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        child.stdout!.off('data', data);
        child.stdout!.resume();
        child.off('error', failed);
        child.off('exit', stopped);
        if (url) {
          resolve(url);
        } else {
          reject(error);
        }
      };
      const abort = () => finish(signal.reason);
      const failed = (error: Error) => finish(error);
      const stopped = (code: number | null) =>
        finish(new Error(`OpenCode exited during startup (${code})`));
      const data = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8192);
        const match = output.match(
          /opencode server listening.*?(http:\/\/127\.0\.0\.1:\d+)/,
        );
        if (match) {
          finish(undefined, match[1]);
        }
      };
      const timer = setTimeout(
        () => finish(new Error('OpenCode startup deadline exceeded')),
        30000,
      );
      child.stdout!.on('data', data);
      child.stderr!.resume();
      child.once('error', failed);
      child.once('exit', stopped);
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) {
        abort();
      }
    });
    signal.throwIfAborted();
    const client = createOpencodeClient({
      baseUrl: url,
      directory: workingDirectory,
      headers: {
        Authorization: `Basic ${Buffer.from(`stratos:${password}`).toString('base64')}`,
      },
    });
    return {client, workingDirectory, close};
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'OpenCode startup and cleanup failed',
      );
    }
    throw error;
  }
}

async function stopOwnedServer(
  child: ChildProcess,
  exited: Promise<void>,
): Promise<void> {
  const groupAlive = () => {
    if (!child.pid || process.platform === 'win32') {
      return false;
    }
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return false;
      }
      throw error;
    }
  };
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) {
      return;
    }
    try {
      if (process.platform === 'win32') {
        child.kill(signal);
      } else {
        process.kill(-child.pid, signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
    }
  };
  const wait = async (ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const terminatedAt = Date.now();
  kill('SIGTERM');
  // The npm launcher can exit while its native child still owns inherited pipes.
  const closed = await wait(1000);
  if (!closed || groupAlive()) {
    if (closed) {
      await new Promise(resolve =>
        setTimeout(resolve, Math.max(0, 1000 - (Date.now() - terminatedAt))),
      );
    }
    kill('SIGKILL');
    if (!(await wait(1000))) {
      throw new Error('OpenCode owned server did not close after SIGKILL');
    }
  }
}
