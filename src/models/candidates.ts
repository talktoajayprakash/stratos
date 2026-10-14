/** Internal MVP identifiers; this module does not discover or initialize harnesses. */
export type HarnessId = 'claude-code' | 'codex' | 'opencode';

export interface ModelCandidate {
  model: string;
  harness: HarnessId;
}

/**
 * Order candidates for already validated canonical IDs and a resolved harness setting.
 * This does not check availability or attempt any candidate.
 */
export function modelCandidates(
  models: readonly string[],
  requiredHarness?: HarnessId,
): ModelCandidate[] {
  if (requiredHarness !== undefined) {
    return models.map(model => ({model, harness: requiredHarness}));
  }

  const candidates: ModelCandidate[] = [];
  for (const model of models) {
    const creator = model.split('/')[0];
    if (creator === 'anthropic') {
      candidates.push({model, harness: 'claude-code'});
    } else if (creator === 'openai') {
      candidates.push({model, harness: 'codex'});
    }
  }
  for (const model of models) {
    candidates.push({model, harness: 'opencode'});
  }
  return candidates;
}
