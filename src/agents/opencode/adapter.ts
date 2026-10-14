import {randomBytes} from 'node:crypto';
import {writeFile, rm} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {type OpencodeClient, type Config} from '@opencode-ai/sdk/v2';
import {z} from 'zod';

import {OpenCodeModels} from '../../telemetry/harness-models.js';
import type {AgentAdapter} from '../adapter.js';
import {ModelUnavailableError, type ProgressOptions} from '../availability.js';
import {createAgentEventSink, type AgentEventConsumer} from '../events.js';
import type {AgentHooks, ToolResultEvent} from '../hooks.js';
import type {HarnessTools} from '../tools.js';
import {OpenCodeActivity} from './activity.js';
import {openCodeOllama} from './ollama.js';
import {
  openCodeConfiguration,
  openCodeDirectory,
  startOpenCodeServer,
  type OwnedOpenCodeServer,
} from './process.js';

/** OpenCode permission keys for canonical tools, then OpenCode-only tools by their own name. */
export const openCodeTools: HarnessTools = {
  shell: ['bash'],
  read: ['read'],
  // OpenCode's edit permission governs edit, write and apply_patch.
  edit: ['edit'],
  write: ['edit'],
  glob: ['glob'],
  grep: ['grep'],
  lsp: ['lsp'],
  web_fetch: ['webfetch'],
  web_search: ['websearch'],
  subagent: ['task'],
  todo: ['todowrite'],
  plan_mode: ['plan_exit'],
  ask_user: ['question'],
  skill: ['skill'],
  notify_user: 'absent',
  codesearch: ['codesearch'],
};

export type OpenCodeAdapterOptions = ProgressOptions & {
  model: {providerID: string; modelID: string};
  workingDirectory: string;
  effort?: string;
  systemPrompt?: string;
  outputSchema?: Record<string, unknown>;
  mcpServers?: Config['mcp'];
  /** Permission keys from `openCodeTools`, denied for this agent. */
  removedTools?: readonly string[];
  env?: Record<string, string>;
  binary?: string;
  hooks?: AgentHooks;
  onEvent: AgentEventConsumer;
  diagnostic(error: unknown): void;
};

const messageSchema = z
  .looseObject({
    id: z.string().min(1),
    sessionID: z.string().min(1),
    role: z.enum(['user', 'assistant']),
    parentID: z.string().optional(),
    structured: z.unknown().optional(),
    error: z.unknown().optional(),
    tokens: z
      .looseObject({output: z.number(), reasoning: z.number()})
      .optional(),
  })
  .refine(
    info => info.role !== 'assistant' || !!info.parentID,
    'Assistant message must have a parent',
  );
const partSchema = z.looseObject({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  messageID: z.string().min(1),
  type: z.enum([
    'text',
    'subtask',
    'reasoning',
    'file',
    'tool',
    'step-start',
    'step-finish',
    'snapshot',
    'patch',
    'agent',
    'retry',
    'compaction',
  ]),
  text: z.string().optional(),
  tokens: z.looseObject({output: z.number(), reasoning: z.number()}).optional(),
});
const messagePartsSchema = z.object({
  info: messageSchema,
  parts: z.array(partSchema),
});
const eventSchema = z.object({
  type: z.string(),
  properties: z.record(z.string(), z.unknown()),
});
type NativeMessage = z.infer<typeof messageSchema>;
type NativePart = z.infer<typeof partSchema>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
}

export function openCodeFailure(
  nativeError: unknown,
  allowModelRejection = true,
): Error {
  const result = z
    .object({
      name: z.literal('APIError'),
      data: z.object({
        statusCode: z.literal(404),
        isRetryable: z.literal(false),
        responseBody: z.string(),
      }),
    })
    .safeParse(nativeError);
  let body: unknown;
  if (result.success) {
    try {
      body = JSON.parse(result.data.data.responseBody);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }
  const specific =
    result.success &&
    z
      .object({error: z.object({code: z.literal('model_not_found')})})
      .safeParse(body).success;
  return specific && allowModelRejection
    ? new ModelUnavailableError(
        'OpenCode provider rejected the model (model_not_found)',
        {cause: nativeError},
      )
    : new Error('OpenCode native execution failed', {cause: nativeError});
}

function partProgress(part: NativePart): boolean {
  return (
    ['tool', 'subtask', 'patch', 'file', 'agent', 'compaction'].includes(
      part.type,
    ) ||
    (['text', 'reasoning'].includes(part.type) && !!part.text) ||
    (!!part.tokens && (part.tokens.output > 0 || part.tokens.reasoning > 0))
  );
}

/** A dedicated owned server avoids changing another agent's plugins or permissions. */
export class OpenCodeAdapter implements AgentAdapter<unknown> {
  private directory?: string;
  private bridge?: Server;
  private server?: OwnedOpenCodeServer;
  private client?: OpencodeClient;
  private sessionId?: string;
  private initializing?: Promise<void>;
  private startupAbort?: AbortController;
  private reader?: Promise<void>;
  private eventsAbort?: AbortController;
  private disposing = false;
  private instanceDisposed = false;
  private streamFailure?: Error;
  private streamFailed = deferred<never>();
  private active?: Promise<unknown>;
  private executionAbort?: AbortController;
  private turn?: {
    messageID: string;
    error: ReturnType<typeof deferred<unknown>>;
    first: boolean;
  };
  private turns = 0;
  private aborting?: Promise<void>;
  private stopFailure?: Error;
  private failed = false;
  private failure: unknown;
  private cancelled = false;
  private closed = false;
  private closing?: Promise<void>;
  private readonly events;
  private readonly models;
  private readonly activity;
  private mcpSnapshot: string;
  private readonly messages = new Map<string, NativeMessage>();
  private readonly pendingProgress = new Map<
    string,
    {progress: boolean; text: string[]}
  >();
  private readonly sessions = new Set<string>();

  constructor(
    private readonly options: OpenCodeAdapterOptions,
    private readonly startServer = startOpenCodeServer,
  ) {
    this.mcpSnapshot = JSON.stringify(options.mcpServers ?? {});
    this.events = createAgentEventSink([options.onEvent], options.diagnostic);
    this.activity = new OpenCodeActivity(event => this.events.onEvent(event));
    this.models = new OpenCodeModels(event => this.events.onEvent(event), {
      model: options.model.modelID,
      provider: options.model.providerID,
    });
    this.streamFailed.promise.catch(() => {});
  }

  initialize(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Agent is closed'));
    }
    if (this.initializing) {
      return this.initializing;
    }
    if (this.sessionId) {
      return Promise.resolve();
    }
    this.cancelled = false;
    this.startupAbort = new AbortController();
    this.initializing = this.start().finally(() => {
      this.initializing = undefined;
    });
    return this.initializing;
  }

  private async start(): Promise<void> {
    const signal = AbortSignal.any([
      this.startupAbort!.signal,
      AbortSignal.timeout(30000),
    ]);
    try {
      let nativeConfig = openCodeConfiguration(this.options);
      if (this.options.model.providerID === 'ollama') {
        nativeConfig = await openCodeOllama(
          nativeConfig,
          this.options.env,
          signal,
        );
        nativeConfig.model = `ollama/${this.options.model.modelID}`;
        nativeConfig.small_model = nativeConfig.model;
      }
      this.directory = await openCodeDirectory(this.options);
      signal.throwIfAborted();
      const plugin = await this.startBridge();
      const removed = this.options.removedTools ?? [];
      const config: Config = {
        ...nativeConfig,
        plugin: [pathToFileURL(plugin).href],
        permission: {
          '*': 'allow',
          ...Object.fromEntries(removed.map(tool => [tool, 'deny'])),
        },
        mcp: this.options.mcpServers ?? {},
      };
      this.server = await this.startServer(
        this.options,
        this.directory,
        config,
        signal,
      );
      this.client = this.server.client;
      // Session rules are evaluated after configured rules, so denials repeat here.
      const session = await this.client.session.create(
        {
          permission: [
            {permission: '*', pattern: '*', action: 'allow'},
            ...removed.map(tool => ({
              permission: tool,
              pattern: '*',
              action: 'deny' as const,
            })),
          ],
        },
        {throwOnError: true, signal},
      );
      const created = z.object({id: z.string().min(1)}).parse(session.data);
      this.sessionId = created.id;
      this.sessions.add(this.sessionId);
      this.streamFailure = undefined;
      this.disposing = false;
      this.instanceDisposed = false;
      this.streamFailed = deferred<never>();
      this.streamFailed.promise.catch(() => {});
      this.eventsAbort = new AbortController();
      await this.subscribe(signal);
      signal.throwIfAborted();
    } catch (error) {
      try {
        await this.aborting;
        await this.release();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'OpenCode initialization and cleanup failed',
        );
      }
      throw error;
    }
  }

  private failStream(cause: unknown): void {
    if (this.streamFailure) {
      return;
    }
    this.streamFailure = new Error('OpenCode lifecycle observation failed', {
      cause,
    });
    this.streamFailed.reject(this.streamFailure);
    if (!this.failed) {
      this.failed = true;
      this.failure = this.streamFailure;
    }
    this.executionAbort?.abort(this.streamFailure);
    if (!this.disposing) {
      this.abort();
    }
  }

  private observeMessage(info: NativeMessage): void {
    this.messages.set(info.id, info);
    const pending = this.pendingProgress.get(info.id);
    this.pendingProgress.delete(info.id);
    if (info.role !== 'assistant') {
      return;
    }
    if (
      pending?.progress ||
      info.structured !== undefined ||
      (info.tokens && (info.tokens.output > 0 || info.tokens.reasoning > 0))
    ) {
      this.options.onProgress?.();
    }
    for (const text of pending?.text ?? []) {
      this.events.onEvent({
        type: 'message.delta',
        timestamp: Date.now(),
        text,
        ...this.activity.parent(info.sessionID),
      });
    }
  }

  private observeActivity(
    messageID: string,
    progress: boolean,
    text?: string,
  ): void {
    const message = this.messages.get(messageID);
    if (!message) {
      const pending = this.pendingProgress.get(messageID) ?? {
        progress: false,
        text: [],
      };
      pending.progress ||= progress;
      if (text) {
        pending.text.push(text);
      }
      this.pendingProgress.set(messageID, pending);
    } else if (message.role === 'assistant') {
      if (progress) {
        this.options.onProgress?.();
      }
      if (text) {
        this.events.onEvent({
          type: 'message.delta',
          timestamp: Date.now(),
          text,
          ...this.activity.parent(message.sessionID),
        });
      }
    }
  }

  private observeEvent(value: unknown): void {
    const event = eventSchema.parse(value);
    const props = event.properties;
    try {
      if (this.sessionId) {
        this.activity.observe(value, this.sessionId);
      }
    } catch (error) {
      try {
        this.options.diagnostic(error);
      } catch {
        // Activity observation cannot affect execution.
      }
    }
    if (!this.observeLifecycle(event)) {
      return;
    }
    const part = props.part as {sessionID?: string} | undefined;
    const info = props.info as {sessionID?: string} | undefined;
    if (
      this.sessions.has(
        String(props.sessionID ?? part?.sessionID ?? info?.sessionID),
      )
    ) {
      try {
        this.models.observe(
          value,
          this.activity.parent(
            String(props.sessionID ?? part?.sessionID ?? info?.sessionID),
          ),
        );
      } catch {
        try {
          this.options.diagnostic(
            new Error('OpenCode model telemetry unavailable'),
          );
        } catch {
          // Diagnostic failures must not interrupt agent execution.
        }
      }
    }
  }

  execute(prompt: string): Promise<unknown> {
    if (this.stopFailure) {
      return Promise.reject(this.stopFailure);
    }
    if (this.closed) {
      return Promise.reject(new Error('Agent is closed'));
    }
    if (!this.client || !this.sessionId) {
      return Promise.reject(new Error('Agent must be initialized'));
    }
    if (this.active) {
      return Promise.reject(new Error('Agent executions must be sequential'));
    }
    if (this.streamFailure) {
      return Promise.reject(this.streamFailure);
    }
    this.failed = false;
    this.failure = undefined;
    this.cancelled = false;
    this.executionAbort = new AbortController();
    const running = this.run(prompt).finally(() => {
      this.active = undefined;
      this.executionAbort = undefined;
      this.turn = undefined;
    });
    this.active = running;
    return running;
  }

  private async run(prompt: string): Promise<unknown> {
    const signal = this.executionAbort!.signal;
    try {
      await this.aborting;
      if (this.stopFailure) {
        throw this.stopFailure;
      }
      signal.throwIfAborted();
      const snapshot = JSON.stringify(this.options.mcpServers ?? {});
      if (snapshot !== this.mcpSnapshot) {
        for (const [name, config] of Object.entries(
          this.options.mcpServers ?? {},
        )) {
          if ('type' in config) {
            try {
              if (config.enabled !== false) {
                this.options.onProgress?.();
              }
              const result = await this.client!.mcp.add(
                {name, config},
                {throwOnError: true, signal},
              );
              if (
                result.data[name]?.status !== 'connected' &&
                config.enabled !== false
              ) {
                throw new Error('MCP connection failed');
              }
            } catch (error) {
              throw new Error('OpenCode MCP credential update failed', {
                cause: error,
              });
            }
          }
        }
        this.mcpSnapshot = snapshot;
      }
      signal.throwIfAborted();
      // Native messages are chronologically ordered by ID, not arbitrary UUIDs.
      const timestamp = ((BigInt(Date.now()) * 0x1000n) & 0xffffffffffffn)
        .toString(16)
        .padStart(12, '0');
      this.turn = {
        messageID: `msg_${timestamp}${randomBytes(7).toString('hex')}`,
        error: deferred<unknown>(),
        first: ++this.turns === 1,
      };
      this.models.prompt(prompt, this.sessionId);
      // The native prompt handler starts configured MCP clients before requesting model output.
      if (
        Object.values(this.options.mcpServers ?? {}).some(
          config => config.enabled !== false,
        )
      ) {
        this.options.onProgress?.();
      }
      const response = await Promise.race([
        this.client!.session.prompt(
          {
            sessionID: this.sessionId!,
            messageID: this.turn.messageID,
            model: this.options.model,
            system: this.options.systemPrompt,
            variant: this.options.effort,
            ...(this.options.outputSchema
              ? {
                  format: {
                    type: 'json_schema' as const,
                    schema: this.options.outputSchema,
                  },
                }
              : {}),
            parts: [{type: 'text', text: prompt}],
          },
          {throwOnError: true, signal},
        ),
        this.streamFailed.promise,
      ]);
      const parsed = messagePartsSchema.safeParse(response.data);
      let sessionError: unknown;
      if (!parsed.success) {
        sessionError = await this.waitForSessionError(signal);
      }
      // Final parts are control evidence too: HTTP completion can precede SSE consumption.
      const final = await this.client!.session.messages(
        {sessionID: this.sessionId!},
        {
          throwOnError: true,
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        },
      );
      const messages = z.array(messagePartsSchema).parse(final.data);
      for (const message of messages) {
        this.reconcile(message);
      }
      if (parsed.success) {
        if (
          parsed.data.info.role !== 'assistant' ||
          parsed.data.info.sessionID !== this.sessionId ||
          parsed.data.info.parentID !== this.turn.messageID
        ) {
          throw new Error('OpenCode returned an unrelated prompt response');
        }
        this.reconcile(parsed.data);
      }
      if (this.pendingProgress.size) {
        throw new Error('OpenCode activity ownership could not be reconciled');
      }
      await this.aborting;
      if (this.failed) {
        throw this.failure;
      }
      signal.throwIfAborted();
      if (!parsed.success) {
        const terminal = [...messages]
          .reverse()
          .find(
            message =>
              message.info.role === 'assistant' &&
              message.info.parentID === this.turn!.messageID &&
              message.info.error,
          );
        if (terminal) {
          throw openCodeFailure(terminal.info.error);
        }
        // session.error has no message ID. It is unambiguous only on a fresh session's first turn.
        if (sessionError) {
          throw openCodeFailure(sessionError, this.turn.first);
        }
        throw new Error('OpenCode returned an invalid prompt response', {
          cause: parsed.error,
        });
      }
      if (parsed.data.info.error) {
        throw openCodeFailure(parsed.data.info.error);
      }
      return this.options.outputSchema
        ? parsed.data.info.structured
        : parsed.data.parts
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('');
    } catch (error) {
      await this.aborting;
      if (this.stopFailure) {
        throw this.stopFailure;
      }
      if (this.failed) {
        throw this.failure;
      }
      if (this.cancelled) {
        throw new Error('Agent execution cancelled', {cause: error});
      }
      throw error;
    }
  }

  private reconcile(message: z.infer<typeof messagePartsSchema>): void {
    if (!this.sessions.has(message.info.sessionID)) {
      throw new Error('OpenCode returned messages from an unrelated session');
    }
    this.observeMessage(message.info);
    for (const part of message.parts) {
      if (
        part.sessionID !== message.info.sessionID ||
        part.messageID !== message.info.id
      ) {
        throw new Error(
          'OpenCode returned inconsistent message part ownership',
        );
      }
      this.observeActivity(part.messageID, partProgress(part));
    }
    try {
      this.models.observe({properties: {info: message.info}});
      for (const part of message.parts) {
        this.models.observe({properties: {part}});
      }
    } catch {
      try {
        this.options.diagnostic(
          new Error('OpenCode final model telemetry unavailable'),
        );
      } catch {
        // Diagnostic failures must not interrupt agent execution.
      }
    }
  }

  private async waitForSessionError(signal: AbortSignal): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        this.turn!.error.promise,
        this.streamFailed.promise,
        new Promise<undefined>((resolve, reject) => {
          timer = setTimeout(() => resolve(undefined), 1000);
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, {once: true});
          if (signal.aborted) {
            abort();
          }
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) {
        signal.removeEventListener('abort', abort);
      }
    }
  }

  private abort(): void {
    if (!this.client || !this.sessionId || this.aborting || this.disposing) {
      return;
    }
    this.aborting = this.client.session
      .abort(
        {sessionID: this.sessionId},
        {throwOnError: true, signal: AbortSignal.timeout(10000)},
      )
      .then(
        () => {},
        async error => {
          const original = this.failed
            ? [this.failure]
            : this.executionAbort?.signal.aborted
              ? [this.executionAbort.signal.reason]
              : [];
          const errors = [...original, error];
          this.stopFailure = new AggregateError(
            errors,
            'OpenCode native cancellation failed; conversation closed',
          );
          try {
            await this.release();
          } catch (cleanupError) {
            this.stopFailure = new AggregateError(
              [...errors, cleanupError],
              'OpenCode native cancellation and cleanup failed',
            );
          }
          try {
            this.options.diagnostic(this.stopFailure);
          } catch {
            /* soft diagnostic */
          }
        },
      )
      .finally(() => {
        this.aborting = undefined;
      });
  }

  cancel(): void {
    this.cancelled = true;
    const error = new Error('Agent execution cancelled');
    this.startupAbort?.abort(error);
    this.executionAbort?.abort(error);
    this.abort();
  }
  close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    this.closed = true;
    this.cancel();
    this.closing = (async () => {
      await this.initializing?.catch(() => {});
      await this.active?.catch(() => {});
      await this.aborting;
      await this.release();
    })();
    return this.closing;
  }

  private async release(): Promise<void> {
    const errors: unknown[] = [];
    if (
      this.client &&
      this.reader &&
      !this.eventsAbort?.signal.aborted &&
      !this.streamFailure
    ) {
      this.disposing = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Native disposal stops the instance, then queues its final SSE event and EOF
        // behind earlier activity. Drain that barrier before terminating the server.
        await this.client.instance.dispose(
          {},
          {throwOnError: true, signal: AbortSignal.timeout(10000)},
        );
        await Promise.race([
          this.reader,
          this.streamFailed.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error('OpenCode lifecycle drain deadline exceeded')),
              10000,
            );
          }),
        ]);
        if (!this.instanceDisposed) {
          throw new Error(
            'OpenCode lifecycle stream ended without its disposal barrier',
          );
        }
        if (this.pendingProgress.size) {
          throw new Error('OpenCode closed with unresolved activity ownership');
        }
      } catch (error) {
        errors.push(error);
      } finally {
        clearTimeout(timer);
      }
    }
    if (this.streamFailure) {
      errors.push(this.streamFailure);
    }
    this.eventsAbort?.abort();
    try {
      await this.server?.close();
    } catch (error) {
      errors.push(error);
    }
    this.server = undefined;
    await this.reader;
    if (this.bridge) {
      const bridge = this.bridge;
      this.bridge = undefined;
      bridge.closeAllConnections();
      try {
        await new Promise<void>((resolve, reject) =>
          bridge.close(error => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        errors.push(error);
      }
    }
    await this.events.drain();
    if (this.directory) {
      try {
        await rm(this.directory, {recursive: true, force: true});
      } catch (error) {
        errors.push(error);
      }
      this.directory = undefined;
    }
    this.client = undefined;
    this.sessionId = undefined;
    this.bridge = undefined;
    this.reader = undefined;
    this.eventsAbort = undefined;
    this.streamFailure = undefined;
    this.sessions.clear();
    this.messages.clear();
    this.pendingProgress.clear();
    this.turns = 0;
    if (errors.length) {
      throw new AggregateError(errors, 'OpenCode cleanup failed');
    }
  }

  private async startBridge(): Promise<string> {
    const token = randomBytes(32).toString('hex');
    this.bridge = createServer((req, res) => {
      if (
        req.method !== 'POST' ||
        req.url !== '/' ||
        req.headers.authorization !== `Bearer ${token}`
      ) {
        res.writeHead(403).end();
        return;
      }
      void (async () => {
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
          }
          const payload = JSON.parse(body) as {
            phase: string;
            event: ToolResultEvent;
            agent?: string;
            sessionID?: string;
          };
          const {phase, event} = payload;
          if (
            phase === 'background-model' &&
            ['title', 'summary', 'compaction'].includes(payload.agent ?? '')
          ) {
            if (this.failed) {
              throw this.failure;
            }
            this.options.onProgress?.();
            res.writeHead(200, {'content-type': 'application/json'}).end('{}');
            return;
          }
          if (
            !event ||
            typeof event.toolCallId !== 'string' ||
            typeof event.toolName !== 'string' ||
            !Object.hasOwn(event, 'input') ||
            !['before', 'after'].includes(phase)
          ) {
            throw new Error('Invalid OpenCode hook event');
          }
          if (event.error) {
            event.error = new Error(event.error.message, {
              cause: event.output,
            });
          }
          let decision;
          if (this.failed) {
            throw this.failure;
          }
          this.options.onProgress?.();
          if (phase === 'before') {
            decision = await this.options.hooks?.beforeToolCall?.(event);
            if (decision?.action !== 'deny') {
              this.events.onEvent({
                type: 'tool.started',
                timestamp: Date.now(),
                ...this.activity.parent(payload.sessionID),
                ...event,
                input:
                  decision?.action === 'modify'
                    ? decision.arguments
                    : event.input,
              });
            }
          } else {
            decision = await this.options.hooks?.afterToolCall?.(event);
            this.events.onEvent({
              type: 'tool.completed',
              timestamp: Date.now(),
              ...this.activity.parent(payload.sessionID),
              toolCallId: event.toolCallId,
              output:
                decision?.action === 'block' ? decision.reason : event.output,
              error: event.error,
            });
          }
          if (this.failed) {
            throw this.failure;
          }
          res
            .writeHead(200, {'content-type': 'application/json'})
            .end(JSON.stringify({decision: decision ?? null}));
        } catch (error) {
          if (!this.failed) {
            this.failed = true;
            this.failure = error;
          }
          this.executionAbort?.abort(error);
          this.abort();
          if (!res.headersSent) {
            res
              .writeHead(200, {'content-type': 'application/json'})
              .end(JSON.stringify({cancelled: true}));
          }
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      this.bridge!.once('error', reject);
      this.bridge!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.bridge.address();
    if (!address || typeof address === 'string') {
      throw new Error('OpenCode callback listener unavailable');
    }
    const plugin = join(this.directory!, 'plugin.mjs');
    await writeFile(
      plugin,
      pluginSource(`http://127.0.0.1:${address.port}`, token),
      {mode: 0o600},
    );
    return plugin;
  }

  private async subscribe(signal: AbortSignal): Promise<void> {
    const ready = deferred<void>();
    const subscription = await this.client!.event.subscribe(
      {},
      {
        signal: this.eventsAbort!.signal,
        sseMaxRetryAttempts: 1,
        onSseError: error => {
          if (!this.eventsAbort?.signal.aborted) {
            this.failStream(error);
          }
        },
        fetch: async request => {
          const response = await fetch(request);
          if (!response.ok) {
            throw new Error(
              `OpenCode lifecycle stream failed (${response.status})`,
            );
          }
          ready.resolve(undefined);
          return response;
        },
      },
    );
    this.reader = (async () => {
      try {
        for await (const event of subscription.stream) {
          this.observeEvent(event);
        }
        if (
          !this.eventsAbort?.signal.aborted &&
          !(this.disposing && this.instanceDisposed)
        ) {
          this.failStream(new Error('OpenCode lifecycle stream ended'));
        }
      } catch (error) {
        if (!this.eventsAbort?.signal.aborted) {
          this.failStream(error);
        }
      }
    })();
    let interrupted: (() => void) | undefined;
    try {
      await Promise.race([
        ready.promise,
        this.streamFailed.promise,
        new Promise<never>((_, reject) => {
          interrupted = () => reject(signal.reason);
          signal.addEventListener('abort', interrupted, {once: true});
          if (signal.aborted) {
            interrupted();
          }
        }),
      ]);
    } finally {
      if (interrupted) {
        signal.removeEventListener('abort', interrupted);
      }
    }
  }

  private observeLifecycle(event: z.infer<typeof eventSchema>): boolean {
    const props = event.properties;
    if (event.type === 'server.instance.disposed') {
      if (
        !this.disposing ||
        props.directory !== this.server?.workingDirectory
      ) {
        throw new Error('OpenCode instance was unexpectedly disposed');
      }
      this.instanceDisposed = true;
    }
    if (event.type === 'session.created') {
      const info = z
        .object({id: z.string(), parentID: z.string().optional()})
        .parse(props.info);
      if (info.parentID && this.sessions.has(info.parentID)) {
        this.sessions.add(info.id);
        this.options.onProgress?.();
      }
    }
    // These events lack session IDs. This is an owned, isolated server, not a shared service.
    if (
      [
        'file.edited',
        'pty.created',
        'worktree.ready',
        'worktree.failed',
      ].includes(event.type)
    ) {
      this.options.onProgress?.();
    }
    if (event.type === 'message.updated') {
      const info = messageSchema.parse(props.info);
      if (!this.sessions.has(info.sessionID)) {
        return false;
      }
      this.observeMessage(info);
    } else if (event.type === 'message.part.updated') {
      const part = partSchema.parse(props.part);
      if (!this.sessions.has(part.sessionID)) {
        return false;
      }
      this.observeActivity(part.messageID, partProgress(part));
    } else if (event.type === 'message.part.delta') {
      const delta = z
        .object({
          sessionID: z.string(),
          messageID: z.string(),
          field: z.string(),
          delta: z.string(),
        })
        .parse(props);
      if (!this.sessions.has(delta.sessionID)) {
        return false;
      }
      const progress =
        ['text', 'reasoning'].includes(delta.field) && !!delta.delta;
      this.observeActivity(
        delta.messageID,
        progress,
        delta.field === 'text' ? delta.delta : undefined,
      );
    } else if (
      event.type === 'session.error' &&
      props.sessionID === this.sessionId &&
      props.error
    ) {
      this.turn?.error.resolve(props.error);
    } else if (
      [
        'permission.asked',
        'command.executed',
        'session.compacted',
        'todo.updated',
      ].includes(event.type) &&
      typeof props.sessionID === 'string' &&
      this.sessions.has(props.sessionID)
    ) {
      this.options.onProgress?.();
    }

    return true;
  }
}

function pluginSource(url: string, token: string): string {
  return `async function invoke(phase,event,agent,sessionID){
    const r=await fetch(${JSON.stringify(url)},{method:'POST',headers:{'content-type':'application/json',authorization:${JSON.stringify('Bearer ' + token)}},body:JSON.stringify({phase,event,agent,sessionID})});
    if(!r.ok)throw Error('Stratos callback connection failed');
    const data=await r.json();if(data.cancelled)throw Error('Stratos hook failed; invocation cancelled');return data.decision;
  }
  export const StratosHooks=async()=>({
    'chat.params':async(i)=>{if(['title','summary','compaction'].includes(i.agent))await invoke('background-model',undefined,i.agent);},
    'tool.execute.before':async(i,o)=>{const d=await invoke('before',{toolCallId:i.callID,toolName:i.tool,input:o.args},undefined,i.sessionID);
      if(d?.action==='deny')throw Error(d.reason);
      if(d?.action==='modify'){for(const key of Object.keys(o.args))delete o.args[key];Object.assign(o.args,d.arguments);}},
    'tool.execute.after':async(i,o)=>{const failed=o.isError||o.metadata?.exit>0;
      const d=await invoke('after',{toolCallId:i.callID,toolName:i.tool,input:i.args,output:o,...(failed?{error:{message:o.output??'Tool failed'}}:{})},undefined,i.sessionID);
      if(d?.action==='block'){if('output' in o)o.output=d.reason;if('content' in o)o.content=[{type:'text',text:d.reason}];}}
  });`;
}
