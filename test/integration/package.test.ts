import assert from 'node:assert/strict';
import {execFile, spawnSync} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

import type {CommandResult} from '../../src/cli/result.js';
import {PACKAGE_ROOT} from '../../src/paths.js';

const manifest = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
) as {version: string};

void test('packed package installs with runtime dependencies, imports independently, and exposes both executable aliases', async t => {
  // Exercise package-root URL decoding after installation outside the checkout.
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'stratos install #')),
  );
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const consumer = join(directory, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({private: true, type: 'module'}),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_cache: join(directory, 'npm-cache'),
  };
  // Do not let the independent consumer borrow repository packages via NODE_PATH.
  delete env.NODE_PATH;
  const npm = (args: string[], cwd: string) => {
    const cli = process.env.npm_execpath;
    const result = cli
      ? spawnSync(process.execPath, [cli, ...args], {
          cwd,
          env,
          encoding: 'utf8',
        })
      : spawnSync('npm', args, {cwd, env, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout;
  };
  const [packed] = JSON.parse(
    npm(
      ['pack', '--ignore-scripts', '--json', '--pack-destination', directory],
      PACKAGE_ROOT,
    ),
  ) as Array<{
    filename: string;
    files: Array<{path: string}>;
  }>;
  assert.ok(packed);
  const files = new Set(packed.files.map(file => file.path));
  for (const file of [
    'dist/src/agents/codex/hook-server.js',
    'dist/src/agents/codex/hook-failure.js',
    'dist/src/index.js',
    'dist/src/index.d.ts',
    'dist/src/cli/main.js',
    'dist/src/cli/help.js',
    'dist/src/cli/provider.js',
    'dist/src/paths.js',
    'src/index.ts',
    'src/workflows/build.ts',
    'scripts/models/generate.ts',
    'test/integration/package.test.ts',
    'test/helpers/home.ts',
    'data/models/model-mapping.v1.json',
    'data/models/provider-mapping.v1.json',
    'data/models/MODELS_DEV_LICENSE',
    'LICENSE',
    'skills/stratos-workflows/SKILL.md',
    'skills/stratos-workflows/references/mcp.md',
    'skills/stratos-workflows/references/composition.md',
  ]) {
    assert.ok(files.has(file), `Missing packed file: ${file}`);
  }
  const allowedFiles = new Set(['LICENSE', 'README.md', 'package.json']);
  const allowedDirectories = [
    'dist/src/',
    'src/',
    'scripts/models/',
    'test/unit/',
    'test/integration/',
    'test/helpers/',
    'data/models/',
    'skills/stratos-workflows/',
  ];
  assert.ok(
    [...files].every(
      file =>
        allowedFiles.has(file) ||
        allowedDirectories.some(directory => file.startsWith(directory)),
    ),
    'The installed package must contain only runtime files, source, and build inputs',
  );

  // A clean cache must fetch declared runtime dependencies; keep installation isolated.
  npm(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      join(directory, packed.filename),
    ],
    consumer,
  );
  const imported = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      'import * as sdk from "@stratoscli/stratos"; console.log(typeof sdk);',
    ],
    {cwd: consumer, env, encoding: 'utf8'},
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, 'object\n');
  const installed = join(consumer, 'node_modules/@stratoscli/stratos');
  const compiler = spawnSync(
    join(consumer, 'node_modules/.bin/tsc'),
    ['--version'],
    {cwd: consumer, env, encoding: 'utf8'},
  );
  assert.equal(compiler.status, 0, compiler.stderr);
  assert.equal(compiler.stdout.trim(), 'Version 7.0.2');
  const hookImport = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      'const m = await import(process.argv[1]); console.log(typeof m.startCodexHookServer);',
      pathToFileURL(join(installed, 'dist/src/agents/codex/hook-server.js'))
        .href,
    ],
    {cwd: consumer, env, encoding: 'utf8'},
  );
  assert.equal(hookImport.status, 0, hookImport.stderr);
  assert.equal(hookImport.stdout, 'function\n');
  assert.equal(
    readFileSync(join(installed, 'data/models/model-mapping.v1.json'), 'utf8'),
    readFileSync(
      join(PACKAGE_ROOT, 'data/models/model-mapping.v1.json'),
      'utf8',
    ),
  );
  const skillPath = join(installed, 'skills/stratos-workflows/SKILL.md');
  const skillContent = readFileSync(skillPath, 'utf8');
  for (const name of ['stratos', 'st']) {
    const command = join(consumer, 'node_modules/.bin', name);
    const version = spawnSync(command, ['--version'], {
      cwd: consumer,
      env,
      encoding: 'utf8',
    });
    assert.equal(version.status, 0, version.stderr || String(version.error));
    assert.equal(version.stdout, manifest.version + '\n');
    for (const args of [[], ['--help'], ['--help', '--json']]) {
      const help = spawnSync(command, args, {
        cwd: consumer,
        env,
        encoding: 'utf8',
      });
      assert.equal(help.status, 0, help.stderr);
      assert.equal(help.stderr, '');
      const text = args.includes('--json')
        ? (JSON.parse(help.stdout) as CommandResult).message + '\n'
        : help.stdout;
      assert.ok(text.includes(skillPath));
      assert.ok(text.endsWith(skillContent + '\n'));
    }
    const scoped = spawnSync(
      command,
      ['provider', 'status', 'ollama', '--help', '--json'],
      {
        cwd: consumer,
        env: {...env, OLLAMA_HOST: 'invalid://no-probe'},
        encoding: 'utf8',
      },
    );
    assert.equal(scoped.status, 0, scoped.stderr);
    const message = (JSON.parse(scoped.stdout) as CommandResult).message;
    assert.match(message, /Usage: stratos provider status ollama/);
    assert.match(message, /Read-only/);
    assert.ok(!message.includes(skillContent));
  }
  await t.test(
    'help reads the installed skill and reports missing content instead of returning partial guidance',
    () => {
      const command = join(consumer, 'node_modules/.bin/stratos');
      const run = (...args: string[]) =>
        spawnSync(command, [...args, '--json'], {
          cwd: consumer,
          env,
          encoding: 'utf8',
        });
      try {
        const updated = skillContent + '\nInstalled skill update.\n';
        writeFileSync(skillPath, updated);
        const help = run('--help');
        assert.equal(help.status, 0, help.stderr);
        assert.ok(
          (JSON.parse(help.stdout) as CommandResult).message.endsWith(updated),
        );
        unlinkSync(skillPath);
        const missing = run('--help');
        assert.equal(missing.status, 1);
        assert.equal(missing.stderr, '');
        const failure = JSON.parse(missing.stdout) as CommandResult;
        assert.equal(failure.success, false);
        assert.equal(failure.errors![0]!.code, 'CLI_ERROR');
        assert.ok(failure.errors![0]!.message.includes(skillPath));
        const version = run('--version');
        assert.equal(version.status, 0, version.stderr);
        assert.deepEqual(JSON.parse(version.stdout), {
          success: true,
          message: manifest.version,
        });
        const scoped = run('provider', 'status', 'ollama', '--help');
        assert.equal(scoped.status, 0, scoped.stderr);
        assert.match(JSON.parse(scoped.stdout).message, /Read-only/);
      } finally {
        writeFileSync(skillPath, skillContent);
      }
    },
  );

  // The installer uses the same native lock as the runtime. Build it only in this consumer.
  npm(['rebuild', 'fs-ext', '--ignore-scripts=false'], consumer);
  const home = join(directory, 'home');
  mkdirSync(home);
  const skillEnv: NodeJS.ProcessEnv = {...env, HOME: home};
  for (const key of [
    'CLAUDE_CONFIG_DIR',
    'GEMINI_CLI_HOME',
    'COPILOT_HOME',
    'OPENCODE_CONFIG_DIR',
    'XDG_CONFIG_HOME',
  ]) {
    delete skillEnv[key];
  }
  const command = join(consumer, 'node_modules/.bin/stratos');
  const skill = 'stratos-workflows';
  let source = realpathSync(join(installed, 'skills', skill));
  const record = join(home, '.stratos/skill-installations.json');
  const destinations: Record<string, string> = {
    claude: join(home, '.claude/skills', skill),
    codex: join(home, '.agents/skills', skill),
    gemini: join(home, '.gemini/skills', skill),
    cursor: join(home, '.cursor/skills', skill),
    copilot: join(home, '.copilot/skills', skill),
    opencode: join(home, '.config/opencode/skills', skill),
  };
  interface SkillData {
    skill: string;
    source: string;
    installations: Array<{
      agent: string;
      path: string;
      status: string;
      managed: boolean;
    }>;
  }
  const runSkill = (
    args: string[],
    expected = 0,
    overrides: NodeJS.ProcessEnv = {},
  ) => {
    const result = spawnSync(command, ['skill', ...args, '--json'], {
      cwd: consumer,
      env: {...skillEnv, ...overrides},
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(
      result.status,
      expected,
      result.stderr || result.stdout || String(result.error),
    );
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout) as CommandResult<SkillData>;
    assert.equal(parsed.success, expected === 0);
    return parsed;
  };
  await t.test(
    'status is read-only and invalid selectors have no filesystem effects',
    () => {
      const status = runSkill(['status']);
      assert.equal(status.data!.installations.length, 6);
      assert.ok(
        status.data!.installations.every(
          entry => entry.status === 'not-installed',
        ),
      );
      for (const args of [
        [],
        ['unknown'],
        ['install'],
        ['uninstall'],
        ['install', '--agent', 'claude,unknown'],
        ['install', '--agent', ''],
        ['install', '--agent', 'claude,'],
        ['install', '--agent', 'claude', '--all'],
        ['install', '--agent', 'claude', '--input', '{}'],
        ['install', '--agent', 'claude', '--workflow', 'greet'],
        ['install', '--agent', 'claude', 'extra'],
      ]) {
        runSkill(args, 1);
      }
      runSkill(['install', '--agent', 'claude,gemini'], 1, {
        GEMINI_CLI_HOME: 'relative',
      });
      assert.deepEqual(readdirSync(home), []);
    },
  );
  await t.test(
    'all targets install the full bundled skill and both aliases report it',
    () => {
      const installedResult = runSkill(['install', '--all']);
      assert.equal(installedResult.data!.skill, skill);
      for (const entry of installedResult.data!.installations) {
        assert.equal(entry.status, 'installed');
        assert.equal(entry.managed, true);
        assert.equal(entry.path, destinations[entry.agent]);
        assert.equal(readlinkSync(entry.path), source);
        for (const file of [
          'SKILL.md',
          'references/mcp.md',
          'references/composition.md',
        ]) {
          assert.equal(
            readFileSync(join(entry.path, file), 'utf8'),
            readFileSync(join(source, file), 'utf8'),
          );
        }
      }
      const before = lstatSync(destinations.claude!).ino;
      const repeated = runSkill([
        'install',
        '--agent',
        'claude-code,claude,codex',
      ]);
      assert.equal(repeated.data!.installations.length, 2);
      assert.ok(
        repeated.data!.installations.every(
          entry => entry.status === 'unchanged',
        ),
      );
      assert.equal(lstatSync(destinations.claude!).ino, before);
      const alias = spawnSync(
        join(consumer, 'node_modules/.bin/st'),
        ['skill', 'status'],
        {
          cwd: consumer,
          env: skillEnv,
          encoding: 'utf8',
        },
      );
      assert.equal(alias.status, 0, alias.stderr);
      assert.match(alias.stdout, /claude: installed/);
      assert.equal(lstatSync(record).mode & 0o777, 0o600);
    },
  );
  await t.test(
    'uninstall is targeted and never deletes skill sources or other harness data',
    () => {
      const sibling = join(home, '.cursor/skills/another-skill');
      mkdirSync(sibling);
      assert.equal(
        runSkill(['uninstall', '--agent', 'cursor']).data!.installations[0]!
          .status,
        'removed',
      );
      assert.equal(existsSync(destinations.cursor!), false);
      assert.ok(existsSync(sibling));
      assert.ok(existsSync(join(source, 'SKILL.md')));
      assert.ok(lstatSync(destinations.claude!).isSymbolicLink());
      assert.equal(
        runSkill(['uninstall', '--agent', 'cursor']).data!.installations[0]!
          .status,
        'not-installed',
      );
      runSkill(['install', '--agent', 'cursor']);
    },
  );
  await t.test(
    'foreign files, directories and symlinks survive conflict and partial failure',
    () => {
      runSkill(['uninstall', '--agent', 'cursor']);
      const destination = destinations.cursor!;
      writeFileSync(destination, 'user-owned');
      const partial = runSkill(['install', '--agent', 'cursor,claude'], 1);
      assert.equal(partial.errors![0]!.code, 'SKILL_CONFLICT');
      assert.deepEqual(
        partial.data!.installations.map(entry => entry.status),
        ['conflict', 'unchanged'],
      );
      assert.equal(readFileSync(destination, 'utf8'), 'user-owned');
      runSkill(['uninstall', '--agent', 'cursor'], 1);
      unlinkSync(destination);
      mkdirSync(destination);
      runSkill(['install', '--agent', 'cursor'], 1);
      assert.ok(lstatSync(destination).isDirectory());
      rmSync(destination, {recursive: true});
      symlinkSync(join(home, 'absent-foreign-source'), destination);
      runSkill(['install', '--agent', 'cursor'], 1);
      runSkill(['uninstall', '--agent', 'cursor'], 1);
      assert.equal(
        readlinkSync(destination),
        join(home, 'absent-foreign-source'),
      );
      unlinkSync(destination);
      symlinkSync(source, destination);
      const same = runSkill(['install', '--agent', 'cursor']);
      assert.equal(same.data!.installations[0]!.status, 'unchanged');
      assert.equal(same.data!.installations[0]!.managed, false);
      runSkill(['uninstall', '--agent', 'cursor'], 1);
      unlinkSync(destination);
      runSkill(['install', '--agent', 'cursor']);
      unlinkSync(destination);
      symlinkSync(join(home, 'replaced-owned-link'), destination);
      runSkill(['install', '--agent', 'cursor'], 1);
      runSkill(['uninstall', '--agent', 'cursor'], 1);
      assert.equal(
        readlinkSync(destination),
        join(home, 'replaced-owned-link'),
      );
      unlinkSync(destination);
      runSkill(['install', '--agent', 'cursor']);
    },
  );
  await t.test(
    'moved packages leave repairable broken links and reinstall uses the running package',
    () => {
      const moved = join(consumer, 'node_modules/stratos-moved');
      renameSync(installed, moved);
      symlinkSync(moved, installed, 'dir');
      // Move the bundled directory independently to exercise genuinely dangling recorded targets.
      const originalSource = join(moved, 'skills', skill);
      renameSync(originalSource, `${originalSource}.old`);
      assert.ok(
        runSkill(['status']).data!.installations.every(
          entry => entry.status === 'broken',
        ),
      );
      renameSync(`${originalSource}.old`, originalSource);
      const status = runSkill(['status']);
      assert.ok(
        status.data!.installations.every(entry => entry.status === 'outdated'),
      );
      const updated = runSkill(['install', '--all']);
      source = realpathSync(originalSource);
      assert.ok(
        updated.data!.installations.every(entry => entry.status === 'updated'),
      );
      for (const destination of Object.values(destinations)) {
        assert.equal(readlinkSync(destination), source);
      }
      // Model a process exit between persisting the move and replacing its link.
      const state = JSON.parse(readFileSync(record, 'utf8'));
      state.links[destinations.claude!] = [
        source,
        join(home, 'interrupted-move'),
      ];
      writeFileSync(record, JSON.stringify(state));
      unlinkSync(destinations.claude!);
      symlinkSync(join(home, 'interrupted-move'), destinations.claude!);
      assert.equal(
        runSkill(['install', '--agent', 'claude']).data!.installations[0]!
          .status,
        'updated',
      );
      const skillFile = join(source, 'references/mcp.md');
      renameSync(skillFile, `${skillFile}.saved`);
      try {
        runSkill(['install', '--agent', 'claude'], 1);
        assert.equal(readlinkSync(destinations.claude!), source);
      } finally {
        renameSync(`${skillFile}.saved`, skillFile);
      }
    },
  );
  await t.test(
    'directory overrides and symlinked harness roots preserve ownership',
    () => {
      const custom = join(home, 'custom claude');
      mkdirSync(custom);
      const alias = join(home, 'aliased-claude');
      symlinkSync(custom, alias, 'dir');
      const overrides = {CLAUDE_CONFIG_DIR: alias};
      const result = runSkill(
        ['install', '--agent', 'claude-code'],
        0,
        overrides,
      );
      assert.equal(
        result.data!.installations[0]!.path,
        join(custom, 'skills', skill),
      );
      assert.equal(
        runSkill(['status', '--agent', 'claude'], 0, overrides).data!
          .installations[0]!.managed,
        true,
      );
      runSkill(['uninstall', '--agent', 'claude'], 0, overrides);
      assert.ok(lstatSync(alias).isSymbolicLink());
      assert.ok(lstatSync(destinations.claude!).isSymbolicLink());
    },
  );
  await t.test(
    'corrupt or symlinked ownership records fail without touching installations',
    () => {
      const saved = readFileSync(record, 'utf8');
      for (const invalid of [
        'not-json',
        '{"version":2,"links":{}}',
        '{"version":1,"links":{"relative":["/target"]}}',
      ]) {
        writeFileSync(record, invalid);
        runSkill(['install', '--agent', 'claude'], 1);
        assert.equal(readFileSync(record, 'utf8'), invalid);
        assert.equal(readlinkSync(destinations.claude!), source);
      }
      unlinkSync(record);
      const foreign = join(home, 'foreign-record');
      writeFileSync(foreign, saved);
      symlinkSync(foreign, record);
      runSkill(['uninstall', '--all'], 1);
      assert.ok(lstatSync(record).isSymbolicLink());
      assert.equal(readFileSync(foreign, 'utf8'), saved);
      unlinkSync(record);
      writeFileSync(record, saved, {mode: 0o600});
    },
  );
  await t.test(
    'permission failures report the affected target and preserve other outcomes',
    context => {
      if (process.getuid?.() === 0) {
        return context.skip('Root bypasses directory permissions.');
      }
      runSkill(['uninstall', '--agent', 'cursor']);
      const parent = join(home, '.cursor/skills');
      chmodSync(parent, 0o500);
      try {
        const failed = runSkill(['install', '--agent', 'cursor,claude'], 1);
        assert.deepEqual(
          failed.data!.installations.map(entry => entry.status),
          ['error', 'unchanged'],
        );
        assert.match(failed.errors![0]!.message, /EACCES/);
        assert.equal(existsSync(destinations.cursor!), false);
      } finally {
        chmodSync(parent, 0o700);
      }
    },
  );
  await t.test(
    'concurrent installers retain every owned link and uninstall all leaves no links',
    async () => {
      await Promise.all(
        ['cursor', 'claude', 'codex', 'gemini'].map(agent =>
          promisify(execFile)(
            command,
            ['skill', 'install', '--agent', agent, '--json'],
            {
              cwd: consumer,
              env: skillEnv,
              timeout: 30_000,
            },
          ),
        ),
      );
      assert.ok(
        runSkill(['status']).data!.installations.every(entry => entry.managed),
      );
      assert.ok(
        runSkill(['uninstall', '--all']).data!.installations.every(
          entry => entry.status === 'removed',
        ),
      );
      assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')).links, {});
      assert.ok(Object.values(destinations).every(path => !existsSync(path)));
      assert.ok(existsSync(join(source, 'SKILL.md')));
      assert.ok(
        readdirSync(join(home, '.stratos')).every(
          file => !file.endsWith('.tmp'),
        ),
      );
    },
  );
  writeFileSync(
    join(installed, 'data/models/provider-mapping.v1.json'),
    '{"formatVersion":99}',
  );
  const invalidCatalog = spawnSync(
    join(consumer, 'node_modules/.bin/stratos'),
    ['--version', '--json'],
    {cwd: consumer, env, encoding: 'utf8'},
  );
  assert.equal(invalidCatalog.status, 1);
  assert.equal(JSON.parse(invalidCatalog.stdout).success, false);
});
