import {setTimeout as delay} from 'node:timers/promises';

/** Shared wire API. Validation happens after this function, outside retries. */
export async function requestDecision(
  url: URL,
  apiKey: string | undefined,
  body: unknown,
  signal: AbortSignal,
  timeoutMs = 60_000,
  retryDelayMs = 1_000,
): Promise<unknown> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; attempt < 4; attempt++) {
    signal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error('Decision request timed out')),
      timeoutMs,
    );
    const combined = AbortSignal.any([signal, timeout.signal]);
    let retry = false;
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            ...(apiKey === undefined
              ? {}
              : {Authorization: `Bearer ${apiKey}`}),
            'Content-Type': 'application/json',
          },
          body: payload,
          signal: combined,
          redirect: 'error',
        });
      } catch {
        signal.throwIfAborted();
        if (attempt === 3) {
          throw new Error(
            timeout.signal.aborted
              ? 'Decision request timed out'
              : 'Decision request failed',
          );
        }
        retry = true;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const transient =
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        if (!transient || attempt === 3) {
          throw new Error(`Decision request failed (HTTP ${response.status})`);
        }
        retry = true;
        continue;
      }
      try {
        return await response.json();
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof SyntaxError) && attempt < 3) {
          retry = true;
          continue;
        }
        // Malformed response data is not retried. Do not echo provider bodies or credentials.
        throw new Error(
          timeout.signal.aborted
            ? 'Decision request timed out'
            : 'Invalid Decision JSON response',
        );
      }
    } finally {
      clearTimeout(timer);
      if (retry) {
        await delay(retryDelayMs, undefined, {signal});
      }
    }
  }
  throw new Error('Decision request failed');
}
