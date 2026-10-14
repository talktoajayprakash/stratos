import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

import Handlebars from 'handlebars';
import {z} from 'zod';

import type {AgentHooks} from './hooks.js';
import {harnessTools} from './native.js';

const source = z.union([
  z.string(),
  z.strictObject({file: z.string()}),
  z.strictObject({template: z.string()}),
]);
export type Prompt = z.infer<typeof source>;
export type PromptSource = Prompt | {configId: string};
const variables = z.record(z.string(), z.unknown());
/** Canonical tool names and every harness's own tool names. */
const toolNames = [
  ...new Set(Object.values(harnessTools).flatMap(tools => Object.keys(tools))),
] as [string, ...string[]];

export const agentSettings = z.strictObject({
  configId: z.string().optional(),
  model: z.array(z.string().min(1)).min(1),
  harness: z.enum(['claude-code', 'codex', 'opencode']).optional(),
  provider: z.string().optional(),
  effort: z.string().optional(),
  systemPrompt: source.optional(),
  prompt: source.optional(),
  templateVariables: z
    .strictObject({
      systemPrompt: variables.optional(),
      prompt: variables.optional(),
    })
    .optional(),
  worktree: z
    .strictObject({
      enabled: z.boolean(),
      name: z.string().optional(),
      cleanup: z.boolean().optional(),
    })
    .optional(),
  workingDirectory: z.string().optional(),
  allowedMcps: z.array(z.string()).optional(),
  allowedTools: z.array(z.enum(toolNames)).optional(),
  disallowedTools: z.array(z.enum(toolNames)).optional(),
  hooks: z.custom<AgentHooks>().optional(),
  outputSchema: z.custom<z.ZodType>().optional(),
});
export type AgentOptions<S extends z.ZodType = z.ZodString> = Partial<
  Omit<z.infer<typeof agentSettings>, 'outputSchema'>
> & {outputSchema?: S};

export function mergeAgentSettings(
  ...layers: Array<Record<string, unknown>>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const templates: Record<string, Record<string, unknown>> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    if (layer.templateVariables !== undefined) {
      const parsed = z
        .record(z.string(), variables)
        .parse(layer.templateVariables);
      for (const [field, values] of Object.entries(parsed)) {
        templates[field] = {...templates[field], ...values};
      }
    }
  }
  if (Object.keys(templates).length) {
    result.templateVariables = templates;
  }
  return result;
}

export async function renderPrompt(
  prompt: Prompt,
  root: string,
  values: Record<string, unknown> = {},
): Promise<string> {
  prompt = source.parse(prompt);
  if (typeof prompt === 'string') {
    return prompt;
  }
  const text = await readFile(
    resolve(root, 'file' in prompt ? prompt.file : prompt.template),
    'utf8',
  );
  return 'template' in prompt
    ? Handlebars.compile(text, {strict: true, noEscape: true})(values)
    : text;
}
