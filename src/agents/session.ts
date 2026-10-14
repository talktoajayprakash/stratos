import type {AgentAdapter} from './adapter.js';
import type {AgentHooks} from './hooks.js';

/** Internal conversation lifecycle; the workflow owner registers and closes it.
 * Admission, prompt resolution and output validation surround execute upstream.
 */
export class AgentSession<T> {
  private initialized = false;
  private active?: Promise<T>;
  private closing?: Promise<void>;
  private closed = false;
  private cancelled = false;

  constructor(
    private readonly adapter: AgentAdapter<T>,
    private readonly hooks: AgentHooks = {},
  ) {}

  execute(prompt: string): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new Error('Agent belongs to a closing or closed workflow'),
      );
    }
    if (this.active) {
      return Promise.reject(
        new Error(
          'Agent executions must be sequential; use separate agents for parallel calls',
        ),
      );
    }
    this.cancelled = false;
    // Reserve the conversation synchronously before initialization or hooks yield.
    const work = Promise.resolve().then(() => this.run(prompt));
    const pending = work.finally(() => {
      if (this.active === pending) {
        this.active = undefined;
      }
    });
    this.active = pending;
    return pending;
  }

  private async run(prompt: string): Promise<T> {
    try {
      this.checkCancelled();
      if (!this.initialized) {
        await this.adapter.initialize();
        this.initialized = true;
      }
      this.checkCancelled();
      await this.hooks.onStart?.();
      this.checkCancelled();
      const result = await this.adapter.execute(prompt);
      this.checkCancelled();
      await this.hooks.onComplete?.();
      this.checkCancelled();
      return result;
    } catch (error) {
      try {
        await this.hooks.onError?.(error);
      } catch (hookError) {
        throw new AggregateError(
          [error, hookError],
          'Agent execution and onError hook failed',
        );
      }
      throw error;
    }
  }

  private checkCancelled(): void {
    if (this.cancelled || this.closed) {
      throw new Error('Agent execution cancelled');
    }
  }

  cancel(): void {
    this.cancelled = true;
    // Includes background-only cancellation after a completed request.
    this.adapter.cancel();
  }

  /** Runtime only. The owner logs close errors and preserves its execution result. */
  close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    this.closed = true;
    this.closing = (async () => {
      let cancelError: unknown;
      let failed = false;
      try {
        this.cancel();
      } catch (error) {
        cancelError = error;
        failed = true;
      }
      await this.active?.catch(() => {});
      try {
        await this.adapter.close();
      } catch (error) {
        if (failed) {
          throw new AggregateError(
            [cancelError, error],
            'Agent cleanup failed',
          );
        }
        throw error;
      }
      if (failed) {
        throw cancelError;
      }
    })();
    return this.closing;
  }
}
