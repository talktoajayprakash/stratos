import assert from 'node:assert/strict';
import test from 'node:test';

import {modelCandidates, type HarnessId} from '../../src/models/candidates.js';

// IDs here test creator/order rules, not the availability of a particular model.
const gpt = 'openai/example';
const claude = 'anthropic/example';
const gemini = 'google/example';

void test('considers every first-party pairing before any OpenCode pairing', () => {
  assert.deepEqual(modelCandidates([gpt, claude]), [
    {model: gpt, harness: 'codex'},
    {model: claude, harness: 'claude-code'},
    {model: gpt, harness: 'opencode'},
    {model: claude, harness: 'opencode'},
  ]);
});

void test('a later first-party model precedes an earlier model without a first-party harness', () => {
  assert.deepEqual(modelCandidates([gemini, claude, gpt]), [
    {model: claude, harness: 'claude-code'},
    {model: gpt, harness: 'codex'},
    {model: gemini, harness: 'opencode'},
    {model: claude, harness: 'opencode'},
    {model: gpt, harness: 'opencode'},
  ]);
});

void test('other model creators use OpenCode in the supplied order', () => {
  const models = [gemini, 'alibaba/example', 'mistralai/example'];
  assert.deepEqual(
    modelCandidates(models),
    models.map(model => ({model, harness: 'opencode'})),
  );
});

void test('an effective harness requirement restricts all candidates to that harness', () => {
  for (const harness of [
    'codex',
    'claude-code',
    'opencode',
  ] satisfies HarnessId[]) {
    assert.deepEqual(modelCandidates([gemini, claude, gpt], harness), [
      {model: gemini, harness},
      {model: claude, harness},
      {model: gpt, harness},
    ]);
  }
});

void test("candidate generation does not mutate the author's model list", () => {
  const models = Object.freeze([claude, gpt]);
  const candidates = modelCandidates(models);
  candidates.reverse();
  assert.deepEqual(models, [claude, gpt]);
  assert.deepEqual(modelCandidates([]), []);
  assert.deepEqual(modelCandidates([], 'opencode'), []);
});
