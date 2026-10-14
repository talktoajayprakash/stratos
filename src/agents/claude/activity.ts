import {randomUUID} from 'node:crypto';

import type {SDKMessage} from '@anthropic-ai/claude-agent-sdk';

import type {AgentEvent, AgentEventConsumer} from '../events.js';

/** Task bookends, not the unordered background membership snapshots. */
export class ClaudeActivity {
  private compaction?: string;
  private compacting = false;
  private readonly tasks = new Map<
    string,
    {ended: boolean; ambient: boolean; start?: string}
  >();
  private readonly progress = new Map<string, string>();
  private readonly completedCompactions = new Set<string>();
  private readonly toolOwners = new Map<string, string>();
  private readonly toolTasks = new Map<string, string>();

  constructor(private readonly emit: AgentEventConsumer) {}

  tool(toolCallId: string, parentTaskId?: string): void {
    if (parentTaskId) {
      this.toolOwners.set(toolCallId, parentTaskId);
    }
  }

  readonly onEvent = (event: AgentEvent): void => {
    const parentTaskId =
      event.parentTaskId ??
      (event.type !== 'background.started' && event.parentToolCallId
        ? this.toolTasks.get(event.parentToolCallId)
        : undefined);
    void this.emit({
      ...event,
      ...(parentTaskId ? {parentTaskId} : {}),
      ...(!parentTaskId && this.compaction && event.type.startsWith('model.')
        ? {parentCompactionId: this.compaction}
        : {}),
    });
  };

  observe(event: SDKMessage): void {
    if (event.type !== 'system') {
      return;
    }
    const timestamp = Date.now();
    if (event.subtype === 'status' && event.status === 'compacting') {
      if (!this.compacting) {
        this.compacting = true;
        this.compaction = randomUUID();
        this.onEvent({
          type: 'compaction.started',
          compactionId: this.compaction,
          timestamp,
        });
      }
    } else if (event.subtype === 'status' && event.status === null) {
      this.compacting = false;
    } else if (event.subtype === 'compact_boundary') {
      if (this.completedCompactions.has(event.uuid)) {
        return;
      }
      this.completedCompactions.add(event.uuid);
      this.onEvent({
        type: 'compaction.completed',
        compactionId: this.compaction ?? event.uuid,
        timestamp,
        output: event.compact_metadata,
      });
      this.compaction = undefined;
      this.compacting = false;
    } else if (event.subtype === 'task_started') {
      const previous = this.tasks.get(event.task_id);
      if (
        previous &&
        (!previous.ended || !previous.start || previous.start === event.uuid)
      ) {
        return;
      }
      this.tasks.set(event.task_id, {
        ended: false,
        ambient: !!(event.ambient || event.skip_transcript),
        start: event.uuid,
      });
      this.progress.delete(event.task_id);
      if (event.tool_use_id) {
        this.toolTasks.set(event.tool_use_id, event.task_id);
      }
      this.onEvent({
        type: 'background.started',
        taskId: event.task_id,
        timestamp,
        description: event.description,
        parentToolCallId: event.tool_use_id,
        parentTaskId: event.tool_use_id
          ? this.toolOwners.get(event.tool_use_id)
          : undefined,
      });
    } else if (event.subtype === 'task_progress') {
      const task = this.tasks.get(event.task_id);
      // Elapsed time and task existence do not establish progress.
      const progress = JSON.stringify([
        event.usage.total_tokens,
        event.usage.tool_uses,
        event.summary,
      ]);
      if (
        task?.ended ||
        task?.ambient ||
        this.progress.get(event.task_id) === progress ||
        (!this.progress.has(event.task_id) &&
          !event.usage.total_tokens &&
          !event.usage.tool_uses &&
          !event.summary)
      ) {
        return;
      }
      this.progress.set(event.task_id, progress);
      this.onEvent({
        type: 'background.activity',
        taskId: event.task_id,
        timestamp,
        progress: {
          description: event.description,
          usage: event.usage,
          summary: event.summary,
          lastToolName: event.last_tool_name,
        },
      });
    } else if (event.subtype === 'task_notification') {
      if (this.tasks.get(event.task_id)?.ended) {
        return;
      }
      this.tasks.set(event.task_id, {
        ...this.tasks.get(event.task_id),
        ended: true,
        ambient: !!event.ambient,
      });
      this.onEvent({
        type: 'background.completed',
        taskId: event.task_id,
        timestamp,
        output: {summary: event.summary, usage: event.usage},
        ...(event.status === 'failed'
          ? {error: new Error(event.summary || 'Claude task failed')}
          : {}),
        ...(event.status === 'stopped' ? {cancelled: true} : {}),
        reason: event.reason,
      });
    }
  }
}
