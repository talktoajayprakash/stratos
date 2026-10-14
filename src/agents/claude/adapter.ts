import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';

import {
  query,
  type Options,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import {claudeProviderEnvironment} from '../../models/catalog.js';
import {ClaudeModels} from '../../telemetry/harness-models.js';
import type {AgentAdapter} from '../adapter.js';
import type {ProgressOptions} from '../availability.js';
import {createAgentEventSink, type AgentEventConsumer} from '../events.js';
import type {AgentHooks} from '../hooks.js';
import type {HarnessTools} from '../tools.js';
import {ClaudeActivity} from './activity.js';
import {claudeResultError, isClaudeProgress} from './availability.js';
import {ClaudeCancellation} from './cancellation.js';
import {blockedClaudeOutput} from './tool-output.js';

/** Claude Code tool names for canonical tools, then Claude-only tools by their own name. */
export const claudeTools: HarnessTools = {
  shell: ['Bash', 'PowerShell'],
  read: ['Read'],
  edit: ['Edit'],
  write: ['Write'],
  glob: ['Glob'],
  grep: ['Grep'],
  lsp: ['LSP'],
  web_fetch: ['WebFetch'],
  web_search: ['WebSearch'],
  subagent: ['Agent', 'SendMessage', 'ListAgents'],
  todo: ['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TodoWrite'],
  plan_mode: ['EnterPlanMode', 'ExitPlanMode'],
  ask_user: ['AskUserQuestion'],
  skill: ['Skill'],
  notify_user: ['PushNotification', 'SendUserFile'],
  NotebookEdit: ['NotebookEdit'],
  Monitor: ['Monitor'],
  TaskStop: ['TaskStop'],
  Workflow: ['Workflow'],
  CronCreate: ['CronCreate'],
  CronDelete: ['CronDelete'],
  CronList: ['CronList'],
  ScheduleWakeup: ['ScheduleWakeup'],
  RemoteTrigger: ['RemoteTrigger'],
  EnterWorktree: ['EnterWorktree'],
  ExitWorktree: ['ExitWorktree'],
  ReportFindings: ['ReportFindings'],
  Artifact: ['Artifact'],
  SendFeedback: ['SendFeedback'],
  ShareOnboardingGuide: ['ShareOnboardingGuide'],
};

/** Resolved native settings, internal to Stratos. Public configuration is resolved upstream. */
export type ClaudeAdapterOptions = Pick<
  Options,
  | 'model'
  | 'cwd'
  | 'systemPrompt'
  | 'effort'
  | 'mcpServers'
  | 'outputFormat'
  | 'disallowedTools'
  | 'env'
  | 'pathToClaudeCodeExecutable'
> &
  ProgressOptions & {
    hooks?: AgentHooks;
    provider?: string;
    onEvent: AgentEventConsumer;
    diagnostic(error: unknown): void;
  };

type ClaudeQuery = Pick<
  Query,
  'close' | 'interrupt' | 'stopTask' | 'setMcpServers'
> &
  AsyncIterable<SDKMessage>;
type QueryFactory = (input: Parameters<typeof query>[0]) => ClaudeQuery;

/** One persistent SDK query and conversation per adapter. */
export class ClaudeAdapter implements AgentAdapter<unknown> {
  private query?: ClaudeQuery;
  private reader?: Promise<void>;
  private cancellation?: ClaudeCancellation;
  private stopping?: Promise<void>;
  private closed = false;
  private cancelled = false;
  private executing = false;
  private streamFailure?: Error;
  private startupHookFailure?: {error: unknown};
  private progressed = false;
  private replyingTo?: readonly string[];
  private readonly syntheticStreams = new Set<string | null>();
  private stopFailure?: AggregateError;
  private shutdownPromise?: Promise<void>;
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private pending?: {
    id: string;
    resolve(value: unknown): void;
    reject(error: unknown): void;
    failed: boolean;
    error?: unknown;
    errors: SDKAssistantMessage[];
  };
  private readonly events;
  private readonly models;
  private readonly activity;
  private mcpSnapshot: string;
  private readonly children = new Set<ChildProcess>();
  private readonly exits = new Set<Promise<void>>();

  constructor(
    private readonly options: ClaudeAdapterOptions,
    private readonly queryFactory: QueryFactory = query,
  ) {
    this.mcpSnapshot = JSON.stringify(options.mcpServers ?? {});
    this.events = createAgentEventSink([options.onEvent], options.diagnostic);
    this.activity = new ClaudeActivity(event => this.events.onEvent(event));
    this.models = new ClaudeModels(this.activity.onEvent);
  }

  async initialize(): Promise<void> {
    if (this.closed) {
      throw new Error('Agent is closed');
    }
    if (this.query) {
      return;
    }
    const {hooks, onEvent, onProgress, diagnostic, provider, ...native} =
      this.options;
    this.query = this.queryFactory({
      prompt: this.input(),
      options: {
        ...native,
        env: claudeProviderEnvironment(provider, {
          ...process.env,
          ...native.env,
        }),
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: native.mcpServers ?? {},
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        permissionPrompts: 'none',
        perTaskStopAffordance: true,
        includePartialMessages: true,
        forwardSubagentText: true,
        includeHookEvents: true,
        spawnClaudeCodeProcess: options => {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          this.children.add(child);
          const exited = new Promise<void>(resolve => {
            const done = () => {
              this.children.delete(child);
              resolve();
            };
            child.once('close', done);
            child.once('error', done);
          });
          this.exits.add(exited);
          void exited.then(() => this.exits.delete(exited));
          return child;
        },
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                async () => {
                  if (this.cancelled) {
                    return {
                      decision: 'block',
                      reason: 'Agent execution cancelled',
                    };
                  }
                  this.cancellation?.beginNativeTurn();
                  return {};
                },
              ],
            },
          ],
          PreToolUse: [
            {
              hooks: [
                async input => {
                  if (input.hook_event_name !== 'PreToolUse') {
                    return {};
                  }
                  const event = {
                    toolCallId: input.tool_use_id,
                    toolName: input.tool_name,
                    input: input.tool_input,
                  };
                  this.activity.tool(input.tool_use_id, input.agent_id);
                  try {
                    this.progress();
                    const decision = this.isStructuredOutputDelivery(
                      event.toolName,
                    )
                      ? undefined
                      : await hooks?.beforeToolCall?.(event);
                    if (this.pending?.failed) {
                      throw this.pending.error;
                    }
                    if (decision?.action === 'deny') {
                      return {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'deny',
                          permissionDecisionReason: decision.reason,
                        },
                      };
                    }
                    this.events.onEvent({
                      type: 'tool.started',
                      timestamp: Date.now(),
                      parentTaskId: input.agent_id,
                      ...event,
                      input:
                        decision?.action === 'modify'
                          ? decision.arguments
                          : event.input,
                    });
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'allow',
                        ...(decision?.action === 'modify'
                          ? {updatedInput: decision.arguments}
                          : {}),
                      },
                    };
                  } catch (error) {
                    this.failHook(error);
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason:
                          'Stratos hook failed; invocation cancelled.',
                      },
                    };
                  }
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                async input => {
                  if (input.hook_event_name !== 'PostToolUse') {
                    return {};
                  }
                  const event = {
                    toolCallId: input.tool_use_id,
                    toolName: input.tool_name,
                    input: input.tool_input,
                    output: input.tool_response,
                  };
                  try {
                    this.progress();
                    const decision = this.isStructuredOutputDelivery(
                      event.toolName,
                    )
                      ? undefined
                      : await hooks?.afterToolCall?.(event);
                    if (this.pending?.failed) {
                      throw this.pending.error;
                    }
                    const replacement =
                      decision?.action === 'block'
                        ? blockedClaudeOutput(event.toolName, decision.reason)
                        : undefined;
                    const output =
                      decision?.action === 'block'
                        ? decision.reason
                        : event.output;
                    this.events.onEvent({
                      type: 'tool.completed',
                      timestamp: Date.now(),
                      parentTaskId: input.agent_id,
                      toolCallId: event.toolCallId,
                      output,
                    });
                    return decision?.action === 'block'
                      ? {
                          decision: 'block',
                          reason: decision.reason,
                          hookSpecificOutput: {
                            hookEventName: 'PostToolUse',
                            updatedToolOutput: replacement,
                          },
                        }
                      : {};
                  } catch (error) {
                    this.failHook(error);
                    const reason = 'Stratos hook failed; invocation cancelled.';
                    return {
                      decision: 'block',
                      reason,
                      ...(event.toolName === 'Bash' ||
                      event.toolName.startsWith('mcp__')
                        ? {
                            hookSpecificOutput: {
                              hookEventName: 'PostToolUse',
                              updatedToolOutput: blockedClaudeOutput(
                                event.toolName,
                                reason,
                              ),
                            },
                          }
                        : {}),
                    };
                  }
                },
              ],
            },
          ],
          PostToolUseFailure: [
            {
              hooks: [
                async input => {
                  if (input.hook_event_name !== 'PostToolUseFailure') {
                    return {};
                  }
                  const error = new Error(input.error);
                  const event = {
                    toolCallId: input.tool_use_id,
                    toolName: input.tool_name,
                    input: input.tool_input,
                    error,
                  };
                  try {
                    this.progress();
                    this.events.onEvent({
                      type: 'tool.completed',
                      timestamp: Date.now(),
                      parentTaskId: input.agent_id,
                      ...event,
                    });
                    const decision = this.isStructuredOutputDelivery(
                      event.toolName,
                    )
                      ? undefined
                      : await hooks?.afterToolCall?.(event);
                    if (decision?.action === 'block') {
                      throw new Error(
                        'Claude cannot replace output through PostToolUseFailure',
                      );
                    }
                  } catch (error) {
                    this.failHook(error);
                  }
                  return {};
                },
              ],
            },
          ],
        },
      },
    });
    this.cancellation = new ClaudeCancellation(this.query);
    this.reader = this.read(this.query);
    if (this.startupHookFailure) {
      throw this.startupHookFailure.error;
    }
    // Streaming input starts the native session with its first user message.
    // Waiting for initializationResult here can deadlock before that message.
  }

  async execute(prompt: string): Promise<unknown> {
    if (this.executing) {
      throw new Error('Agent executions must be sequential');
    }
    this.executing = true;
    try {
      return await this.executeTurn(prompt);
    } finally {
      this.executing = false;
    }
  }

  private async executeTurn(prompt: string): Promise<unknown> {
    if (this.closed) {
      throw new Error('Agent is closed');
    }
    if (this.pending) {
      throw new Error('Agent executions must be sequential');
    }
    await this.stopping;
    if (this.startupHookFailure) {
      throw this.startupHookFailure.error;
    }
    if (this.streamFailure) {
      throw this.streamFailure;
    }
    if (!this.query) {
      throw new Error('Agent must be initialized');
    }
    const snapshot = JSON.stringify(this.options.mcpServers ?? {});
    if (snapshot !== this.mcpSnapshot) {
      const result = await this.query.setMcpServers(
        this.options.mcpServers ?? {},
      );
      if (Object.keys(result.errors).length) {
        throw new Error('Claude MCP credential update failed');
      }
      this.mcpSnapshot = snapshot;
    }
    const id = randomUUID();
    this.cancellation!.beginTurn(id);
    this.cancelled = false;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending = {id, resolve, reject, failed: false, errors: []};
    });
    this.models.prompt(prompt);
    this.queue.push({
      type: 'user',
      uuid: id,
      message: {role: 'user', content: prompt},
      parent_tool_use_id: null,
    });
    this.wake?.();
    try {
      return await result;
    } finally {
      await this.stopping;
      if (this.stopFailure) {
        // eslint-disable-next-line no-unsafe-finally -- The aggregate includes the request failure and must report incomplete cancellation.
        throw this.stopFailure;
      }
    }
  }

  cancel(): void {
    if (this.pending && !this.pending.failed) {
      this.pending.failed = true;
      this.pending.error = new Error('Agent execution cancelled');
    }
    this.stop();
  }

  private stop(): void {
    // Stopped tasks can enqueue native notification turns after stopTask returns.
    this.cancelled = true;
    if (!this.cancellation || this.stopping) {
      return;
    }
    const pending = this.pending;
    this.stopping = this.cancellation
      .cancel()
      .catch(async error => {
        const errors = pending?.failed ? [pending.error, error] : [error];
        this.stopFailure = new AggregateError(
          errors,
          'Claude cancellation failed; conversation closed',
        );
        this.streamFailure = this.stopFailure;
        try {
          await this.shutdown();
        } catch (cleanupError) {
          this.stopFailure = new AggregateError(
            [...errors, cleanupError],
            'Claude cancellation failed; conversation closed',
          );
          this.streamFailure = this.stopFailure;
        }
        if (this.pending) {
          const current = this.pending;
          this.pending = undefined;
          current.reject(this.stopFailure);
        }
        try {
          this.options.diagnostic(this.stopFailure);
        } catch {
          /* best effort */
        }
      })
      .finally(() => {
        this.stopping = undefined;
      });
  }

  private failHook(error: unknown): void {
    if (this.pending && !this.pending.failed) {
      this.pending.failed = true;
      this.pending.error = error;
    } else if (!this.pending) {
      this.startupHookFailure ??= {error};
    }
    this.stop();
  }

  private progress(): void {
    this.progressed = true;
    this.options.onProgress?.();
  }

  private isStructuredOutputDelivery(toolName: string): boolean {
    return (
      this.options.outputFormat !== undefined && toolName === 'StructuredOutput'
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.stopping;
    } finally {
      try {
        await this.shutdown();
      } finally {
        await this.events.drain();
      }
    }
  }

  private shutdown(): Promise<void> {
    return (this.shutdownPromise ??= this.shutdownNative());
  }

  private async shutdownNative(): Promise<void> {
    this.closed = true;
    this.wake?.();
    try {
      this.query?.close();
    } finally {
      for (const child of this.children) {
        child.kill();
      }
      await Promise.all(this.exits);
      await this.reader;
    }
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const message = this.queue.shift();
      if (message) {
        yield message;
      } else {
        await new Promise<void>(resolve => {
          this.wake = resolve;
        });
      }
    }
  }

  private async read(query: ClaudeQuery): Promise<void> {
    try {
      for await (const event of query) {
        this.observe(event);
      }
    } catch (error) {
      this.streamFailure ??=
        error instanceof Error
          ? error
          : new Error('Claude stream failed', {cause: error});
    } finally {
      const error = this.streamFailure ?? new Error('Claude stream closed');
      this.cancellation?.streamClosed(error);
      if (this.pending) {
        const pending = this.pending;
        this.pending = undefined;
        pending.reject(pending.failed ? pending.error : error);
      }
    }
  }

  private observe(event: SDKMessage): void {
    this.cancellation?.observe(event);
    if (this.observeProgress(event)) {
      return;
    }
    try {
      this.activity.observe(event);
      this.models.observe(event);
    } catch {
      try {
        this.options.diagnostic(
          new Error('Claude model telemetry unavailable'),
        );
      } catch {
        // Diagnostic failures must not interrupt agent execution.
      }
    }
    if (
      event.type === 'stream_event' &&
      event.event.type === 'content_block_delta' &&
      event.event.delta.type === 'text_delta'
    ) {
      this.activity.onEvent({
        type: 'message.delta',
        text: event.event.delta.text,
        timestamp: Date.now(),
        parentToolCallId: event.parent_tool_use_id ?? undefined,
      });
    }
    this.completeTurn(event);
  }

  private completeTurn(event: SDKMessage): void {
    if (event.type !== 'result' || !this.pending) {
      return;
    }
    if (
      event.user_message_uuid !== this.pending.id &&
      !event.user_message_uuids?.includes(this.pending.id)
    ) {
      // Native task notifications can start their own turn without a client UUID.
      if (
        !event.user_message_uuid &&
        !event.user_message_uuids?.length &&
        event.origin?.kind !== 'task-notification'
      ) {
        throw new Error('Uncorrelated Claude result', {cause: event});
      }
      return;
    }
    const pending = this.pending;
    this.pending = undefined;
    if (pending.failed) {
      pending.reject(pending.error);
    } else if (
      event.subtype !== 'success' ||
      event.is_error ||
      pending.errors.length > 0
    ) {
      pending.reject(
        claudeResultError(event, {
          errors: pending.errors,
          progressed: this.progressed,
        }),
      );
    } else if (
      !this.options.outputFormat &&
      (typeof event.result !== 'string' || !event.result.trim())
    ) {
      pending.reject(
        new Error('Claude returned no assistant text', {cause: event}),
      );
    } else {
      pending.resolve(
        this.options.outputFormat ? event.structured_output : event.result,
      );
    }
  }

  private observeProgress(event: SDKMessage): boolean {
    if (
      (event.type === 'assistant' || event.type === 'stream_event') &&
      event.parent_tool_use_id === null
    ) {
      if (event.user_message_uuid || event.user_message_uuids?.length) {
        this.replyingTo = [
          ...(event.user_message_uuids ?? []),
          ...(event.user_message_uuid ? [event.user_message_uuid] : []),
        ];
      }
    }
    if (event.type === 'stream_event' && event.event.type === 'message_start') {
      if (event.event.message.model === '<synthetic>') {
        this.syntheticStreams.add(event.parent_tool_use_id);
      } else {
        this.syntheticStreams.delete(event.parent_tool_use_id);
      }
    }
    const syntheticStream =
      event.type === 'stream_event' &&
      this.syntheticStreams.has(event.parent_tool_use_id);
    const failedFinal =
      event.type === 'result' &&
      this.pending &&
      this.pending.errors.length > 0 &&
      (event.user_message_uuid === this.pending.id ||
        event.user_message_uuids?.includes(this.pending.id));
    const finalOutput =
      event.type === 'result' &&
      event.subtype === 'success' &&
      !event.is_error &&
      !failedFinal &&
      ((typeof event.result === 'string' && event.result.length > 0) ||
        event.structured_output !== undefined);
    if (finalOutput || isClaudeProgress(event, syntheticStream)) {
      this.progress();
    }
    if (
      event.type === 'assistant' &&
      event.error &&
      event.parent_tool_use_id === null &&
      !event.subagent_type &&
      this.pending &&
      (!this.replyingTo || this.replyingTo.includes(this.pending.id))
    ) {
      this.pending.errors.push(event);
    }
    // Synthetic diagnostics are native errors, not successful model output.
    return syntheticStream;
  }
}
