/** Returning no decision allows the tool call unchanged. */
export type BeforeToolCallResult =
  | void
  | {action: 'allow'}
  | {action: 'deny'; reason: string}
  | {action: 'modify'; arguments: Record<string, unknown>};

/** Block withholds the completed result and supplies feedback; it does not undo execution. */
export type AfterToolCallResult = void | {action: 'block'; reason: string};

export type ToolCallEvent = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};
export type ToolResultEvent = ToolCallEvent & {output?: unknown; error?: Error};
export type AgentHooks = {
  onStart?(): void | Promise<void>;
  onComplete?(): void | Promise<void>;
  onError?(error: unknown): void | Promise<void>;
  beforeToolCall?(
    event: ToolCallEvent,
  ): BeforeToolCallResult | Promise<BeforeToolCallResult>;
  afterToolCall?(
    event: ToolResultEvent,
  ): AfterToolCallResult | Promise<AfterToolCallResult>;
};
