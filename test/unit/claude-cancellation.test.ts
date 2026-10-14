import assert from 'node:assert/strict';
import {test} from 'node:test';

import {ClaudeCancellation} from '../../src/agents/claude/cancellation.js';

const snapshot = (...ids: string[]) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: ids.map(task_id => ({task_id})),
});

void test('interrupts foreground and stops earlier and newly arriving background tasks', async () => {
  const stopped: string[] = [];
  let interrupts = 0;
  const c = new ClaudeCancellation({
    async interrupt() {
      interrupts++;
      c.observe({type: 'result'});
    },
    async stopTask(id) {
      stopped.push(id);
      c.observe(id === 'earlier' ? snapshot('late') : snapshot());
    },
  });
  c.observe(snapshot('earlier'));
  c.beginTurn();
  const completion = c.cancel();
  assert.equal(c.cancel(), completion);
  assert.throws(() => c.beginTurn(), /cancellation/);
  await completion;
  assert.equal(interrupts, 1);
  assert.deepEqual(stopped, ['earlier', 'late']);
  c.beginTurn(); // Same query remains reusable.
  c.observe({type: 'result'});
});

void test('background-only cancellation waits for actual removal, not stop acknowledgement', async () => {
  let stopped!: () => void;
  const sent = new Promise<void>(r => {
    stopped = r;
  });
  const c = new ClaudeCancellation({
    async interrupt() {
      assert.fail('idle interrupt');
    },
    async stopTask() {
      stopped();
    },
  });
  c.observe(snapshot('background'));
  let done = false;
  const completion = c.cancel().then(() => {
    done = true;
  });
  await sent;
  await new Promise(r => setImmediate(r));
  assert.equal(done, false);
  c.observe(snapshot());
  // A late edge must not resurrect the removed task.
  c.observe({type: 'system', subtype: 'task_started'});
  await completion;
});

void test('one failed control does not prevent stopping other tasks; errors propagate', async () => {
  const stopped: string[] = [];
  const c = new ClaudeCancellation({
    async interrupt() {
      throw Error('interrupt failed');
    },
    async stopTask(id) {
      stopped.push(id);
      if (id === 'a') {
        throw Error('stop failed');
      }
    },
  });
  c.beginTurn();
  c.observe(snapshot('a', 'b'));
  await assert.rejects(c.cancel(), AggregateError);
  assert.deepEqual(stopped.sort(), ['a', 'b']);
});

void test('stream closure and caller abort reject waiting without claiming termination', async () => {
  for (const mode of ['close', 'abort']) {
    const c = new ClaudeCancellation({
      async interrupt() {},
      async stopTask() {},
    });
    const controller = new AbortController();
    c.observe(snapshot('still-running'));
    const completion = c.cancel(controller.signal);
    await new Promise(r => setImmediate(r));
    if (mode === 'close') {
      c.streamClosed(Error('lost stream'));
    } else {
      controller.abort(Error('test deadline'));
    }
    await assert.rejects(
      completion,
      mode === 'close' ? /lost stream/ : /test deadline/,
    );
  }
});

void test('cancellation does not touch a different session', async () => {
  let unrelatedCalls = 0;
  const other = new ClaudeCancellation({
    async interrupt() {
      unrelatedCalls++;
    },
    async stopTask() {
      unrelatedCalls++;
    },
  });
  other.beginTurn();
  other.observe(snapshot('other'));
  const c = new ClaudeCancellation({
    async interrupt() {},
    async stopTask() {
      c.observe(snapshot());
    },
  });
  c.observe(snapshot('mine'));
  await c.cancel();
  assert.equal(unrelatedCalls, 0);
});

void test('an autonomous result cannot complete the explicitly submitted turn', async () => {
  const c = new ClaudeCancellation({async interrupt() {}, async stopTask() {}});
  c.beginTurn('submitted');
  let done = false;
  const completion = c.cancel().then(() => {
    done = true;
  });
  c.observe({type: 'result', user_message_uuid: 'background-notification'});
  await new Promise(r => setImmediate(r));
  assert.equal(done, false);
  c.observe({type: 'result', user_message_uuids: ['submitted']});
  await completion;
});

void test('cancellation interrupts an autonomous native turn and waits for its result', async () => {
  let interrupts = 0;
  const c = new ClaudeCancellation({
    async interrupt() {
      interrupts++;
    },
    async stopTask() {
      assert.fail('No background task to stop');
    },
  });
  c.beginNativeTurn();
  let done = false;
  const completion = c.cancel().then(() => {
    done = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(interrupts, 1);
  assert.equal(
    done,
    false,
    'Interrupt acknowledgement does not finish the native turn',
  );
  c.observe({type: 'result'});
  await completion;
  c.beginTurn('continued');
  c.observe({type: 'result', user_message_uuid: 'continued'});
});
