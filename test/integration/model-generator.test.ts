import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test, {type TestContext} from 'node:test';

import {generateMapping} from '../../scripts/models/generator.js';
import {PACKAGE_ROOT} from '../../src/paths.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'stratos-models-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=Mapping test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {encoding: 'utf8'},
    ).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), text);
  };
  git('init', '--quiet');
  write('models/author/model.toml', 'name = "Model"\n');
  write('models/author/other.toml', 'name = "Other"\n');
  write('providers/author/provider.toml', 'name = "Author"\n');
  write('providers/author/models/model.toml', 'name = "Model"\n');
  write('providers/gateway/provider.toml', 'name = "Gateway"\n');
  write(
    'providers/gateway/models/author/model.toml',
    'base_model = "author/other"\n',
  );
  write(
    'providers/gateway/models/author/model:free.toml',
    'base_model = "author/other"\n',
  );
  write('providers/gateway/models/invalid.toml', 'base_model = 42\n');
  write(
    'providers/gateway/models/missing.toml',
    'base_model = "author/absent"\n',
  );
  write('providers/gateway/models/malformed.toml', 'broken = [\n');
  symlinkSync(
    'absent.toml',
    join(root, 'providers/gateway/models/broken.toml'),
  );
  symlinkSync(
    'author/model.toml',
    join(root, 'providers/gateway/models/alias.toml'),
  );
  const commit = () => {
    git('add', '.');
    git('commit', '--quiet', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  return {root, git, write, commit, sha: commit()};
}

void test('real Git/TOML scan preserves aliases and variants, excludes inferred and broken links', t => {
  const f = fixture(t);
  const result = generateMapping(f.root, f.sha);
  assert.deepEqual(JSON.parse(JSON.stringify(result.models)), {
    'author/model': {},
    'author/other': {gateway: ['alias', 'author/model', 'author/model:free']},
  });
  assert.deepEqual(result.coverage.totals, {
    entries: 8,
    mapped: 3,
    withoutBaseModel: 1,
    invalidBaseModel: 1,
    missingCanonicalTarget: 1,
    readErrors: 1,
    parseErrors: 1,
  });
  assert.deepEqual(
    result.diagnostics.map(d => d.code),
    [
      'read_error',
      'invalid_base_model',
      'parse_error',
      'missing_canonical_target',
    ],
  );
  assert.equal(result.source.commit, f.sha);
  assert.equal(
    JSON.stringify(generateMapping(f.root, f.sha)),
    JSON.stringify(result),
  );
});

void test('rejects unpinned or mismatched source revisions', t => {
  const f = fixture(t);
  assert.throws(
    () => generateMapping(f.root, 'HEAD'),
    /full lowercase source commit SHA/,
  );
  assert.throws(
    () => generateMapping(f.root, '0'.repeat(40)),
    /does not match/,
  );
});

void test('refuses tracked and untracked source changes', t => {
  const f = fixture(t);
  f.write('models/author/model.toml', 'name = "Modified"\n');
  assert.throws(() => generateMapping(f.root, f.sha), /local changes/);
  f.git('restore', 'models/author/model.toml');
  f.write('models/author/new.toml', 'name = "New"\n');
  assert.throws(() => generateMapping(f.root, f.sha), /local changes/);
});

void test('fails generation if the canonical catalog cannot be parsed', t => {
  const f = fixture(t);
  f.write('models/author/model.toml', 'broken = [\n');
  assert.throws(
    () => generateMapping(f.root, f.commit()),
    /Invalid canonical source/,
  );
});

void test('fails generation for an incomplete source tree or undeclared provider', t => {
  const f = fixture(t);
  f.write(
    'providers/undeclared/models/model.toml',
    'base_model = "author/model"\n',
  );
  assert.throws(
    () => generateMapping(f.root, f.commit()),
    /Missing provider declaration/,
  );
  rmSync(join(f.root, 'models'), {recursive: true});
  assert.throws(
    () => generateMapping(f.root, f.commit()),
    /Expected Models.dev/,
  );
});

void test('does not read provider symlinks outside the source repository', t => {
  const f = fixture(t);
  symlinkSync(
    '/dev/null',
    join(f.root, 'providers/gateway/models/external.toml'),
  );
  const result = generateMapping(f.root, f.commit());
  assert.ok(
    result.diagnostics.some(
      d => d.source.endsWith('/external.toml') && d.code === 'read_error',
    ),
  );
});

void test('CLI writes deterministic JSON and --check detects drift without rewriting', t => {
  const f = fixture(t);
  const script = join(PACKAGE_ROOT, 'dist/scripts/models/generate.js');
  const output = join(f.root, 'generated/mapping.json');
  const args = [
    script,
    '--repo',
    f.root,
    '--commit',
    f.sha,
    '--output',
    output,
  ];
  const run = (extra: string[] = []) =>
    spawnSync(process.execPath, [...args, ...extra], {encoding: 'utf8'});
  const created = run();
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).action, 'generated');
  assert.equal(run(['--check']).status, 0);
  const expected = readFileSync(output, 'utf8');
  writeFileSync(output, '{}\n');
  const stale = run(['--check']);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /differs from source/);
  assert.equal(readFileSync(output, 'utf8'), '{}\n');
  assert.equal(run().status, 0);
  assert.equal(readFileSync(output, 'utf8'), expected);
});

void test('CLI reports invalid arguments without writing an artifact', () => {
  const script = join(PACKAGE_ROOT, 'dist/scripts/models/generate.js');
  const result = spawnSync(process.execPath, [script], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});
