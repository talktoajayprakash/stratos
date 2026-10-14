import {z} from 'zod';

const span = z.looseObject({
  name: z.string(),
  spanId: z.string(),
  traceId: z.string(),
  parentSpanId: z.string().optional(),
  status: z.object({code: z.number().optional()}),
  attributes: z.array(
    z.object({
      key: z.string(),
      value: z.looseObject({
        stringValue: z.string().optional(),
        intValue: z.union([z.string(), z.number()]).optional(),
      }),
    }),
  ),
});
const payloadSchema = z.object({
  resourceSpans: z.array(
    z.object({
      scopeSpans: z.array(z.object({spans: z.array(span)})),
    }),
  ),
});

export function traceSpans(payload: unknown) {
  return payloadSchema
    .parse(payload)
    .resourceSpans.flatMap(resource =>
      resource.scopeSpans.flatMap(scope => scope.spans),
    );
}
