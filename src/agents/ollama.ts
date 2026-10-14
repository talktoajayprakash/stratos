import {z} from 'zod';

import {snapshotCatalog} from './availability.js';
import {ollamaModelId} from '../models/ollama.js';

export function ollamaUrl(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  let url: URL;
  try {
    url = new URL(host.includes('://') ? host : `http://${host}`);
    if (!host.includes('://') && !url.port) {
      url.port = '11434';
    }
  } catch {
    throw new Error('Invalid OLLAMA_HOST');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'OLLAMA_HOST must be an HTTP(S) origin without credentials',
    );
  }
  return url.origin;
}

const modelSchema = z.object({
  name: z.string().min(1),
  digest: z.string().min(1),
});
const detailsSchema = z.object({
  capabilities: z.array(z.string()),
  parameters: z.string().optional(),
  model_info: z.record(z.string(), z.unknown()).optional(),
  remote_model: z.string().optional(),
  remote_host: z.string().optional(),
});

export type OllamaModel = {
  id: string;
  digest: string;
  capabilities: readonly string[];
  context: number;
  output: number;
};

export class OllamaConnectionError extends Error {
  constructor(url: string, cause: unknown) {
    super(
      `Cannot reach Ollama at ${url}. Run stratos provider status ollama --json for installation/startup checks; verify OLLAMA_HOST if using another server.`,
      {cause},
    );
    this.name = 'OllamaConnectionError';
  }
}

export async function requestOllama(
  url: string,
  path: string,
  signal: AbortSignal,
  model?: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: model === undefined ? 'GET' : 'POST',
      headers: model === undefined ? {} : {'content-type': 'application/json'},
      body: model === undefined ? undefined : JSON.stringify({model}),
      redirect: 'error',
      signal,
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new OllamaConnectionError(url, error);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Ollama discovery ${path} failed (HTTP ${response.status})`,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}

/** All installed metadata, including decision-only and cloud-backed entries. */
export async function readOllamaInventory(
  baseUrl: string,
  signal?: AbortSignal,
) {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error('Invalid Ollama discovery base URL');
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('Invalid Ollama discovery base URL');
  }
  const url = base.href.replace(/\/$/, '');
  const combined = AbortSignal.any([
    AbortSignal.timeout(15000),
    ...(signal ? [signal] : []),
  ]);
  const inventory = z
    .object({models: z.array(modelSchema)})
    .parse(await requestOllama(url, '/api/tags', combined));
  const models = [];
  const ids = new Set<string>();
  for (const item of inventory.models) {
    const id = ollamaModelId(item.name);
    if (ids.has(id)) {
      throw new Error('Duplicate Ollama model in installed inventory');
    }
    ids.add(id);
    const details = detailsSchema.parse(
      await requestOllama(url, '/api/show', combined, id),
    );
    models.push(
      Object.freeze({
        ...details,
        id,
        digest: item.digest,
        capabilities: Object.freeze([...details.capabilities]),
      }),
    );
  }
  return Object.freeze(models);
}

/** Metadata only: never pulls, loads, warms or changes a model or server. */
export async function readOllamaModels(
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<readonly OllamaModel[]> {
  const inventory = await readOllamaInventory(ollamaUrl(env), signal);
  return ollamaAgentModels(inventory);
}

export function ollamaAgentModels(
  inventory: Awaited<ReturnType<typeof readOllamaInventory>>,
): readonly OllamaModel[] {
  const models: OllamaModel[] = [];
  for (const details of inventory) {
    if (
      details.remote_host ||
      details.remote_model ||
      !details.capabilities.includes('completion') ||
      !details.capabilities.includes('tools')
    ) {
      continue;
    }
    const contextParameter =
      details.parameters?.match(/^num_ctx\s+(\d+)\s*$/m)?.[1];
    const outputParameter = details.parameters?.match(
      /^num_predict\s+(-?\d+)\s*$/m,
    )?.[1];
    const info = z.record(z.string(), z.unknown()).parse(details.model_info);
    const architecture = z.string().parse(info['general.architecture']);
    const context = z
      .number()
      .int()
      .positive()
      .parse(
        contextParameter === undefined
          ? info[`${architecture}.context_length`]
          : Number(contextParameter),
      );
    const output = outputParameter === undefined ? -1 : Number(outputParameter);
    models.push({
      id: details.id,
      digest: details.digest,
      capabilities: Object.freeze([...details.capabilities]),
      context,
      // OpenCode uses zero to select its default output budget, not unlimited output.
      output:
        output === -1 ? 0 : output > 0 ? Math.min(output, context) : context,
    });
  }
  return Object.freeze(models.map(model => Object.freeze(model)));
}

export function ollamaCatalog(models: readonly OllamaModel[]) {
  return snapshotCatalog({
    provider: 'ollama',
    source: 'ollama/api/tags+show',
    complete: true,
    modelIds: models.map(model => model.id),
  });
}
