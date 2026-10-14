import {SpanKind, SpanStatusCode, type Span} from '@opentelemetry/api';
import {z} from 'zod';

import {
  inputSchema,
  type Content,
  type Question,
  type DecisionResult,
} from './questions.js';
import {validateResponse} from './response.js';
import {requestDecision} from './transport.js';
import {ollamaUrl} from '../agents/ollama.js';
import {readSecretFile} from '../secrets.js';
import {getContext} from '../workflows/runtime.js';

export interface DecisionSettings {
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
}
export type DecisionOptions<Q extends Record<string, Question>> =
  DecisionSettings & {configId?: string; state: Content; questions: Q};
const settingsSchema = z.strictObject({
  model: z.string().min(1),
  provider: z.enum(['jev', 'ollama']).default('jev'),
  baseUrl: z.url().optional(),
  apiKey: z
    .string()
    .regex(
      /^\{(env|file):[^{}]+\}$/,
      'Decision apiKey must be an env/file reference',
    )
    .optional(),
});

async function credential(reference: string, root: string): Promise<string> {
  const match = /^\{(env|file):([^{}]+)\}$/.exec(reference)!;
  let value: string | undefined;
  if (match[1] === 'env') {
    value = process.env[match[2]!];
  } else {
    try {
      value = await readSecretFile(match[2]!, root, info => {
        if (
          !info.isFile() ||
          (process.getuid && info.uid !== process.getuid())
        ) {
          throw new Error('permissions');
        }
      });
    } catch {
      throw new Error(
        'Cannot read Decision credential file; check path and owner-only permissions',
      );
    }
  }
  if (!value || /[\r\n]/.test(value)) {
    throw new Error('Missing or invalid Decision credential');
  }
  return value;
}

export function decision<const Q extends Record<string, Question>>(
  options: DecisionOptions<Q>,
): Promise<DecisionResult<Q>> {
  const owner = getContext();
  const abort = new AbortController();
  let pending: Promise<DecisionResult<Q>>;
  const resource = {
    async close() {
      abort.abort(new Error('Decision execution cancelled'));
      await pending.catch(() => {});
    },
  };
  owner.resources.add(resource);
  pending = Promise.resolve().then(async () => {
    let span: Span | undefined;
    const telemetry = (fn: () => void) => {
      try {
        fn();
      } catch {
        try {
          console.error('Decision telemetry failed');
        } catch {
          // Diagnostic failures must not change the inference result.
        }
      }
    };
    try {
      const {configId, state, questions, ...call} = options;
      const configs = z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .parse(owner.workflow?.decision ?? {});
      if (configId !== undefined && !Object.hasOwn(configs, configId)) {
        throw new Error(`Unknown Decision config: ${configId}`);
      }
      const configured =
        configId === undefined
          ? {}
          : {...configs[configId], ...owner.overrides.decision?.[configId]};
      const settings = settingsSchema.parse({
        ...configured,
        ...Object.fromEntries(
          Object.entries(call).filter(([, value]) => value !== undefined),
        ),
      });
      if (settings.provider === 'jev' && settings.apiKey === undefined) {
        throw new Error('Decision Jev provider requires an apiKey reference');
      }
      const input = inputSchema.parse({
        model: settings.model,
        state,
        questions,
      });
      const base = new URL(
        settings.baseUrl ??
          (settings.provider === 'ollama'
            ? ollamaUrl()
            : 'https://api.typesafe.ai'),
      );
      if (
        !['http:', 'https:'].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      ) {
        throw new Error('Invalid Decision baseUrl');
      }
      const endpoint = new URL(`${base.href.replace(/\/$/, '')}/v1/systemone`);
      telemetry(() => {
        const content = JSON.stringify({
          state: input.state,
          questions: input.questions,
        });
        span = owner.telemetry.tracer.startSpan(
          `decision ${settings.model}`,
          {
            kind: SpanKind.CLIENT,
            attributes: {
              'gen_ai.operation.name': 'decision',
              'gen_ai.provider.name': settings.provider,
              'gen_ai.request.model': settings.model,
              'stratos.workflow.name': owner.name,
              'stratos.workflow.execution.id': owner.id,
              // OpenInference content attributes preserve structured decisions without invented chat roles.
              'openinference.span.kind': 'LLM',
              'input.mime_type': 'application/json',
              'input.value': content,
              'stratos.decision.input': content,
              'stratos.timing.scope':
                'Decision invocation: credential resolution, request attempts, retry waits, response validation',
            },
          },
          owner.traceContext,
        );
      });
      // Ollama does not use Jev credentials, including inherited configuration.
      const apiKey =
        settings.provider === 'jev' && settings.apiKey !== undefined
          ? await credential(
              settings.apiKey,
              owner.workflow?.path ?? owner.workingDirectory,
            )
          : undefined;
      if (apiKey !== undefined) {
        owner.telemetry.addSecret(apiKey);
      }
      abort.signal.throwIfAborted();
      const raw = await requestDecision(endpoint, apiKey, input, abort.signal);
      const result = validateResponse(raw, questions);
      telemetry(() => {
        const content = JSON.stringify(result.answers);
        span?.setAttributes({
          'gen_ai.response.model': result.model,
          'gen_ai.usage.input_tokens': result.usage.input_tokens,
          'gen_ai.usage.output_tokens': result.usage.output_tokens,
          'output.mime_type': 'application/json',
          'output.value': content,
          'stratos.decision.output': content,
          'stratos.completion.status': 'success',
        });
        span?.setStatus({code: SpanStatusCode.OK});
      });
      return result;
    } catch (error) {
      telemetry(() => {
        const message =
          error instanceof Error ? error.message : 'Decision failed';
        if (abort.signal.aborted) {
          span?.setAttributes({
            'stratos.completion.status': 'cancelled',
            'stratos.completion.reason': message,
          });
        } else {
          span?.setAttributes({
            'stratos.completion.status': 'error',
            'error.type': error instanceof Error ? error.name : 'Error',
          });
          if (error instanceof Error) {
            span?.recordException(error);
          }
          span?.setStatus({code: SpanStatusCode.ERROR, message});
        }
      });
      throw error;
    } finally {
      owner.resources.delete(resource);
      telemetry(() => span?.end());
    }
  });
  return pending;
}
