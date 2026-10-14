import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  access,
  readFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {
  acquireWorktree,
  withWorktreeLock,
} from '../../src/git/worktrees/index.js';
import {adjectives, nouns} from '../../src/git/worktrees/names.js';
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', ['-C', cwd, ...args])).stdout.trim();
async function repository(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'stratos-worktrees-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await git(root, 'config', 'user.name', 'Fixture');
  await writeFile(join(root, 'file'), 'base');
  await git(root, 'add', 'file');
  await git(root, 'commit', '-m', 'base');
  return root;
}

void test('worktree word pools have exactly 256 unique lowercase words', () => {
  for (const pool of [adjectives, nouns]) {
    assert.equal(pool.length, 256);
    assert.equal(new Set(pool).size, 256);
    assert.ok(pool.every(word => /^[a-z]+$/.test(word)));
  }
});

void test('fresh worktree uses cached origin default, omits dirty files and retains committed progress', async t => {
  const root = await repository(t);
  const base = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'update-ref', 'refs/remotes/origin/main', base);
  await git(
    root,
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  );
  await writeFile(join(root, 'file'), 'newer');
  await git(root, 'commit', '-am', 'local only');
  await writeFile(join(root, 'dirty'), 'do not copy');
  const warnings: string[] = [];
  const tree = await acquireWorktree(root, {enabled: true, name: 'sample'}, m =>
    warnings.push(m),
  );
  assert.equal(await git(tree.path, 'rev-parse', 'HEAD'), base);
  await assert.rejects(access(join(tree.path, 'dirty')));
  assert.equal(warnings.length, 0);
  await writeFile(join(tree.path, 'file'), 'committed progress');
  await git(tree.path, 'commit', '-am', 'progress');
  const progress = await git(tree.path, 'rev-parse', 'HEAD');
  await tree.release();
  await assert.rejects(access(tree.path));
  assert.equal(await git(root, 'rev-parse', 'stratos/sample'), progress);
  const resumed = await acquireWorktree(
    root,
    {enabled: true, name: 'sample'},
    m => warnings.push(m),
  );
  assert.equal(await git(resumed.path, 'rev-parse', 'HEAD'), progress);
  await resumed.release();
});

void test('shared checkout is retained until last release, accepts changed branch and persistent opt-out', async t => {
  const root = await repository(t);
  const warnings: string[] = [];
  const a = await acquireWorktree(root, {enabled: true, name: 'shared'}, m =>
    warnings.push(m),
  );
  assert.ok(warnings.some(m => m.includes('local HEAD')));
  const b = await acquireWorktree(root, {enabled: true, name: 'shared'}, m =>
    warnings.push(m),
  );
  await git(a.path, 'switch', '-c', 'changed');
  await a.release();
  await access(b.path);
  const c = await acquireWorktree(
    root,
    {enabled: true, name: 'shared', cleanup: false},
    m => warnings.push(m),
  );
  assert.equal(c.branch, 'changed');
  await b.release();
  await c.release();
  await access(c.path);
  const d = await acquireWorktree(root, {enabled: true, name: 'shared'}, m =>
    warnings.push(m),
  );
  await d.release();
  await access(d.path);
  await git(root, 'worktree', 'remove', d.path);
  const recreated = await acquireWorktree(
    root,
    {enabled: true, name: 'shared'},
    m => warnings.push(m),
  );
  await recreated.release();
  await assert.rejects(access(recreated.path));
});

void test('dirty staged, unstaged and untracked files prevent cleanup; invalid paths remain untouched', async t => {
  const root = await repository(t);
  for (const kind of ['staged', 'unstaged', 'untracked']) {
    const warnings: string[] = [];
    const tree = await acquireWorktree(root, {enabled: true, name: kind}, m =>
      warnings.push(m),
    );
    await writeFile(
      join(tree.path, kind === 'untracked' ? 'new' : 'file'),
      'keep',
    );
    if (kind === 'staged') {
      await git(tree.path, 'add', 'file');
    }
    await tree.release();
    await access(tree.path);
    assert.ok(warnings.some(m => m.includes('uncommitted')));
  }
  const invalid = join(root, '.stratos/worktrees/invalid');
  await mkdir(invalid);
  await writeFile(join(invalid, 'keep'), 'keep');
  await assert.rejects(
    acquireWorktree(root, {enabled: true, name: 'invalid'}, () => {}),
  );
  assert.equal(await readFile(join(invalid, 'keep'), 'utf8'), 'keep');
  await assert.rejects(
    acquireWorktree(root, {enabled: true, name: '../escape'}, () => {}),
  );
});

void test('generated names create separate branches and unsafe shutdown preserves checkout', async t => {
  const root = await repository(t);
  const a = await acquireWorktree(root, {enabled: true}, () => {});
  const b = await acquireWorktree(root, {enabled: true}, () => {});
  assert.notEqual(a.name, b.name);
  assert.match(a.name, /^[a-z]+-[a-z]+$/);
  await a.release(false);
  await access(a.path);
  await b.release();
  await assert.rejects(access(b.path));
});

void test('cross-process usage preserves active and crashed owners; OS locks release on crash', async t => {
  const root = await repository(t);
  const module = new URL('../../src/git/worktrees/index.js', import.meta.url)
    .href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { acquireWorktree } from ${JSON.stringify(module)}; const tree=await acquireWorktree(${JSON.stringify(root)},{enabled:true,name:'shared'},()=>{}); console.log(tree.path); setInterval(()=>{},1000);`,
    ],
    {stdio: ['ignore', 'pipe', 'pipe']},
  );
  t.after(() => {
    child.kill('SIGKILL');
  });
  await once(child.stdout!, 'data');
  const warnings: string[] = [];
  const a = await acquireWorktree(root, {enabled: true, name: 'shared'}, m =>
    warnings.push(m),
  );
  await a.release();
  await access(a.path);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const b = await acquireWorktree(root, {enabled: true, name: 'shared'}, m =>
    warnings.push(m),
  );
  await b.release();
  await access(b.path);
  assert.ok(warnings.some(m => m.includes('orphaned')));
  const lock = join(root, 'test.lock');
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { withWorktreeLock } from ${JSON.stringify(module)}; await withWorktreeLock(${JSON.stringify(lock)},async()=>{console.log('locked');setInterval(()=>{},1000);await new Promise(()=>{});});`,
    ],
    {stdio: ['ignore', 'pipe', 'pipe']},
  );
  t.after(() => {
    holder.kill('SIGKILL');
  });
  await once(holder.stdout!, 'data');
  const start = performance.now();
  await assert.rejects(
    withWorktreeLock(lock, async () => {}),
    /five seconds/,
  );
  assert.ok(performance.now() - start >= 4900);
  const stopped = once(holder, 'exit');
  holder.kill('SIGKILL');
  await stopped;
  await withWorktreeLock(lock, async () => {});
});
