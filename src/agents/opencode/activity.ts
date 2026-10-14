import {z} from 'zod';

import type {AgentEventConsumer} from '../events.js';

const eventSchema = z.object({
  type: z.string(),
  properties: z.record(z.string(), z.unknown()),
});
const infoSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  role: z.string(),
  summary: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
  error: z.unknown().optional(),
});
const partSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  type: z.string(),
  auto: z.boolean().optional(),
  state: z
    .object({
      status: z.string(),
      output: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
});

/** Native child sessions are awaited tasks, not detached background processes. */
export class OpenCodeActivity {
  private root?: string;
  private readonly parents = new Map<string, string>();
  private readonly active = new Set<string>();
  private readonly started = new Set<string>();
  private readonly errors = new Map<string, Error>();
  private readonly compactions = new Map<string, string>();
  private readonly parts = new Map<string, string>();
  private readonly seenCompactions = new Set<string>();

  constructor(private readonly emit: AgentEventConsumer) {}

  parent(sessionId: string | undefined): {
    parentTaskId?: string;
    parentCompactionId?: string;
  } {
    return {
      ...(sessionId && this.parents.has(sessionId)
        ? {parentTaskId: sessionId}
        : {}),
      ...(sessionId && this.compactions.has(sessionId)
        ? {parentCompactionId: this.compactions.get(sessionId)}
        : {}),
    };
  }

  private start(sessionId: string, timestamp: number): void {
    if (!this.parents.has(sessionId) || this.active.has(sessionId)) {
      return;
    }
    this.active.add(sessionId);
    this.started.add(sessionId);
    this.errors.delete(sessionId);
    const parent = this.parents.get(sessionId)!;
    void this.emit({
      type: 'background.started',
      taskId: sessionId,
      timestamp,
      ...(parent !== this.root ? {parentTaskId: parent} : {}),
    });
  }

  observe(value: unknown, root: string): void {
    this.root = root;
    const {type, properties: props} = eventSchema.parse(value);
    const timestamp = Date.now();
    if (type === 'session.created') {
      const info = z
        .object({id: z.string(), parentID: z.string().optional()})
        .parse(props.info);
      if (
        info.parentID === root ||
        (info.parentID && this.parents.has(info.parentID))
      ) {
        this.parents.set(info.id, info.parentID);
      }
      return;
    }
    const info =
      type === 'message.updated' ? infoSchema.parse(props.info) : undefined;
    const part =
      type === 'message.part.updated'
        ? partSchema.parse(props.part)
        : undefined;
    const sessionId = info?.sessionID ?? part?.sessionID ?? props.sessionID;
    if (
      typeof sessionId !== 'string' ||
      (sessionId !== root && !this.parents.has(sessionId))
    ) {
      return;
    }
    const status =
      type === 'session.status'
        ? z.object({type: z.string()}).parse(props.status).type
        : undefined;
    if (
      status === 'busy' ||
      (info?.role === 'assistant' && !this.started.has(sessionId))
    ) {
      this.start(sessionId, timestamp);
    }
    if (part?.type === 'compaction' && !this.seenCompactions.has(part.id)) {
      this.seenCompactions.add(part.id);
      const parent = this.parent(sessionId);
      this.compactions.set(sessionId, part.id);
      void this.emit({
        type: 'compaction.started',
        compactionId: part.id,
        timestamp,
        input: {auto: part.auto},
        ...parent,
      });
    }
    if (type === 'session.compacted') {
      void this.emit({
        type: 'compaction.completed',
        compactionId:
          this.compactions.get(sessionId) ?? `${sessionId}:${timestamp}`,
        timestamp,
        ...(this.parents.has(sessionId) ? {parentTaskId: sessionId} : {}),
      });
      this.compactions.delete(sessionId);
    }
    const failure =
      info?.error ?? (type === 'session.error' ? props.error : undefined);
    if (failure) {
      const native = z
        .object({
          name: z.string(),
          data: z.object({message: z.string().optional()}).optional(),
        })
        .parse(failure);
      const error = new Error(native.data?.message ?? native.name);
      error.name = native.name;
      this.errors.set(sessionId, error);
      if (info?.summary === true && this.compactions.has(sessionId)) {
        void this.emit({
          type: 'compaction.completed',
          compactionId: this.compactions.get(sessionId)!,
          timestamp,
          error,
          ...this.parent(sessionId),
        });
        this.compactions.delete(sessionId);
      }
    }
    if (!this.active.has(sessionId)) {
      return;
    }
    if (
      type === 'message.part.delta' &&
      props.delta &&
      ['text', 'reasoning'].includes(String(props.field))
    ) {
      void this.emit({
        type: 'background.activity',
        taskId: sessionId,
        timestamp,
        progress: {field: props.field, delta: props.delta},
      });
    }
    if (part?.type === 'tool' && part.state) {
      const state = JSON.stringify(part.state);
      if (this.parts.get(part.id) !== state) {
        this.parts.set(part.id, state);
        void this.emit({
          type: 'background.activity',
          taskId: sessionId,
          timestamp,
          progress: {toolPartId: part.id, ...part.state},
        });
      }
    }
    if (status === 'idle' || type === 'session.idle') {
      this.active.delete(sessionId);
      const error = this.errors.get(sessionId);
      void this.emit({
        type: 'background.completed',
        taskId: sessionId,
        timestamp,
        ...(error?.name === 'MessageAbortedError'
          ? {cancelled: true, reason: error.message}
          : {error}),
      });
    }
  }
}
