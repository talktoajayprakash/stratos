import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';

import {ROOT_CONTEXT, trace, SpanStatusCode} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import type {AgentEvent} from '../../src/agents/events.js';
import {AgentTrace} from '../../src/telemetry/agent-trace.js';

function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return {exporter, provider, tracer: provider.getTracer('stratos-test')};
}

void test('background spans outlive prompts, nest tools and tasks, and close only on observed completion', async t => {
  const {exporter, provider, tracer} = setup();
  t.after(() => provider.shutdown());
  const errors: unknown[] = [];
  const agent = new AgentTrace({
    tracer,
    parentContext: ROOT_CONTEXT,
    workflowName: 'w',
    workflowExecutionId: 'r',
    agentName: 'a',
    timestamp: 1000,
    input: 'p',
    diagnostic: e => errors.push(e),
  });
  agent.onEvent({type: 'background.started', timestamp: 1001, taskId: 'outer'});
  agent.onEvent({
    type: 'compaction.started',
    timestamp: 1001,
    compactionId: 'ongoing',
  });
  agent.finish({output: 'foreground done'}, 1002, true);
  agent.onEvent({
    type: 'background.started',
    timestamp: 1003,
    taskId: 'child',
    parentTaskId: 'outer',
  });
  agent.onEvent({
    type: 'tool.started',
    timestamp: 1004,
    toolCallId: 'tool',
    toolName: 'echo',
    input: {},
    parentTaskId: 'child',
  });
  agent.onEvent({type: 'tool.completed', timestamp: 1005, toolCallId: 'tool'});
  agent.onEvent({
    type: 'background.completed',
    timestamp: 1006,
    taskId: 'child',
    output: 'Done',
  });
  agent.onEvent({
    type: 'background.completed',
    timestamp: 1007,
    taskId: 'outer',
    cancelled: true,
  });
  agent.close(1008);
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  const outer = spans.find(s => s.attributes['stratos.task.id'] === 'outer')!;
  const child = spans.find(s => s.attributes['stratos.task.id'] === 'child')!;
  const tool = spans.find(s => s.name === 'execute_tool echo')!;
  assert.equal(spans.length, 5);
  assert.equal(
    spans.find(span => span.name === 'compaction')!.attributes[
      'stratos.completion.status'
    ],
    'incomplete',
  );
  assert.deepEqual(
    spans.find(span => span.name === 'compaction')!.endTime,
    [1, 8000000],
  );
  assert.equal(child.parentSpanContext?.spanId, outer.spanContext().spanId);
  assert.equal(tool.parentSpanContext?.spanId, child.spanContext().spanId);
  assert.equal(outer.attributes['stratos.completion.status'], 'cancelled');
  assert.equal(child.attributes['stratos.completion.status'], 'success');
  assert.deepEqual(errors, []);
});

void test('unobserved task completion is incomplete, not success; missing compaction start stays an event', async t => {
  const {exporter, provider, tracer} = setup();
  t.after(() => provider.shutdown());
  const agent = new AgentTrace({
    tracer,
    parentContext: ROOT_CONTEXT,
    workflowName: 'w',
    workflowExecutionId: 'r',
    agentName: 'a',
    timestamp: 1000,
    input: 'p',
    diagnostic: error => assert.fail(String(error)),
  });
  agent.onEvent({
    type: 'compaction.completed',
    timestamp: 1001,
    compactionId: 'no-start',
  });
  agent.onEvent({
    type: 'background.started',
    timestamp: 1002,
    taskId: 'unobserved',
  });
  agent.onEvent({
    type: 'background.completed',
    timestamp: 1002,
    taskId: 'no-start-failure',
    error: new Error('Native task failed before its start was observed'),
  });
  agent.finish({output: 'Done'}, 1003, true);
  agent.close(1004);
  agent.close(1005);
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 2);
  assert.equal(
    spans.find(s => s.name === 'background task')!.attributes[
      'stratos.completion.status'
    ],
    'incomplete',
  );
  const event = spans.find(s => s.name === 'invoke_agent a')!.events[0]!;
  assert.equal(event.name, 'compaction.completed');
  assert.equal(event.attributes?.['stratos.observation.missing_start'], true);
  const failure = spans.find(s => s.name === 'invoke_agent a')!.events[1]!;
  assert.match(
    String(failure.attributes?.['stratos.observation.error']),
    /Native task failed/,
  );
});

void test('HTTP-delivered events retain workflow/child/agent parentage across interleaved invocations', async t => {
  const {exporter, provider, tracer} = setup();
  t.after(() => provider.shutdown());
  const workflow = tracer.startSpan('workflow', {}, ROOT_CONTEXT);
  const rootContext = trace.setSpan(ROOT_CONTEXT, workflow);
  const child = tracer.startSpan('child workflow', {}, rootContext);
  const errors: unknown[] = [];
  const agents = [
    new AgentTrace({
      tracer,
      parentContext: rootContext,
      workflowName: 'parent',
      workflowExecutionId: 'run-1',
      agentName: 'parent-agent',
      timestamp: 1000,
      input: 'parent prompt',
      diagnostic: e => errors.push(e),
    }),
    new AgentTrace({
      tracer,
      parentContext: trace.setSpan(ROOT_CONTEXT, child),
      workflowName: 'child',
      workflowExecutionId: 'run-2',
      agentName: 'child-agent',
      timestamp: 1000,
      input: 'child prompt',
      systemPrompt: 'system',
      settings: {model: 'example', effort: 'high'},
      diagnostic: e => errors.push(e),
    }),
  ];
  const http = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const {agent, event} = JSON.parse(body) as {
      agent: number;
      event: AgentEvent;
    };
    agents[agent]!.onEvent(event);
    res.writeHead(204).end();
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>(resolve => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  );
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const send = (agent: number, event: AgentEvent) =>
    fetch(`http://127.0.0.1:${address.port}`, {
      method: 'POST',
      body: JSON.stringify({agent, event}),
    });
  // The same native tool ID in two agents must not collide.
  await Promise.all(
    [0, 1].map(agent =>
      send(agent, {
        type: 'tool.started',
        timestamp: 1010,
        toolCallId: 'tool-1',
        toolName: 'echo',
        input: {agent},
      }),
    ),
  );
  await send(1, {
    type: 'model.started',
    timestamp: 1011,
    modelCallId: 'model-1',
    input: [{role: 'user', parts: [{type: 'text', content: 'hello'}]}],
    settings: {model: 'example'},
    reconstructed: true,
  });
  await send(1, {
    type: 'tool.completed',
    timestamp: 1020,
    toolCallId: 'tool-1',
    output: 'child output',
  });
  await send(0, {
    type: 'tool.completed',
    timestamp: 1021,
    toolCallId: 'tool-1',
    output: 'parent output',
  });
  await send(1, {
    type: 'model.completed',
    timestamp: 1022,
    modelCallId: 'model-1',
    output: [{role: 'assistant', parts: [{type: 'text', content: 'done'}]}],
    usage: {inputTokens: 12, outputTokens: 3},
  });
  agents.forEach(agent => agent.finish({output: 'done'}, 1030));
  child.end();
  workflow.end();
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 7);
  assert.deepEqual(errors, []);
  assert.ok(
    spans.every(
      s => s.spanContext().traceId === workflow.spanContext().traceId,
    ),
  );
  const parentAgent = spans.find(s => s.name === 'invoke_agent parent-agent')!;
  const childAgent = spans.find(s => s.name === 'invoke_agent child-agent')!;
  assert.equal(
    parentAgent.parentSpanContext?.spanId,
    workflow.spanContext().spanId,
  );
  assert.equal(
    spans.find(s => s.name === 'child workflow')!.parentSpanContext?.spanId,
    workflow.spanContext().spanId,
  );
  assert.equal(
    childAgent.parentSpanContext?.spanId,
    child.spanContext().spanId,
  );
  for (const span of spans.filter(s =>
    ['execute_tool echo', 'chat example'].includes(s.name),
  )) {
    const isChild =
      span.attributes['stratos.workflow.execution_id'] === 'run-2';
    assert.equal(
      span.parentSpanContext?.spanId,
      (isChild ? childAgent : parentAgent).spanContext().spanId,
    );
    assert.equal(
      span.attributes['stratos.workflow.name'],
      isChild ? 'child' : 'parent',
    );
  }
  const model = spans.find(s => s.name === 'chat example')!;
  assert.equal(model.attributes['gen_ai.usage.input_tokens'], 12);
  assert.equal(model.attributes['gen_ai.usage.output_tokens'], 3);
  assert.equal(model.attributes['stratos.reconstructed'], true);
});

void test('cancel closes open spans once without marking intentional cancellation as error', async t => {
  const {exporter, provider, tracer} = setup();
  t.after(() => provider.shutdown());
  const agent = new AgentTrace({
    tracer,
    parentContext: ROOT_CONTEXT,
    workflowName: 'w',
    workflowExecutionId: 'r',
    agentName: 'a',
    input: 'p',
    timestamp: 1000,
    diagnostic: () => {},
  });
  agent.onEvent({
    type: 'compaction.started',
    timestamp: 1001,
    compactionId: 'c',
  });
  agent.onEvent({
    type: 'background.started',
    timestamp: 1002,
    taskId: 'b',
    parentTaskId: 'outer',
  });
  agent.onEvent({
    type: 'background.activity',
    timestamp: 1003,
    taskId: 'b',
    progress: 'working',
  });
  agent.finish({cancelled: true, reason: 'workflow cancelled'}, 1010);
  agent.finish({}, 1020);
  agent.onEvent({
    type: 'tool.started',
    timestamp: 1021,
    toolCallId: 'late',
    toolName: 'late',
    input: {},
  });
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 3);
  for (const span of spans) {
    assert.equal(span.status.code, SpanStatusCode.UNSET);
    assert.equal(span.attributes['stratos.completion.status'], 'cancelled');
    assert.equal(
      span.attributes['stratos.completion.reason'],
      'workflow cancelled',
    );
  }
  assert.equal(
    spans.find(s => s.name === 'background task')!.events[0]?.name,
    'activity',
  );
});

void test('tool failure does not fail successful parent; missing boundaries and bad content are soft', async t => {
  const {exporter, provider, tracer} = setup();
  t.after(() => provider.shutdown());
  const diagnostics: unknown[] = [];
  const agent = new AgentTrace({
    tracer,
    parentContext: ROOT_CONTEXT,
    workflowName: 'w',
    workflowExecutionId: 'r',
    agentName: 'a',
    input: 'p',
    timestamp: 1000,
    diagnostic: e => diagnostics.push(e),
  });
  agent.onEvent({
    type: 'model.completed',
    modelCallId: 'missing',
    timestamp: 1001,
  });
  agent.onEvent({
    type: 'tool.started',
    toolCallId: 't',
    toolName: 'bad',
    input: {},
    timestamp: 1002,
  });
  agent.onEvent({
    type: 'tool.started',
    toolCallId: 't',
    toolName: 'bad',
    input: {},
    timestamp: 1002,
  });
  agent.onEvent({
    type: 'tool.completed',
    toolCallId: 't',
    error: new Error('tool failed'),
    timestamp: 1003,
  });
  agent.onEvent({
    type: 'tool.started',
    toolCallId: 'c',
    toolName: 'circular',
    input: {},
    timestamp: 1004,
  });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  agent.onEvent({
    type: 'tool.completed',
    toolCallId: 'c',
    output: circular,
    timestamp: 1005,
  });
  agent.finish({output: 'recovered'}, 1010);
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 3);
  assert.equal(diagnostics.length, 3);
  assert.equal(
    spans.find(s => s.name === 'execute_tool bad')!.status.code,
    SpanStatusCode.ERROR,
  );
  assert.equal(
    spans.find(s => s.name === 'invoke_agent a')!.attributes[
      'stratos.completion.status'
    ],
    'success',
  );
});

void test('separate top-level runs stay on separate traces and failure closes every open child', async t => {
  const {exporter, provider, tracer} = setup();
  t.after(() => provider.shutdown());
  const roots = [
    tracer.startSpan('root-1', {}, ROOT_CONTEXT),
    tracer.startSpan('root-2', {}, ROOT_CONTEXT),
  ];
  const agents = roots.map(
    (root, index) =>
      new AgentTrace({
        tracer,
        parentContext: trace.setSpan(ROOT_CONTEXT, root),
        workflowName: 'same-name',
        workflowExecutionId: String(index),
        agentName: 'a',
        timestamp: 1000,
        input: 'p',
        diagnostic: () => {},
      }),
  );
  agents.forEach(agent =>
    agent.onEvent({
      type: 'model.started',
      timestamp: 1001,
      modelCallId: 'same-id',
    }),
  );
  agents[1]!.finish(
    {error: new Error('inactivity timeout'), reason: 'no meaningful activity'},
    1010,
  );
  agents[0]!.finish({output: 'ok'}, 1011);
  roots.forEach(root => root.end());
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  assert.notEqual(
    roots[0]!.spanContext().traceId,
    roots[1]!.spanContext().traceId,
  );
  for (const span of spans.filter(
    s => s.attributes['stratos.workflow.execution_id'] !== undefined,
  )) {
    const index = Number(span.attributes['stratos.workflow.execution_id']);
    assert.equal(
      span.spanContext().traceId,
      roots[index]!.spanContext().traceId,
    );
    assert.equal(
      span.status.code,
      index === 1 ? SpanStatusCode.ERROR : SpanStatusCode.UNSET,
    );
  }
});
