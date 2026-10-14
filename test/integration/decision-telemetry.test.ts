import assert from 'node:assert/strict';
import '../helpers/home.js';
import {once} from 'node:events';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {setTimeout as pause} from 'node:timers/promises';

import {z} from 'zod';

import {choice, score, noul, decision, workflow} from '../../src/index.js';
import type {WorkflowMetadata} from '../../src/workflows/discovery.js';
import {executeWorkflow, getContext} from '../../src/workflows/runtime.js';

const attributes = z
  .array(
    z.object({
      key: z.string(),
      value: z.object({
        stringValue: z.string().optional(),
        intValue: z.union([z.string(), z.number()]).optional(),
      }),
    }),
  )
  .transform(entries =>
    Object.fromEntries(
      entries.map(entry => [
        entry.key,
        entry.value.stringValue ?? entry.value.intValue,
      ]),
    ),
  );
const spanSchema = z.object({
  name: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  startTimeUnixNano: z.string(),
  endTimeUnixNano: z.string(),
  attributes,
  status: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
  }),
  events: z.array(z.object({name: z.string(), attributes})).default([]),
});
const payloadSchema = z.object({
  resourceSpans: z.array(
    z.object({
      scopeSpans: z.array(z.object({spans: z.array(spanSchema)})),
    }),
  ),
});

async function readSpans(directory: string) {
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const text = await readFile(join(directory, files[0]!), 'utf8');
  return {
    text,
    spans: text
      .trim()
      .split('\n')
      .flatMap(line =>
        payloadSchema
          .parse(JSON.parse(line))
          .resourceSpans.flatMap(resource =>
            resource.scopeSpans.flatMap(scope => scope.spans),
          ),
      ),
  };
}

void test('Decision exports structured decisions, elapsed invocation time, usage and completion outcomes', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'stratos-decision-telemetry-'),
  );
  t.after(() => rm(directory, {recursive: true, force: true}));
  const secret = 'decision-telemetry-fixture-key';
  const keyFile = join(directory, 'credential');
  await writeFile(keyFile, secret, {mode: 0o600});
  const state = {
    ticket: 'PDF export crashes; CSV works',
    context: ['text', {value: 4}],
    apiKey: 'redact-by-name',
    note: secret,
  };
  const questions = {
    category: choice('What kind of request?', {
      bug: 'Broken behavior',
      feature: 'New behavior',
    }),
    severity: score('Impact?', [
      'Cosmetic',
      {description: 'Broken with workaround', note: secret},
    ]),
    workaround: noul('Is a workaround available?'),
  };
  const answers = {
    category: {
      type: 'choice',
      choice: 'bug',
      confidence: 0.8,
      probabilities: {bug: 0.9, feature: 0.1},
    },
    severity: {
      type: 'score',
      score: 0.75,
      confidence: 0.7,
      probabilities: {'0': 0.25, '1': 0.75},
      legend: {
        '0': 'Cosmetic',
        '1': {description: 'Broken with workaround', note: secret},
      },
    },
    workaround: {type: 'noul', noul: 0.8},
  };
  let mode = 'success';
  let calls = 0;
  const server = createServer(async (request, response) => {
    calls++;
    for await (const chunk of request) {
      /* Drain the request before controlled response handling. */
      void chunk;
    }
    if (mode === 'cancelled') {
      return;
    }
    if (mode === 'retry' && calls === 1) {
      response.writeHead(503).end();
      return;
    }
    if (mode === 'error') {
      response.writeHead(401).end(secret);
      return;
    }
    await pause(40);
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        model: 'resolved-model',
        answers: mode === 'malformed' ? {} : answers,
        usage: {input_tokens: 13, output_tokens: 7},
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const settings = {
    model: 'requested-model',
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: `{file:${keyFile}}`,
  };

  for (const outcome of [
    'success',
    'retry',
    'error',
    'malformed',
    'cancelled',
  ]) {
    await t.test(outcome, async () => {
      mode = outcome;
      calls = 0;
      const destination = join(directory, outcome);
      const metadata: WorkflowMetadata = {
        name: outcome,
        shortDescription: 'Test fixture',
        longDescription: 'Exercise this test fixture with schema-valid input.',
        version: '1',
        entrypoint: 'workflow.ts',
        path: directory,
        root: directory,
        otel: {traces: {exporter: {type: 'file', path: destination}}},
      };
      await executeWorkflow(
        workflow({
          input: z.strictObject({}),
          output: z.strictObject({}),
          async run() {
            const pending = decision({...settings, state, questions});
            if (outcome === 'cancelled') {
              const rejected = assert.rejects(pending, /cancelled/);
              await once(server, 'request');
              await Promise.all(
                [...getContext().resources].map(resource => resource.close()),
              );
              await rejected;
            } else if (outcome === 'error' || outcome === 'malformed') {
              await assert.rejects(
                pending,
                outcome === 'error' ? /HTTP 401/ : /answer keys/,
              );
            } else {
              const result = await pending;
              assert.deepEqual(
                result.answers,
                answers,
                'Telemetry must not alter returned provider values',
              );
            }
            return {};
          },
        }),
        {},
        outcome,
        directory,
        metadata,
      );

      const {text, spans} = await readSpans(destination);
      assert.equal(spans.length, 2);
      const model = spans.find(
        span => span.name === 'decision requested-model',
      )!;
      const parent = spans.find(span => span.name === `workflow ${outcome}`)!;
      assert.equal(model.parentSpanId, parent.spanId);
      assert.equal(
        parent.status.code,
        1,
        'Caught failures and cancellation must not fail the workflow',
      );
      const attrs = model.attributes;
      const expectedInput = JSON.parse(
        JSON.stringify({state, questions})
          .replaceAll(secret, '[redacted]')
          .replaceAll('redact-by-name', '[redacted]'),
      );
      assert.deepEqual(JSON.parse(String(attrs['input.value'])), expectedInput);
      assert.equal(attrs['input.value'], attrs['stratos.decision.input']);
      assert.equal(attrs['input.mime_type'], 'application/json');
      assert.equal(attrs['openinference.span.kind'], 'LLM');
      assert.equal(
        attrs['gen_ai.input.messages'],
        undefined,
        'A structured decision is not a chat conversation',
      );
      assert.equal(attrs['gen_ai.request.model'], 'requested-model');
      assert.equal(
        attrs['stratos.workflow.execution.id'],
        parent.attributes['stratos.workflow.execution.id'],
      );
      assert.match(String(attrs['stratos.timing.scope']), /retry waits/);
      assert.ok(!text.includes(secret) && !text.includes('redact-by-name'));
      const durationMs =
        Number(
          BigInt(model.endTimeUnixNano) - BigInt(model.startTimeUnixNano),
        ) / 1e6;
      assert.ok(durationMs >= 0);
      if (outcome === 'success' || outcome === 'retry') {
        assert.equal(calls, outcome === 'retry' ? 2 : 1);
        assert.ok(
          durationMs >= (outcome === 'retry' ? 1000 : 30),
          'Duration must include the controlled response delay and retry wait',
        );
        assert.deepEqual(
          JSON.parse(String(attrs['output.value'])),
          JSON.parse(JSON.stringify(answers).replaceAll(secret, '[redacted]')),
        );
        assert.equal(attrs['output.value'], attrs['stratos.decision.output']);
        assert.equal(attrs['output.mime_type'], 'application/json');
        assert.equal(attrs['gen_ai.response.model'], 'resolved-model');
        assert.equal(Number(attrs['gen_ai.usage.input_tokens']), 13);
        assert.equal(Number(attrs['gen_ai.usage.output_tokens']), 7);
        assert.equal(attrs['stratos.completion.status'], 'success');
        assert.equal(model.status.code, 1);
      } else {
        assert.equal(
          calls,
          1,
          'Cancellation and non-transient/validation failures must not retry',
        );
        assert.equal(attrs['output.value'], undefined);
        assert.equal(
          attrs['gen_ai.usage.input_tokens'],
          undefined,
          'Do not invent usage for a failed invocation',
        );
        if (outcome === 'cancelled') {
          assert.equal(attrs['stratos.completion.status'], 'cancelled');
          assert.match(String(attrs['stratos.completion.reason']), /cancelled/);
          assert.notEqual(model.status.code, 2);
          assert.equal(model.events.length, 0);
        } else {
          assert.equal(attrs['stratos.completion.status'], 'error');
          assert.equal(model.status.code, 2);
          assert.equal(attrs['error.type'], 'Error');
          assert.equal(model.events[0]?.name, 'exception');
          assert.match(
            String(model.events[0]?.attributes['exception.message']),
            outcome === 'error' ? /HTTP 401/ : /answer keys/,
          );
        }
      }
    });
  }
});
