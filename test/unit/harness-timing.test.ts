import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout} from 'node:timers/promises';

import {ROOT_CONTEXT, type Tracer} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {startHarnessTiming} from '../../src/telemetry/harness-timing.js';

void test('harness timing ends once with monotonic SDK timing and explicit incomplete status', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  try {
    const finish = startHarnessTiming({
      tracer: provider.getTracer('test'),
      parentContext: ROOT_CONTEXT,
      workflowName: 'w',
      workflowExecutionId: 'r',
      agentName: 'a',
      agentSessionId: 's',
      harness: 'codex',
      phase: 'startup',
      diagnostic: error => assert.fail(String(error)),
    });
    await setTimeout(25);
    finish('incomplete');
    finish('success');
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(
      spans[0]!.attributes['stratos.completion.status'],
      'incomplete',
    );
    assert.equal(
      spans[0]!.attributes['stratos.harness.ready_boundary'],
      'codex.turn.started',
    );
    assert.equal(spans[0]!.status.code, 0);
    assert.equal(
      spans[0]!.attributes['stratos.completion.reason'],
      'Native readiness was not observed',
    );
    const [seconds, nanos] = spans[0]!.duration;
    assert.ok(seconds * 1000 + nanos / 1e6 >= 20);
  } finally {
    await provider.shutdown();
  }
});

void test('harness timing and its diagnostics remain soft on observer failure', () => {
  const tracer: Tracer = {
    startSpan() {
      throw new Error('sensitive native error');
    },
    startActiveSpan() {
      throw new Error('unused');
    },
  };
  let diagnostics = 0;
  const finish = startHarnessTiming({
    tracer,
    parentContext: ROOT_CONTEXT,
    workflowName: 'w',
    workflowExecutionId: 'r',
    agentName: 'a',
    agentSessionId: 's',
    harness: 'codex',
    phase: 'initialize',
    diagnostic(error) {
      diagnostics++;
      assert(error instanceof Error);
      assert.equal(error.message, 'Harness timing telemetry failed');
      throw new Error('diagnostic failure');
    },
  });
  finish('error');
  finish('error');
  assert.equal(diagnostics, 1);
});

void test('harness timing still attempts end after status failure and never repeats a failed end', async () => {
  const provider = new BasicTracerProvider();
  try {
    const span = provider.getTracer('test').startSpan('fixture');
    let ends = 0;
    let diagnostics = 0;
    span.setAttribute = () => {
      throw new Error('status failure');
    };
    span.end = () => {
      ends++;
      throw new Error('end failure');
    };
    const tracer: Tracer = {
      startSpan: () => span,
      startActiveSpan() {
        throw new Error('unused');
      },
    };
    const finish = startHarnessTiming({
      tracer,
      parentContext: ROOT_CONTEXT,
      workflowName: 'w',
      workflowExecutionId: 'r',
      agentName: 'a',
      agentSessionId: 's',
      harness: 'codex',
      phase: 'initialize',
      diagnostic: () => {
        diagnostics++;
      },
    });
    finish('error');
    finish('success');
    assert.equal(ends, 1);
    assert.equal(diagnostics, 2);
  } finally {
    await provider.shutdown();
  }
});
