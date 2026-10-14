import assert from 'node:assert/strict';
import '../helpers/home.js';
import {once} from 'node:events';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {z} from 'zod';

import {
  choice,
  noul,
  score,
  decision,
  workflow,
  type DecisionSettings,
} from '../../src/index.js';
import {
  executeWorkflow,
  type WorkflowOverrides,
} from '../../src/workflows/runtime.js';
import {traceSpans} from '../helpers/otlp.js';

const questions = {
  category: choice('What kind of issue?', {bug: 'Broken', feature: null}),
  severity: score('Impact?', ['Cosmetic', 'Blocked']),
  reproducible: noul('Are reproduction steps stated?'),
};
const answer = {
  model: 'fixture-resolved',
  usage: {input_tokens: 21, output_tokens: 3},
  answers: {
    category: {
      type: 'choice',
      choice: 'bug',
      probabilities: {bug: 0.8, feature: 0.8},
      confidence: 0.123,
    },
    severity: {
      type: 'score',
      score: 0.17,
      probabilities: {'0': 0.9, '1': 0.9},
      legend: {'0': 'Cosmetic', '1': 'Blocked'},
      confidence: 0.456,
    },
    reproducible: {type: 'noul', noul: 0.789},
  },
};

void test('Decision selects provider defaults without resolving or forwarding inherited Jev credentials to Ollama', async t => {
  const previousHost = process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_HOST;
  t.after(() => {
    if (previousHost === undefined) {
      delete process.env.OLLAMA_HOST;
    } else {
      process.env.OLLAMA_HOST = previousHost;
    }
  });
  const requests: Array<{
    url: string;
    authorization: string | null;
    body: unknown;
  }> = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    requests.push({
      url: url.href,
      authorization: new Headers(options.headers).get('authorization'),
      body: JSON.parse(String(options.body)),
    });
    return Response.json(answer);
  });
  const invoke = (settings: DecisionSettings) =>
    executeWorkflow(
      workflow({
        input: z.strictObject({}),
        output: z.strictObject({}),
        async run() {
          const result = await decision({
            ...settings,
            state: {synthetic: true},
            questions,
          });
          assert.deepEqual(result, answer);
          return {};
        },
      }),
      {},
      'provider-defaults',
      process.cwd(),
    );
  const unavailableKey = '{env:STRATOS_NONEXISTENT_JEV_PROVIDER_TEST_KEY}';
  await invoke({provider: 'ollama', model: 'nimble', apiKey: unavailableKey});
  await invoke({provider: 'ollama', model: 'clef'});
  assert.deepEqual(
    requests.map(r => [r.url, r.authorization]),
    [
      ['http://127.0.0.1:11434/v1/systemone', null],
      ['http://127.0.0.1:11434/v1/systemone', null],
    ],
  );
  assert.deepEqual(requests[0]!.body, {
    model: 'nimble',
    state: {synthetic: true},
    questions,
  });
  await assert.rejects(
    invoke({model: 'jev'}),
    /Jev provider requires an apiKey/,
  );
  await assert.rejects(
    invoke({model: 'jev', apiKey: unavailableKey}),
    /Missing or invalid/,
  );
  await assert.rejects(invoke({provider: 'unknown', model: 'nimble'}));
  for (const baseUrl of [
    'ftp://localhost',
    'http://user:password@localhost',
    'http://localhost/?key=private',
    'http://localhost/#fragment',
  ]) {
    await assert.rejects(
      invoke({provider: 'ollama', model: 'nimble', baseUrl}),
      /Invalid Decision baseUrl/,
    );
  }
  assert.equal(requests.length, 2);
  const previousKey = process.env.STRATOS_PROVIDER_DEFAULT_KEY;
  process.env.STRATOS_PROVIDER_DEFAULT_KEY = 'synthetic-provider-key';
  t.after(() => {
    if (previousKey === undefined) {
      delete process.env.STRATOS_PROVIDER_DEFAULT_KEY;
    } else {
      process.env.STRATOS_PROVIDER_DEFAULT_KEY = previousKey;
    }
  });
  process.env.OLLAMA_HOST = 'invalid://must-not-affect-jev';
  await invoke({model: 'jev', apiKey: '{env:STRATOS_PROVIDER_DEFAULT_KEY}'});
  assert.equal(requests[2]!.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(requests[2]!.authorization, 'Bearer synthetic-provider-key');
});

void test('Decision uses explicit baseUrl before OLLAMA_HOST and rejects invalid endpoints without fallback', async t => {
  const previousHost = process.env.OLLAMA_HOST;
  t.after(() => {
    if (previousHost === undefined) {
      delete process.env.OLLAMA_HOST;
    } else {
      process.env.OLLAMA_HOST = previousHost;
    }
  });
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    requests.push(url.href);
    assert.equal(new Headers(options.headers).get('authorization'), null);
    return Response.json(answer);
  });
  const invoke = (
    yaml: DecisionSettings = {},
    override: DecisionSettings = {},
    call: DecisionSettings = {},
  ) =>
    executeWorkflow(
      workflow({
        input: z.strictObject({}),
        output: z.strictObject({}),
        async run() {
          assert.deepEqual(
            await decision({
              configId: 'decision',
              ...call,
              state: 'synthetic',
              questions,
            }),
            answer,
          );
          return {};
        },
      }),
      {},
      'endpoint-precedence',
      process.cwd(),
      {
        name: 'endpoint-precedence',
        shortDescription: 'Test fixture',
        longDescription: 'Exercise this test fixture with schema-valid input.',
        version: '1',
        entrypoint: 'workflow.ts',
        path: process.cwd(),
        root: process.cwd(),
        decision: {decision: {provider: 'ollama', model: 'nimble', ...yaml}},
      },
      {decision: {decision: override}},
    );
  process.env.OLLAMA_HOST = 'http://127.0.0.1:12345';
  await invoke();
  process.env.OLLAMA_HOST = 'localhost:12346';
  await invoke();
  assert.deepEqual(requests, [
    'http://127.0.0.1:12345/v1/systemone',
    'http://localhost:12346/v1/systemone',
  ]);
  for (const host of [
    '',
    'not a host',
    'ftp://localhost',
    'http://secret@localhost',
    'http://localhost/prefix',
    'http://localhost/?key=secret',
    'http://localhost/#secret',
  ]) {
    process.env.OLLAMA_HOST = host;
    await assert.rejects(
      invoke(),
      error =>
        error instanceof Error &&
        /OLLAMA_HOST/.test(error.message) &&
        !error.message.includes('secret'),
    );
  }
  assert.equal(
    requests.length,
    2,
    'Invalid environment fails before any request',
  );
  const yaml = {baseUrl: 'http://yaml.invalid/prefix/'};
  const override = {baseUrl: 'http://override.invalid/prefix/'};
  const call = {baseUrl: 'http://call.invalid/prefix/'};
  await invoke(yaml);
  await invoke(yaml, override);
  await invoke(yaml, override, call);
  assert.deepEqual(requests.slice(2), [
    'http://yaml.invalid/prefix/v1/systemone',
    'http://override.invalid/prefix/v1/systemone',
    'http://call.invalid/prefix/v1/systemone',
  ]);
  process.env.OLLAMA_HOST = 'http://127.0.0.1:12345';
  await assert.rejects(invoke({baseUrl: ''}));
  await assert.rejects(
    invoke({baseUrl: 'ftp://invalid'}),
    /Invalid Decision baseUrl/,
  );
  assert.equal(
    requests.length,
    5,
    'Invalid explicit URL cannot fall back to the environment',
  );
});

void test('Decision swaps Jev and Ollama configuration field by field with unchanged answers and correct traces', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'stratos-decision-providers-'),
  );
  t.after(() => rm(directory, {recursive: true, force: true}));
  const requests: Array<{
    url: string | undefined;
    auth: string | undefined;
    model: string;
  }> = [];
  let malformed = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({
      url: req.url,
      auth: req.headers.authorization,
      model: JSON.parse(body).model,
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(malformed ? {...answer, answers: {}} : answer));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/prefix/`;
  const previousKey = process.env.STRATOS_PROVIDER_SWAP_KEY;
  process.env.STRATOS_PROVIDER_SWAP_KEY = 'synthetic-swap-key';
  t.after(() => {
    if (previousKey === undefined) {
      delete process.env.STRATOS_PROVIDER_SWAP_KEY;
    } else {
      process.env.STRATOS_PROVIDER_SWAP_KEY = previousKey;
    }
  });
  const config = {
    provider: 'jev',
    model: 'yaml-model',
    apiKey: '{env:STRATOS_PROVIDER_SWAP_KEY}',
  };
  const invoke = (
    name: string,
    call: DecisionSettings,
    overrides: WorkflowOverrides,
  ) =>
    executeWorkflow(
      workflow({
        input: z.strictObject({}),
        output: z.strictObject({}),
        async run() {
          const result = await decision({
            configId: 'decision',
            ...call,
            state: 'synthetic',
            questions,
          });
          assert.deepEqual(
            result,
            answer,
            'Do not normalize probabilities, confidence or scores',
          );
          return {};
        },
      }),
      {},
      name,
      directory,
      {
        name,
        shortDescription: 'Test fixture',
        longDescription: 'Exercise this test fixture with schema-valid input.',
        version: '1',
        entrypoint: 'workflow.ts',
        path: directory,
        root: directory,
        decision: {decision: config},
        otel: {
          traces: {exporter: {type: 'file', path: join(directory, 'traces')}},
        },
      },
      overrides,
    );

  await invoke(
    'ollama-override',
    {},
    {decision: {decision: {provider: 'ollama', model: 'nimble', baseUrl}}},
  );
  await invoke(
    'ollama-call',
    {provider: 'ollama', model: 'clef', baseUrl},
    {
      decision: {
        decision: {
          provider: 'jev',
          model: 'override-model',
          baseUrl: 'http://127.0.0.1:1',
        },
      },
    },
  );
  await invoke(
    'jev-call',
    {provider: 'jev'},
    {
      decision: {
        decision: {provider: 'ollama', model: 'override-model', baseUrl},
      },
    },
  );
  malformed = true;
  await assert.rejects(
    invoke('ollama-malformed', {provider: 'ollama', baseUrl}, {}),
    /answer keys/,
  );
  assert.deepEqual(requests, [
    {url: '/prefix/v1/systemone', auth: undefined, model: 'nimble'},
    {url: '/prefix/v1/systemone', auth: undefined, model: 'clef'},
    {
      url: '/prefix/v1/systemone',
      auth: 'Bearer synthetic-swap-key',
      model: 'override-model',
    },
    {url: '/prefix/v1/systemone', auth: undefined, model: 'yaml-model'},
  ]);
  const spans = (
    await Promise.all(
      (await readdir(join(directory, 'traces'))).map(async file =>
        (await readFile(join(directory, 'traces', file), 'utf8'))
          .trim()
          .split('\n')
          .flatMap(line => traceSpans(JSON.parse(line))),
      ),
    )
  ).flat();
  const attr = (span: (typeof spans)[number], key: string) =>
    span.attributes.find(a => a.key === key)?.value.stringValue;
  const models = spans.filter(s => s.name.startsWith('decision '));
  assert.equal(models.length, 4);
  for (const model of models) {
    const name = attr(model, 'stratos.workflow.name')!;
    const parent = spans.find(s => s.name === `workflow ${name}`);
    assert.equal(model.parentSpanId, parent?.spanId);
    assert.equal(
      attr(model, 'gen_ai.provider.name'),
      name.startsWith('ollama') ? 'ollama' : 'jev',
    );
    assert.equal(
      attr(model, 'stratos.completion.status'),
      name.endsWith('malformed') ? 'error' : 'success',
    );
    if (!name.endsWith('malformed')) {
      assert.deepEqual(
        JSON.parse(attr(model, 'output.value')!),
        answer.answers,
      );
      assert.equal(attr(model, 'gen_ai.response.model'), answer.model);
    }
  }
  assert.ok(!JSON.stringify(spans).includes('synthetic-swap-key'));
});
