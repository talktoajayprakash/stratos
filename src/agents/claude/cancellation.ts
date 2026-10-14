/** Internal Claude control protocol integration; not a public Agent API. */
type QueryControls = {
  interrupt(): Promise<unknown>;
  stopTask(taskId: string): Promise<void>;
};

type Event = {
  type: string;
  subtype?: string;
  tasks?: ReadonlyArray<{task_id: string}>;
  user_message_uuid?: string;
  user_message_uuids?: readonly string[];
};

/** One instance per persistent query. Feed every SDK event into observe(). */
export class ClaudeCancellation {
  private tasks = new Set<string>();
  private turnActive = false;
  private nativeTurnActive = false;
  private promptId: string | undefined;
  private wake: (() => void) | undefined;
  private pending: Promise<void> | undefined;
  private streamError: Error | undefined;

  constructor(private readonly query: QueryControls) {}

  beginTurn(promptId?: string): void {
    if (this.pending) {
      throw new Error('Claude cancellation is still in progress');
    }
    if (this.streamError) {
      throw this.streamError;
    }
    if (this.turnActive) {
      throw new Error('Claude turn is already active');
    }
    this.turnActive = true;
    this.promptId = promptId;
  }

  beginNativeTurn(): void {
    this.nativeTurnActive = true;
  }

  observe(event: Event): void {
    // Snapshot events are authoritative. Do not combine them with task_started /
    // task_notification edges: the SDK does not guarantee their relative order.
    if (
      event.type === 'system' &&
      event.subtype === 'background_tasks_changed'
    ) {
      this.tasks = new Set(event.tasks?.map(task => task.task_id) ?? []);
    }
    if (event.type === 'result') {
      this.nativeTurnActive = false;
    }
    if (
      event.type === 'result' &&
      (this.promptId === undefined ||
        event.user_message_uuid === this.promptId ||
        event.user_message_uuids?.includes(this.promptId))
    ) {
      this.turnActive = false;
    }
    this.wake?.();
  }

  streamClosed(error = new Error('Claude event stream closed')): void {
    this.streamError = error;
    this.wake?.();
  }

  /** Internal completion promise. Public cancel() remains a synchronous signal.
   * The owner supplies an abort signal if it needs to bound cleanup waiting;
   * aborting the wait does not claim the native tasks have stopped.
   */
  cancel(signal?: AbortSignal): Promise<void> {
    if (this.pending) {
      return this.pending;
    }
    this.pending = this.stopAll(signal).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async stopAll(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const errors: unknown[] = [];
    const requested = new Set<string>();
    // Native notification turns can run without a submitted execute call.
    if (this.turnActive || this.nativeTurnActive) {
      try {
        await this.query.interrupt();
      } catch (error) {
        errors.push(error);
      }
    }
    for (;;) {
      signal?.throwIfAborted();
      if (this.streamError) {
        throw this.streamError;
      }
      const ids = [...this.tasks].filter(id => !requested.has(id));
      if (ids.length) {
        for (const id of ids) {
          requested.add(id);
        }
        const results = await Promise.allSettled(
          ids.map(id => this.query.stopTask(id)),
        );
        for (const result of results) {
          if (result.status === 'rejected') {
            errors.push(result.reason);
          }
        }
        // Process tasks that appeared while these requests were in flight too.
        continue;
      }
      if (errors.length) {
        throw new AggregateError(errors, 'Claude cancellation failed');
      }
      if (!this.turnActive && !this.nativeTurnActive && this.tasks.size === 0) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal?.removeEventListener('abort', abort);
          this.wake = undefined;
          resolve();
        };
        const abort = () => {
          this.wake = undefined;
          reject(signal?.reason);
        };
        this.wake = finish;
        signal?.addEventListener('abort', abort, {once: true});
      });
    }
  }
}
