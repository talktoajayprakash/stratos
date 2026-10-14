import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {promisify} from 'node:util';

import {PACKAGE_ROOT} from '../../src/paths.js';

const exec = promisify(execFile);
const commitMessage =
  'Exercise style hook\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>';

async function repository(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'stratos pre-commit '));
  t.after(() => rm(root, {recursive: true, force: true}));
  const env = {
    ...process.env,
    HUSKY: '1',
    XDG_CONFIG_HOME: join(root, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const git = async (...args: string[]) =>
    (
      await exec('git', args, {
        cwd: root,
        env,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
  const write = async (path: string, content: string) =>
    writeFile(join(root, path), content);
  const read = (path: string) => readFile(join(root, path), 'utf8');
  await git('init', '--template=', '-b', 'main');
  await git('config', 'user.name', 'Stratos hook fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  for (const directory of ['.husky', 'src', 'scripts', 'generated']) {
    await mkdir(join(root, directory));
  }
  for (const file of [
    'package.json',
    'eslint.config.mjs',
    'tsconfig.eslint.json',
    '.husky/pre-commit',
  ]) {
    await copyFile(join(PACKAGE_ROOT, file), join(root, file));
  }
  await symlink(join(PACKAGE_ROOT, 'node_modules'), join(root, 'node_modules'));
  await write('.gitignore', 'node_modules/\n.config/\n');
  await write('scripts/untouched.mjs', "export const untouched = 'base';\n");
  await write(
    'src/partial.ts',
    "export const staged = 'base';\n\n" +
      Array.from(
        {length: 15},
        (_, i) => `export const spacer${i} = ${i};\n`,
      ).join('') +
      "\nexport const unstaged = 'base';\n",
  );
  await git('add', '.');
  await git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', commitMessage);
  await exec('npm', ['run', 'prepare'], {cwd: root, env, timeout: 30_000});
  assert.equal(
    (await git('config', '--local', '--get', 'core.hooksPath')).trim(),
    '.husky/_',
  );
  return {root, git, write, read};
}

void test('pre-commit fixes and stages JS/TS without touching unrelated edits or excluded files', async t => {
  const f = await repository(t);
  const untouched = 'export const untouched = "unstaged"\n';
  const untracked = 'var untracked = "leave alone"\n';
  const generated = 'export default "generated fixture"\n';
  await f.write('scripts/fix me.mjs', 'export const name = "javascript"\n');
  await f.write('src/fix.ts', 'export const name: string = "typescript"\n');
  await f.write('scripts/untouched.mjs', untouched);
  await f.write('scripts/untracked.mjs', untracked);
  await f.write('generated/ignored.ts', generated);
  await f.git(
    'add',
    'scripts/fix me.mjs',
    'src/fix.ts',
    'generated/ignored.ts',
  );
  await f.git('commit', '-m', commitMessage);

  assert.equal(
    await f.git('show', 'HEAD:scripts/fix me.mjs'),
    "export const name = 'javascript';\n",
  );
  assert.equal(
    await f.git('show', 'HEAD:src/fix.ts'),
    "export const name: string = 'typescript';\n",
  );
  assert.equal(
    await f.read('scripts/fix me.mjs'),
    "export const name = 'javascript';\n",
  );
  assert.equal(await f.git('show', 'HEAD:generated/ignored.ts'), generated);
  assert.equal(await f.read('scripts/untouched.mjs'), untouched);
  assert.equal(
    await f.git('show', 'HEAD:scripts/untouched.mjs'),
    "export const untouched = 'base';\n",
  );
  assert.equal(await f.read('scripts/untracked.mjs'), untracked);
  assert.equal(await f.git('ls-files', '--', 'scripts/untracked.mjs'), '');
  assert.equal(await f.git('diff', '--cached'), '');
  assert.equal(await f.git('stash', 'list'), '');
});

void test('pre-commit preserves unstaged hunks in partially staged files', async t => {
  const f = await repository(t);
  const base = await f.read('src/partial.ts');
  const staged = base.replace("staged = 'base';", 'staged = "committed"');
  await f.write('src/partial.ts', staged);
  await f.git('add', 'src/partial.ts');
  await f.write(
    'src/partial.ts',
    staged.replace("unstaged = 'base';", 'unstaged = "local only"'),
  );
  await f.git('commit', '-m', commitMessage);

  const committed = base.replace("staged = 'base';", "staged = 'committed';");
  assert.equal(await f.git('show', 'HEAD:src/partial.ts'), committed);
  assert.equal(
    await f.read('src/partial.ts'),
    committed.replace("unstaged = 'base';", 'unstaged = "local only"'),
  );
  assert.match(await f.git('diff', '--', 'src/partial.ts'), /local only/);
  assert.equal(await f.git('diff', '--cached'), '');
  assert.equal(await f.git('stash', 'list'), '');
});

void test('pre-commit blocks unfixable lint errors and restores staged and unstaged contents', async t => {
  const f = await repository(t);
  const base = await f.read('src/partial.ts');
  const staged = base.replace("staged = 'base';", 'staged: any = "bad"');
  const working = staged.replace(
    "unstaged = 'base';",
    'unstaged = "local only"',
  );
  await f.write('src/partial.ts', staged);
  await f.git('add', 'src/partial.ts');
  await f.write('src/partial.ts', working);
  await f.write('scripts/fix me.mjs', 'export const name = "also staged"\n');
  await f.git('add', 'scripts/fix me.mjs');
  const head = await f.git('rev-parse', 'HEAD');
  const index = await f.git('diff', '--cached');
  const unstaged = await f.git('diff');

  await assert.rejects(f.git('commit', '-m', commitMessage), error => {
    assert.ok(error instanceof Error && 'stdout' in error && 'stderr' in error);
    assert.match(`${error.stdout}\n${error.stderr}`, /no-explicit-any/);
    return true;
  });
  assert.equal(await f.git('rev-parse', 'HEAD'), head);
  assert.equal(await f.git('diff', '--cached'), index);
  assert.equal(await f.git('diff'), unstaged);
  assert.equal(await f.read('src/partial.ts'), working);
  assert.equal(
    await f.read('scripts/fix me.mjs'),
    'export const name = "also staged"\n',
  );
  assert.equal(await f.git('stash', 'list'), '');
});

void test('pre-commit permits documentation-only commits and staged deletions', async t => {
  const f = await repository(t);
  await f.write('notes.txt', 'Not JavaScript or TypeScript.\n');
  await f.git('add', 'notes.txt');
  await f.git('rm', 'src/partial.ts');
  await f.git('commit', '-m', commitMessage);
  assert.equal(
    await f.git('show', 'HEAD:notes.txt'),
    'Not JavaScript or TypeScript.\n',
  );
  assert.equal(await f.git('ls-files', '--', 'src/partial.ts'), '');
  assert.equal(await f.git('status', '--porcelain'), '');
});
