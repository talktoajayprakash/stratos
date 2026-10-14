import {execFile} from 'node:child_process';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';

const exec = promisify(execFile);

export async function waitForRetention(home: string): Promise<void> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const {stdout} = await exec('ps', ['-Ao', 'command=']);
    if (
      !stdout
        .split('\n')
        .some(
          line =>
            line.includes('retention.js') &&
            line.includes(join(home, '.stratos/runs')),
        )
    ) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('Owned retention process did not exit');
    }
    await delay(25);
  }
}
