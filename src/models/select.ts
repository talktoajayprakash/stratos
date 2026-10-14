import {
  modelCandidates,
  type HarnessId,
  type ModelCandidate,
} from './candidates.js';

/** Adapters classify only established availability failures into these reasons.
 * Other errors must be thrown unchanged, never classified by message matching.
 */
export type UnavailableReason =
  'model-unavailable' | 'harness-missing' | 'authentication-missing';
export type CandidateAttempt<T> =
  | {available: true; value: T}
  | {available: false; reason: UnavailableReason; error: Error};

/** Internal initial selection only; never used to recover an active conversation.
 * A failed attempt must release its partial resources before returning/throwing.
 */
export async function selectModel<T>(
  models: readonly string[],
  harness: HarnessId | undefined,
  attempt: (candidate: ModelCandidate) => Promise<CandidateAttempt<T>>,
  signal?: AbortSignal,
): Promise<{candidate: ModelCandidate; value: T}> {
  const failures: Error[] = [];
  for (const candidate of modelCandidates(models, harness)) {
    signal?.throwIfAborted();
    const result = await attempt(candidate);
    // Transfer successful ownership even if cancellation arrived during the
    // attempt: the caller must close that resource, rather than lose its handle.
    if (result.available) {
      return {candidate, value: result.value};
    }
    if (
      result.reason !== 'model-unavailable' &&
      result.reason !== 'harness-missing' &&
      result.reason !== 'authentication-missing'
    ) {
      throw result.error;
    }
    failures.push(result.error);
  }
  signal?.throwIfAborted();
  throw new AggregateError(
    failures,
    'No requested model/harness combination is available',
  );
}
