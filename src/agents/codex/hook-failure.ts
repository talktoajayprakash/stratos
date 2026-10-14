/** Internal, invocation-scoped Codex hook failure handling; no public Agent API. */
export class CodexHookFailure {
  private readonly controller = new AbortController();
  private failed = false;
  private failure: unknown;

  /** The owner passes this signal to the SDK and awaits execution termination. */
  async execute<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      if (this.failed) {
        throw this.failure;
      }
      const result = await work(this.controller.signal);
      if (this.failed) {
        throw this.failure;
      }
      return result;
    } catch (error) {
      // SDK cancellation errors must not replace the original callback exception.
      if (this.failed) {
        throw this.failure;
      }
      throw error;
    }
  }

  /** Return a blocking native hook decision, never an MCP isError response for
   * a callback exception: Codex treats MCP hook errors as non-blocking.
   */
  async invoke<T>(phase: 'before' | 'after', callback: () => T | Promise<T>) {
    if (!this.failed) {
      try {
        const result = await callback();
        // Another concurrent callback may have failed while this one awaited.
        if (!this.failed) {
          return result;
        }
      } catch (error) {
        if (!this.failed) {
          this.failure = error;
          this.failed = true;
          this.controller.abort(error);
        }
      }
    }
    const reason = 'Stratos hook failed; agent invocation cancelled.';
    return phase === 'before'
      ? {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }
      : {decision: 'block', reason};
  }
}
