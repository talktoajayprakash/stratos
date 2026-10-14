import assert from 'node:assert/strict';
import '../helpers/home.js';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {z} from 'zod';

import {createAgentWithAdapters} from '../../src/agents/agent.js';
import {workflow} from '../../src/index.js';
import {executeWorkflow} from '../../src/workflows/runtime.js';
import {traceSpans} from '../helpers/otlp.js';

for (const outcome of [
  'success',
  'preflight-error',
  'preflight-cancelled',
  'unavailable',
  'initialize-error',
  'cancelled',
] as const) {
  void test(`harness timing records ${outcome} without changing execution or reuse`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'stratos-harness-timing-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const traces = join(directory, 'traces');
    let preflights = 0;
    let initializations = 0;
    let turns = 0;
    const definition = workflow({
      input: z.strictObject({}),
      output: z.strictObject({}),
      async run() {
        const agent = createAgentWithAdapters(
          {harness: 'codex', provider: 'azure', model: ['openai/gpt-6-astra']},
          {
            async preflight() {
              preflights++;
              if (outcome === 'preflight-error') {
                throw new Error('private-native-detail');
              }
              if (outcome === 'preflight-cancelled') {
                agent.cancel();
                throw new Error('private-cancel-detail');
              }
              if (outcome === 'unavailable') {
                return {
                  available: false,
                  reason: 'harness-missing',
                  error: new Error('missing'),
                };
              }
              return {
                available: true,
                catalogs: [
                  {
                    provider: 'azure',
                    source: 'fixture',
                    modelIds: ['gpt-6-astra'],
                    complete: true,
                  },
                ],
              };
            },
            createAdapter(settings) {
              return {
                async initialize() {
                  initializations++;
                  if (outcome === 'initialize-error') {
                    throw new Error('private-native-detail');
                  }
                  if (outcome === 'cancelled') {
                    agent.cancel();
                    throw new Error('private-cancel-detail');
                  }
                },
                async execute() {
                  turns++;
                  assert.equal(settings.harness, 'codex');
                  const finish = settings.options.onStartup?.();
                  finish?.('success');
                  return 'OK';
                },
                cancel() {},
                async close() {},
              };
            },
          },
        );
        if (outcome === 'success') {
          assert.equal(await agent.execute('first'), 'OK');
          assert.equal(await agent.execute('second'), 'OK');
        } else {
          await assert.rejects(agent.execute('first'));
        }
        return {};
      },
    });
    await executeWorkflow(definition, {}, 'timing', directory, {
      name: 'timing',
      shortDescription: 'Test fixture',
      longDescription: 'Exercise this test fixture with schema-valid input.',
      version: '1',
      entrypoint: 'workflow.ts',
      path: directory,
      root: directory,
      otel: {traces: {exporter: {type: 'file', path: traces}}},
    });
    const spans = (
      await Promise.all(
        (await readdir(traces)).map(async file =>
          (await readFile(join(traces, file), 'utf8'))
            .trim()
            .split('\n')
            .flatMap(line => traceSpans(JSON.parse(line))),
        ),
      )
    ).flat();
    const attribute = (span: (typeof spans)[number], key: string) =>
      span.attributes.find(a => a.key === key)?.value.stringValue;
    const preparation = spans.filter(s => s.name.startsWith('harness.'));
    const parent = spans.find(s => s.name === 'workflow timing')!;
    const agents = spans.filter(s => s.name === 'invoke_agent agent');
    assert.equal(preflights, 1);
    assert.equal(
      initializations,
      outcome.startsWith('preflight-') || outcome === 'unavailable' ? 0 : 1,
    );
    assert.equal(turns, outcome === 'success' ? 2 : 0);
    assert.equal(
      preparation.length,
      outcome === 'success' ? 4 : initializations + 1,
    );
    assert.equal(
      new Set(preparation.map(s => attribute(s, 'stratos.agent.session.id')))
        .size,
      1,
    );
    assert.ok(preparation.every(s => s.traceId === parent.traceId));
    assert.ok(
      preparation.every(s => attribute(s, 'gen_ai.provider.name') === 'azure'),
    );
    for (const span of preparation) {
      if (span.name === 'harness.startup codex') {
        assert.ok(agents.some(a => a.spanId === span.parentSpanId));
      } else {
        assert.equal(span.parentSpanId, parent.spanId);
      }
      const terminal: string =
        span.name === 'harness.initialize codex'
          ? outcome
          : span.name === 'harness.preflight codex' && !initializations
            ? outcome
            : 'success';
      const status: string = terminal.endsWith('-error')
        ? 'error'
        : terminal.endsWith('cancelled')
          ? 'cancelled'
          : terminal;
      assert.equal(attribute(span, 'stratos.completion.status'), status);
      if (status === 'cancelled') {
        assert.equal(
          attribute(span, 'stratos.completion.reason'),
          'Agent execution cancelled',
        );
      }
      assert.equal(
        span.status.code,
        status === 'success' ? 1 : status === 'cancelled' ? 0 : 2,
      );
    }
    assert.ok(!JSON.stringify(preparation).includes('private-native-detail'));
    assert.ok(!JSON.stringify(preparation).includes('private-cancel-detail'));
  });
}
