import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {z} from 'zod';

import {ollamaUrl} from '../../src/agents/ollama.js';
import {
  choice,
  noul,
  score,
  decision,
  workflow,
  type DecisionResult,
} from '../../src/index.js';
import {executeWorkflow} from '../../src/workflows/runtime.js';
import {isolateArtifacts} from '../helpers/artifacts.js';
import {traceSpans} from '../helpers/otlp.js';

const questions = {
  category: choice('What kind of request is this?', {
    bug: 'Existing functionality is broken',
    feature: 'New functionality is requested',
    other: 'Neither a bug report nor a feature request',
  }),
  severity: score('How severe is the reported problem?', [
    'Cosmetic issue; functionality works',
    'Broken functionality with an available workaround',
    'Blocked functionality with no available workaround',
  ]),
  hasWorkaround: noul(
    'Does the ticket explicitly describe an available workaround?',
  ),
};

void test(
  'live Ollama Decision: contract, telemetry and synthetic decision quality',
  {
    skip:
      !process.env.STRATOS_TEST_OLLAMA_MODEL &&
      'Opt in with STRATOS_TEST_OLLAMA_MODEL after pulling a decision model',
    timeout: 300000,
  },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'stratos-ollama-live-'));
    const requestedModel = process.env.STRATOS_TEST_OLLAMA_MODEL!;
    let drain: (() => Promise<void>) | undefined;
    let result: DecisionResult<typeof questions> | undefined;
    let contractPassed = false;
    let passed = false;
    t.after(async () => {
      try {
        await drain?.();
        const evidence = process.env.STRATOS_TEST_OLLAMA_EVIDENCE;
        if (evidence) {
          await mkdir(evidence, {recursive: true, mode: 0o700});
          const archive = await mkdtemp(join(evidence, 'ollama-'));
          await cp(directory, join(archive, 'run'), {recursive: true});
          await writeFile(
            join(archive, 'result.json'),
            JSON.stringify(
              {requestedModel, contractPassed, passed, result},
              null,
              2,
            ),
            {mode: 0o600},
          );
        }
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    });
    drain = await isolateArtifacts(t, join(directory, 'artifacts'));
    const baseUrl = process.env.STRATOS_TEST_OLLAMA_URL;
    const local = new URL(baseUrl ?? ollamaUrl());
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname),
      'Live test is local-only',
    );
    const state = {
      ticket:
        'PDF export crashes. CSV export still works. I can use CSV for now.',
      environment: {browser: 'Safari', os: 'macOS'},
    };
    await executeWorkflow(
      workflow({
        input: z.strictObject({}),
        output: z.strictObject({}),
        async run() {
          result = await decision({
            configId: 'decision',
            state,
            questions,
          });
          return {};
        },
      }),
      {},
      'ollama-live',
      directory,
      {
        name: 'ollama-live',
        shortDescription: 'Test fixture',
        longDescription: 'Exercise this test fixture with schema-valid input.',
        version: '1',
        entrypoint: 'workflow.ts',
        path: directory,
        root: directory,
        decision: {
          decision: {provider: 'ollama', model: requestedModel, baseUrl},
        },
        otel: {
          traces: {exporter: {type: 'file', path: join(directory, 'traces')}},
        },
      },
    );
    assert.ok(result);
    assert.equal(result.model, requestedModel);
    assert.deepEqual(result.answers.severity.legend, {
      '0': questions.severity.criteria[0],
      '1': questions.severity.criteria[1],
      '2': questions.severity.criteria[2],
    });
    assert.ok(result.usage.input_tokens > 0);
    assert.ok(result.usage.output_tokens >= 0);
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
    const model = spans.find(s => s.name === `decision ${requestedModel}`)!;
    const parent = spans.find(s => s.name === 'workflow ollama-live')!;
    assert.ok(model && parent);
    assert.equal(model.parentSpanId, parent.spanId);
    const attr = (key: string) =>
      model.attributes.find(a => a.key === key)?.value.stringValue;
    assert.equal(attr('gen_ai.provider.name'), 'ollama');
    assert.equal(attr('stratos.completion.status'), 'success');
    assert.deepEqual(JSON.parse(attr('input.value')!), {state, questions});
    assert.deepEqual(JSON.parse(attr('output.value')!), result.answers);
    contractPassed = true;
    t.diagnostic(JSON.stringify({requestedModel, result}));
    // Keep semantic failures visible after verifying transport and telemetry.
    assert.equal(result.answers.category.choice, 'bug');
    assert.ok(result.answers.hasWorkaround.noul >= 0.5);
    const severity = result.answers.severity.probabilities;
    assert.ok(severity['1'] > severity['0'] && severity['1'] > severity['2']);
    passed = true;
  },
);
