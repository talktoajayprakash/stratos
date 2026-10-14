import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectModel,
  type CandidateAttempt,
  type UnavailableReason,
} from '../../src/models/select.js';

const models = ['openai/example', 'anthropic/example', 'google/gemma-example'];

void test('initial selection exhausts first-party candidates before OpenCode and stops at success', async () => {
  const calls: string[] = [];
  const session = {};
  const result = await selectModel(models, undefined, async candidate => {
    calls.push(`${candidate.harness}:${candidate.model}`);
    return candidate.harness === 'opencode'
      ? {available: true, value: session}
      : {
          available: false,
          reason: 'model-unavailable',
          error: new Error('unavailable'),
        };
  });
  assert.deepEqual(calls, [
    'codex:openai/example',
    'claude-code:anthropic/example',
    'opencode:openai/example',
  ]);
  assert.equal(result.value, session);
  assert.deepEqual(result.candidate, {harness: 'opencode', model: models[0]});
});

void test('each approved availability failure allows the next model only within an explicit harness', async () => {
  for (const reason of [
    'model-unavailable',
    'harness-missing',
    'authentication-missing',
  ] satisfies UnavailableReason[]) {
    const calls: string[] = [];
    const result = await selectModel(models, 'opencode', async candidate => {
      assert.equal(candidate.harness, 'opencode');
      calls.push(candidate.model);
      return calls.length === 1
        ? {available: false, reason, error: new Error(reason)}
        : {available: true, value: 'session'};
    });
    assert.deepEqual(calls, models.slice(0, 2));
    assert.equal(result.candidate.model, models[1]);
  }
});

void test('rate limits and other thrown failures preserve identity and never fall back', async () => {
  for (const code of [
    'rate_limit',
    'network_failure',
    'invalid_configuration',
    'execution_failure',
  ]) {
    const error = Object.assign(new Error(code), {code});
    let attempts = 0;
    await assert.rejects(
      selectModel(models, undefined, async () => {
        attempts++;
        throw error;
      }),
      e => e === error,
    );
    assert.equal(attempts, 1);
  }
});

void test('unknown runtime classifications do not silently gain fallback permission', async () => {
  const error = new Error('rate limited');
  let attempts = 0;
  await assert.rejects(
    selectModel(models, undefined, async () => {
      attempts++;
      return {
        available: false,
        reason: 'rate-limit',
        error,
      } as unknown as CandidateAttempt<never>;
    }),
    e => e === error,
  );
  assert.equal(attempts, 1);
});

void test('exhaustion retains original errors and an empty list attempts nothing', async () => {
  const errors: Error[] = [];
  await assert.rejects(
    selectModel(models, 'codex', async () => {
      const error = new Error('unavailable');
      errors.push(error);
      return {available: false, reason: 'model-unavailable', error};
    }),
    error =>
      error instanceof AggregateError &&
      assert.deepEqual(error.errors, errors) === undefined,
  );
  assert.equal(errors.length, models.length);
  await assert.rejects(
    selectModel([], undefined, async () => assert.fail('must not attempt')),
    AggregateError,
  );
});

void test('cancellation stops candidate progression but does not discard a successfully acquired resource', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  let attempts = 0;
  await assert.rejects(
    selectModel(
      models,
      undefined,
      async () => {
        attempts++;
        controller.abort(reason);
        return {
          available: false,
          reason: 'model-unavailable',
          error: new Error('unavailable'),
        };
      },
      controller.signal,
    ),
    e => e === reason,
  );
  assert.equal(attempts, 1);
  await assert.rejects(
    selectModel(
      [],
      undefined,
      async () => assert.fail('must not attempt'),
      controller.signal,
    ),
    e => e === reason,
  );
  const successful = new AbortController();
  const resource = {};
  const selected = await selectModel(
    models,
    undefined,
    async () => {
      successful.abort(reason);
      return {available: true, value: resource};
    },
    successful.signal,
  );
  assert.equal(selected.value, resource);
});
