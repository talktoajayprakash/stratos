import type {HarnessId} from '../models/candidates.js';
import {loadCatalog} from '../models/catalog.js';
import {providerModelId} from '../models/mapping.js';
import {ollamaModelId} from '../models/ollama.js';

/** Only integrations with model-specific native evidence may construct this. */
export class ModelUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelUnavailableError';
  }
}

export type ModelCatalog = Readonly<{
  provider: string;
  source: string;
  modelIds: readonly string[];
  complete: boolean;
}>;

export type HarnessReadiness =
  | {available: true; catalogs: readonly ModelCatalog[]}
  | {
      available: false;
      reason: 'harness-missing' | 'authentication-missing';
      error: Error;
    };

/** Synchronous control evidence, separate from best-effort event delivery. */
export type ProgressOptions = {onProgress?: () => void};
export type ModelSupport = Readonly<{
  eligible: boolean;
  status:
    | 'incompatible-harness'
    | 'missing-mapping'
    | 'listed'
    | 'not-listed'
    | 'unknown';
  source: string;
  provider?: string;
  nativeModel?: string;
}>;

export function snapshotCatalog(catalog: ModelCatalog): ModelCatalog {
  if (
    !catalog ||
    typeof catalog.provider !== 'string' ||
    !catalog.provider.trim() ||
    typeof catalog.source !== 'string' ||
    !catalog.source.trim() ||
    typeof catalog.complete !== 'boolean' ||
    !Array.isArray(catalog.modelIds) ||
    catalog.modelIds.some(id => typeof id !== 'string' || !id.trim())
  ) {
    throw new TypeError('Invalid harness model catalog');
  }
  return Object.freeze({
    provider: catalog.provider,
    source: catalog.source,
    complete: catalog.complete,
    modelIds: Object.freeze([...new Set(catalog.modelIds)]),
  });
}

export function catalogSupport(
  pair: {model: string; harness: HarnessId},
  catalog: ModelCatalog,
): ModelSupport {
  const creator = {
    'claude-code': 'anthropic',
    codex: 'openai',
    opencode: undefined,
  }[pair.harness];
  if (
    catalog.provider === 'ollama'
      ? pair.harness === 'claude-code'
      : creator && pair.model.split('/')[0] !== creator
  ) {
    return {
      eligible: false,
      status: 'incompatible-harness',
      source: 'harness-capabilities',
    } as const;
  }
  const nativeModel =
    catalog.provider === 'ollama'
      ? ollamaModelId(pair.model)
      : providerModelId(loadCatalog().models, pair.model, catalog.provider);
  if (nativeModel === undefined) {
    return {
      eligible: false,
      status: 'missing-mapping',
      source: 'packaged-provider-mapping',
      provider: catalog.provider,
    } as const;
  }
  const listed = catalog.modelIds.includes(nativeModel);
  return {
    eligible: listed || !catalog.complete,
    status: listed ? 'listed' : catalog.complete ? 'not-listed' : 'unknown',
    source: catalog.source,
    provider: catalog.provider,
    nativeModel,
  } as const;
}

export function isMissingExecutable(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'MODULE_NOT_FOUND')
  );
}
