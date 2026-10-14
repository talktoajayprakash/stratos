import assert from 'node:assert/strict';
import '../helpers/home.js';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {z} from 'zod';

import {createAgentWithAdapters} from '../../src/agents/agent.js';
import {ModelUnavailableError} from '../../src/agents/availability.js';
import type {AgentEventConsumer} from '../../src/agents/events.js';
import {workflow} from '../../src/index.js';
import {executeWorkflow} from '../../src/workflows/runtime.js';

const spanSchema = z.object({
  name: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  traceId: z.string(),
  attributes: z
    .array(
      z.object({
        key: z.string(),
        value: z.object({stringValue: z.string().optional()}),
      }),
    )
    .transform(entries =>
      Object.fromEntries(
        entries.map(entry => [entry.key, entry.value.stringValue]),
      ),
    ),
  status: z.object({code: z.number().optional()}),
});
const payloadSchema = z.object({
  resourceSpans: z.array(
    z.object({
      scopeSpans: z.array(z.object({spans: z.array(spanSchema)})),
    }),
  ),
});

void test('fallback attempts retain correct trace settings and reject late events from the discarded resource', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stratos-fallback-trace-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  let rejectedEvents: AgentEventConsumer | undefined;
  const definition = workflow({
    input: z.strictObject({}),
    output: z.object({result: z.string().describe('Agent result')}),
    async run() {
      const agent = createAgentWithAdapters(
        {model: ['openai/invented', 'openai/gpt-6-astra']},
        {
          async preflight() {
            return {
              available: true,
              catalogs: [
                {
                  provider: 'openai',
                  source: 'independent-fixture',
                  modelIds: ['gpt-6-astra'],
                  complete: true,
                },
              ],
            };
          },
          createAdapter(settings) {
            if (settings.harness === 'codex') {
              rejectedEvents = settings.options.onEvent;
            }
            return {
              async initialize() {},
              cancel() {},
              async close() {},
              async execute() {
                const {onEvent} = settings.options;
                await onEvent({
                  type: 'model.started',
                  timestamp: Date.now(),
                  modelCallId: 'same-native-id',
                  settings: {
                    model: settings.canonicalModel,
                    provider: settings.provider,
                  },
                });
                if (settings.harness === 'codex') {
                  const error = new ModelUnavailableError(
                    'controlled native model rejection',
                  );
                  await onEvent({
                    type: 'model.completed',
                    timestamp: Date.now(),
                    modelCallId: 'same-native-id',
                    error,
                  });
                  throw error;
                }
                await rejectedEvents?.({
                  type: 'tool.started',
                  timestamp: Date.now(),
                  toolCallId: 'late',
                  toolName: 'rejected-resource-late-event',
                  input: {},
                });
                await onEvent({
                  type: 'model.completed',
                  timestamp: Date.now(),
                  modelCallId: 'same-native-id',
                  output: [
                    {role: 'assistant', parts: [{type: 'text', content: 'OK'}]},
                  ],
                });
                return 'OK';
              },
            };
          },
        },
      );
      return {result: await agent.execute('unchanged prompt')};
    },
  });
  const traceDirectory = join(directory, 'traces');
  assert.deepEqual(
    await executeWorkflow(definition, {}, 'fallback', directory, {
      name: 'fallback',
      shortDescription: 'Test fixture',
      longDescription: 'Exercise this test fixture with schema-valid input.',
      version: '1',
      entrypoint: 'workflow.ts',
      path: directory,
      root: directory,
      otel: {traces: {exporter: {type: 'file', path: traceDirectory}}},
    }),
    {result: 'OK'},
  );
  const files = await readdir(traceDirectory);
  assert.equal(files.length, 1);
  const spans = (await readFile(join(traceDirectory, files[0]!), 'utf8'))
    .trim()
    .split('\n')
    .flatMap(line =>
      payloadSchema
        .parse(JSON.parse(line))
        .resourceSpans.flatMap(resource =>
          resource.scopeSpans.flatMap(scope => scope.spans),
        ),
    );
  const parent = spans.find(span => span.name === 'workflow fallback')!;
  const attempts = spans.filter(span => span.name === 'invoke_agent agent');
  assert.equal(attempts.length, 2);
  assert.ok(spans.every(span => span.traceId === parent.traceId));
  assert.ok(attempts.every(span => span.parentSpanId === parent.spanId));
  assert.deepEqual(
    attempts.map(span => span.status.code),
    [2, 0],
  );
  assert.equal(attempts[1]?.attributes['stratos.completion.status'], 'success');
  assert.deepEqual(
    attempts.map(
      span =>
        JSON.parse(span.attributes['stratos.agent.configuration']!).harness,
    ),
    ['codex', 'opencode'],
  );
  assert.ok(
    attempts.every(
      span => span.attributes['stratos.agent.input'] === 'unchanged prompt',
    ),
  );
  assert.equal(spans.filter(span => span.name.startsWith('chat ')).length, 2);
  assert.equal(
    spans.some(span => span.name.includes('rejected-resource-late-event')),
    false,
  );
});
