import {mkdir, realpath} from 'node:fs/promises';
import type {TestContext} from 'node:test';

import {waitForRetention} from './retention.js';
import {RunArtifacts} from '../../src/telemetry/artifacts.js';

/** Isolate artifacts without moving native login/configuration directories. */
export async function isolateArtifacts(
  t: TestContext,
  directory: string,
): Promise<() => Promise<void>> {
  await mkdir(directory, {recursive: true});
  const home = await realpath(directory);
  const create = RunArtifacts.create;
  t.mock.method(
    RunArtifacts,
    'create',
    (...[workspace, name, id, telemetry]: Parameters<typeof create>) =>
      create(workspace, name, id, telemetry, home),
  );
  return () => waitForRetention(home);
}
