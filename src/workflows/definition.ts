import {z} from 'zod';

export interface WorkflowDefinition<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> {
  input: I;
  output: O;
  run(input: z.output<I>): z.input<O> | Promise<z.input<O>>;
}

export function workflow<I extends z.ZodType, O extends z.ZodType>(
  definition: WorkflowDefinition<I, O>,
): WorkflowDefinition<I, O> {
  return definition;
}

export function inspectWorkflow(definition: WorkflowDefinition) {
  if (!definition || typeof definition.run !== 'function') {
    throw new Error('Default export must be workflow({ input, output, run })');
  }
  // Zod input-mode conversion can omit transforms/refinements. Reject those before conversion.
  const visited = new Set<object>();
  const check = (value: unknown): void => {
    if (!value || typeof value !== 'object' || visited.has(value)) {
      return;
    }
    visited.add(value);
    const node = value as {_zod?: {def?: Record<string, unknown>}};
    const def = node._zod?.def;
    if (def) {
      if (def.type === 'transform' || def.check === 'custom') {
        throw new Error(
          'Public schemas cannot contain transformations or custom refinements; put these checks in run',
        );
      }
      for (const child of Object.values(def)) {
        check(child);
      }
    } else {
      for (const child of Object.values(value)) {
        check(child);
      }
    }
  };
  const convert = (schema: z.ZodType, io: 'input' | 'output') => {
    check(schema);
    const json = z.toJSONSchema(schema, {
      io,
      target: 'draft-2020-12',
      cycles: 'throw',
    });
    if (json.type !== 'object') {
      throw new Error(`${io} schema must describe an object`);
    }
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') {
        return;
      }
      const item = node as Record<string, unknown>;
      if (item.type === 'object') {
        if (io === 'input' && item.additionalProperties !== false) {
          throw new Error(
            'Input objects must reject unknown fields; use z.strictObject',
          );
        }
        for (const [key, child] of Object.entries(item.properties ?? {})) {
          if (
            !child ||
            typeof child !== 'object' ||
            typeof (child as Record<string, unknown>).description !== 'string'
          ) {
            throw new Error(`Missing description for ${io} field ${key}`);
          }
        }
      }
      for (const child of Object.values(item)) {
        if (Array.isArray(child)) {
          child.forEach(walk);
        } else {
          walk(child);
        }
      }
    };
    walk(json);
    if (io === 'input' && Object.hasOwn(json.properties ?? {}, 'overrides')) {
      throw new Error('Input field overrides is reserved');
    }
    return json;
  };
  return {
    inputSchema: convert(definition.input, 'input'),
    outputSchema: convert(definition.output, 'output'),
  };
}
