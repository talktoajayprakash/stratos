import assert from 'node:assert/strict';
import test from 'node:test';

import type {AgentAdapter} from '../../src/agents/adapter.js';
import {
  ModelUnavailableError,
  snapshotCatalog,
  type HarnessReadiness,
} from '../../src/agents/availability.js';
import {
  AgentSelection,
  type ReadyCandidate,
} from '../../src/agents/selection.js';
import type {HarnessId} from '../../src/models/candidates.js';

const gpt = 'openai/gpt-6-astra';
const second = 'openai/gpt-6-sol';
const claude = 'anthropic/claude-haiku-4-5';
const codex = {model: gpt, harness: 'codex' as const, provider: 'openai'};
const opencode = {...codex, harness: 'opencode' as const};
const unavailable = () =>
  new ModelUnavailableError('native structured model rejection');
function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
}
function ready(harness: HarnessId): HarnessReadiness {
  return {
    available: true,
    catalogs:
      harness === 'claude-code'
        ? [
            {
              provider: 'anthropic',
              source: 'fixture-partial',
              complete: false,
              modelIds: ['claude-haiku-4-5'],
            },
          ]
        : [
            {
              provider: 'openai',
              source: 'fixture-independent',
              complete: true,
              modelIds: ['gpt-6-astra', 'gpt-6-sol'],
            },
          ],
  };
}
function fixture(
  options: {
    models?: string[];
    harness?: HarnessId;
    provider?: string;
    preflight?: (
      harness: HarnessId,
      signal: AbortSignal,
      count: number,
    ) => Promise<HarnessReadiness> | HarnessReadiness;
    initialize?: (
      candidate: ReadyCandidate,
      progress: () => void,
    ) => Promise<void> | void;
    execute?: (
      candidate: ReadyCandidate,
      prompt: string,
      progress: () => void,
      turn: number,
    ) => Promise<unknown> | unknown;
    cancel?: (candidate: ReadyCandidate) => void;
    close?: (candidate: ReadyCandidate, count: number) => Promise<void> | void;
  } = {},
) {
  const preflights: HarnessId[] = [];
  const opens: ReadyCandidate[] = [];
  const lifecycle: string[] = [];
  const prompts: string[] = [];
  const callbacks: Array<() => void> = [];
  const pipeline = new AgentSelection({
    models: options.models ?? [gpt],
    harness: options.harness,
    provider: options.provider,
    async preflight(harness, signal) {
      preflights.push(harness);
      return options.preflight
        ? options.preflight(harness, signal, preflights.length)
        : ready(harness);
    },
    createAdapter(candidate, progress): AgentAdapter<unknown> {
      opens.push(candidate);
      callbacks.push(progress);
      let turns = 0;
      let closes = 0;
      return {
        async initialize() {
          lifecycle.push(`open:${candidate.harness}`);
          await options.initialize?.(candidate, progress);
        },
        async execute(prompt) {
          prompts.push(prompt);
          lifecycle.push(`execute:${candidate.harness}`);
          return options.execute
            ? options.execute(candidate, prompt, progress, ++turns)
            : prompt;
        },
        cancel() {
          lifecycle.push(`cancel:${candidate.harness}`);
          options.cancel?.(candidate);
        },
        async close() {
          lifecycle.push(`close:${candidate.harness}`);
          await options.close?.(candidate, ++closes);
        },
      };
    },
  });
  return {pipeline, preflights, opens, lifecycle, prompts, callbacks};
}

void test('discovery is inference-free, ordered, immutable and once per harness', async () => {
  const f = fixture({models: [gpt, claude, second]});
  await f.pipeline.initialize();
  assert.deepEqual(f.preflights, ['codex', 'claude-code', 'opencode']);
  assert.deepEqual(f.pipeline.candidates, [
    codex,
    {model: claude, provider: 'anthropic', harness: 'claude-code'},
    {...codex, model: second},
    opencode,
    {...opencode, model: second},
  ]);
  assert.equal(f.opens.length, 0);
  assert.ok(Object.isFrozen(f.pipeline.candidates));
  assert.ok(Object.isFrozen(f.pipeline.candidates[0]));
  await f.pipeline.initialize();
  assert.equal(f.preflights.length, 3);
  await f.pipeline.close();
});

void test('explicit Ollama harnesses select only installed native IDs without canonical mappings', async () => {
  for (const harness of ['codex', 'opencode'] as const) {
    const f = fixture({
      models: ['missing', 'team/custom', 'gemma4:26b'],
      provider: 'ollama',
      harness,
      preflight: () => ({
        available: true,
        catalogs: [
          {
            provider: 'ollama',
            source: 'ollama-fixture',
            complete: true,
            modelIds: ['team/custom:latest', 'gemma4:26b'],
          },
        ],
      }),
    });
    await f.pipeline.initialize();
    assert.deepEqual(f.preflights, [harness]);
    assert.deepEqual(f.pipeline.candidates, [
      {model: 'team/custom', provider: 'ollama', harness},
      {model: 'gemma4:26b', provider: 'ollama', harness},
    ]);
    assert.equal(f.pipeline.skipped[0]?.support?.status, 'not-listed');
    await f.pipeline.execute('first');
    await f.pipeline.execute('second');
    assert.equal(f.opens.length, 1);
    await f.pipeline.close();
  }
  for (const harness of [undefined, 'claude-code'] as const) {
    assert.throws(
      () => fixture({provider: 'ollama', models: ['gemma4:26b'], harness}),
      /explicit codex or opencode/,
    );
  }
  const unconfigured = fixture({models: ['gemma4:26b']});
  await assert.rejects(unconfigured.pipeline.initialize(), /No available/);
  assert.deepEqual(unconfigured.preflights, []);
  await unconfigured.pipeline.close();
});

void test('exact mapping and independent complete catalogs exclude candidates without opening them', async () => {
  const f = fixture({
    models: ['openai/invented', 'openai/gpt-5.6-sol', gpt],
    harness: 'codex',
  });
  await f.pipeline.initialize();
  assert.deepEqual(f.pipeline.candidates, [codex]);
  assert.deepEqual(
    f.pipeline.skipped.map(item => item.support?.status),
    ['missing-mapping', 'not-listed'],
  );
  assert.equal(await f.pipeline.execute('valid'), 'valid');
  assert.deepEqual(f.opens, [codex]);
  await f.pipeline.close();
});

void test('partial catalog absence remains visible, never a false definitive exclusion', async () => {
  const f = fixture({
    harness: 'codex',
    preflight: () => ({
      available: true,
      catalogs: [
        {provider: 'openai', source: 'partial', modelIds: [], complete: false},
      ],
    }),
  });
  await f.pipeline.initialize();
  assert.equal(f.pipeline.modelSupport[0]?.support.status, 'unknown');
  assert.deepEqual(f.pipeline.candidates, [codex]);
  await f.pipeline.close();
});

void test('catalog snapshots copy lists and require truthful, unique provenance', async () => {
  const modelIds = ['gpt-6-astra'];
  const catalog = {
    provider: 'openai',
    source: 'native',
    modelIds,
    complete: true,
  };
  const snapshot = snapshotCatalog(catalog);
  modelIds.push('injected');
  assert.deepEqual(snapshot.modelIds, ['gpt-6-astra']);
  assert.throws(() => snapshotCatalog({...catalog, source: ''}), TypeError);
  const f = fixture({
    preflight: () => ({available: true, catalogs: [catalog, catalog]}),
  });
  await assert.rejects(f.pipeline.initialize(), /Duplicate/);
  assert.equal(f.opens.length, 0);
  await f.pipeline.close();
});

void test('entirely unmapped requests fail without probing native tools or authentication', async () => {
  const f = fixture({models: ['unknown/no-model']});
  await assert.rejects(f.pipeline.initialize(), /No available/);
  assert.deepEqual(f.preflights, []);
  assert.equal(f.opens.length, 0);
  await f.pipeline.close();
});

void test('OpenCode preserves provider preference, explicit provider and ambiguity errors', async () => {
  const catalogs = [
    {
      provider: 'openai',
      source: 'fixture',
      modelIds: ['gpt-6-astra'],
      complete: true,
    },
    {
      provider: 'openrouter',
      source: 'fixture',
      modelIds: ['openai/gpt-6-astra'],
      complete: true,
    },
    {
      provider: 'azure',
      source: 'fixture',
      modelIds: ['gpt-6-astra'],
      complete: true,
    },
  ];
  for (const provider of [undefined, 'openai']) {
    const f = fixture({
      harness: 'opencode',
      provider,
      preflight: () => ({available: true, catalogs}),
    });
    await f.pipeline.initialize();
    assert.equal(f.pipeline.candidates[0]?.provider, provider ?? 'openrouter');
    await f.pipeline.close();
  }
  const f = fixture({
    harness: 'opencode',
    preflight: () => ({
      available: true,
      catalogs: catalogs.filter(catalog => catalog.provider !== 'openrouter'),
    }),
  });
  await assert.rejects(f.pipeline.initialize(), /Specify provider/);
  assert.equal(f.opens.length, 0);
  await f.pipeline.close();
});

for (const reason of ['harness-missing', 'authentication-missing'] as const) {
  void test(`${reason} skips all affected pairs but preserves the original cause`, async () => {
    const error = new Error(reason);
    const f = fixture({
      models: [gpt, second],
      preflight: harness =>
        harness === 'codex'
          ? {available: false, reason, error}
          : ready(harness),
    });
    await f.pipeline.initialize();
    assert.deepEqual(f.pipeline.candidates, [
      opencode,
      {...opencode, model: second},
    ]);
    assert.equal(f.pipeline.skipped.length, 2);
    assert.equal(f.pipeline.skipped[0]?.error, error);
    assert.equal(await f.pipeline.execute('prompt'), 'prompt');
    assert.deepEqual(f.opens, [opencode]);
    await f.pipeline.close();
  });
}

void test('preflight errors propagate unchanged; only a later invocation retries discovery', async () => {
  const failure = new Error('policy or malformed native metadata');
  const f = fixture({
    preflight: (harness, signal, count) => {
      if (count === 1) {
        throw failure;
      }
      return ready(harness);
    },
  });
  await assert.rejects(f.pipeline.execute('first'), error => error === failure);
  assert.equal(f.preflights.length, 1);
  assert.equal(f.opens.length, 0);
  assert.equal(await f.pipeline.execute('new prompt'), 'new prompt');
  assert.deepEqual(f.prompts, ['new prompt']);
  await f.pipeline.close();
});

void test('catalog-qualified model rejection closes before same-prompt fallback and pins success', async () => {
  const rejected = unavailable();
  const f = fixture({
    execute: (candidate, prompt, progress, turn) => {
      if (candidate.harness === 'codex') {
        throw rejected;
      }
      if (turn > 2) {
        throw unavailable();
      }
      return prompt;
    },
  });
  assert.equal(await f.pipeline.execute('unchanged'), 'unchanged');
  assert.deepEqual(f.lifecycle, [
    'open:codex',
    'execute:codex',
    'close:codex',
    'open:opencode',
    'execute:opencode',
  ]);
  assert.deepEqual(f.prompts, ['unchanged', 'unchanged']);
  assert.deepEqual(f.pipeline.selected, opencode);
  assert.equal(await f.pipeline.execute('follow-up'), 'follow-up');
  await assert.rejects(f.pipeline.execute('later'), ModelUnavailableError);
  assert.equal(f.opens.length, 2);
  assert.equal(f.preflights.length, 2);
  await f.pipeline.close();
});

for (const progressAt of ['initialize', 'execute'] as const) {
  void test(`progress at ${progressAt} prevents any execution fallback`, async () => {
    const error = unavailable();
    const f = fixture({
      initialize: (candidate, progress) => {
        if (progressAt === 'initialize') {
          progress();
        }
      },
      execute: (candidate, prompt, progress) => {
        if (progressAt === 'execute') {
          progress();
        }
        throw error;
      },
    });
    await assert.rejects(
      f.pipeline.execute('prompt'),
      failure => failure === error,
    );
    assert.equal(f.opens.length, 1);
    assert.deepEqual(f.pipeline.selected, codex);
    await f.pipeline.close();
  });
}

void test('error prose, names, statuses, auth failures and generic execution errors never authorize replay', async () => {
  for (const error of [
    new Error('model_not_found'),
    Object.assign(new Error('HTTP 404'), {statusCode: 404}),
    Object.assign(new Error('unavailable'), {name: 'ModelUnavailableError'}),
    new Error('invalid credentials'),
    new Error('rate limit'),
    new Error('network'),
  ]) {
    const f = fixture({
      execute: (candidate, prompt, progress, turn) => {
        if (turn === 1) {
          throw error;
        }
        return 'continued';
      },
    });
    await assert.rejects(
      f.pipeline.execute('first'),
      failure => failure === error,
    );
    assert.equal(await f.pipeline.execute('different'), 'continued');
    assert.deepEqual(f.prompts, ['first', 'different']);
    assert.equal(f.opens.length, 1);
    await f.pipeline.close();
  }
});

void test('required harness stays constrained and exhaustion retains every cause', async () => {
  const errors = [unavailable(), unavailable()];
  const f = fixture({
    models: [gpt, second],
    harness: 'codex',
    execute: candidate => {
      throw errors[candidate.model === gpt ? 0 : 1];
    },
  });
  await assert.rejects(f.pipeline.execute('first'), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, errors);
    return true;
  });
  assert.deepEqual(f.preflights, ['codex']);
  assert.equal(f.lifecycle.filter(item => item === 'close:codex').length, 2);
  assert.equal(f.pipeline.selected, undefined);
  await f.pipeline.close();
});

void test('cleanup failure stops selection and preserves both causes, including null-valued cleanup errors', async () => {
  const rejected = unavailable();
  const f = fixture({
    execute: () => {
      throw rejected;
    },
    close: (candidate, count) => {
      if (count === 1) {
        throw null;
      }
    },
  });
  await assert.rejects(f.pipeline.execute('first'), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [rejected, null]);
    return true;
  });
  await assert.rejects(f.pipeline.execute('must not replay'), AggregateError);
  assert.equal(f.opens.length, 1);
  assert.equal(f.prompts.length, 1);
  await f.pipeline.close();
});

void test('initialization failures clean partial resources and never auto-fallback', async () => {
  let first = true;
  const failure = new Error('native startup');
  const f = fixture({
    initialize: () => {
      if (first) {
        first = false;
        throw failure;
      }
    },
  });
  await assert.rejects(f.pipeline.execute('first'), error => error === failure);
  assert.deepEqual(f.lifecycle, ['open:codex', 'close:codex']);
  assert.equal(await f.pipeline.execute('new'), 'new');
  assert.deepEqual(f.prompts, ['new']);
  await f.pipeline.close();
});

void test('late rejected-resource progress cannot pin the next candidate', async () => {
  const f = fixture({
    execute: candidate => {
      if (candidate.harness === 'opencode') {
        f.callbacks[0]!();
      }
      throw unavailable();
    },
  });
  await assert.rejects(f.pipeline.execute('first'), AggregateError);
  assert.equal(f.pipeline.selected, undefined);
  assert.equal(f.lifecycle.filter(item => item.startsWith('close:')).length, 2);
  await f.pipeline.close();
});

void test('progress drained during candidate cleanup prevents fallback and a later implicit restart', async () => {
  const error = unavailable();
  const f = fixture({
    execute: () => {
      throw error;
    },
    close: async () => {
      await Promise.resolve();
      f.callbacks[0]!();
    },
  });
  await assert.rejects(
    f.pipeline.execute('first'),
    failure => failure === error,
  );
  assert.equal(f.opens.length, 1);
  await assert.rejects(
    f.pipeline.execute('must not restart'),
    failure => failure === error,
  );
  assert.equal(f.opens.length, 1);
  await f.pipeline.close();
});

void test('cancellation during failed-candidate cleanup prevents the next attempt', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel cleanup');
  const f = fixture({
    execute: () => {
      throw unavailable();
    },
    close: () => controller.abort(reason),
  });
  await assert.rejects(
    f.pipeline.execute('first', controller.signal),
    error => error === reason,
  );
  assert.equal(f.opens.length, 1);
  assert.equal(f.pipeline.selected, undefined);
  await f.pipeline.close();
});

void test('overlap rejection leaves the first invocation and its conversation intact', async () => {
  const started = gate();
  const done = gate<string>();
  const f = fixture({
    execute: async () => {
      started.resolve();
      return done.promise;
    },
  });
  const first = f.pipeline.execute('first');
  await started.promise;
  await assert.rejects(f.pipeline.execute('overlap'), /sequential/);
  assert.equal(
    f.lifecycle.some(item => item.startsWith('cancel:')),
    false,
  );
  done.resolve('OK');
  assert.equal(await first, 'OK');
  await f.pipeline.close();
});

void test('cancel before work starts opens nothing, then explicit retry works', async () => {
  const f = fixture();
  const first = f.pipeline.execute('first');
  f.pipeline.cancel();
  await assert.rejects(first, /cancelled/);
  assert.equal(f.preflights.length, 0);
  assert.equal(await f.pipeline.execute('new'), 'new');
  await f.pipeline.close();
});

void test('cancellation during discovery discards partial snapshots and retries only explicitly', async () => {
  let first = true;
  const started = gate();
  const f = fixture({
    preflight: async (harness, signal) => {
      if (first) {
        first = false;
        started.resolve();
        await new Promise<void>((resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        );
      }
      return ready(harness);
    },
  });
  const running = f.pipeline.execute('first');
  const rejection = assert.rejects(running, /cancelled/);
  await started.promise;
  f.pipeline.cancel();
  await rejection;
  assert.equal(f.pipeline.candidates.length, 0);
  assert.equal(f.opens.length, 0);
  assert.equal(await f.pipeline.execute('new'), 'new');
  await f.pipeline.close();
});

void test('cancellation during native initialize signals and cleans that resource without fallback', async () => {
  const started = gate();
  const stopped = gate();
  const f = fixture({
    initialize: async () => {
      started.resolve();
      await stopped.promise;
    },
    cancel: () => stopped.resolve(),
  });
  const controller = new AbortController();
  const reason = new Error('abort startup');
  const first = f.pipeline.execute('first', controller.signal);
  const rejection = assert.rejects(first, error => error === reason);
  await started.promise;
  controller.abort(reason);
  await rejection;
  assert.equal(f.opens.length, 1);
  assert.equal(f.prompts.length, 0);
  assert.ok(f.lifecycle.includes('close:codex'));
  await f.pipeline.close();
});

void test('cancelled execution retains the same native conversation for explicit continuation', async () => {
  const started = gate();
  const stopped = gate();
  const f = fixture({
    execute: async (candidate, prompt, progress, turn) => {
      if (turn === 1) {
        started.resolve();
        await stopped.promise;
        throw unavailable();
      }
      return prompt;
    },
    cancel: () => stopped.resolve(),
  });
  const first = f.pipeline.execute('first');
  const rejection = assert.rejects(first, /cancelled/);
  await started.promise;
  f.pipeline.cancel();
  await rejection;
  assert.equal(await f.pipeline.execute('new'), 'new');
  assert.deepEqual(f.prompts, ['first', 'new']);
  assert.deepEqual(f.pipeline.selected, codex);
  assert.equal(f.opens.length, 1);
  await f.pipeline.close();
});

void test('cancel callback exceptions are catchable, not unhandled abort-listener failures', async () => {
  const started = gate();
  const stopped = gate();
  const failure = new Error('native cancel failed');
  const f = fixture({
    execute: async () => {
      started.resolve();
      await stopped.promise;
      return 'late';
    },
    cancel: () => {
      stopped.resolve();
      throw failure;
    },
  });
  const controller = new AbortController();
  const reason = new Error('cancel');
  const first = f.pipeline.execute('first', controller.signal);
  const rejection = assert.rejects(first, error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.includes(failure));
    return true;
  });
  await started.promise;
  assert.doesNotThrow(() => controller.abort(reason));
  await rejection;
  assert.equal(f.opens.length, 1);
  await assert.rejects(f.pipeline.close(), failure);
});

void test('closing waits for owned operations and releases resources exactly once', async () => {
  const started = gate();
  const stopped = gate();
  const f = fixture({
    execute: async () => {
      started.resolve();
      await stopped.promise;
      return 'late';
    },
    cancel: () => stopped.resolve(),
  });
  const first = f.pipeline.execute('first');
  const rejection = assert.rejects(first, /closed|cancelled/);
  await started.promise;
  await f.pipeline.close();
  await rejection;
  await f.pipeline.close();
  assert.equal(f.lifecycle.filter(item => item === 'close:codex').length, 1);
  await assert.rejects(f.pipeline.execute('later'), /closed/);
  await assert.rejects(f.pipeline.initialize(), /closed/);
});

void test('closing during catalog discovery aborts the probe and never opens an adapter', async () => {
  const started = gate();
  const f = fixture({
    preflight: async (harness, signal) => {
      started.resolve();
      await new Promise<void>((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
      return ready(harness);
    },
  });
  const initializing = f.pipeline.initialize();
  const rejection = assert.rejects(initializing, /closed/);
  await started.promise;
  await f.pipeline.close();
  await rejection;
  assert.equal(f.opens.length, 0);
  assert.equal(f.pipeline.candidates.length, 0);
});

void test('background-only progress and cancellation stay with the established resource', async () => {
  const f = fixture();
  await f.pipeline.execute('first');
  f.callbacks[0]!();
  f.pipeline.cancel();
  assert.deepEqual(f.pipeline.selected, codex);
  assert.equal(f.lifecycle.filter(item => item === 'cancel:codex').length, 1);
  assert.equal(await f.pipeline.execute('follow-up'), 'follow-up');
  assert.equal(f.opens.length, 1);
  await f.pipeline.close();
});
