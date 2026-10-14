import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {skillCommand, skillDirectories} from '../../src/cli/skill.js';
import {PACKAGE_ROOT} from '../../src/paths.js';

void test('skill targets use global harness paths, not workflow runtime targets', () => {
  const directories = skillDirectories('/home/author', {});
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(directories).map(([key, get]) => [key, get()]),
    ),
    {
      claude: '/home/author/.claude/skills',
      codex: '/home/author/.agents/skills',
      gemini: '/home/author/.gemini/skills',
      cursor: '/home/author/.cursor/skills',
      copilot: '/home/author/.copilot/skills',
      opencode: '/home/author/.config/opencode/skills',
    },
  );
});

void test('skill targets honor documented directory overrides without redirecting other targets', () => {
  const directories = skillDirectories('/home/author', {
    CLAUDE_CONFIG_DIR: '/configs/claude',
    GEMINI_CLI_HOME: '/configs/gemini-home',
    COPILOT_HOME: '/configs/copilot',
    XDG_CONFIG_HOME: '/configs/xdg',
    CODEX_HOME: '/configs/codex',
  });
  assert.equal(directories.claude!(), '/configs/claude/skills');
  assert.equal(directories.gemini!(), '/configs/gemini-home/.gemini/skills');
  assert.equal(directories.copilot!(), '/configs/copilot/skills');
  assert.equal(directories.opencode!(), '/configs/xdg/opencode/skills');
  assert.equal(directories.codex!(), '/home/author/.agents/skills');
  assert.equal(directories.cursor!(), '/home/author/.cursor/skills');
  assert.equal(
    skillDirectories('/home/author', {
      OPENCODE_CONFIG_DIR: '/configs/opencode',
      XDG_CONFIG_HOME: 'ignored-relative-path',
    }).opencode!(),
    '/configs/opencode/skills',
  );
});

void test('relative and empty override directories fail rather than install into the current project', () => {
  for (const [agent, variable] of [
    ['claude', 'CLAUDE_CONFIG_DIR'],
    ['gemini', 'GEMINI_CLI_HOME'],
    ['copilot', 'COPILOT_HOME'],
    ['opencode', 'OPENCODE_CONFIG_DIR'],
    ['opencode', 'XDG_CONFIG_HOME'],
  ]) {
    for (const value of ['', '.', 'relative']) {
      const directories = skillDirectories('/home/author', {
        [variable!]: value,
      });
      assert.throws(directories[agent!]!, /absolute directory/);
    }
  }
});

void test('skill command reports ownership, safe mutations and recoverable filesystem errors', async t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stratos-skill-unit-')));
  const savedEnv = {...process.env};
  t.after(() => {
    process.env = savedEnv;
    rmSync(home, {recursive: true, force: true});
  });
  process.env.HOME = home;
  for (const key of [
    'CLAUDE_CONFIG_DIR',
    'GEMINI_CLI_HOME',
    'COPILOT_HOME',
    'OPENCODE_CONFIG_DIR',
    'XDG_CONFIG_HOME',
  ]) {
    delete process.env[key];
  }
  await skillCommand('status', undefined, false);
  assert.deepEqual(readdirSync(home), []);
  for (const [action, agent, all] of [
    [undefined, undefined, false],
    ['install', undefined, false],
    ['install', 'claude', true],
    ['install', 'invalid', false],
  ] as const) {
    await assert.rejects(skillCommand(action, agent, all));
  }
  assert.equal((await skillCommand('install', undefined, true)).success, true);
  assert.equal(
    (await skillCommand('install', 'claude-code,claude', false)).success,
    true,
  );
  const destination = join(home, '.claude/skills/stratos-workflows');
  const source = realpathSync(join(PACKAGE_ROOT, 'skills/stratos-workflows'));
  const record = join(home, '.stratos/skill-installations.json');
  const state = JSON.parse(readFileSync(record, 'utf8'));
  const oldSource = join(home, 'old-source');
  mkdirSync(oldSource);
  for (const target of [oldSource, join(home, 'missing-source')]) {
    state.links[destination] = [target];
    writeFileSync(record, JSON.stringify(state));
    unlinkSync(destination);
    symlinkSync(target, destination);
    const status = await skillCommand('status', 'claude', false);
    assert.match(status.message, existsSync(target) ? /outdated/ : /broken/);
    assert.match(
      (await skillCommand('install', 'claude', false)).message,
      /updated/,
    );
    assert.equal(readlinkSync(destination), source);
  }
  unlinkSync(destination);
  writeFileSync(destination, 'foreign');
  assert.equal(
    (await skillCommand('install', 'claude', false)).errors![0]!.code,
    'SKILL_CONFLICT',
  );
  unlinkSync(destination);
  symlinkSync(oldSource, destination);
  assert.equal(
    (await skillCommand('uninstall', 'claude', false)).success,
    false,
  );
  unlinkSync(destination);
  symlinkSync(source, destination);
  const unownedState = JSON.parse(readFileSync(record, 'utf8'));
  delete unownedState.links[destination];
  writeFileSync(record, JSON.stringify(unownedState));
  assert.match(
    (await skillCommand('install', 'claude', false)).message,
    /unmanaged/,
  );
  assert.equal(
    (await skillCommand('uninstall', 'claude', false)).success,
    false,
  );
  unlinkSync(destination);
  assert.equal((await skillCommand('install', 'claude', false)).success, true);
  unlinkSync(destination);
  assert.match(
    (await skillCommand('uninstall', 'claude', false)).message,
    /not-installed/,
  );
  assert.equal(
    JSON.parse(readFileSync(record, 'utf8')).links[destination],
    undefined,
  );

  await t.test(
    'an unwritable record rolls back a new link instead of leaving an untracked installation',
    async context => {
      if (process.getuid?.() === 0) {
        return context.skip('Root bypasses directory permissions.');
      }
      const directory = join(home, '.stratos');
      chmodSync(directory, 0o500);
      try {
        const result = await skillCommand('install', 'claude', false);
        assert.equal(result.success, false);
        assert.match(result.errors![0]!.message, /EACCES/);
        assert.equal(existsSync(destination), false);
        assert.equal(
          readdirSync(directory).some(file => file.endsWith('.tmp')),
          false,
        );
      } finally {
        chmodSync(directory, 0o700);
      }
    },
  );
  assert.equal((await skillCommand('install', 'claude', false)).success, true);
  const valid = readFileSync(record, 'utf8');
  writeFileSync(record, 'invalid');
  await assert.rejects(skillCommand('uninstall', 'claude', false));
  assert.ok(lstatSync(destination).isSymbolicLink());
  unlinkSync(record);
  mkdirSync(record);
  await assert.rejects(
    skillCommand('status', undefined, false),
    /regular file/,
  );
  rmSync(record, {recursive: true});
  const fifo = spawnSync('mkfifo', [record], {encoding: 'utf8'});
  assert.equal(fifo.status, 0, fifo.stderr);
  await assert.rejects(
    skillCommand('status', undefined, false),
    /regular file/,
  );
  unlinkSync(record);
  symlinkSync(join(home, 'missing-record'), record);
  await assert.rejects(skillCommand('status', undefined, false));
  unlinkSync(record);
  writeFileSync(record, valid);
  assert.equal(
    (await skillCommand('uninstall', undefined, true)).success,
    true,
  );
  assert.equal((await skillCommand('status', undefined, true)).success, true);
});
