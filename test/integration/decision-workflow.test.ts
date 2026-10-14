import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {once} from 'node:events';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  readFile,
} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {z} from 'zod';

import {decision, noul, workflow} from '../../src/index.js';
import {PACKAGE_ROOT} from '../../src/paths.js';
import type {WorkflowMetadata} from '../../src/workflows/discovery.js';
import {executeWorkflow, getContext} from '../../src/workflows/runtime.js';
import {waitForRetention} from '../helpers/home.js';
import {ollamaFixture} from '../helpers/ollama.js';
import {traceSpans} from '../helpers/otlp.js';

const exec = promisify(execFile);

void test(
  'CLI builds and runs Decision against the same OLLAMA_HOST, including changed hosts and explicit prefixes',
  {timeout: 180000},
  async t => {
    const f = await ollamaFixture(t);
    const alternate = await ollamaFixture(t);
    const prefixed = await ollamaFixture(t, '/prefix');
    const response = {
      model: 'nimble',
      usage: {input_tokens: 3, output_tokens: 1},
      answers: {yes: {type: 'noul', noul: 0.75}},
    };
    for (const fixture of [f, alternate, prefixed]) {
      fixture.state.decisionResponse = response;
    }
    const cwd = await mkdtemp(join(tmpdir(), 'stratos-decision-host-'));
    t.after(async () => {
      try {
        await waitForRetention();
      } finally {
        await rm(cwd, {recursive: true, force: true});
      }
    });
    const dir = join(cwd, '.stratos/workflows/classify');
    await mkdir(dir, {recursive: true});
    const manifest = (baseUrl?: string) => `name: classify
shortDescription: Decision endpoint test
longDescription: Exercise this test fixture with schema-valid input.
version: "1"
decision:
  classifier:
    provider: ollama
    model: nimble
${baseUrl === undefined ? '' : `    baseUrl: ${baseUrl}\n`}`;
    await writeFile(join(dir, 'workflow.yaml'), manifest());
    await writeFile(
      join(dir, 'workflow.ts'),
      `import {workflow, decision, noul} from '@stratoscli/stratos'; import {z} from 'zod';
export default workflow({input:z.strictObject({}),output:z.strictObject({probability:z.number().describe('Probability')}),
async run(){const result=await decision({configId:'classifier',state:'Synthetic',questions:{yes:noul('Is it true?')}});return {probability:result.answers.yes.noul};}});`,
    );
    const call = (action: string, host: string) =>
      exec(
        process.execPath,
        [
          join(PACKAGE_ROOT, 'dist/src/cli/main.js'),
          action,
          'classify',
          '--json',
        ],
        {
          cwd,
          env: {...process.env, OLLAMA_HOST: host},
          signal: t.signal,
          timeout: 90000,
        },
      );
    for (const fixture of [f, alternate]) {
      const built = await call('build', fixture.url);
      assert.equal(JSON.parse(built.stdout).success, true);
      assert.ok(fixture.requests.some(r => r.path === '/api/tags'));
      assert.ok(
        !fixture.requests.some(r => r.path === '/v1/systemone'),
        'Build never runs decisions',
      );
      assert.deepEqual(
        JSON.parse((await call('run', fixture.url)).stdout).data,
        {probability: 0.75},
      );
      assert.equal(
        fixture.requests.filter(r => r.path === '/v1/systemone').length,
        1,
      );
    }
    delete alternate.models['nimble:latest'];
    await assert.rejects(call('build', alternate.url), error =>
      String((error as {stdout: string}).stdout).includes('not installed'),
    );
    const before = f.requests.length;
    for (const action of ['build', 'run']) {
      await assert.rejects(call(action, 'invalid://no-fallback'), error =>
        String((error as {stdout: string}).stdout).includes('OLLAMA_HOST'),
      );
    }
    assert.equal(f.requests.length, before);
    await writeFile(join(dir, 'workflow.yaml'), manifest(prefixed.url));
    await call('build', 'invalid://explicit-url-wins');
    assert.deepEqual(
      JSON.parse((await call('run', 'invalid://explicit-url-wins')).stdout)
        .data,
      {probability: 0.75},
    );
    assert.ok(prefixed.requests.some(r => r.path === '/prefix/api/tags'));
    assert.equal(
      prefixed.requests.filter(r => r.path === '/prefix/v1/systemone').length,
      1,
    );
    assert.ok(
      [f, alternate, prefixed].every(fixture =>
        fixture.requests.every(r => !r.authorization),
      ),
    );
  },
);

void test('installed workflow CLI executes Decision with overrides and preserves provider answers', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'stratos-decision-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const dir = join(cwd, '.stratos/workflows/classify');
  await mkdir(dir, {recursive: true});
  let calls = 0;
  let malformed = false;
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, '/v1/systemone');
    assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    let text = '';
    for await (const chunk of req) {
      text += chunk;
    }
    const input = JSON.parse(text);
    assert.equal(input.model, 'call-model');
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: 'returned-model',
        usage: {input_tokens: 12, output_tokens: 4},
        answers: malformed
          ? {}
          : {
              category: {
                type: 'choice',
                choice: 'a',
                confidence: 0.4,
                probabilities: {a: 0.8, b: 0.8},
              },
              severity: {
                type: 'score',
                score: 0.17,
                confidence: 0.3,
                probabilities: {'0': 0.9, '1': 0.9},
                legend: {'0': 'Low', '1': 'High'},
              },
              yes: {type: 'noul', noul: 0.7},
            },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  await writeFile(
    join(dir, 'workflow.yaml'),
    "name: classify\nshortDescription: Decision integration\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: '1'\ndecision:\n  classifier:\n    model: yaml-model\n    baseUrl: http://127.0.0.1:1\n    apiKey: '{env:STRATOS_TEST_JEV_KEY}'\n",
  );
  await writeFile(
    join(dir, 'workflow.ts'),
    `import { workflow, decision, choice, score, noul } from '@stratoscli/stratos'; import { z } from 'zod';
export default workflow({ input: z.strictObject({}), output: z.object({ score: z.number().describe(''), probability: z.number().describe(''), model: z.string().describe('') }), async run() {
 const result = await decision({ configId: 'classifier', model: 'call-model', state: { ticket: 'fixture' }, questions: { category: choice('', { a: null, b: null }), severity: score('', ['Low', 'High']), yes: noul('Yes?') } });
 return { score: result.answers.severity.score, probability: result.answers.category.probabilities.b, model: result.model };
} });`,
  );
  const call = () =>
    exec(
      process.execPath,
      [
        join(PACKAGE_ROOT, 'dist/src/cli/main.js'),
        'run',
        'classify',
        '--json',
        '--overrides',
        JSON.stringify({
          decision: {classifier: {model: 'override-model', baseUrl}},
        }),
      ],
      {cwd, env: {...process.env, STRATOS_TEST_JEV_KEY: 'fixture-secret'}},
    );
  const first = await call();
  assert.deepEqual(JSON.parse(first.stdout).data, {
    score: 0.17,
    probability: 0.8,
    model: 'returned-model',
  });
  assert.equal(calls, 1);
  malformed = true;
  await assert.rejects(
    call(),
    error =>
      !String((error as {stdout: string}).stdout).includes('fixture-secret') &&
      String((error as {stdout: string}).stdout).includes('answer keys'),
  );
  assert.equal(calls, 2, 'Malformed successful responses are not retried');
});

void test('Decision owns a child span and aborts with workflow resource cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stratos-decision-traces-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  process.env.STRATOS_TEST_DECISION = 'secret';
  t.after(() => {
    delete process.env.STRATOS_TEST_DECISION;
  });
  let hang = false;
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    if (!hang) {
      res.end(
        JSON.stringify({
          model: 'resolved',
          answers: {yes: {type: 'noul', noul: 0.6}},
          usage: {input_tokens: 5, output_tokens: 1},
        }),
      );
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const settings = {
    model: 'requested',
    baseUrl: `http://127.0.0.1:${(server.address() as {port: number}).port}`,
    apiKey: '{env:STRATOS_TEST_DECISION}',
  };
  await executeWorkflow(
    workflow({
      input: zEmpty(),
      output: zEmpty(),
      async run() {
        await decision({
          ...settings,
          state: 'state',
          questions: {yes: noul()},
        });
        return {};
      },
    }),
    {},
    'owner',
    process.cwd(),
    {
      name: 'owner',
      shortDescription: 'Test fixture',
      longDescription: 'Exercise this test fixture with schema-valid input.',
      version: '1',
      entrypoint: 'workflow.ts',
      path: directory,
      root: directory,
      otel: {traces: {exporter: {type: 'file', path: directory}}},
    } as WorkflowMetadata,
  );
  const payload = JSON.parse(
    (
      await readFile(join(directory, (await readdir(directory))[0]!), 'utf8')
    ).trim(),
  );
  const spans = traceSpans(payload);
  const child = spans.find(s => s.name === 'decision requested')!;
  const parent = spans.find(s => s.name === 'workflow owner')!;
  assert.equal(child.parentSpanId, parent.spanId);
  assert.equal(
    Number(
      child.attributes.find(a => a.key === 'gen_ai.usage.input_tokens')!.value
        .intValue,
    ),
    5,
  );
  assert.ok(!JSON.stringify(spans.map(s => s.attributes)).includes('secret'));
  hang = true;
  await executeWorkflow(
    workflow({
      input: zEmpty(),
      output: zEmpty(),
      async run() {
        const pending = decision({
          ...settings,
          state: 'state',
          questions: {yes: noul()},
        });
        const rejected = assert.rejects(pending, /cancelled/);
        await once(server, 'request');
        await Promise.all(
          [...getContext().resources].map(resource => resource.close()),
        );
        await rejected;
        return {};
      },
    }),
    {},
    'cancel-owner',
    process.cwd(),
  );
  assert.equal(calls, 2);
});
const zEmpty = () => z.strictObject({});

void test('Decision rejects missing credentials and unsafe files before connecting', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'stratos-jev-credentials-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const file = join(cwd, 'key');
  await writeFile(file, 'fixture-secret', {mode: 0o644});
  const invoke = (apiKey: string) =>
    executeWorkflow(
      workflow({
        input: zEmpty(),
        output: zEmpty(),
        async run() {
          await decision({
            model: 'jev',
            apiKey,
            baseUrl: 'http://127.0.0.1:1',
            state: '',
            questions: {yes: noul()},
          });
          return {};
        },
      }),
      {},
      'credential-test',
      cwd,
    );
  await assert.rejects(
    invoke('{env:STRATOS_MISSING_JEV_CREDENTIAL}'),
    /Missing or invalid/,
  );
  await assert.rejects(invoke('{file:key}'), /owner-only permissions/);
  await assert.rejects(
    invoke('literal-secret'),
    error => !String(error).includes('literal-secret'),
  );
});
