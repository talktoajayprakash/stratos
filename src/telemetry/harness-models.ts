import type {SDKMessage} from '@anthropic-ai/claude-agent-sdk';
import type {Part, Message} from '@opencode-ai/sdk/v2';

import type {
  AgentEvent,
  AgentEventConsumer,
  ModelMessage,
} from '../agents/events.js';

type ClaudeStreamEvent = Extract<SDKMessage, {type: 'stream_event'}>['event'];
type ClaudeBlock = Extract<
  ClaudeStreamEvent,
  {type: 'content_block_start'}
>['content_block'] & {json: string};
type ClaudeUsage = Extract<
  ClaudeStreamEvent,
  {type: 'message_start'}
>['message']['usage'];

const text = (role: string, content: string): ModelMessage => ({
  role,
  parts: [{type: 'text', content}],
});
/** Observed conversation only: harness-hidden instructions/provider payloads are unavailable. */
export class ClaudeModels {
  private readonly histories = new Map<string, ModelMessage[]>();
  private readonly streams = new Map<
    string,
    {
      id: string;
      blocks: ClaudeBlock[];
      usage: ClaudeUsage;
      reason?: string | null;
    }
  >();
  constructor(private emit: AgentEventConsumer) {}
  private history(key: string): ModelMessage[] {
    let history = this.histories.get(key);
    if (!history) {
      history = [];
      this.histories.set(key, history);
    }
    return history;
  }
  prompt(prompt: string) {
    this.history('').push(text('user', prompt));
  }
  observe(e: SDKMessage) {
    const now = Date.now();
    const key = 'parent_tool_use_id' in e ? (e.parent_tool_use_id ?? '') : '';
    const history = this.history(key);
    const parent = key ? {parentToolCallId: key} : {};
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block.type === 'tool_result') {
          history.push({
            role: 'tool',
            parts: [
              {
                type: 'tool_call_response',
                id: block.tool_use_id,
                result: block.content,
              },
            ],
          });
        }
      }
    }
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      history.length = 0;
    }
    if (e.type !== 'stream_event') {
      return;
    }
    const s = e.event;
    if (s.type === 'message_start') {
      this.streams.set(key, {
        id: s.message.id,
        blocks: [],
        usage: {...s.message.usage},
      });
      void this.emit({
        type: 'model.started',
        timestamp: now,
        modelCallId: s.message.id,
        input: structuredClone(history),
        ...parent,
        settings: {model: s.message.model, provider: 'anthropic'},
      });
    }
    const c = this.streams.get(key);
    if (!c) {
      return;
    }
    if (s.type === 'content_block_start') {
      c.blocks[s.index] = {...s.content_block, json: ''};
    }
    if (s.type === 'content_block_delta') {
      const block = c.blocks[s.index];
      if (!block) {
        return;
      }
      if (s.delta.type === 'text_delta' && block.type === 'text') {
        block.text += s.delta.text;
      }
      if (s.delta.type === 'input_json_delta') {
        block.json += s.delta.partial_json;
      }
    }
    if (s.type === 'message_delta') {
      Object.assign(c.usage, s.usage);
      c.reason = s.delta.stop_reason;
    }
    if (s.type === 'message_stop') {
      const output: ModelMessage = {
        role: 'assistant',
        ...(c.reason ? {finish_reason: c.reason} : {}),
        parts: c.blocks.flatMap<Record<string, unknown>>(b =>
          b.type === 'text'
            ? [{type: 'text', content: b.text}]
            : b.type === 'tool_use'
              ? [
                  {
                    type: 'tool_call',
                    id: b.id,
                    name: b.name,
                    arguments: b.json ? JSON.parse(b.json) : b.input,
                  },
                ]
              : [],
        ),
      };
      history.push(output);
      this.streams.delete(key);
      void this.emit({
        type: 'model.completed',
        timestamp: now,
        modelCallId: c.id,
        ...parent,
        output: [output],
        usage: {
          inputTokens:
            c.usage.input_tokens +
            (c.usage.cache_read_input_tokens ?? 0) +
            (c.usage.cache_creation_input_tokens ?? 0),
          outputTokens: c.usage.output_tokens,
          cacheReadInputTokens: c.usage.cache_read_input_tokens ?? undefined,
        },
      });
    }
  }
}

export class OpenCodeModels {
  private readonly histories = new Map<string, ModelMessage[]>();
  private history(sessionId: string): ModelMessage[] {
    let history = this.histories.get(sessionId);
    if (!history) {
      history = [];
      this.histories.set(sessionId, history);
    }
    return history;
  }
  private parts = new Map<string, Part>();
  private infos = new Map<string, Message>();
  private active = new Set<string>();
  private finished = new Set<string>();
  constructor(
    private emit: AgentEventConsumer,
    private settings: {model: string; provider: string},
  ) {}
  prompt(prompt: string, sessionId = '') {
    this.history(sessionId).push(text('user', prompt));
  }
  observe(
    event: unknown,
    parent: Pick<AgentEvent, 'parentTaskId' | 'parentCompactionId'> = {},
  ) {
    const e = event as {properties?: {info?: Message; part?: Part}};
    const now = Date.now();
    const info = e.properties?.info;
    const part = e.properties?.part;
    if (info) {
      this.infos.set(info.id, info);
    }
    if (!part) {
      return;
    }
    this.parts.set(part.id, part);
    const history = this.history(part.sessionID ?? '');
    const id = part.messageID;
    if (
      part.type === 'step-start' &&
      !this.active.has(id) &&
      !this.finished.has(id)
    ) {
      this.active.add(id);
      void this.emit({
        type: 'model.started',
        modelCallId: id,
        timestamp: now,
        input: structuredClone(history),
        ...parent,
        settings: this.settings,
      });
    }
    if (part.type !== 'step-finish' || !this.active.delete(id)) {
      return;
    }
    this.finished.add(id);
    const ps = [...this.parts.values()].filter(p => p.messageID === id);
    const output: ModelMessage = {
      role: 'assistant',
      finish_reason: part.reason,
      parts: ps.flatMap<Record<string, unknown>>(p =>
        p.type === 'text'
          ? [{type: 'text', content: p.text}]
          : p.type === 'tool'
            ? [
                {
                  type: 'tool_call',
                  id: p.callID,
                  name: p.tool,
                  arguments: p.state.input,
                },
              ]
            : [],
      ),
    };
    history.push(output);
    for (const p of ps) {
      if (p.type === 'tool') {
        history.push({
          role: 'tool',
          parts: [
            {
              type: 'tool_call_response',
              id: p.callID,
              result:
                ('output' in p.state ? p.state.output : undefined) ??
                ('error' in p.state ? p.state.error : undefined),
            },
          ],
        });
      }
    }
    const u = part.tokens;
    const completedInfo = this.infos.get(id);
    const error =
      completedInfo?.role === 'assistant' ? completedInfo.error : undefined;
    const errorMessage =
      error?.data && 'message' in error.data ? error.data.message : undefined;
    void this.emit({
      type: 'model.completed',
      modelCallId: id,
      ...parent,
      timestamp: now,
      output: [output],
      ...(error
        ? {
            error: new Error(String(errorMessage ?? 'OpenCode model failed')),
          }
        : {}),
      usage: u
        ? {
            inputTokens: u.input + (u.cache?.read ?? 0) + (u.cache?.write ?? 0),
            outputTokens: u.output + (u.reasoning ?? 0),
            cacheReadInputTokens: u.cache?.read,
          }
        : undefined,
    });
    for (const p of ps) {
      this.parts.delete(p.id);
    }
    this.infos.delete(id);
  }
}

interface CodexRow {
  type: string;
  timestamp: string;
  payload?: {
    type?: string;
    model?: string;
    role?: string;
    content?: Array<{type: string; text?: string}>;
    arguments?: string;
    input?: string;
    call_id?: string;
    name?: string;
    output?: unknown;
    info?: {
      last_token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
      };
    };
  };
}

/** Codex rollout reconstruction: intervals are transcript times, not API latency. */
export function codexModels(
  rows: CodexRow[],
  after: number,
  emit: AgentEventConsumer,
  provider = 'openai',
) {
  const history: ModelMessage[] = [];
  let model: string | undefined;
  let boundary = 0;
  let current: {id: string; output: ModelMessage[]} | undefined;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const p = row.payload;
    const timestamp = Date.parse(row.timestamp);
    if (!p || !Number.isFinite(timestamp)) {
      continue;
    }
    if (row.type === 'turn_context') {
      model = p.model;
    }
    if (row.type === 'event_msg' && p.type === 'task_started') {
      boundary = timestamp;
    }
    if (row.type === 'compacted') {
      history.length = 0;
      current = undefined;
      boundary = timestamp;
    }
    if (row.type === 'response_item') {
      let message: ModelMessage | undefined;
      if (p.type === 'message' && Array.isArray(p.content)) {
        message = {
          role: p.role!,
          parts: p.content
            .filter(c => ['input_text', 'output_text'].includes(c.type))
            .map(c => ({type: 'text', content: c.text})),
        };
      }
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        let args: unknown = p.arguments ?? p.input;
        try {
          args = JSON.parse(args as string);
        } catch {
          // Custom-tool inputs can be plain text rather than JSON.
        }
        message = {
          role: 'assistant',
          parts: [
            {type: 'tool_call', id: p.call_id, name: p.name, arguments: args},
          ],
        };
      }
      if (
        p.type === 'function_call_output' ||
        p.type === 'custom_tool_call_output'
      ) {
        message = {
          role: 'tool',
          parts: [
            {type: 'tool_call_response', id: p.call_id, result: p.output},
          ],
        };
      }
      if (message) {
        if (message.role === 'assistant') {
          if (!current) {
            current = {id: String(index), output: []};
            if (index >= after) {
              void emit({
                type: 'model.started',
                modelCallId: current.id,
                timestamp: boundary || timestamp,
                reconstructed: true,
                input: structuredClone(history),
                settings: {model, provider},
              });
            }
          }
          current.output.push(message);
        }
        history.push(message);
      }
    }
    if (row.type === 'event_msg' && p.type === 'token_count' && current) {
      if (Number(current.id) >= after) {
        const u = p.info?.last_token_usage;
        void emit({
          type: 'model.completed',
          modelCallId: current.id,
          timestamp,
          reconstructed: true,
          output: current.output,
          usage: u
            ? {
                inputTokens: u.input_tokens,
                outputTokens: u.output_tokens,
                cacheReadInputTokens: u.cached_input_tokens,
              }
            : undefined,
        });
      }
      current = undefined;
      boundary = timestamp;
    }
  }
}
