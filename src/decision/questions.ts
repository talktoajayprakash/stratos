import {z} from 'zod';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | {[key: string]: JsonValue};
export type Content = string | JsonValue[] | {[key: string]: JsonValue};
export type Description = Content | null;
export type ChoiceQuestion<
  C extends Record<string, Description> = Record<string, Description>,
> = {type: 'choice'; instructions?: Description; criteria: C};
export type ScoreQuestion<
  C extends readonly Content[] = readonly [Content, Content, ...Content[]],
> = {type: 'score'; instructions?: Description; criteria: C};
export type NoulQuestion = {
  type: 'noul';
  instructions?: Description;
  criteria?: {true?: Description; false?: Description} | null;
};
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

const content = z.union([
  z.string(),
  z.array(z.json()),
  z.record(z.string(), z.json()),
]);
const description = content.nullable();
export const questionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('choice'),
    instructions: description.optional(),
    criteria: z
      .record(z.string(), description)
      .refine(
        value =>
          Object.keys(value).length >= 1 && Object.keys(value).length <= 255,
        'Choice requires 1–255 options',
      ),
  }),
  z.strictObject({
    type: z.literal('score'),
    instructions: description.optional(),
    criteria: z.array(content).min(2).max(10),
  }),
  z.strictObject({
    type: z.literal('noul'),
    instructions: description.optional(),
    criteria: z
      .strictObject({
        true: description.optional(),
        false: description.optional(),
      })
      .nullable()
      .optional(),
  }),
]);
export const inputSchema = z.strictObject({
  model: z.string().min(1),
  state: content,
  questions: z
    .record(z.string(), questionSchema)
    .refine(
      value => Object.keys(value).length > 0,
      'Questions must not be empty',
    ),
});

/** Pure builders; no context, connection, or generated wrapper is required. */
export function choice<const C extends Record<string, Description>>(
  instructions: Description,
  criteria: C,
): ChoiceQuestion<C> {
  const result: ChoiceQuestion<C> = {type: 'choice', instructions, criteria};
  questionSchema.parse(result);
  return result;
}
export function score<
  const C extends readonly [Content, Content, ...Content[]],
>(instructions: Description, criteria: C): ScoreQuestion<C> {
  const result: ScoreQuestion<C> = {type: 'score', instructions, criteria};
  questionSchema.parse(result);
  return result;
}
export function noul(
  instructions?: Description,
  criteria?: NoulQuestion['criteria'],
): NoulQuestion {
  const result: NoulQuestion = {
    type: 'noul',
    ...(instructions !== undefined ? {instructions} : {}),
    ...(criteria !== undefined ? {criteria} : {}),
  };
  questionSchema.parse(result);
  return result;
}

export type ChoiceAnswer<K extends string> = {
  type: 'choice';
  choice: K;
  probabilities: Record<K, number>;
  confidence: number;
};
type LevelKeys<C extends readonly Content[]> = number extends C['length']
  ? string
  : Exclude<keyof C, keyof (readonly unknown[])> & string;
export type ScoreAnswer<K extends string = string> = {
  type: 'score';
  score: number;
  probabilities: Record<K, number>;
  legend: Record<K, Content>;
  confidence: number;
};
export type NoulAnswer = {type: 'noul'; noul: number};
export type Answer<Q extends Question> =
  Q extends ChoiceQuestion<infer C>
    ? ChoiceAnswer<keyof C & string>
    : Q extends ScoreQuestion<infer C>
      ? ScoreAnswer<LevelKeys<C>>
      : NoulAnswer;
export type DecisionResult<Q extends Record<string, Question>> = {
  model: string;
  answers: {[K in keyof Q]: Answer<Q[K]>};
  usage: {input_tokens: number; output_tokens: number};
};
