import {z} from 'zod';

import type {AgentEvent, AgentEventConsumer} from '../events.js';

export const codexTranscriptSchema = z.array(
  z.object({
    timestamp: z.iso.datetime({offset: true}),
    type: z.string(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
);
export type CodexTranscript = z.infer<typeof codexTranscriptSchema>;

// Some native exec versions expose these extensions outside SDK ThreadItem.
const collabSchema = z.object({
  type: z.enum(['item.started', 'item.updated', 'item.completed']),
  item: z.object({
    type: z.literal('collab_tool_call'),
    tool: z.enum(['spawn_agent', 'send_input', 'wait', 'close_agent']),
    sender_thread_id: z.string(),
    receiver_thread_ids: z.array(z.string()),
    prompt: z.string().nullish(),
    agents_states: z.record(
      z.string(),
      z.object({
        status: z.enum([
          'pending_init',
          'running',
          'interrupted',
          'completed',
          'errored',
          'shutdown',
          'not_found',
        ]),
        message: z.string().nullish(),
      }),
    ),
  }),
});

export class CodexActivity {
  private readonly tasks = new Map<string, string>();
  private readonly liveTasks = new Set<string>();

  constructor(private readonly emit: AgentEventConsumer) {}

  /** Native exec can omit collaboration items; rollout bookends remain evidence. */
  transcript(
    rows: CodexTranscript,
    after: number,
    threadId: string,
    parentTaskId?: string,
    inheritedTurns = new Set<string>(),
  ): AgentEvent[] {
    const events: AgentEvent[] = [];
    let active = false;
    let ownedTurnSeen = false;
    for (const [index, row] of rows.entries()) {
      const p = row.payload;
      const timestamp = Date.parse(row.timestamp);
      if (!p || !Number.isFinite(timestamp)) {
        continue;
      }
      const base = {timestamp, reconstructed: true};
      if (
        row.type === 'compacted' &&
        index >= after &&
        (!parentTaskId || ownedTurnSeen)
      ) {
        events.push({
          ...base,
          type: 'compaction.completed',
          compactionId: `${threadId}:${index}`,
          output: typeof p.message === 'string' ? p.message : undefined,
          ...(parentTaskId ? {parentTaskId: threadId} : {}),
        });
      }
      if (!parentTaskId) {
        continue;
      }
      if (
        row.type === 'event_msg' &&
        p.type === 'task_started' &&
        typeof p.turn_id === 'string' &&
        !inheritedTurns.has(p.turn_id)
      ) {
        active = true;
        ownedTurnSeen = true;
        if (
          index >= after &&
          !this.liveTasks.has(threadId) &&
          !['running', 'pending_init'].includes(this.tasks.get(threadId) ?? '')
        ) {
          this.tasks.set(threadId, 'running');
          events.push({
            ...base,
            type: 'background.started',
            taskId: threadId,
            parentTaskId,
          });
        }
      } else if (
        active &&
        row.type === 'event_msg' &&
        p.type === 'task_complete'
      ) {
        active = false;
        if (
          index >= after &&
          !this.liveTasks.has(threadId) &&
          this.tasks.get(threadId) !== 'completed'
        ) {
          this.tasks.set(threadId, 'completed');
          events.push({
            ...base,
            type: 'background.completed',
            taskId: threadId,
            output:
              typeof p.last_agent_message === 'string'
                ? p.last_agent_message
                : undefined,
          });
        }
      } else if (
        active &&
        row.type === 'event_msg' &&
        p.type === 'turn_aborted'
      ) {
        active = false;
        if (
          index >= after &&
          !this.liveTasks.has(threadId) &&
          this.tasks.get(threadId) !== 'interrupted'
        ) {
          this.tasks.set(threadId, 'interrupted');
          events.push({
            ...base,
            type: 'background.completed',
            taskId: threadId,
            cancelled: true,
          });
        }
      } else if (
        active &&
        !this.liveTasks.has(threadId) &&
        index >= after &&
        row.type === 'response_item' &&
        ['function_call', 'custom_tool_call'].includes(String(p.type))
      ) {
        events.push({
          ...base,
          type: 'background.activity',
          taskId: threadId,
          progress: {toolName: p.name, toolCallId: p.call_id},
        });
      }
    }
    return events;
  }

  observe(value: unknown, rootThreadId?: string): void {
    const candidate = z
      .object({item: z.object({type: z.literal('collab_tool_call')})})
      .safeParse(value);
    if (!candidate.success) {
      return;
    }
    const {item} = collabSchema.parse(value);
    const timestamp = Date.now();
    for (const [taskId, state] of Object.entries(item.agents_states)) {
      this.liveTasks.add(taskId);
      const previous = this.tasks.get(taskId);
      if (previous === state.status) {
        continue;
      }
      const running = ['pending_init', 'running'].includes(state.status);
      if (
        running &&
        (!previous || !['pending_init', 'running'].includes(previous))
      ) {
        void this.emit({
          type: 'background.started',
          taskId,
          timestamp,
          ...(item.sender_thread_id !== rootThreadId
            ? {parentTaskId: item.sender_thread_id}
            : {}),
          description: item.prompt ?? undefined,
        });
      } else if (running) {
        void this.emit({
          type: 'background.activity',
          taskId,
          timestamp,
          progress: {status: state.status},
        });
      } else {
        void this.emit({
          type: 'background.completed',
          taskId,
          timestamp,
          output: state.message ?? undefined,
          ...(state.status === 'errored' || state.status === 'not_found'
            ? {error: new Error(state.message ?? `Codex agent ${state.status}`)}
            : {}),
          ...(['interrupted', 'shutdown'].includes(state.status)
            ? {cancelled: true, reason: state.status}
            : {}),
        });
      }
      this.tasks.set(taskId, state.status);
    }
  }
}
