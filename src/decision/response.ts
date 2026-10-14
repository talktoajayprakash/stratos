import {z} from 'zod';

import type {Question, DecisionResult} from './questions.js';

const probability = z.number().min(0).max(1);
const answer = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), probability),
    confidence: probability,
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    probabilities: z.record(z.string(), probability),
    legend: z.record(z.string(), z.json()),
    confidence: probability,
  }),
  z.object({type: z.literal('noul'), noul: probability}),
]);
const response = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), answer),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});
const sameKeys = (actual: object, expected: string[]) =>
  Object.keys(actual).length === expected.length &&
  expected.every(key => Object.hasOwn(actual, key));

export function validateResponse<Q extends Record<string, Question>>(
  raw: unknown,
  questions: Q,
): DecisionResult<Q> {
  // Do not include a provider's raw body in diagnostic errors.
  const parsed = response.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Invalid Decision response structure or numeric range');
  }
  if (!sameKeys(parsed.data.answers, Object.keys(questions))) {
    throw new Error('Decision answer keys do not match questions');
  }
  for (const [key, question] of Object.entries(questions)) {
    const value = parsed.data.answers[key]!;
    if (value.type !== question.type) {
      throw new Error(`Decision answer type mismatch: ${key}`);
    }
    if (value.type === 'choice' && question.type === 'choice') {
      if (
        !Object.hasOwn(question.criteria, value.choice) ||
        !sameKeys(value.probabilities, Object.keys(question.criteria))
      ) {
        throw new Error(`Decision choice options mismatch: ${key}`);
      }
    }
    if (value.type === 'score' && question.type === 'score') {
      const keys = question.criteria.map((_, index) => String(index));
      if (
        value.score < 0 ||
        value.score > question.criteria.length - 1 ||
        !sameKeys(value.probabilities, keys) ||
        !sameKeys(value.legend, keys)
      ) {
        throw new Error(`Decision score levels or range mismatch: ${key}`);
      }
      for (const level of Object.values(value.legend)) {
        if (
          level === null ||
          typeof level === 'number' ||
          typeof level === 'boolean'
        ) {
          throw new Error(`Invalid Decision score legend: ${key}`);
        }
      }
    }
  }
  // Provider values are returned unchanged: no sums, normalization, or score recalculation.
  return raw as DecisionResult<Q>;
}
