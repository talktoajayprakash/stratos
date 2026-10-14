import assert from 'node:assert/strict';
import test from 'node:test';

import type {SDKMessage} from '@anthropic-ai/claude-agent-sdk';

import type {AgentEvent} from '../../src/agents/events.js';
import {
  ClaudeModels,
  OpenCodeModels,
  codexModels,
} from '../../src/telemetry/harness-models.js';

void test('Claude streams preserve observed conversation and combine cache token usage', () => {
  const events: AgentEvent[] = [];
  const models = new ClaudeModels(e => {
    events.push(e);
  });
  models.prompt('hello');
  const observe = (event: unknown) =>
    models.observe({type: 'stream_event', event} as SDKMessage);
  observe({
    type: 'message_start',
    message: {
      id: 'm',
      model: 'claude',
      usage: {input_tokens: 3, cache_read_input_tokens: 4},
    },
  });
  observe({
    type: 'content_block_start',
    index: 0,
    content_block: {type: 'text', text: ''},
  });
  observe({
    type: 'content_block_delta',
    index: 0,
    delta: {type: 'text_delta', text: 'answer'},
  });
  observe({
    type: 'message_delta',
    usage: {output_tokens: 2},
    delta: {stop_reason: 'end_turn'},
  });
  observe({type: 'message_stop'});
  assert.equal(events.length, 2);
  const end = events[1]!;
  assert.equal(end.type, 'model.completed');
  if (end.type === 'model.completed') {
    assert.equal(end.usage?.inputTokens, 7);
    assert.equal(end.output?.[0]?.parts[0]?.content, 'answer');
  }
});

void test('OpenCode duplicate step events do not duplicate model spans', () => {
  const events: AgentEvent[] = [];
  const models = new OpenCodeModels(
    e => {
      events.push(e);
    },
    {model: 'm', provider: 'p'},
  );
  models.prompt('hello');
  const observe = (part: Record<string, unknown>) =>
    models.observe({properties: {part: {...part, messageID: 'm1'}}});
  observe({id: 's', type: 'step-start'});
  observe({id: 's', type: 'step-start'});
  observe({id: 't', type: 'text', text: 'answer'});
  observe({
    id: 'f',
    type: 'step-finish',
    tokens: {input: 2, output: 1, reasoning: 0, cache: {read: 3, write: 0}},
  });
  observe({id: 'f', type: 'step-finish'});
  assert.equal(events.length, 2);
  const end = events[1]!;
  if (end.type === 'model.completed') {
    assert.equal(end.usage?.inputTokens, 5);
  }
});

void test('OpenCode model errors retain diagnostic text or the missing-data fallback', () => {
  for (const [error, expected] of [
    [
      {data: {message: 'Provider rejected the request'}},
      'Provider rejected the request',
    ],
    [{}, 'OpenCode model failed'],
  ] as const) {
    const events: AgentEvent[] = [];
    const models = new OpenCodeModels(
      event => {
        events.push(event);
      },
      {model: 'm', provider: 'p'},
    );
    models.observe({properties: {info: {id: 'm1', role: 'assistant', error}}});
    models.observe({
      properties: {part: {id: 'start', messageID: 'm1', type: 'step-start'}},
    });
    models.observe({
      properties: {part: {id: 'finish', messageID: 'm1', type: 'step-finish'}},
    });
    const completed = events[1];
    assert.ok(completed?.type === 'model.completed');
    assert.equal(completed.error?.message, expected);
  }
});

void test('Codex resumed transcript exports only new steps and labels reconstructed content', () => {
  const rows: Parameters<typeof codexModels>[0] = [];
  const row = (type: string, payload: (typeof rows)[number]['payload']) =>
    rows.push({
      type,
      payload,
      timestamp: new Date(1700000000000 + rows.length * 100).toISOString(),
    });
  row('turn_context', {model: 'gpt'});
  const turn = () => {
    row('event_msg', {type: 'task_started'});
    row('response_item', {
      type: 'message',
      role: 'user',
      content: [{type: 'input_text', text: 'hello'}],
    });
    row('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{type: 'output_text', text: 'answer'}],
    });
    row('event_msg', {
      type: 'token_count',
      info: {last_token_usage: {input_tokens: 5, output_tokens: 2}},
    });
  };
  turn();
  const offset = rows.length;
  turn();
  const events: AgentEvent[] = [];
  codexModels(rows, offset, e => {
    events.push(e);
  });
  assert.equal(events.length, 2);
  assert.ok(events.every(e => e.reconstructed));
  const start = events[0]!;
  if (start.type === 'model.started') {
    assert.equal(start.input?.length, 3);
    assert.equal(start.settings?.provider, 'openai');
  }
  const azureEvents: AgentEvent[] = [];
  codexModels(
    rows,
    offset,
    event => {
      azureEvents.push(event);
    },
    'azure',
  );
  assert.equal(azureEvents[0]?.type, 'model.started');
  if (azureEvents[0]?.type === 'model.started') {
    assert.equal(azureEvents[0].settings?.provider, 'azure');
  }
});

void test('Claude interleaved subagent streams keep independent model state and conversation histories', () => {
  const events: AgentEvent[] = [];
  const models = new ClaudeModels(event => {
    events.push(event);
  });
  models.prompt('parent-only input');
  const observe = (parent: string | null, event: unknown) =>
    models.observe({
      type: 'stream_event',
      parent_tool_use_id: parent,
      event,
    } as SDKMessage);
  for (const [parent, id] of [
    [null, 'parent-model'],
    ['spawn', 'child-model'],
  ] as const) {
    observe(parent, {
      type: 'message_start',
      message: {id, model: 'claude', usage: {input_tokens: 3}},
    });
    observe(parent, {
      type: 'content_block_start',
      index: 0,
      content_block: {type: 'text', text: ''},
    });
  }
  for (const parent of [null, 'spawn']) {
    observe(parent, {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: parent ? 'child output' : 'parent output',
      },
    });
    observe(parent, {
      type: 'message_delta',
      usage: {output_tokens: 1},
      delta: {stop_reason: 'end_turn'},
    });
    observe(parent, {type: 'message_stop'});
  }
  const starts = events.filter(e => e.type === 'model.started');
  const ends = events.filter(e => e.type === 'model.completed');
  assert.equal(starts[0]?.input?.[0]?.parts[0]?.content, 'parent-only input');
  assert.deepEqual(starts[1]?.input, []);
  assert.equal(starts[1]?.parentToolCallId, 'spawn');
  assert.deepEqual(
    ends.map(event => [
      event.modelCallId,
      event.output?.[0]?.parts[0]?.content,
    ]),
    [
      ['parent-model', 'parent output'],
      ['child-model', 'child output'],
    ],
  );
});

void test('OpenCode separates child model history from the main session and retains compaction parentage', () => {
  const events: AgentEvent[] = [];
  const models = new OpenCodeModels(
    event => {
      events.push(event);
    },
    {model: 'm', provider: 'p'},
  );
  models.prompt('parent-only input', 'root');
  const part = (
    sessionID: string,
    messageID: string,
    type: string,
    id: string,
    rest = {},
  ) =>
    models.observe(
      {properties: {part: {sessionID, messageID, type, id, ...rest}}},
      sessionID === 'child'
        ? {parentTaskId: 'child', parentCompactionId: 'compact'}
        : {},
    );
  part('root', 'root-model', 'step-start', 'root-start');
  part('child', 'child-model', 'step-start', 'child-start');
  part('child', 'child-model', 'text', 'child-text', {
    text: 'child-only answer',
  });
  part('child', 'child-model', 'step-finish', 'child-end');
  part('root', 'root-model', 'text', 'root-text', {text: 'root-only answer'});
  part('root', 'root-model', 'step-finish', 'root-end');
  part('root', 'next-root-model', 'step-start', 'next-root-start');
  const starts = events.filter(e => e.type === 'model.started');
  assert.deepEqual(starts[1]?.input, []);
  assert.equal(starts[1]?.parentTaskId, 'child');
  assert.equal(starts[1]?.parentCompactionId, 'compact');
  assert.ok(!JSON.stringify(starts[2]?.input).includes('child-only answer'));
  assert.ok(JSON.stringify(starts[2]?.input).includes('root-only answer'));
});
