import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {ensureEsmPackage} from '../../src/workflows/esm.js';

void test('ESM setup creates missing metadata and preserves authored fields without rewriting on reuse', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stratos-esm-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = join(dir, 'package.json');
  assert.deepEqual(await ensureEsmPackage(dir), {
    private: true,
    type: 'module',
  });
  await writeFile(
    file,
    JSON.stringify({
      name: 'test',
      scripts: {test: 'echo test'},
      dependencies: {zod: '4.6.5'},
    }),
  );
  const pkg = await ensureEsmPackage(dir);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.name, 'test');
  assert.deepEqual(pkg.scripts, {test: 'echo test'});
  assert.deepEqual(pkg.dependencies, {zod: '4.6.5'});
  const before = await stat(file);
  await ensureEsmPackage(dir);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
});

void test('explicit CommonJS and malformed package metadata fail without overwriting the file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stratos-esm-conflict-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = join(dir, 'package.json');
  for (const text of [
    '{"type":"commonjs","name":"keep"}',
    'null',
    '[]',
    '{ invalid',
  ]) {
    await writeFile(file, text);
    await assert.rejects(ensureEsmPackage(dir));
    assert.equal(await readFile(file, 'utf8'), text);
  }
});
