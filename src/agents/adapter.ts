/** Internal harness lifecycle contract; not exported to workflow authors. */
export interface AgentAdapter<TOutput = string> {
  /** Prepare native session resources when the Agent first needs them. */
  initialize(): Promise<void>;

  /** Execute a rendered user prompt in the adapter's existing conversation. */
  execute(prompt: string): Promise<TOutput>;

  /** Signal cancellation without waiting; pending execute observes completion. */
  cancel(): void;

  /** Release owned resources during runtime cleanup. */
  close(): Promise<void>;
}
