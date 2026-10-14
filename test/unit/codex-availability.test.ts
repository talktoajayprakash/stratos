import assert from 'node:assert/strict';
import test from 'node:test';

import type {ThreadEvent, ThreadItem} from '@openai/codex-sdk';

import {ModelUnavailableError} from '../../src/agents/availability.js';
import {isCodexProgress, codexFailure} from '../../src/agents/codex/adapter.js';
import {codexEnvironment} from '../../src/agents/codex/preflight.js';

void test('Codex native reasoning, text, attempted tool, file, web and plan items pin selection', () => {
  const items: ThreadItem[] = [
    {id: 'text', type: 'agent_message', text: 'answer'},
    {id: 'reason', type: 'reasoning', text: 'thinking'},
    {
      id: 'command',
      type: 'command_execution',
      command: 'echo fixture',
      aggregated_output: '',
      status: 'in_progress',
    },
    {
      id: 'mcp',
      type: 'mcp_tool_call',
      server: 'fixture',
      tool: 'tool',
      arguments: {},
      status: 'in_progress',
    },
    {id: 'patch', type: 'file_change', changes: [], status: 'failed'},
    {id: 'web', type: 'web_search', query: 'fixture'},
    {id: 'plan', type: 'todo_list', items: []},
  ];
  for (const type of [
    'item.started',
    'item.updated',
    'item.completed',
  ] as const) {
    for (const item of items) {
      assert.equal(
        isCodexProgress({type, item}),
        true,
        `${type}: ${item.type}`,
      );
    }
  }
});

void test('Codex thread/turn dispatch, empty text/reasoning and error reports are not progress', () => {
  const events: ThreadEvent[] = [
    {type: 'thread.started', thread_id: 'fixture'},
    {type: 'turn.started'},
    {type: 'error', message: 'model not found'},
    {type: 'turn.failed', error: {message: 'failure'}},
    ...(['item.started', 'item.updated', 'item.completed'] as const).flatMap(
      type => [
        {type, item: {id: 'text', type: 'agent_message' as const, text: ''}},
        {type, item: {id: 'reason', type: 'reasoning' as const, text: ''}},
        {type, item: {id: 'error', type: 'error' as const, message: 'error'}},
      ],
    ),
  ];
  for (const event of events) {
    assert.equal(isCodexProgress(event), false, event.type);
  }
});

void test('Codex generic errors retain exact native evidence and never authorize fallback by prose', () => {
  for (const message of [
    'model not found',
    'invalid_request_error',
    '401 missing API key',
    'rate limited',
    'permission denied',
  ]) {
    const event: ThreadEvent = {type: 'turn.failed', error: {message}};
    const error = codexFailure(event);
    assert.equal(error.cause, event);
    assert.equal(error instanceof ModelUnavailableError, false);
  }
});

void test('Codex API-key environment matches SDK execution precedence without mutating configuration', () => {
  const env = {
    CODEX_API_KEY: 'codex-fixture',
    OPENAI_API_KEY: 'openai-fixture',
    PATH: 'fixture-path',
  };
  assert.equal(
    codexEnvironment({env, apiKey: 'explicit-fixture'}).CODEX_API_KEY,
    'explicit-fixture',
  );
  assert.equal(codexEnvironment({env}).CODEX_API_KEY, 'codex-fixture');
  assert.equal(
    codexEnvironment({env: {OPENAI_API_KEY: 'openai-fixture'}}).CODEX_API_KEY,
    'openai-fixture',
  );
  assert.equal(env.CODEX_API_KEY, 'codex-fixture');
  assert.deepEqual(codexEnvironment({env: {}}), {});
  for (const value of ['', '   ']) {
    assert.throws(() => codexEnvironment({env: {}, apiKey: value}), /empty/);
  }
});
