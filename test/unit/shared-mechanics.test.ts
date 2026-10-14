import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, open, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {acquireFileLock, withFileLock} from '../../src/file-lock.js';
import {referencedMcps} from '../../src/mcp/generate.js';
import {
  interpolateSecretReferences,
  readSecretFile,
} from '../../src/secrets.js';
import {referencedImports} from '../../src/workflows/imports.js';

void test('import traversal follows helpers and re-exports without evaluating modules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stratos-imports-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'workflow');
  await mkdir(join(path, 'generated/mcp'), {recursive: true});
  const workflow = {
    path,
    root,
    name: 'test',
    shortDescription: 'Test fixture',
    longDescription: 'Exercise this test fixture with schema-valid input.',
    version: '1',
    entrypoint: 'workflow.ts',
  };
  await writeFile(
    join(path, 'workflow.ts'),
    `
    throw new Error('must not execute');
    import './helper.js';
    export * from './generated/mcp/direct.js';
    import type {Input} from './generated/mcp/types.js';
    export type {Output} from './generated/mcp/exported-types.js';
    import type Child from '../.generated/child.js';
    import '../outside.js';
    import './missing.js';
    import './generated/ignored.js';
    import('dynamic-import-is-not-a-static-dependency');
  `,
  );
  await writeFile(
    join(path, 'helper.ts'),
    `
    import './workflow.js';
    export {default} from './generated/mcp/helper.js';
  `,
  );
  await writeFile(join(root, 'outside.ts'), 'not valid TypeScript !!!');
  await writeFile(
    join(path, 'generated/ignored.ts'),
    'not valid TypeScript !!!',
  );
  assert.deepEqual(await referencedMcps(workflow), ['helper', 'direct']);
  assert.deepEqual(
    await referencedImports(workflow, join(path, 'generated/mcp'), true),
    ['helper', 'direct', 'types', 'exported-types'].map(name =>
      join(path, 'generated/mcp', name + '.js'),
    ),
  );
  assert.deepEqual(
    await referencedImports(workflow, join(root, '.generated'), true),
    [join(root, '.generated/child.js')],
  );
  await writeFile(join(path, 'helper.ts'), 'invalid TypeScript !!!');
  await assert.rejects(referencedMcps(workflow), SyntaxError);
});

void test('secret mechanics preserve literal text, ordering, empty references and caller validation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stratos-secret-mechanics-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'secret'), ' fixture \n', {mode: 0o600});
  const calls: string[] = [];
  assert.equal(
    await interpolateSecretReferences(
      'prefix {env:EMPTY}:{file:secret}:{env:VALUE} {unknown:literal}',
      async (kind, name) => {
        calls.push(`${kind}:${name}`);
        return kind === 'file'
          ? readSecretFile(name, root)
          : name === 'EMPTY'
            ? ''
            : 'value';
      },
    ),
    'prefix :fixture:value {unknown:literal}',
  );
  assert.deepEqual(calls, ['env:EMPTY', 'file:secret', 'env:VALUE']);
  const failure = new Error('caller-specific validation');
  await assert.rejects(
    readSecretFile('secret', root, () => {
      throw failure;
    }),
    error => error === failure,
  );
  await chmod(join(root, 'secret'), 0o644);
  await assert.rejects(readSecretFile('secret', root), /owner-only/);
  await assert.rejects(readSecretFile('missing', root), {code: 'ENOENT'});
  await assert.rejects(
    interpolateSecretReferences('{env:MISSING}', async () => {
      throw failure;
    }),
    error => error === failure,
  );
});

void test('file lock mechanics retain caller deadlines, cancellation and release after failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stratos-lock-mechanics-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = join(root, 'lock');
  const first = await open(file, 'w', 0o600);
  const second = await open(file, 'r+');
  t.after(async () => {
    await first.close();
    await second.close();
  });
  await acquireFileLock(first);
  await assert.rejects(acquireFileLock(second, undefined, 0), /timed out/);
  const abort = new AbortController();
  const waiting = acquireFileLock(second, abort.signal);
  const reason = new Error('stop waiting');
  abort.abort(reason);
  await assert.rejects(
    waiting,
    error =>
      error === reason || (error instanceof Error && error.cause === reason),
  );
  await first.close();
  await acquireFileLock(second);
  await second.close();
  const failure = new Error('action failed');
  await assert.rejects(
    withFileLock(file, async () => {
      throw failure;
    }),
    error => error === failure,
  );
  assert.equal(await withFileLock(file, async () => 'released'), 'released');
  const raced = await open(join(root, 'race.lock'), 'w', 0o600);
  t.after(() => raced.close());
  const cancelled = new AbortController();
  const handle = new Proxy(raced, {
    get(target, property, receiver) {
      if (property === 'fd') {
        cancelled.abort(reason);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  await assert.rejects(
    acquireFileLock(handle, cancelled.signal),
    error => error === reason,
  );
});

void test('retention helper imports do not change the home or register home cleanup', async () => {
  const home = process.env.HOME;
  const {waitForRetention} = await import('../helpers/retention.js');
  assert.equal(process.env.HOME, home);
  await waitForRetention(join(tmpdir(), 'stratos-no-retention-process'));
  assert.equal(process.env.HOME, home);
});
