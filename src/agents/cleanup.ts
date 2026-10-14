import type {AgentAdapter} from './adapter.js';

/** Internal cleanup coordination. The owner must stop admitting work first. */
export async function closeAgentAdapters(
  adapters: Iterable<Pick<AgentAdapter, 'close'>>,
  report: (error: unknown) => void,
): Promise<void> {
  const results = await Promise.allSettled(
    Array.from(adapters, adapter =>
      Promise.resolve().then(() => adapter.close()),
    ),
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      try {
        report(result.reason);
      } catch {
        /* Diagnostics must not replace the execution outcome. */
      }
    }
  }
}
