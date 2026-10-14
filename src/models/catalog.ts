import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {z} from 'zod';

import {PACKAGE_ROOT} from '../paths.js';
import {type MappingSnapshot, providerModelId} from './mapping.js';
import {ollamaModelId} from './ollama.js';

const providerSchema = z.strictObject({
  formatVersion: z.literal(1),
  codex: z.strictObject({
    providers: z.record(z.string(), z.string().min(1)),
  }),
  claude: z.strictObject({
    backendFlags: z.array(z.string()),
    providers: z.record(
      z.string(),
      z.strictObject({env: z.record(z.string(), z.string())}),
    ),
  }),
});

export interface Catalog {
  models: MappingSnapshot;
  providers: z.infer<typeof providerSchema>;
}

/** The packaged catalog is shared by CLI startup and internal adapters. No network reads. */
export function readCatalog(directory: string): Catalog {
  const models = JSON.parse(
    readFileSync(join(directory, 'model-mapping.v1.json'), 'utf8'),
  );
  z.object({
    formatVersion: z.literal(1),
    policy: z.literal('explicit-base-model-only'),
    models: z.record(z.string(), z.record(z.string(), z.array(z.string()))),
  }).parse(models);
  const providers = providerSchema.parse(
    JSON.parse(
      readFileSync(join(directory, 'provider-mapping.v1.json'), 'utf8'),
    ),
  );
  return {models, providers};
}

let catalog: Catalog | undefined;
export function loadCatalog(): Catalog {
  return (catalog ??= readCatalog(join(PACKAGE_ROOT, 'data/models')));
}

export function resolveNativeModel(
  canonicalId: string,
  provider: string,
): string {
  if (provider === 'ollama') {
    return ollamaModelId(canonicalId);
  }
  const id = providerModelId(loadCatalog().models, canonicalId, provider);
  if (id === undefined) {
    throw new Error(
      `No declared native model mapping for ${canonicalId} through ${provider}`,
    );
  }
  return id;
}

/** Select only native backend flags; credentials and account settings stay with the harness. */
export function claudeProviderEnvironment(
  provider: string | undefined,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (provider === undefined) {
    return {...environment};
  }
  const {claude} = loadCatalog().providers;
  if (!Object.hasOwn(claude.providers, provider)) {
    throw new Error(`No Claude Code provider mapping for ${provider}`);
  }
  const result = {...environment};
  // Explicit zero overrides SDK/native inherited environment without mutating process.env.
  for (const flag of claude.backendFlags) {
    result[flag] = '0';
  }
  return Object.assign(result, claude.providers[provider]!.env);
}
