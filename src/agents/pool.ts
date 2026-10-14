import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {z} from 'zod';

export class AgentPool {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(
    private readonly concurrent = 10,
    private readonly outstanding = 100,
  ) {}
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    if (this.running + this.queue.length >= this.outstanding) {
      return Promise.reject(new Error('Agent outstanding limit reached'));
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.queue = this.queue.filter(item => item !== start);
        reject(signal.reason);
      };
      const start = () => {
        signal.removeEventListener('abort', abort);
        this.running++;
        let released = false;
        resolve(() => {
          if (released) {
            return;
          }
          released = true;
          this.running--;
          this.queue.shift()?.();
        });
      };
      if (this.running < this.concurrent) {
        start();
      } else {
        this.queue.push(start);
        signal.addEventListener('abort', abort, {once: true});
      }
    });
  }
}
export async function loadAgentPool(): Promise<AgentPool> {
  let settings;
  try {
    settings = JSON.parse(
      await readFile(join(homedir(), '.stratos/settings.json'), 'utf8'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const limits = z
    .object({
      maxConcurrent: z.number().int().positive().default(10),
      maxOutstanding: z.number().int().positive().default(100),
    })
    .parse(settings?.agents ?? {});
  return new AgentPool(limits.maxConcurrent, limits.maxOutstanding);
}
