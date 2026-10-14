import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

import type {SDKMessage} from '@anthropic-ai/claude-agent-sdk';

import {ClaudeActivity} from '../../src/agents/claude/activity.js';
import {
  CodexActivity,
  type CodexTranscript,
} from '../../src/agents/codex/activity.js';
import type {AgentEvent} from '../../src/agents/events.js';
import {OpenCodeActivity} from '../../src/agents/opencode/activity.js';

const envelope = {uuid: randomUUID(), session_id: 'session'};

void test('Claude maps real task edges and nesting without treating snapshots or elapsed time as progress', () => {
  const events: AgentEvent[] = [];
  const activity = new ClaudeActivity(event => {
    events.push(event);
  });
  const observe = (event: SDKMessage) => activity.observe(event);
  activity.tool('nested-spawn', 'parent');
  const started: SDKMessage = {
    ...envelope,
    type: 'system',
    subtype: 'task_started',
    task_id: 'child',
    tool_use_id: 'nested-spawn',
    description: 'Work',
  };
  observe(started);
  observe(started);
  observe({
    ...envelope,
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [],
  });
  const progress: SDKMessage = {
    ...envelope,
    type: 'system',
    subtype: 'task_progress',
    task_id: 'child',
    description: 'Working',
    usage: {total_tokens: 0, tool_uses: 0, duration_ms: 1000},
  };
  observe(progress);
  observe({...progress, usage: {...progress.usage, tool_uses: 1}});
  observe({
    ...progress,
    usage: {...progress.usage, tool_uses: 1, duration_ms: 2000},
  });
  activity.onEvent({
    type: 'model.started',
    timestamp: 1,
    modelCallId: 'model',
    parentToolCallId: 'nested-spawn',
  });
  const completed: SDKMessage = {
    ...envelope,
    type: 'system',
    subtype: 'task_notification',
    task_id: 'child',
    status: 'stopped',
    output_file: 'unused',
    summary: 'Stopped',
    usage: {total_tokens: 12, tool_uses: 1, duration_ms: 3000},
  };
  observe(completed);
  observe(completed);
  observe(progress);
  assert.deepEqual(
    events.map(e => e.type),
    [
      'background.started',
      'background.activity',
      'model.started',
      'background.completed',
    ],
  );
  assert.equal(events[0]!.parentTaskId, 'parent');
  assert.equal(events[2]!.parentTaskId, 'child');
  assert.ok(events[3]?.type === 'background.completed' && events[3].cancelled);
  assert.equal(
    'usage' in events[3],
    false,
    'Total task tokens are not input/output token counts',
  );
});

void test('Claude compaction preserves observed bookends and does not manufacture a missing start', () => {
  const events: AgentEvent[] = [];
  const activity = new ClaudeActivity(event => {
    events.push(event);
  });
  const boundary: SDKMessage = {
    ...envelope,
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {trigger: 'manual', pre_tokens: 500, post_tokens: 100},
  };
  activity.observe({
    ...envelope,
    type: 'system',
    subtype: 'status',
    status: 'compacting',
  });
  activity.observe({
    ...envelope,
    type: 'system',
    subtype: 'status',
    status: 'compacting',
  });
  activity.observe(boundary);
  activity.observe({...boundary, uuid: randomUUID()});
  assert.deepEqual(
    events.map(e => e.type),
    ['compaction.started', 'compaction.completed', 'compaction.completed'],
  );
  assert.ok(events[0]?.type === 'compaction.started');
  assert.ok(events[1]?.type === 'compaction.completed');
  assert.equal(events[0].compactionId, events[1].compactionId);
  assert.deepEqual(events[1].output, boundary.compact_metadata);
  assert.equal(events[1].usage, undefined);
});

void test('Claude reports unknown task endpoints and failures without inventing starts', () => {
  const events: AgentEvent[] = [];
  const activity = new ClaudeActivity(event => {
    events.push(event);
  });
  activity.observe({
    ...envelope,
    type: 'system',
    subtype: 'task_notification',
    task_id: 'missing',
    status: 'failed',
    output_file: '',
    summary: 'Native failure',
  });
  assert.equal(events.length, 1);
  assert.ok(events[0]?.type === 'background.completed');
  assert.equal(events[0].error?.message, 'Native failure');
  activity.observe({
    ...envelope,
    type: 'system',
    subtype: 'task_started',
    task_id: 'missing',
    description: 'Late edge',
  });
  assert.equal(events.length, 1);
});

void test('Codex collab tool completion does not mean the spawned agent completed', () => {
  const events: AgentEvent[] = [];
  const activity = new CodexActivity(event => {
    events.push(event);
  });
  const state = (status: string, tool = 'spawn_agent', parent = 'root') => ({
    type: 'item.completed',
    item: {
      type: 'collab_tool_call',
      tool,
      sender_thread_id: parent,
      receiver_thread_ids: ['child'],
      prompt: 'Work',
      agents_states: {
        child: {status, message: status === 'completed' ? 'Done' : null},
      },
    },
  });
  activity.observe(state('pending_init'), 'root');
  activity.observe(state('running'), 'root');
  activity.observe(state('running', 'wait'), 'root');
  assert.deepEqual(
    events.map(e => e.type),
    ['background.started', 'background.activity'],
  );
  activity.observe(state('completed', 'wait'), 'root');
  activity.observe(state('completed', 'wait'), 'root');
  assert.ok(events[2]?.type === 'background.completed');
  assert.equal(events[2].output, 'Done');
  activity.observe(state('running', 'send_input', 'outer'), 'root');
  assert.equal(events[3]?.parentTaskId, 'outer');
  activity.observe(state('shutdown', 'close_agent'), 'root');
  assert.ok(events[4]?.type === 'background.completed' && events[4].cancelled);
});

void test('Codex validates native extensions and reports missing endpoints honestly', () => {
  const events: AgentEvent[] = [];
  const activity = new CodexActivity(event => {
    events.push(event);
  });
  activity.observe({type: 'item.started', item: {type: 'command_execution'}});
  assert.throws(() =>
    activity.observe({type: 'item.started', item: {type: 'collab_tool_call'}}),
  );
  const rows = [
    {
      type: 'compacted',
      timestamp: new Date(1000).toISOString(),
      payload: {message: 'Summary'},
    },
  ];
  const compaction = activity.transcript(rows, 0, 'session');
  assert.equal(compaction.length, 1);
  assert.ok(compaction[0]?.type === 'compaction.completed');
  assert.equal(compaction[0].timestamp, 1000);
  assert.equal(compaction[0].reconstructed, true);
  assert.equal(compaction[0].output, 'Summary');
  assert.deepEqual(activity.transcript(rows, rows.length, 'session'), []);
});

void test('OpenCode isolates child tasks, emits actual progress and deduplicates native idle bookends', () => {
  const events: AgentEvent[] = [];
  const activity = new OpenCodeActivity(event => {
    events.push(event);
  });
  const observe = (type: string, properties: Record<string, unknown>) =>
    activity.observe({type, properties}, 'root');
  observe('session.created', {info: {id: 'child', parentID: 'root'}});
  observe('session.created', {info: {id: 'nested', parentID: 'child'}});
  observe('session.created', {info: {id: 'unrelated'}});
  assert.equal(events.length, 0, 'Session existence is not execution');
  observe('session.status', {sessionID: 'child', status: {type: 'busy'}});
  observe('session.status', {sessionID: 'nested', status: {type: 'busy'}});
  observe('session.status', {sessionID: 'unrelated', status: {type: 'busy'}});
  observe('session.status', {sessionID: 'child', status: {type: 'busy'}});
  observe('server.heartbeat', {});
  observe('message.part.delta', {sessionID: 'child', field: 'text', delta: ''});
  observe('message.part.delta', {
    sessionID: 'child',
    field: 'text',
    delta: 'Working',
  });
  observe('session.error', {
    sessionID: 'nested',
    error: {name: 'MessageAbortedError', data: {message: 'Aborted'}},
  });
  observe('session.status', {sessionID: 'nested', status: {type: 'idle'}});
  observe('session.idle', {sessionID: 'nested'});
  observe('session.idle', {sessionID: 'child'});
  assert.deepEqual(
    events.map(e => e.type),
    [
      'background.started',
      'background.started',
      'background.activity',
      'background.completed',
      'background.completed',
    ],
  );
  assert.equal(events[1]?.parentTaskId, 'child');
  assert.ok(events[3]?.type === 'background.completed' && events[3].cancelled);
});

void test('OpenCode compaction uses native part correlation, not model tokens or session existence', () => {
  const events: AgentEvent[] = [];
  const activity = new OpenCodeActivity(event => {
    events.push(event);
  });
  const part = {
    id: 'compact',
    sessionID: 'root',
    type: 'compaction',
    auto: true,
  };
  activity.observe({type: 'message.part.updated', properties: {part}}, 'root');
  activity.observe({type: 'message.part.updated', properties: {part}}, 'root');
  activity.observe(
    {type: 'session.compacted', properties: {sessionID: 'root'}},
    'root',
  );
  assert.equal(events.length, 2);
  assert.ok(
    events[0]?.type === 'compaction.started' &&
      events[1]?.type === 'compaction.completed',
  );
  assert.equal(events[0].compactionId, events[1].compactionId);
  assert.equal(events[1].usage, undefined);
});

void test('Codex reconstructs only owned child turns, excludes copied parent history and deduplicates reads', () => {
  const activity = new CodexActivity(() => {});
  const rows: CodexTranscript = [];
  const add = (type: string, payload: Record<string, unknown>) =>
    rows.push({
      type,
      payload,
      timestamp: new Date(1000 + rows.length * 100).toISOString(),
    });
  add('event_msg', {type: 'task_started', turn_id: 'inherited'});
  add('response_item', {type: 'function_call', name: 'parent-tool'});
  add('compacted', {message: 'inherited parent compaction'});
  add('event_msg', {type: 'task_started', turn_id: 'owned'});
  add('response_item', {
    type: 'function_call',
    name: 'child-tool',
    call_id: 'tool',
  });
  const offset = rows.length;
  const first = activity.transcript(
    rows,
    0,
    'child',
    'parent',
    new Set(['inherited']),
  );
  assert.deepEqual(
    first.map(event => event.type),
    ['background.started', 'background.activity'],
  );
  assert.ok(first.every(event => event.reconstructed));
  assert.equal(first[0]?.timestamp, 1300);
  assert.equal(first[0]?.parentTaskId, 'parent');
  assert.deepEqual(
    activity.transcript(
      rows,
      offset,
      'child',
      'parent',
      new Set(['inherited']),
    ),
    [],
  );
  add('event_msg', {
    type: 'task_complete',
    turn_id: 'owned',
    last_agent_message: 'done',
  });
  const last = activity.transcript(
    rows,
    offset,
    'child',
    'parent',
    new Set(['inherited']),
  );
  assert.equal(last.length, 1);
  assert.ok(last[0]?.type === 'background.completed');
  assert.equal(last[0].output, 'done');
  assert.deepEqual(
    activity.transcript(
      rows,
      rows.length,
      'child',
      'parent',
      new Set(['inherited']),
    ),
    [],
  );
});

void test('Codex missing task termination remains missing; native interruption is not success', () => {
  const activity = new CodexActivity(() => {});
  const rows = [
    {
      type: 'event_msg',
      timestamp: new Date(1000).toISOString(),
      payload: {type: 'task_started', turn_id: 'owned'},
    },
  ];
  assert.deepEqual(
    activity.transcript(rows, 0, 'child', 'parent').map(event => event.type),
    ['background.started'],
  );
  rows.push({
    type: 'event_msg',
    timestamp: new Date(1100).toISOString(),
    payload: {type: 'turn_aborted', turn_id: 'owned'},
  });

  const events = activity.transcript(rows, 1, 'child', 'parent');
  assert.ok(events[0]?.type === 'background.completed' && events[0].cancelled);
});

void test('Codex native collaboration bookends are not duplicated by transcript reconstruction', () => {
  const events: AgentEvent[] = [];
  const activity = new CodexActivity(event => {
    events.push(event);
  });
  for (const status of ['running', 'completed']) {
    activity.observe(
      {
        type: 'item.updated',
        item: {
          type: 'collab_tool_call',
          tool: 'wait',
          sender_thread_id: 'root',
          receiver_thread_ids: ['child'],
          agents_states: {child: {status}},
        },
      },
      'root',
    );
  }
  const rows = [
    {
      type: 'event_msg',
      timestamp: new Date(1000).toISOString(),
      payload: {type: 'task_started', turn_id: 'turn'},
    },
    {
      type: 'event_msg',
      timestamp: new Date(1100).toISOString(),
      payload: {type: 'task_complete', turn_id: 'turn'},
    },
  ];
  assert.deepEqual(activity.transcript(rows, 0, 'child', 'root'), []);
  assert.deepEqual(
    events.map(event => event.type),
    ['background.started', 'background.completed'],
  );
});

void test('Claude can resume a completed native task and ignores duplicate compaction boundaries', () => {
  const events: AgentEvent[] = [];
  const activity = new ClaudeActivity(event => {
    events.push(event);
  });
  const start: SDKMessage = {
    ...envelope,
    type: 'system',
    subtype: 'task_started',
    task_id: 'task',
    tool_use_id: 'spawn',
    description: 'Task',
  };
  activity.observe(start);
  activity.observe({
    ...envelope,
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task',
    status: 'completed',
    summary: 'Done',
    output_file: '',
  });
  activity.observe(start);
  activity.observe({...start, uuid: randomUUID()});
  activity.observe({
    ...envelope,
    type: 'system',
    subtype: 'status',
    status: 'compacting',
  });
  activity.observe({
    ...envelope,
    type: 'system',
    subtype: 'status',
    status: null,
  });
  const boundary: SDKMessage = {
    ...envelope,
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {trigger: 'auto', pre_tokens: 100},
  };
  activity.observe(boundary);
  activity.observe(boundary);
  assert.deepEqual(
    events.map(event => event.type),
    [
      'background.started',
      'background.completed',
      'background.started',
      'compaction.started',
      'compaction.completed',
    ],
  );
  assert.ok(
    events[3]?.type === 'compaction.started' &&
      events[4]?.type === 'compaction.completed',
  );
  assert.equal(events[3].compactionId, events[4].compactionId);
});

void test('OpenCode user summaries and late message updates do not create phantom child activity', () => {
  const events: AgentEvent[] = [];
  const activity = new OpenCodeActivity(event => {
    events.push(event);
  });
  const observe = (type: string, properties: Record<string, unknown>) =>
    activity.observe({type, properties}, 'root');
  observe('message.updated', {
    info: {
      id: 'user',
      sessionID: 'root',
      role: 'user',
      summary: {title: 'title', diffs: []},
    },
  });
  observe('session.created', {info: {id: 'child', parentID: 'root'}});
  observe('session.status', {sessionID: 'child', status: {type: 'busy'}});
  observe('session.idle', {sessionID: 'child'});
  observe('message.updated', {
    info: {id: 'done', sessionID: 'child', role: 'assistant'},
  });
  assert.deepEqual(
    events.map(event => event.type),
    ['background.started', 'background.completed'],
  );
  observe('session.status', {sessionID: 'child', status: {type: 'busy'}});
  assert.equal(
    events.at(-1)?.type,
    'background.started',
    'A real subsequent turn can reuse the child',
  );
});
