import {
  mkdtemp,
  writeFile,
  symlink,
  rm,
  access,
  readdir,
  readFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

import {
  Codex,
  type CodexOptions,
  type ThreadOptions,
  type ThreadEvent,
} from '@openai/codex-sdk';
import {stringify} from 'smol-toml';
import {z} from 'zod';

import {codexModels} from '../../telemetry/harness-models.js';
import type {AgentAdapter} from '../adapter.js';
import type {ProgressOptions} from '../availability.js';
import {
  createAgentEventSink,
  type AgentEvent,
  type AgentEventConsumer,
} from '../events.js';
import type {AgentHooks} from '../hooks.js';
import type {HarnessTools} from '../tools.js';
import {CodexActivity, codexTranscriptSchema} from './activity.js';
import {CodexHookFailure} from './hook-failure.js';
import {
  startCodexHookServer,
  codexMcpHookConfiguration,
} from './hook-server.js';
import {codexOllamaCatalog} from './ollama.js';
import {codexBinary} from './preflight.js';
import {
  codexProvider,
  codexAuthPath,
  codexEnvironment,
  type CodexProvider,
} from './provider.js';

export type CodexAdapterOptions = ProgressOptions & {
  model: string;
  provider?: string;
  workingDirectory: string;
  effort?: ThreadOptions['modelReasoningEffort'];
  systemPrompt?: string;
  outputSchema?: Record<string, unknown>;
  mcpServers?: NonNullable<CodexOptions['config']>;
  /** Config keys from `codexTools`, disabled for this agent. */
  removedTools?: readonly string[];
  env?: Record<string, string>;
  apiKey?: string;
  binary?: string;
  hooks?: AgentHooks;
  onEvent: AgentEventConsumer;
  diagnostic(error: unknown): void;
  onStartup?: () => (
    outcome: 'success' | 'error' | 'cancelled' | 'incomplete',
  ) => void;
};

export function isCodexProgress(event: ThreadEvent): boolean {
  if (
    event.type !== 'item.started' &&
    event.type !== 'item.updated' &&
    event.type !== 'item.completed'
  ) {
    return false;
  }
  const item = event.item;
  return (
    item.type !== 'error' &&
    ((item.type !== 'agent_message' && item.type !== 'reasoning') ||
      Boolean(item.text))
  );
}

export function codexFailure(event: ThreadEvent): Error {
  return new Error(
    'Codex native turn failed; no model-specific code is exposed',
    {cause: event},
  );
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/**
 * Codex config keys for canonical tools, then Codex-only tools by their
 * feature name. Removal sets a key to `false` (`web_search` to `"disabled"`).
 */
export const codexTools: HarnessTools = {
  shell: ['features.shell_tool'],
  read: 'absent',
  // apply_patch edits and creates files; it comes from model metadata and has no switch.
  edit: 'fixed',
  write: 'fixed',
  glob: 'absent',
  grep: 'absent',
  lsp: 'absent',
  web_fetch: 'absent',
  web_search: ['web_search', 'features.standalone_web_search'],
  subagent: ['features.multi_agent', 'features.multi_agent_v2'],
  todo: ['tools.update_plan.enabled'],
  plan_mode: 'absent',
  ask_user: ['tools.experimental_request_user_input.enabled'],
  skill: ['cloud.skills.enabled'],
  notify_user: ['features.send_message_to_user_async'],
  view_image: ['features.view_image'],
  goals: ['features.goals'],
  memories: ['features.memories'],
  sleep_tool: ['features.sleep_tool'],
  tool_suggest: ['features.tool_suggest'],
  image_generation: ['features.image_generation'],
  request_permissions_tool: ['features.request_permissions_tool'],
  current_time_reminder: ['features.current_time_reminder'],
  // Also gates the history-notes tools.
  token_budget: ['features.token_budget'],
  deferred_executor: ['features.deferred_executor'],
  code_mode: ['features.code_mode'],
  agent_message_board: ['features.agent_message_board'],
};

/** Base Codex config with native tools disabled by their config keys. */
export function codexToolConfig(
  removed: readonly string[] = [],
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    features: {hooks: true, apps: false},
  };
  for (const key of removed) {
    const path = key.split('.');
    let target = config;
    for (const part of path.slice(0, -1)) {
      target = (target[part] ??= {}) as Record<string, unknown>;
    }
    target[path.at(-1)!] = key === 'web_search' ? 'disabled' : false;
  }
  return config;
}

/** SDK turns share one native thread; only Stratos-generated hooks are trusted. */
export class CodexAdapter implements AgentAdapter<unknown> {
  private home?: string;
  private launcher?: string;
  private provider?: CodexProvider;
  private threadId?: string;
  private readonly transcriptRows = new Map<string, number>();
  private active?: Promise<unknown>;
  private initializing?: Promise<void>;
  private initializationAbort?: AbortController;
  private controller?: AbortController;
  private closed = false;
  private closing?: Promise<void>;
  private readonly events;
  private readonly activity;
  private readonly hookServerName: string;

  constructor(private readonly options: CodexAdapterOptions) {
    this.events = createAgentEventSink([options.onEvent], options.diagnostic);
    this.activity = new CodexActivity(event => this.events.onEvent(event));
    let name = 'stratos_hooks';
    for (
      let suffix = 1;
      Object.hasOwn(options.mcpServers ?? {}, name);
      suffix++
    ) {
      name = `stratos_hooks_${suffix}`;
    }
    this.hookServerName = name;
  }

  initialize(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Agent is closed'));
    }
    if (this.initializing) {
      return this.initializing;
    }
    if (this.home) {
      return Promise.resolve();
    }
    this.initializationAbort = new AbortController();
    this.initializing = this.start(this.initializationAbort.signal).finally(
      () => {
        this.initializing = undefined;
        this.initializationAbort = undefined;
      },
    );
    return this.initializing;
  }

  private async start(signal: AbortSignal): Promise<void> {
    const binary = this.options.binary ?? codexBinary();
    await access(binary);
    const provider = await codexProvider(this.options);
    if (provider.id === 'azure' && !provider.hasApiKey) {
      throw new Error(
        'Codex Azure authentication is not configured: set the provider env_key',
      );
    }
    const home = await mkdtemp(join(tmpdir(), 'stratos-codex-'));
    try {
      if (this.options.provider === 'ollama') {
        provider.config.model_catalog_json = await codexOllamaCatalog(
          home,
          this.options.model,
          provider.env,
          signal,
        );
      }
      if (provider.id === 'openai' && !provider.hasApiKey) {
        const auth = codexAuthPath(this.options);
        try {
          await access(auth);
          await symlink(auth, join(home, 'auth.json'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
      }
      await writeFile(join(home, 'config.toml'), stringify(provider.config), {
        mode: 0o600,
      });
      await writeFile(
        join(home, 'hooks.json'),
        JSON.stringify({hooks: codexMcpHookConfiguration(this.hookServerName)}),
        {mode: 0o600},
      );
      const launcher = join(home, 'codex');
      // exec preserves the SDK-owned PID and AbortSignal termination behavior.
      await writeFile(
        launcher,
        `#!/bin/sh\nexec ${quote(binary)} --dangerously-bypass-hook-trust "$@"\n`,
        {mode: 0o700},
      );
      signal.throwIfAborted();
      this.home = home;
      this.launcher = launcher;
      this.provider = provider;
    } catch (error) {
      await rm(home, {recursive: true, force: true});
      throw error;
    }
  }

  execute(prompt: string): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('Agent is closed'));
    }
    if (!this.home) {
      return Promise.reject(new Error('Agent must be initialized'));
    }
    if (this.active) {
      return Promise.reject(new Error('Agent executions must be sequential'));
    }
    this.controller = new AbortController();
    const running = this.run(prompt, this.controller.signal).finally(() => {
      this.active = undefined;
      this.controller = undefined;
    });
    this.active = running;
    return running;
  }

  private async run(prompt: string, signal: AbortSignal): Promise<unknown> {
    let finishStartup:
      ReturnType<NonNullable<CodexAdapterOptions['onStartup']>> | undefined;
    const startup = (
      outcome: Parameters<NonNullable<typeof finishStartup>>[0],
    ) => {
      try {
        finishStartup?.(outcome);
      } catch {
        try {
          this.options.diagnostic(new Error('Codex startup telemetry failed'));
        } catch {
          // Observation failures do not change execution.
        }
      }
      finishStartup = undefined;
    };
    try {
      finishStartup = this.options.onStartup?.();
    } catch {
      try {
        this.options.diagnostic(new Error('Codex startup telemetry failed'));
      } catch {
        // The workflow observer is best effort, like native event consumers.
      }
    }
    try {
      return await this.runTurn(prompt, signal, () => startup('success'));
    } catch (error) {
      startup(signal.aborted ? 'cancelled' : 'error');
      throw error;
    } finally {
      startup(signal.aborted ? 'cancelled' : 'incomplete');
    }
  }

  private async runTurn(
    prompt: string,
    signal: AbortSignal,
    ready: () => void,
  ): Promise<unknown> {
    const guard = new CodexHookFailure();
    const server = await startCodexHookServer(
      {
        beforeToolCall: async event => {
          this.options.onProgress?.();
          const decision = await this.options.hooks?.beforeToolCall?.(event);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision:
                decision?.action === 'deny' ? 'deny' : 'allow',
              ...(decision?.action === 'deny'
                ? {permissionDecisionReason: decision.reason}
                : {}),
              ...(decision?.action === 'modify'
                ? {updatedInput: decision.arguments}
                : {}),
            },
          };
        },
        afterToolCall: async event => {
          this.options.onProgress?.();
          const decision = await this.options.hooks?.afterToolCall?.(event);
          return decision?.action === 'block'
            ? {decision: 'block', reason: decision.reason}
            : {};
        },
      },
      guard,
    );
    try {
      const env =
        this.provider!.id === 'openai'
          ? codexEnvironment(this.options)
          : {...this.provider!.env};
      env.CODEX_HOME = this.home!;
      env.STRATOS_HOOK_TOKEN = server.bearerToken;
      const cwd = resolve(this.options.workingDirectory);
      const client = new Codex({
        codexPathOverride: this.launcher,
        env,
        config: {
          cli_auth_credentials_store: 'file',
          model_provider: this.provider!.id,
          ...codexToolConfig(this.options.removedTools),
          projects: {[cwd]: {trust_level: 'untrusted'}},
          ...(this.options.systemPrompt
            ? this.options.provider === 'ollama'
              ? {instructions: this.options.systemPrompt}
              : {developer_instructions: this.options.systemPrompt}
            : {}),
          mcp_servers: {
            ...(this.options.mcpServers ?? {}),
            [this.hookServerName]: {
              url: server.url,
              bearer_token_env_var: 'STRATOS_HOOK_TOKEN',
            },
          },
          otel: {
            exporter: 'none',
            trace_exporter: 'none',
            metrics_exporter: 'none',
          },
        },
      });
      const options: ThreadOptions = {
        model: this.options.model,
        modelReasoningEffort: this.options.effort,
        workingDirectory: cwd,
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      };
      const thread = this.threadId
        ? client.resumeThread(this.threadId, options)
        : client.startThread(options);
      return await guard.execute(async hookSignal => {
        const turnSignal = AbortSignal.any([signal, hookSignal]);
        const {events} = await thread.runStreamed(prompt, {
          signal: turnSignal,
          outputSchema: this.options.outputSchema,
        });
        let output = '';
        let completed = false;
        let lastError: ThreadEvent | undefined;
        let terminalError: ThreadEvent | undefined;
        try {
          for await (const event of events) {
            if (event.type === 'turn.started') {
              ready();
            }
            if (isCodexProgress(event)) {
              this.options.onProgress?.();
            }
            if (event.type === 'thread.started') {
              this.threadId = event.thread_id;
            }
            try {
              this.activity.observe(event, this.threadId);
            } catch (error) {
              try {
                this.options.diagnostic(error);
              } catch {
                // Activity observation is best effort.
              }
            }
            if (event.type === 'turn.failed') {
              terminalError = event;
            }
            if (event.type === 'error') {
              lastError = event;
            }
            if (event.type === 'turn.completed') {
              completed = true;
            }
            if (
              event.type !== 'item.started' &&
              event.type !== 'item.completed'
            ) {
              continue;
            }
            const item = event.item;
            if (
              item.type === 'agent_message' &&
              event.type === 'item.completed'
            ) {
              output = item.text;
              this.events.onEvent({
                type: 'message.delta',
                timestamp: Date.now(),
                text: item.text,
              });
            }
            if (
              item.type !== 'command_execution' &&
              item.type !== 'mcp_tool_call'
            ) {
              continue;
            }
            const toolName =
              item.type === 'command_execution'
                ? 'Bash'
                : `mcp__${item.server}__${item.tool}`;
            const input =
              item.type === 'command_execution'
                ? {command: item.command}
                : item.arguments;
            if (event.type === 'item.started') {
              this.events.onEvent({
                type: 'tool.started',
                timestamp: Date.now(),
                toolCallId: item.id,
                toolName,
                input,
              });
            } else {
              const failed =
                item.status === 'failed' ||
                (item.type === 'command_execution' &&
                  item.exit_code !== null &&
                  item.exit_code !== undefined &&
                  item.exit_code !== 0);
              const output =
                item.type === 'command_execution'
                  ? item.aggregated_output
                  : item.result;
              const error = failed
                ? new Error(
                    item.type === 'command_execution'
                      ? `Command failed (${item.exit_code}): ${item.aggregated_output}`
                      : (item.error?.message ?? 'MCP tool failed'),
                    {cause: output},
                  )
                : undefined;
              this.events.onEvent({
                type: 'tool.completed',
                timestamp: Date.now(),
                toolCallId: item.id,
                output,
                error,
              });
              // Native MCP errors omit PostToolUse. Supply that missing failure callback.
              if (item.type === 'mcp_tool_call' && failed) {
                await guard.invoke('after', async () => {
                  const decision = await this.options.hooks?.afterToolCall?.({
                    toolCallId: item.id,
                    toolName,
                    input,
                    error,
                  });
                  if (decision?.action === 'block') {
                    throw new Error(
                      'Codex cannot block a tool failure reported only through SDK events',
                    );
                  }
                });
              }
            }
          }
        } catch (error) {
          const nativeError = terminalError ?? lastError;
          if (nativeError && !turnSignal.aborted) {
            throw codexFailure(nativeError);
          }
          throw error;
        }
        turnSignal.throwIfAborted();
        if (terminalError) {
          throw codexFailure(terminalError);
        }
        if (!completed) {
          if (lastError) {
            throw codexFailure(lastError);
          }
          throw new Error('Codex ended without completing the turn');
        }
        if (!this.options.outputSchema && !output.trim()) {
          throw new Error('Codex returned no text');
        }
        return this.options.outputSchema ? JSON.parse(output) : output;
      });
    } finally {
      await this.captureTranscripts();
      try {
        await server.close();
      } catch (error) {
        try {
          this.options.diagnostic(error);
        } catch {
          /* soft cleanup */
        }
      }
      await this.events.drain();
    }
  }

  private async captureTranscripts(): Promise<void> {
    try {
      await this.readTranscripts();
    } catch {
      try {
        this.options.diagnostic(
          new Error('Codex transcript telemetry unavailable'),
        );
      } catch {
        // Diagnostic failures must not interrupt agent execution.
      }
    }
  }

  private async readTranscripts(): Promise<void> {
    if (!this.threadId || !this.home) {
      return;
    }
    const directory = join(this.home, 'sessions');
    const transcripts = await Promise.all(
      (await readdir(directory, {recursive: true}))
        .filter(file => file.endsWith('.jsonl'))
        .map(async file => {
          const content = await readFile(join(directory, file), 'utf8');
          // A still-running child may be in the middle of appending its next row.
          const rows = codexTranscriptSchema.parse(
            content
              .slice(0, content.lastIndexOf('\n') + 1)
              .split('\n')
              .filter(Boolean)
              .map(line => JSON.parse(line)),
          );
          const meta = z
            .object({
              id: z.string(),
              source: z.union([
                z.string(),
                z.object({
                  subagent: z.object({
                    thread_spawn: z.object({parent_thread_id: z.string()}),
                  }),
                }),
              ]),
            })
            .safeParse(rows[0]?.payload);
          return {rows, meta: meta.success ? meta.data : undefined};
        }),
    );
    const root = transcripts.find(t => t.meta?.id === this.threadId);
    if (!root) {
      throw new Error('Codex root transcript unavailable');
    }
    const owned = new Map([[this.threadId, root]]);
    for (let size = 0; size !== owned.size;) {
      size = owned.size;
      for (const transcript of transcripts) {
        const source = transcript.meta?.source;
        if (
          source &&
          typeof source !== 'string' &&
          !owned.has(transcript.meta!.id) &&
          owned.has(source.subagent.thread_spawn.parent_thread_id)
        ) {
          owned.set(transcript.meta!.id, transcript);
        }
      }
    }
    const activities: AgentEvent[] = [];
    for (const [id, {rows, meta}] of owned) {
      const after = this.transcriptRows.get(id) ?? 0;
      const source = meta!.source;
      const parentId =
        typeof source === 'string'
          ? undefined
          : source.subagent.thread_spawn.parent_thread_id;
      const inherited = new Set<string>();
      let ancestor = parentId;
      while (ancestor) {
        const parent = owned.get(ancestor);
        for (const row of parent?.rows ?? []) {
          if (
            row.payload?.type === 'task_started' &&
            typeof row.payload.turn_id === 'string'
          ) {
            inherited.add(row.payload.turn_id);
          }
        }
        const source = parent?.meta?.source;
        ancestor =
          source && typeof source !== 'string'
            ? source.subagent.thread_spawn.parent_thread_id
            : undefined;
      }
      activities.push(
        ...this.activity
          .transcript(rows, after, id, parentId, inherited)
          .map(event =>
            event.parentTaskId === this.threadId
              ? {...event, parentTaskId: undefined}
              : event,
          ),
      );
      if (id === this.threadId) {
        codexModels(
          rows,
          after,
          event => this.events.onEvent(event),
          this.options.provider ?? 'openai',
        );
      }
      this.transcriptRows.set(id, rows.length);
    }
    for (const event of activities.sort((a, b) => a.timestamp - b.timestamp)) {
      this.events.onEvent(event);
    }
  }

  cancel(): void {
    this.initializationAbort?.abort(
      new Error('Agent initialization cancelled'),
    );
    this.controller?.abort(new Error('Agent execution cancelled'));
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
      await this.captureTranscripts();
      await this.events.drain();
      if (this.home) {
        await rm(this.home, {recursive: true, force: true});
      }
    })();
    return this.closing;
  }
}
