import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after} from 'node:test';

import {waitForRetention as waitForHomeRetention} from './retention.js';
export const testHome = await realpath(
  await mkdtemp(join(tmpdir(), 'stratos-test-home-')),
);
const original = process.env.HOME;
process.env.HOME = testHome;

export function waitForRetention(home = testHome): Promise<void> {
  return waitForHomeRetention(home);
}

after(async () => {
  try {
    await waitForRetention();
  } finally {
    if (original === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = original;
    }
    await rm(testHome, {recursive: true, force: true});
  }
});
