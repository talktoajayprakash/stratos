import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';

import {stringify} from 'yaml';

import {
  discover,
  readWorkflow,
  selectWorkflow,
  workflowHash,
} from '../../src/workflows/discovery.js';
import {testHome} from '../helpers/home.js';

for (const [field, maximum] of [
  ['shortDescription', 400],
  ['longDescription', 12_000],
] as const) {
  void test(`${field} validates presence, type and Unicode boundaries without truncation`, async t => {
    const directory = await mkdtemp(join(testHome, 'description-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const file = join(directory, 'workflow.yaml');
    const manifest = {
      name: 'description',
      shortDescription: 'Select this fixture.',
      longDescription: 'Use the fixture with valid input.',
      version: '1',
    };
    const save = (value: unknown) =>
      writeFile(file, stringify({...manifest, [field]: value}));
    for (const value of [
      'a',
      'x'.repeat(maximum),
      '\u{1f680}'.repeat(maximum),
      ' x ',
    ]) {
      await save(value);
      assert.equal((await readWorkflow(directory))[field], value);
    }
    for (const value of [
      undefined,
      null,
      42,
      {},
      [],
      '',
      ' \t\r\n\u2003',
      'x'.repeat(maximum + 1),
      '\u{1f680}'.repeat(maximum + 1),
      'x'.repeat(maximum) + ' ',
    ]) {
      await save(value);
      await assert.rejects(readWorkflow(directory), error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(file));
        assert.ok(error.message.includes(field));
        if (typeof value === 'string' && [...value].length > maximum) {
          assert.ok(error.message.includes(`${maximum + 1} characters`));
          assert.ok(error.message.includes(`maximum is ${maximum}`));
        }
        return true;
      });
    }
  });
}

void test('short descriptions reject internal breaks and preserve folded YAML; manuals allow Markdown', async t => {
  const directory = await mkdtemp(join(testHome, 'paragraph-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = join(directory, 'workflow.yaml');
  await writeFile(
    file,
    'name: paragraph\nshortDescription: >\n  Choose this\n  workflow.\nlongDescription: |\n  ## Usage\n\n  Supply valid input.\nversion: "1"\n',
  );
  const parsed = await readWorkflow(directory);
  assert.equal(parsed.shortDescription, 'Choose this workflow.\n');
  assert.equal(parsed.longDescription, '## Usage\n\nSupply valid input.\n');
  for (const separator of ['\n', '\r', '\r\n', '\u0085', '\u2028', '\u2029']) {
    await writeFile(
      file,
      stringify({...parsed, shortDescription: `First${separator}Second`}),
    );
    await assert.rejects(readWorkflow(directory), /single paragraph/);
  }
});

void test('legacy description is rejected even alongside both new fields', async t => {
  const directory = await mkdtemp(join(testHome, 'legacy-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const fields of [
    {},
    {shortDescription: 'Select fixture.', longDescription: 'Use valid input.'},
  ]) {
    await writeFile(
      join(directory, 'workflow.yaml'),
      stringify({
        name: 'legacy',
        description: 'Old text',
        version: '1',
        ...fields,
      }),
    );
    await assert.rejects(
      readWorkflow(directory),
      /description was removed; replace it with shortDescription and an author-written longDescription/,
    );
  }
});

void test('discovery reports invalid and duplicate manifests, skips generated directories and rejects escaping entries', async t => {
  const cwd = await mkdtemp(join(testHome, 'discovery-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  assert.deepEqual(await discover(cwd, true), {workflows: [], errors: []});
  const root = join(cwd, '.stratos/workflows');
  for (const [directory, name] of [
    ['first', 'duplicate'],
    ['second', 'duplicate'],
    ['valid', 'valid'],
    ['.hidden', 'hidden'],
    ['node_modules', 'dependencies'],
  ]) {
    const path = join(root, directory!);
    await mkdir(path, {recursive: true});
    await writeFile(
      join(path, 'workflow.yaml'),
      `name: ${name}\nshortDescription: Fixture\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: '1'\n`,
    );
  }
  await mkdir(join(root, 'missing'));
  await mkdir(join(root, 'broken'));
  await writeFile(join(root, 'broken/workflow.yaml'), 'name: [');
  await writeFile(join(root, 'not-a-directory'), '');
  const found = await discover(cwd, true);
  assert.deepEqual(
    found.workflows.map(workflow => workflow.name),
    ['valid'],
  );
  assert.equal(found.errors.length, 2);
  assert.ok(
    found.errors.every(error => error.code === 'WORKFLOW_CONFIG_ERROR'),
  );
  await assert.rejects(
    selectWorkflow(cwd, 'duplicate'),
    /Duplicate workflow name/,
  );
  await assert.rejects(selectWorkflow(cwd, 'absent'), /not found/);
  assert.equal(
    (await selectWorkflow(cwd, './.stratos/workflows/valid')).name,
    'valid',
  );
  await writeFile(
    join(root, 'valid/workflow.yaml'),
    'name: valid\nshortDescription: Fixture\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: "1"\nentrypoint: ../outside.ts\n',
  );
  await assert.rejects(
    readWorkflow(join(root, 'valid')),
    /Entrypoint must be inside/,
  );
});

void test('discovery requires explicit paths for cross-root ambiguity and hashes only authored content', async t => {
  const cwd = await mkdtemp(join(testHome, 'discovery-roots-'));
  const global = join(testHome, '.stratos/workflows/ambiguous');
  t.after(() => rm(cwd, {recursive: true, force: true}));
  t.after(() => rm(global, {recursive: true, force: true}));
  const local = join(cwd, '.stratos/workflows/ambiguous');
  for (const path of [local, global]) {
    await mkdir(path, {recursive: true});
    await writeFile(
      join(path, 'workflow.yaml'),
      'name: ambiguous\nshortDescription: Fixture\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: "1"\n',
    );
  }
  await assert.rejects(selectWorkflow(cwd, 'ambiguous'), /Ambiguous workflow/);
  assert.equal((await discover(cwd, true)).workflows.length, 1);
  const initial = await workflowHash(local);
  for (const ignored of [
    'dist',
    'generated',
    '.generated',
    'node_modules',
    '.git',
  ]) {
    await mkdir(join(local, ignored));
    await writeFile(join(local, ignored, 'ignored'), 'not authored');
  }
  assert.equal(await workflowHash(local), initial);
  await mkdir(join(local, 'helpers'));
  await writeFile(join(local, 'helpers/source.ts'), 'export const value = 1;');
  assert.notEqual(await workflowHash(local), initial);
});
