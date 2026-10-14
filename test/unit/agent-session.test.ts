import assert from 'node:assert/strict';
import test from 'node:test';

import {AgentSession} from '../../src/agents/session.js';

void test('lazy session preserves conversation and rejects overlap without cancelling the first', async () => {
  let initialize = 0;
  let cancel = 0;
  let close = 0;
  let finish!: (value: string) => void;
  const session = new AgentSession({
    async initialize() {
      initialize++;
    },
    execute() {
      return new Promise<string>(resolve => {
        finish = resolve;
      });
    },
    cancel() {
      cancel++;
    },
    async close() {
      close++;
    },
  });
  assert.equal(initialize, 0);
  const first = session.execute('first');
  await assert.rejects(session.execute('overlap'), /sequential/);
  while (!finish) {
    await Promise.resolve();
  }
  assert.equal(cancel, 0);
  finish('first result');
  assert.equal(await first, 'first result');
  const second = session.execute('second');
  await Promise.resolve();
  await Promise.resolve();
  finish('second result');
  assert.equal(await second, 'second result');
  assert.equal(initialize, 1);
  await session.close();
  await session.close();
  assert.equal(close, 1);
  await assert.rejects(session.execute('too late'), /closed/);
});

void test('initialization retries only on a later call; execution failures preserve session', async () => {
  let initialize = 0;
  const failure = new Error('failed');
  const session = new AgentSession({
    async initialize() {
      if (++initialize === 1) {
        throw failure;
      }
    },
    async execute(prompt) {
      if (prompt === 'fail') {
        throw failure;
      }
      return prompt;
    },
    cancel() {},
    async close() {},
  });
  await assert.rejects(session.execute('first'), error => error === failure);
  assert.equal(initialize, 1);
  await assert.rejects(session.execute('fail'), error => error === failure);
  assert.equal(await session.execute('continue'), 'continue');
  assert.equal(initialize, 2);
  await session.close();
});

void test('onError failure preserves both errors without recursion', async () => {
  const original = new Error('execution');
  const secondary = new Error('hook');
  let called = 0;
  const session = new AgentSession(
    {
      async initialize() {},
      async execute() {
        throw original;
      },
      cancel() {},
      async close() {},
    },
    {
      onError(error) {
        assert.equal(error, original);
        called++;
        throw secondary;
      },
    },
  );
  await assert.rejects(session.execute('fail'), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [original, secondary]);
    return true;
  });
  assert.equal(called, 1);
  await session.close();
});

void test('cancel before work starts rejects without initialization and permits explicit reuse', async () => {
  let initialized = 0;
  const session = new AgentSession({
    async initialize() {
      initialized++;
    },
    async execute(p) {
      return p;
    },
    cancel() {},
    async close() {},
  });
  const pending = session.execute('cancelled');
  session.cancel();
  await assert.rejects(pending, /cancelled/);
  assert.equal(initialized, 0);
  assert.equal(await session.execute('continue'), 'continue');
  await session.close();
});

void test('close during initialization prevents execution and waits before releasing native resources', async () => {
  let ready!: () => void;
  let initialized = false;
  let released = false;
  const session = new AgentSession({
    initialize() {
      return new Promise<void>(resolve => {
        ready = () => {
          initialized = true;
          resolve();
        };
      });
    },
    async execute() {
      assert.fail('closed context must not execute');
    },
    cancel() {},
    async close() {
      assert.equal(initialized, true);
      released = true;
    },
  });
  const request = session.execute('first');
  const rejection = assert.rejects(request, /cancelled/);
  await Promise.resolve();
  const closure = session.close();
  assert.equal(released, false);
  ready();
  await rejection;
  await closure;
  assert.equal(released, true);
});

void test('close still releases resources when cancellation throws', async () => {
  const error = new Error('native cancellation failed');
  let closed = false;
  const session = new AgentSession({
    async initialize() {},
    async execute() {},
    cancel() {
      throw error;
    },
    async close() {
      closed = true;
    },
  });
  await assert.rejects(session.close(), value => value === error);
  assert.equal(closed, true);
});
