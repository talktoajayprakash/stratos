/** Internal catalog format, not a Stratos SDK or adapter API. */
export interface Counts {
  entries: number;
  mapped: number;
  withoutBaseModel: number;
  invalidBaseModel: number;
  missingCanonicalTarget: number;
  readErrors: number;
  parseErrors: number;
}

export interface MappingSnapshot {
  formatVersion: 1;
  policy: 'explicit-base-model-only';
  source: {repository: string; commit: string; commitDate: string};
  models: Record<string, Record<string, string[]>>;
  coverage: {
    canonicalModels: number;
    mappedCanonicalModels: number;
    providers: Record<string, Counts>;
    totals: Counts;
  };
  diagnostics: Array<{
    source: string;
    code:
      | 'read_error'
      | 'parse_error'
      | 'invalid_base_model'
      | 'missing_canonical_target';
  }>;
}

/** All declared IDs, including variants. This does not select a route. */
export function providerModelIds(
  snapshot: MappingSnapshot,
  canonicalId: string,
  provider: string,
): readonly string[] {
  if (!Object.hasOwn(snapshot.models, canonicalId)) {
    return [];
  }
  const providers = snapshot.models[canonicalId]!;
  return Object.hasOwn(providers, provider) ? providers[provider]! : [];
}

/** MVP: arbitrary native-ID selection is approved. Preserve snapshot order for repeatability. */
export function providerModelId(
  snapshot: MappingSnapshot,
  canonicalId: string,
  provider: string,
): string | undefined {
  return providerModelIds(snapshot, canonicalId, provider)[0];
}

/** Provider-qualified lookup: a native model ID alone is not globally unique. */
export function canonicalModelId(
  snapshot: MappingSnapshot,
  provider: string,
  modelId: string,
): string | undefined {
  for (const canonicalId of Object.keys(snapshot.models)) {
    if (providerModelIds(snapshot, canonicalId, provider).includes(modelId)) {
      return canonicalId;
    }
  }
  return undefined;
}
