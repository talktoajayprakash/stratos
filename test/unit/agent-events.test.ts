import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAgentEventSink,
  type AgentEvent,
} from '../../src/agents/events.js';

void test('event consumers preserve arrival order and isolate synchronous and asynchronous failures', async () => {
  const errors: unknown[] = [];
  const seen: number[] = [];
  const failure = new Error('consumer failed');
  const sink = createAgentEventSink(
    [
      () => {
        throw failure;
      },
      async () => {
        throw failure;
      },
      event => {
        seen.push(event.timestamp);
      },
    ],
    error => {
      errors.push(error);
    },
  );
  for (const timestamp of [1, 2]) {
    sink.onEvent({type: 'message.delta', timestamp, text: 'hello'});
  }
  await sink.drain();
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(errors, [failure, failure, failure, failure]);
});

void test('slow observation does not pause the adapter; drain awaits pending consumers', async () => {
  let finish!: () => void;
  let consumed = false;
  const sink = createAgentEventSink(
    [
      async () => {
        await new Promise<void>(resolve => {
          finish = resolve;
        });
        consumed = true;
      },
    ],
    () => {
      throw new Error('unexpected diagnostic');
    },
  );
  const event: AgentEvent = {
    type: 'message.delta',
    timestamp: 1,
    text: 'delta',
  };
  assert.equal(sink.onEvent(event), undefined);
  assert.equal(consumed, false);
  finish();
  await sink.drain();
  assert.equal(consumed, true);
});

void test('even diagnostic failure cannot escape the observation sink', async () => {
  const sink = createAgentEventSink(
    [
      () => {
        throw new Error('trace unavailable');
      },
    ],
    () => {
      throw new Error('log unavailable');
    },
  );
  sink.onEvent({type: 'message.delta', timestamp: 1, text: 'hello'});
  await sink.drain();
});
