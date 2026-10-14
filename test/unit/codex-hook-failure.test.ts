import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CodexHookFailure} from '../../src/agents/codex/hook-failure.js';

void test('before exception aborts SDK and caller receives same Error with cause/code', async () => {
  const guard = new CodexHookFailure();
  const original = Object.assign(
    new Error('hook failed', {cause: new Error('cause')}),
    {code: 'FIXTURE'},
  );
  await assert.rejects(
    guard.execute(async signal => {
      const decision = await guard.invoke('before', () => {
        throw original;
      });
      assert.equal(signal.aborted, true);
      assert.equal(signal.reason, original);
      assert.equal(decision.hookSpecificOutput?.permissionDecision, 'deny');
      throw new Error('SDK abort error');
    }),
    e => e === original,
  );
});
void test('after rejected callback blocks result and failure wins over SDK success', async () => {
  const guard = new CodexHookFailure();
  const error = new Error('after failed');
  await assert.rejects(
    guard.execute(async () => {
      const decision = await guard.invoke('after', async () => {
        throw error;
      });
      assert.equal(decision.decision, 'block');
      return 'native completed';
    }),
    e => e === error,
  );
});
void test('intentional denial is not an invocation failure', async () => {
  const guard = new CodexHookFailure();
  const denial = {hookSpecificOutput: {permissionDecision: 'deny'}};
  const result = await guard.execute(async signal => {
    assert.equal(await guard.invoke('before', () => denial), denial);
    assert.equal(signal.aborted, false);
    return 'agent continued';
  });
  assert.equal(result, 'agent continued');
});
void test('concurrent late allow and subsequent callbacks cannot bypass fatal error', async () => {
  const guard = new CodexHookFailure();
  const original = new Error('first');
  let release!: () => void;
  let called = false;
  await assert.rejects(
    guard.execute(async () => {
      const late = guard.invoke('before', async () => {
        await new Promise<void>(r => {
          release = r;
        });
        return {};
      });
      await guard.invoke('before', () => {
        throw original;
      });
      release();
      const decision = await late;
      assert('hookSpecificOutput' in decision);
      assert.equal(decision.hookSpecificOutput?.permissionDecision, 'deny');
      await guard.invoke('before', () => {
        called = true;
        throw new Error('later');
      });
      return null;
    }),
    e => e === original,
  );
  assert.equal(called, false);
});
void test('unrelated SDK error preserved; independent invocation remains usable', async () => {
  const error = new Error('network');
  await assert.rejects(
    new CodexHookFailure().execute(async () => {
      throw error;
    }),
    e => e === error,
  );
  assert.equal(await new CodexHookFailure().execute(async () => 42), 42);
});
