import assert from 'node:assert/strict';
import '../helpers/home.js';
import test from 'node:test';

import {z} from 'zod';

import type {AgentAdapter} from '../../src/agents/adapter.js';
import {createAgentWithAdapters} from '../../src/agents/agent.js';
import {ModelUnavailableError} from '../../src/agents/availability.js';
import type {createNativeAdapter} from '../../src/agents/native.js';
import {workflow} from '../../src/index.js';
import {executeWorkflow} from '../../src/workflows/runtime.js';

const model = 'openai/gpt-6-astra';
const textResult = z.object({result: z.string().describe('Agent result')});
const passedResult = z.object({
  result: z.boolean().describe('Scenario completed'),
});
type NativeOptions = Parameters<typeof createNativeAdapter>[0];
function fixture(create: (options: NativeOptions) => AgentAdapter<unknown>) {
  const lifecycle: string[] = [];
  const options: NativeOptions[] = [];
  return {
    lifecycle,
    options,
    adapters: {
      async preflight(harness: string) {
        lifecycle.push(`preflight:${harness}`);
        return {
          available: true as const,
          catalogs: [
            {
              provider: 'openai',
              source: 'independent-test-catalog',
              modelIds: ['gpt-6-astra', 'gpt-6-sol'],
              complete: true,
            },
          ],
        };
      },
      createAdapter(settings: NativeOptions) {
        lifecycle.push(`create:${settings.harness}`);
        options.push(settings);
        const adapter = create(settings);
        return {
          async initialize() {
            lifecycle.push(`initialize:${settings.harness}`);
            await adapter.initialize();
          },
          async execute(prompt: string) {
            lifecycle.push(`execute:${settings.harness}:${prompt}`);
            return adapter.execute(prompt);
          },
          cancel() {
            adapter.cancel();
          },
          async close() {
            lifecycle.push(`close:${settings.harness}`);
            await adapter.close();
          },
        };
      },
    },
  };
}
const idle = {async initialize() {}, cancel() {}, async close() {}};

void test('production agent composes discovery, identical-prompt fallback, hooks, output and owner cleanup', async () => {
  const hooks: string[] = [];
  let marker: string | undefined;
  const f = fixture(options => ({
    ...idle,
    async execute(prompt) {
      if (options.harness === 'codex') {
        throw new ModelUnavailableError('structured native model rejection');
      }
      if (marker === undefined) {
        marker = prompt;
        return 'OK';
      }
      return marker;
    },
  }));
  const definition = workflow({
    input: z.strictObject({}),
    output: textResult,
    async run() {
      const agent = createAgentWithAdapters(
        {
          model: ['openai/invented', model],
          systemPrompt: 'fixed instructions',
          hooks: {
            onStart: () => {
              hooks.push('start');
            },
            onComplete: () => {
              hooks.push('complete');
            },
            onError: () => {
              hooks.push('error');
            },
          },
        },
        f.adapters,
      );
      assert.deepEqual(f.lifecycle, []);
      assert.equal(await agent.execute('MARKER'), 'OK');
      return {result: await agent.execute('recall')};
    },
  });
  assert.deepEqual(
    await executeWorkflow(definition, {}, 'fallback', process.cwd()),
    {result: 'MARKER'},
  );
  assert.deepEqual(f.lifecycle, [
    'preflight:codex',
    'preflight:opencode',
    'create:codex',
    'initialize:codex',
    'execute:codex:MARKER',
    'close:codex',
    'create:opencode',
    'initialize:opencode',
    'execute:opencode:MARKER',
    'execute:opencode:recall',
    'close:opencode',
  ]);
  assert.deepEqual(hooks, ['start', 'complete', 'start', 'complete']);
  assert.ok(
    f.options.every(
      options =>
        options.canonicalModel === model &&
        options.options.systemPrompt === 'fixed instructions',
    ),
  );
});

void test('required harness cannot escape and onError sees aggregate native rejection causes', async () => {
  const failure = new ModelUnavailableError('rejected');
  let observed: unknown;
  const f = fixture(() => ({
    ...idle,
    async execute() {
      throw failure;
    },
  }));
  const definition = workflow({
    input: z.strictObject({}),
    output: passedResult,
    async run() {
      const agent = createAgentWithAdapters(
        {
          harness: 'codex',
          model: [model],
          hooks: {
            onError(error) {
              observed = error;
            },
          },
        },
        f.adapters,
      );
      await assert.rejects(agent.execute('first'), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [failure]);
        return true;
      });
      return {result: true};
    },
  });
  await executeWorkflow(definition, {}, 'required', process.cwd());
  assert.ok(observed instanceof AggregateError);
  assert.equal(f.options.length, 1);
  assert.deepEqual(
    f.lifecycle.filter(item => item.startsWith('preflight')),
    ['preflight:codex'],
  );
});

for (const progressed of [false, true]) {
  void test(`${progressed ? 'progress followed by model rejection' : 'generic native failure'} preserves the production conversation`, async () => {
    const failure = progressed
      ? new ModelUnavailableError('after output')
      : new Error('HTTP 401');
    let attempts = 0;
    const f = fixture(options => ({
      ...idle,
      async execute(prompt) {
        if (++attempts === 1) {
          if (progressed) {
            options.options.onProgress?.();
          }
          throw failure;
        }
        return prompt;
      },
    }));
    const definition = workflow({
      input: z.strictObject({}),
      output: textResult,
      async run() {
        const agent = createAgentWithAdapters({model: [model]}, f.adapters);
        await assert.rejects(
          agent.execute('first'),
          error => error === failure,
        );
        return {result: await agent.execute('new prompt')};
      },
    });
    assert.deepEqual(
      await executeWorkflow(definition, {}, 'continuation', process.cwd()),
      {result: 'new prompt'},
    );
    assert.equal(f.options.length, 1);
  });
}

void test('structured native output is validated on the selected attempt without another model call', async () => {
  let calls = 0;
  const f = fixture(() => ({
    ...idle,
    async execute() {
      calls++;
      return calls === 1 ? {value: 'wrong'} : {value: 42};
    },
  }));
  const definition = workflow({
    input: z.strictObject({}),
    output: z.object({result: z.number().describe('Structured result')}),
    async run() {
      const agent = createAgentWithAdapters(
        {model: [model], outputSchema: z.object({value: z.number()})},
        f.adapters,
      );
      await assert.rejects(agent.execute('first'), z.ZodError);
      return {result: (await agent.execute('new prompt')).value};
    },
  });
  assert.deepEqual(
    await executeWorkflow(definition, {}, 'structured', process.cwd()),
    {result: 42},
  );
  assert.equal(f.options.length, 1);
  assert.equal(calls, 2);
});

void test('empty text output cannot silently succeed or trigger execution fallback', async () => {
  const f = fixture(() => ({
    ...idle,
    async execute() {
      return '   ';
    },
  }));
  const definition = workflow({
    input: z.strictObject({}),
    output: passedResult,
    async run() {
      const agent = createAgentWithAdapters({model: [model]}, f.adapters);
      await assert.rejects(agent.execute('first'), /no text/);
      return {result: true};
    },
  });
  await executeWorkflow(definition, {}, 'empty', process.cwd());
  assert.equal(f.options.length, 1);
});

void test('native cleanup failure blocks fallback, while final owner cleanup remains soft', async () => {
  const failure = new ModelUnavailableError('rejected');
  const cleanup = new Error('close failed');
  let closes = 0;
  const f = fixture(() => ({
    ...idle,
    async execute() {
      throw failure;
    },
    async close() {
      if (++closes === 1) {
        throw cleanup;
      }
    },
  }));
  const definition = workflow({
    input: z.strictObject({}),
    output: passedResult,
    async run() {
      const agent = createAgentWithAdapters({model: [model]}, f.adapters);
      await assert.rejects(agent.execute('first'), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [failure, cleanup]);
        return true;
      });
      await assert.rejects(agent.execute('must not run'), AggregateError);
      return {result: true};
    },
  });
  await executeWorkflow(definition, {}, 'cleanup', process.cwd());
  assert.equal(f.options.length, 1);
  assert.equal(closes, 2);
});

void test('named configuration precedence is fixed across fallback and prompt-only config references', async () => {
  const f = fixture(() => ({
    ...idle,
    async execute(prompt) {
      return prompt;
    },
  }));
  const definition = workflow({
    input: z.strictObject({}),
    output: textResult,
    async run() {
      const agent = createAgentWithAdapters(
        {configId: 'worker', model: [model], systemPrompt: 'creation wins'},
        f.adapters,
      );
      await agent.execute('initial');
      return {result: await agent.execute({configId: 'request-only'})};
    },
  });
  const cwd = process.cwd();
  assert.deepEqual(
    await executeWorkflow(
      definition,
      {},
      'precedence',
      cwd,
      {
        path: cwd,
        root: cwd,
        name: 'precedence',
        shortDescription: 'Test fixture',
        longDescription: 'Exercise this test fixture with schema-valid input.',
        version: '1',
        entrypoint: 'workflow.ts',
        agents: {
          worker: {
            model: ['openai/gpt-6-sol'],
            systemPrompt: 'yaml',
            effort: 'low',
          },
          'request-only': {
            model: ['unrelated/model'],
            harness: 'claude-code',
            prompt: 'next',
            systemPrompt: 'must not leak',
          },
        },
      },
      {
        agents: {
          worker: {
            harness: 'codex',
            systemPrompt: 'invocation',
            effort: 'high',
          },
        },
      },
    ),
    {result: 'next'},
  );
  assert.deepEqual(
    f.lifecycle.filter(item => item.startsWith('preflight')),
    ['preflight:codex'],
  );
  assert.equal(f.options.length, 1);
  assert.equal(f.options[0]?.canonicalModel, model);
  assert.equal(f.options[0]?.options.systemPrompt, 'creation wins');
  assert.equal(f.options[0]?.options.effort, 'high');
});

void test('public cancellation is signal-only and resumes the same selected resource on an explicit next prompt', async () => {
  let started!: () => void;
  let finish!: () => void;
  const active = new Promise<void>(resolve => {
    started = resolve;
  });
  const stopped = new Promise<void>(resolve => {
    finish = resolve;
  });
  let turn = 0;
  const f = fixture(() => ({
    ...idle,
    cancel: () => finish(),
    async execute(prompt) {
      if (++turn === 1) {
        started();
        await stopped;
        throw new ModelUnavailableError('cancelled model error');
      }
      return prompt;
    },
  }));
  const definition = workflow({
    input: z.strictObject({}),
    output: textResult,
    async run() {
      const agent = createAgentWithAdapters({model: [model]}, f.adapters);
      const first = agent.execute('first');
      const rejection = assert.rejects(first, /cancelled/);
      await active;
      assert.equal(agent.cancel(), undefined);
      await rejection;
      return {result: await agent.execute('continue explicitly')};
    },
  });
  assert.deepEqual(
    await executeWorkflow(definition, {}, 'cancellation', process.cwd()),
    {result: 'continue explicitly'},
  );
  assert.equal(f.options.length, 1);
});
