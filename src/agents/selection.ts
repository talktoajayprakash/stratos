import type {AgentAdapter} from './adapter.js';
import {
  catalogSupport,
  ModelUnavailableError,
  snapshotCatalog,
  type HarnessReadiness,
  type ModelCatalog,
} from './availability.js';
import {
  modelCandidates,
  type HarnessId,
  type ModelCandidate,
} from '../models/candidates.js';
import {loadCatalog} from '../models/catalog.js';

export type ReadyCandidate = Readonly<ModelCandidate & {provider: string}>;
type Support = ReturnType<typeof catalogSupport>;
type Exclusion = Readonly<{
  pair: Readonly<ModelCandidate>;
  reason: string;
  error: Error;
  support?: Support;
}>;
type SelectionOptions = {
  models: readonly string[];
  harness?: HarnessId;
  provider?: string;
  preflight(harness: HarnessId, signal: AbortSignal): Promise<HarnessReadiness>;
  createAdapter(
    candidate: ReadyCandidate,
    onProgress: () => void,
  ): AgentAdapter<unknown>;
};
type Resource = {
  candidate: ReadyCandidate;
  adapter: AgentAdapter<unknown>;
  pinned: boolean;
};

/** Inference-free discovery, then first-turn selection. Never replays an established conversation. */
export class AgentSelection implements AgentAdapter<unknown> {
  private readonly pairs;
  private ready?: readonly ReadyCandidate[];
  private excluded: readonly Exclusion[] = [];
  private support: ReadonlyArray<
    Readonly<{pair: Readonly<ModelCandidate>; support: Support}>
  > = [];
  private initializing?: Promise<void>;
  private active?: Promise<unknown>;
  private operation?: AbortController;
  private current?: Resource;
  private cancellationAttached = false;
  private cleanupFailure?: unknown;
  private cleanupFailed = false;
  private replayBlocked = false;
  private replayFailure?: unknown;
  private closing?: Promise<void>;
  private closed = false;
  private readonly lifetime = new AbortController();

  constructor(private readonly options: SelectionOptions) {
    if (
      options.provider === 'ollama' &&
      options.harness !== 'codex' &&
      options.harness !== 'opencode'
    ) {
      throw new Error(
        'Ollama agents require an explicit codex or opencode harness',
      );
    }
    this.pairs = Object.freeze(
      modelCandidates(options.models, options.harness).map(pair =>
        Object.freeze(pair),
      ),
    );
  }

  get candidates() {
    return this.ready ?? Object.freeze([]);
  }
  get skipped() {
    return this.excluded;
  }
  get modelSupport() {
    return this.support;
  }
  get selected() {
    return this.current?.pinned ? this.current.candidate : undefined;
  }

  initialize(signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Agent selection is closed'));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (this.ready) {
      return Promise.resolve();
    }
    if (this.initializing) {
      return this.initializing;
    }
    const controller = new AbortController();
    this.operation = controller;
    const combined = AbortSignal.any([
      controller.signal,
      this.lifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    this.initializing = this.prepare(combined).finally(() => {
      this.initializing = undefined;
      if (this.operation === controller) {
        this.operation = undefined;
      }
    });
    return this.initializing;
  }

  private async prepare(signal: AbortSignal): Promise<void> {
    const readiness = new Map<HarnessId, HarnessReadiness>();
    const candidates: ReadyCandidate[] = [];
    const excluded: Exclusion[] = [];
    const support: Array<{pair: Readonly<ModelCandidate>; support: Support}> =
      [];
    for (const pair of this.pairs) {
      signal.throwIfAborted();
      if (
        this.options.provider !== 'ollama' &&
        !Object.hasOwn(loadCatalog().models.models, pair.model)
      ) {
        const decision = Object.freeze({
          eligible: false,
          status: 'missing-mapping',
          source: 'packaged-provider-mapping',
        } as const);
        support.push(Object.freeze({pair, support: decision}));
        excluded.push(
          Object.freeze({
            pair,
            reason: 'model-not-supported',
            support: decision,
            error: new Error(`No declared provider mapping for ${pair.model}`, {
              cause: decision,
            }),
          }),
        );
        continue;
      }
      if (!readiness.has(pair.harness)) {
        const result = await this.options.preflight(pair.harness, signal);
        signal.throwIfAborted();
        if (result?.available === true) {
          if (!Array.isArray(result.catalogs)) {
            throw new TypeError('Missing harness catalogs');
          }
          const catalogs = result.catalogs.map(snapshotCatalog);
          if (
            new Set(catalogs.map(catalog => catalog.provider)).size !==
            catalogs.length
          ) {
            throw new TypeError('Duplicate provider catalogs from harness');
          }
          readiness.set(pair.harness, {
            available: true,
            catalogs: Object.freeze(catalogs),
          });
        } else {
          if (
            result?.available !== false ||
            !(result.error instanceof Error) ||
            !['harness-missing', 'authentication-missing'].includes(
              result.reason,
            )
          ) {
            throw new TypeError('Invalid harness readiness result', {
              cause: result,
            });
          }
          readiness.set(pair.harness, result);
        }
      }
      const result = readiness.get(pair.harness)!;
      if (!result.available) {
        excluded.push(
          Object.freeze({pair, reason: result.reason, error: result.error}),
        );
        continue;
      }
      const catalog = this.providerCatalog(pair, result.catalogs);
      if (!catalog) {
        excluded.push(
          Object.freeze({
            pair,
            reason: 'provider-unavailable',
            error: new Error(
              `No available provider mapping for ${pair.model} through ${pair.harness}`,
            ),
          }),
        );
        continue;
      }
      const decision = Object.freeze(catalogSupport(pair, catalog));
      support.push(Object.freeze({pair, support: decision}));
      if (decision.eligible) {
        candidates.push(Object.freeze({...pair, provider: catalog.provider}));
      } else {
        excluded.push(
          Object.freeze({
            pair,
            reason: 'model-not-supported',
            support: decision,
            error: new Error(
              `${pair.harness}/${pair.model} excluded by catalog: ${decision.status}`,
              {cause: decision},
            ),
          }),
        );
      }
    }
    signal.throwIfAborted();
    this.excluded = Object.freeze(excluded);
    this.support = Object.freeze(support);
    if (!candidates.length) {
      throw new AggregateError(
        excluded.map(item => item.error),
        'No available harness/model candidate',
      );
    }
    this.ready = Object.freeze(candidates);
  }

  private providerCatalog(
    pair: ModelCandidate,
    catalogs: readonly ModelCatalog[],
  ): ModelCatalog | undefined {
    const requested =
      this.options.provider ??
      (pair.harness === 'codex'
        ? 'openai'
        : pair.harness === 'claude-code'
          ? 'anthropic'
          : undefined);
    if (requested) {
      return catalogs.find(catalog => catalog.provider === requested);
    }
    const supported = catalogs.filter(
      catalog =>
        loadCatalog().models.models[pair.model]?.[catalog.provider]?.length,
    );
    const openrouter = supported.find(
      catalog => catalog.provider === 'openrouter',
    );
    if (openrouter) {
      return openrouter;
    }
    if (supported.length > 1) {
      throw new Error(
        `Specify provider for ${pair.model}; configured candidates: ${supported.map(catalog => catalog.provider).join(', ')}`,
      );
    }
    return supported[0];
  }

  execute(prompt: string, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('Agent selection is closed'));
    }
    if (this.active) {
      return Promise.reject(new Error('Agent executions must be sequential'));
    }
    if (this.cleanupFailed) {
      return Promise.reject(this.cleanupFailure);
    }
    if (this.replayBlocked) {
      return Promise.reject(this.replayFailure);
    }
    const controller = new AbortController();
    this.operation = controller;
    const combined = AbortSignal.any([
      controller.signal,
      this.lifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    const pending = Promise.resolve()
      .then(async () => {
        await this.initialize(combined);
        this.operation = controller;
        combined.throwIfAborted();
        return this.run(prompt, combined);
      })
      .finally(() => {
        this.active = undefined;
        if (this.operation === controller) {
          this.operation = undefined;
        }
      });
    this.active = pending;
    return pending;
  }

  private async run(prompt: string, signal: AbortSignal): Promise<unknown> {
    if (this.current) {
      return this.executeCurrent(prompt, signal);
    }
    const failures = this.excluded.map(item => item.error);
    for (const candidate of this.ready!) {
      signal.throwIfAborted();
      let resource: Resource | undefined;
      const adapter = this.options.createAdapter(candidate, () => {
        if (resource && this.current === resource) {
          resource.pinned = true;
        }
      });
      resource = {candidate, adapter, pinned: false};
      this.current = resource;
      try {
        await this.cancellable(resource, signal, () => adapter.initialize());
      } catch (error) {
        await this.release(error);
        throw error;
      }
      try {
        return await this.executeCurrent(prompt, signal);
      } catch (error) {
        if (
          signal.aborted ||
          resource.pinned ||
          !(error instanceof ModelUnavailableError)
        ) {
          throw error;
        }
        failures.push(error);
        await this.release(error);
        if (resource.pinned) {
          // Cleanup may drain late output or tool events. This resource is now
          // closed, so neither fallback nor a later implicit restart is safe.
          this.replayBlocked = true;
          this.replayFailure = error;
          throw error;
        }
        signal.throwIfAborted();
      }
    }
    throw new AggregateError(
      failures,
      'All available harness/model candidates rejected the model',
    );
  }

  private async executeCurrent(
    prompt: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const resource = this.current!;
    try {
      const result = await this.cancellable(resource, signal, () =>
        resource.adapter.execute(prompt),
      );
      resource.pinned = true;
      return result;
    } catch (error) {
      if (signal.aborted || !(error instanceof ModelUnavailableError)) {
        resource.pinned = true;
      }
      if (signal.aborted) {
        if (error instanceof AggregateError) {
          if (error.errors.includes(signal.reason)) {
            throw error;
          }
          throw new AggregateError(
            [signal.reason, error],
            'Agent cancellation and native cleanup failed',
          );
        }
        throw signal.reason;
      }
      throw error;
    }
  }

  private async cancellable<T>(
    resource: Resource,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    let cancellationError: unknown;
    let cancellationFailed = false;
    const cancel = () => {
      resource.pinned = true;
      try {
        resource.adapter.cancel();
      } catch (error) {
        cancellationError = error;
        cancellationFailed = true;
      }
    };
    this.cancellationAttached = true;
    signal.addEventListener('abort', cancel, {once: true});
    try {
      signal.throwIfAborted();
      const value = await work();
      signal.throwIfAborted();
      return value;
    } catch (error) {
      if (cancellationFailed) {
        throw new AggregateError(
          [error, cancellationError],
          'Agent cancellation failed',
        );
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      this.cancellationAttached = false;
    }
  }

  cancel(): void {
    this.operation?.abort(new Error('Agent execution cancelled'));
    if (this.current && !this.cancellationAttached) {
      this.current.pinned = true;
      this.current.adapter.cancel();
    }
  }

  private async release(originalError?: unknown): Promise<void> {
    if (!this.current) {
      return;
    }
    try {
      await this.current.adapter.close();
    } catch (error) {
      this.current.pinned = true;
      this.cleanupFailed = true;
      this.cleanupFailure =
        originalError === undefined
          ? error
          : new AggregateError(
              [originalError, error],
              'Candidate cleanup failed',
            );
      throw this.cleanupFailure;
    }
    this.current = undefined;
    this.cleanupFailed = false;
    this.cleanupFailure = undefined;
  }

  close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    this.closed = true;
    this.closing = (async () => {
      this.lifetime.abort(new Error('Agent selection is closed'));
      let cancellationError: unknown;
      let cancellationFailed = false;
      try {
        this.cancel();
      } catch (error) {
        cancellationError = error;
        cancellationFailed = true;
      }
      await Promise.allSettled(
        [this.initializing, this.active].filter(value => value !== undefined),
      );
      try {
        await this.release();
      } catch (error) {
        if (cancellationFailed) {
          throw new AggregateError(
            [cancellationError, error],
            'Agent cleanup failed',
          );
        }
        throw error;
      }
      if (cancellationFailed) {
        throw cancellationError;
      }
    })();
    return this.closing;
  }
}
