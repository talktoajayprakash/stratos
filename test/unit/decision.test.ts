import assert from 'node:assert/strict';
import test from 'node:test';

import {
  choice,
  score,
  noul,
  inputSchema,
  type DecisionResult,
} from '../../src/decision/questions.js';
import {validateResponse} from '../../src/decision/response.js';

void test('Decision builders preserve structured descriptions and work outside workflow context', () => {
  const questions = {
    category: choice(null, {
      billing: {examples: ['Duplicate charge']},
      other: null,
    }),
    severity: score('How severe?', ['Low', {meaning: 'High'}]),
    evidence: noul('Enough evidence?', {true: null}),
  };
  assert.deepEqual(questions.category.criteria.billing, {
    examples: ['Duplicate charge'],
  });
  assert.deepEqual(noul(), {type: 'noul'});
  assert.equal(
    inputSchema.parse({model: 'jev-1.13.0', state: [{nested: true}], questions})
      .questions.severity?.type,
    'score',
  );
  // Compile-time assertions exercise inference, including Score's literal level keys.
  const check = (result: DecisionResult<typeof questions>) => {
    const category: 'billing' | 'other' = result.answers.category.choice;
    const level: number = result.answers.severity.probabilities['1'];
    // @ts-expect-error Unknown choices are not silently widened to strings.
    const bad: 'missing' = result.answers.category.choice;
    // @ts-expect-error Fixed two-level rubrics do not expose a third level.
    void result.answers.severity.probabilities['2'];
    return {category, level, bad};
  };
  void check;
});

void test('Decision validates content, nonempty questions and provider criteria limits', () => {
  for (const state of [
    null,
    1,
    true,
    undefined,
    {nested: NaN},
    {nested: () => 1},
  ]) {
    assert.throws(() =>
      inputSchema.parse({model: 'jev', state, questions: {yes: noul('Yes?')}}),
    );
  }
  assert.throws(() =>
    inputSchema.parse({model: 'jev', state: '', questions: {}}),
  );
  assert.throws(() => choice('', {}));
  assert.throws(() =>
    choice(
      '',
      Object.fromEntries(
        Array.from({length: 256}, (_, i) => [String(i), null]),
      ),
    ),
  );
  assert.throws(() =>
    inputSchema.parse({
      model: 'jev',
      state: '',
      questions: {score: {type: 'score', criteria: ['one']}},
    }),
  );
  assert.throws(() =>
    inputSchema.parse({
      model: 'jev',
      state: '',
      questions: {score: {type: 'score', criteria: ['one', null]}},
    }),
  );
  assert.throws(() =>
    inputSchema.parse({
      model: 'jev',
      state: '',
      questions: {score: {type: 'score', criteria: Array(11).fill('level')}},
    }),
  );
  assert.equal(
    inputSchema.parse({
      model: 'jev',
      state: '',
      questions: {yes: {type: 'noul', criteria: null}},
    }).model,
    'jev',
  );
});
void test('Decision returns provider values unchanged without probability arithmetic', () => {
  const questions = {
    category: choice('', {a: null, b: null}),
    severity: score('', ['Low', 'High']),
    yes: noul(),
  };
  const response = {
    model: 'actual',
    usage: {input_tokens: 2, output_tokens: 3},
    answers: {
      category: {
        type: 'choice',
        choice: 'a',
        confidence: 0.3,
        probabilities: {b: 0.8, a: 0.8},
      },
      severity: {
        type: 'score',
        score: 0.17,
        confidence: 0.2,
        probabilities: {'0': 0.9, '1': 0.9},
        legend: {'0': 'Low', '1': 'High'},
      },
      yes: {type: 'noul', noul: 0.8},
    },
  };
  assert.equal(validateResponse(response, questions), response);
  for (const bad of [
    {
      ...response,
      answers: {
        category: response.answers.category,
        severity: response.answers.severity,
      },
    },
    {
      ...response,
      answers: {...response.answers, yes: {...response.answers.yes, noul: 1.1}},
    },
    {
      ...response,
      answers: {
        ...response.answers,
        category: {...response.answers.category, choice: 'missing'},
      },
    },
    {
      ...response,
      answers: {
        ...response.answers,
        category: {...response.answers.category, probabilities: {a: 0.8}},
      },
    },
    {
      ...response,
      answers: {
        ...response.answers,
        severity: {...response.answers.severity, score: 2},
      },
    },
    {
      ...response,
      answers: {
        ...response.answers,
        severity: {
          ...response.answers.severity,
          legend: {'0': 'Low', '1': null},
        },
      },
    },
    {
      ...response,
      usage: {...response.usage, input_tokens: 1.5},
    },
  ]) {
    assert.throws(() => validateResponse(bad, questions));
  }
});
