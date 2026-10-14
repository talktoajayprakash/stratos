import assert from 'node:assert/strict';
import '../helpers/home.js';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {z} from 'zod';

import {mergeAgentSettings, renderPrompt} from '../../src/agents/config.js';
import {AgentPool} from '../../src/agents/pool.js';
import {createAgent, workflow} from '../../src/index.js';
import {executeWorkflow} from '../../src/workflows/runtime.js';

void test('configuration merges fields and template variables without mutating defaults', () => {
  const yaml = {
    model: ['a'],
    effort: 'low',
    templateVariables: {prompt: {first: 1, object: {a: 1, b: 2}}},
  };
  const result = mergeAgentSettings(
    yaml,
    {effort: 'high', templateVariables: {prompt: {second: 2}}},
    {model: ['b'], templateVariables: {prompt: {object: {a: 3}}}},
  );
  assert.deepEqual(result, {
    model: ['b'],
    effort: 'high',
    templateVariables: {prompt: {first: 1, second: 2, object: {a: 3}}},
  });
  assert.deepEqual(yaml.model, ['a']);
});
void test('prompt templates preserve text, require variables, and resolve at workflow root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stratos-prompts-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'prompt.hbs'), 'Review {{language}}: {{code}}');
  assert.equal(
    await renderPrompt({template: 'prompt.hbs'}, root, {
      language: 'TS',
      code: 'a < b',
    }),
    'Review TS: a < b',
  );
  assert.equal(
    await renderPrompt({file: 'prompt.hbs'}, root),
    'Review {{language}}: {{code}}',
  );
  await assert.rejects(
    renderPrompt({template: 'prompt.hbs'}, root, {language: 'TS'}),
  );
});
void test('public agents are lazy, reject overlapping/closed calls, and cancel queued preparation', async () => {
  assert.throws(
    () => createAgent({model: ['missing/model']}),
    /No active workflow/,
  );
  let saved: ReturnType<typeof createAgent> | undefined;
  const definition = workflow({
    input: z.strictObject({}),
    output: z.object({}),
    async run() {
      saved = createAgent({model: ['missing/model']});
      // No native harness is started while constructing an unused agent.
      const first = saved.execute('hello');
      await assert.rejects(saved.execute('overlap'), /sequential/);
      saved.cancel();
      await assert.rejects(first, /cancelled/);
      await assert.rejects(saved.execute('new request'), /No available/);
      return {};
    },
  });
  await executeWorkflow(definition, {}, 'test', process.cwd());
  await assert.rejects(saved!.execute('closed'), /closed workflow/);
});
void test('agent pool queues at capacity, rejects excess and releases cancelled waiters', async () => {
  const pool = new AgentPool(1, 2);
  const release = await pool.acquire(new AbortController().signal);
  const abort = new AbortController();
  const waiting = pool.acquire(abort.signal);
  await assert.rejects(
    pool.acquire(new AbortController().signal),
    /outstanding/,
  );
  abort.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/);
  let admitted = false;
  const next = pool.acquire(new AbortController().signal).then(done => {
    admitted = true;
    done();
  });

  void test('Ollama rejects unsupported reasoning overrides before native discovery', async () => {
    const definition = workflow({
      input: z.strictObject({}),
      output: z.strictObject({}),
      run() {
        assert.throws(
          () =>
            createAgent({
              provider: 'ollama',
              harness: 'opencode',
              model: ['gemma4:26b'],
              effort: 'low',
            }),
          /effort overrides are not supported/,
        );
        return {};
      },
    });
    await executeWorkflow(
      definition,
      {},
      'local-effort-validation',
      process.cwd(),
    );
  });
  assert.equal(admitted, false);
  release();
  await next;
  assert.equal(admitted, true);
});
