/** Internal adapter observations. Times are Unix epoch milliseconds. */
type EventBase = {
  timestamp: number;
  reconstructed?: boolean;
  parentTaskId?: string;
  parentToolCallId?: string;
  parentCompactionId?: string;
};
type Outcome = {
  output?: unknown;
  error?: Error;
  cancelled?: boolean;
  reason?: string;
};
export type ModelSettings = {
  model?: string;
  provider?: string;
  effort?: string;
  temperature?: number;
  maxOutputTokens?: number;
};
/** Adapters normalize available model messages into the GenAI message shape. */
export type ModelMessage = {
  role: string;
  parts: ReadonlyArray<Record<string, unknown>>;
  finish_reason?: string;
};
export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
};
export type AgentEvent = EventBase &
  (
    | {type: 'message.delta'; text: string}
    | {
        type: 'tool.started';
        toolCallId: string;
        toolName: string;
        input: unknown;
      }
    | ({type: 'tool.completed'; toolCallId: string} & Outcome)
    | {
        type: 'model.started';
        modelCallId: string;
        input?: readonly ModelMessage[];
        settings?: ModelSettings;
      }
    | ({
        type: 'model.completed';
        modelCallId: string;
        usage?: TokenUsage;
        output?: readonly ModelMessage[];
      } & Outcome)
    | {type: 'compaction.started'; compactionId: string; input?: unknown}
    | ({
        type: 'compaction.completed';
        compactionId: string;
        usage?: TokenUsage;
      } & Outcome)
    | {
        type: 'background.started';
        taskId: string;
        parentTaskId?: string;
        description?: string;
      }
    | {type: 'background.activity'; taskId: string; progress?: unknown}
    | ({
        type: 'background.completed';
        taskId: string;
        usage?: TokenUsage;
      } & Outcome)
  );
export type AgentEventConsumer = (event: AgentEvent) => void | Promise<void>;
export type EventDiagnostic = (error: unknown) => void;

/** Observation failures never become hook failures. Invoke consumers in arrival
 * order; asynchronous observation does not pause the harness's agent loop.
 */
export function createAgentEventSink(
  consumers: readonly AgentEventConsumer[],
  diagnostic: EventDiagnostic,
) {
  const pending = new Set<Promise<void>>();
  const warn = (error: unknown) => {
    try {
      diagnostic(error);
    } catch {
      /* Logging is best effort too. */
    }
  };
  return {
    onEvent(event: AgentEvent): void {
      for (const consumer of consumers) {
        try {
          const result = consumer(event);
          if (result) {
            const work = Promise.resolve(result)
              .catch(warn)
              .finally(() => pending.delete(work));
            pending.add(work);
          }
        } catch (error) {
          warn(error);
        }
      }
    },
    async drain(): Promise<void> {
      while (pending.size) {
        await Promise.all([...pending]);
      }
    },
  };
}
