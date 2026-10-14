import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {harnessTools} from '../../src/agents/native.js';
import {PACKAGE_ROOT} from '../../src/paths.js';

const entry = join(PACKAGE_ROOT, 'dist/src/cli/main.js');
const skillPath = join(PACKAGE_ROOT, 'skills/stratos-workflows/SKILL.md');
const skillContent = readFileSync(skillPath, 'utf8');
const {version} = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
) as {version: string};
const run = (...args: string[]) =>
  spawnSync(process.execPath, [entry, ...args], {encoding: 'utf8'});

void test('CLI help includes the exact bundled skill, reference location and command summary', () => {
  for (const args of [[], ['--help']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Usage: stratos/);
    assert.match(result.stdout, /st\s+<action>/);
    assert.match(result.stdout, /provider status ollama \[--json\]/);
    assert.match(result.stdout, /tools list \[harness\] \[--json\]/);
    assert.ok(!result.stdout.includes('stratos setup ollama'));
    assert.match(
      result.stdout,
      /OAuth login\/refresh and selected agent MCPs are supported/,
    );
    assert.ok(result.stdout.includes(skillPath));
    assert.ok(result.stdout.endsWith(skillContent + '\n'));
  }
});

void test('CLI version is sourced from the package and JSON uses the common envelope', () => {
  const text = run('--version');
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, version + '\n');
  assert.equal(text.stderr, '');
  const json = run('--version', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stderr, '');
  assert.deepEqual(JSON.parse(json.stdout), {success: true, message: version});
  const help = run('--help', '--json');
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, '');
  assert.equal(JSON.parse(help.stdout).success, true);
  assert.match(JSON.parse(help.stdout).message, /Usage: stratos/);
  assert.equal(JSON.parse(help.stdout).message + '\n', run('--help').stdout);
});

void test('invalid arguments fail without mixing JSON output and diagnostics', () => {
  for (const args of [
    ['--unknown'],
    ['run'],
    ['describe'],
    ['describe', 'example', '--name', 'other'],
    ['describe', 'example', 'extra'],
    ['describe', 'example', '--input', '{}'],
    ['describe', 'example', '--input', ''],
    ['describe', 'example', '--overrides', '{}'],
    ['describe', 'example', '--overrides', ''],
    ['describe', 'example', '--workflow', 'other'],
    ['--help', '--version'],
    ['list', '--agent', 'claude'],
    ['build', '--all'],
    ['setup', 'ollama', '--agent', 'codex'],
    ['setup', 'ollama', '--all'],
    ['setup', 'ollama', '--workflow', 'greet'],
    ['setup', 'ollama', '--overrides', '{}'],
    ['setup', 'ollama', 'extra'],
    ['provider'],
    ['provider', 'status'],
    ['provider', 'setup', 'ollama'],
    ['provider', 'status', 'unknown'],
    ['provider', 'status', 'ollama', 'extra'],
    ['provider', 'status', 'ollama', '--agent', 'codex'],
    ['provider', 'status', 'ollama', '--all'],
    ['provider', 'status', 'ollama', '--name', 'ollama'],
    ['provider', 'status', 'ollama', '--workflow', 'greet'],
    ['provider', 'status', 'ollama', '--input', '{}'],
    ['provider', 'status', 'ollama', '--overrides', '{}'],
    ['provider', 'status', 'ollama', '--unknown'],
    ['unknown', '--help'],
    ['mcp', 'unknown', '--help'],
    ['skill', 'unknown', '--help'],
    ['provider', 'setup', '--help'],
    ['provider', 'status', 'unknown', '--help'],
    ['provider', 'status', 'ollama', 'extra', '--help'],
    ['mcp', 'list', 'extra', '--help'],
    ['skill', 'status', 'extra', '--help'],
    ['list', 'extra', '--help'],
    ['tools'],
    ['tools', 'status'],
    ['tools', 'list', 'unknown'],
    ['tools', 'list', 'codex', 'extra'],
    ['tools', 'list', '--name', 'codex'],
    ['tools', 'list', '--workflow', 'greet'],
    ['tools', 'list', '--agent', 'codex'],
    ['tools', 'unknown', '--help'],
    ['tools', 'list', 'unknown', '--help'],
    ['tools', 'list', 'codex', 'extra', '--help'],
  ]) {
    const text = run(...args);
    assert.equal(text.status, 1);
    assert.equal(text.stdout, '');
    assert.match(text.stderr, /CLI_ERROR:/);
    const json = run(...args, '--json');
    assert.equal(json.status, 1);
    assert.equal(json.stderr, '');
    const result = JSON.parse(json.stdout);
    assert.equal(result.success, false);
    assert.equal(result.errors[0].code, 'CLI_ERROR');
    assert.ok(result.errors[0].message.length > 0);
    assert.equal('column' in result.errors[0], false);
  }
});

void test('command-specific help is scoped, JSON-compatible and does not execute commands', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stratos-cli-help-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const workflow = join(directory, '.stratos/workflows/broken');
  mkdirSync(workflow, {recursive: true});
  writeFileSync(join(workflow, 'workflow.yaml'), 'name: [invalid yaml');
  const initialFiles = readdirSync(directory, {recursive: true});
  for (const args of [
    ['list'],
    ['build'],
    ['build', 'broken'],
    ['schema'],
    ['describe'],
    ['describe', '--name', 'broken'],
    ['describe', 'broken'],
    ['run'],
    ['run', '--name', 'broken'],
    ['clean'],
    ['mcp'],
    ['mcp', 'list'],
    ['mcp', 'login'],
    ['mcp', 'login', 'github'],
    ['mcp', 'logout', '--name', 'github'],
    ['skill'],
    ['skill', 'install'],
    ['skill', 'status'],
    ['skill', 'uninstall', '--agent', 'codex'],
    ['provider'],
    ['provider', 'status'],
    ['provider', 'status', 'ollama'],
    ['tools'],
    ['tools', 'list'],
    ['tools', 'list', 'codex'],
  ]) {
    const invoke = (json: boolean) =>
      spawnSync(
        process.execPath,
        [entry, ...args, '--help', ...(json ? ['--json'] : [])],
        {
          cwd: directory,
          env: {
            ...process.env,
            HOME: directory,
            OLLAMA_HOST: 'invalid://must-not-connect',
          },
          encoding: 'utf8',
        },
      );
    const text = invoke(false);
    assert.equal(text.status, 0, text.stderr);
    assert.equal(text.stderr, '');
    assert.match(text.stdout, new RegExp(`Usage: stratos ${args[0]}\\b`));
    assert.ok(!text.stdout.includes('Workflow authoring skill:'));
    assert.ok(!text.stdout.includes('# Stratos workflows'));
    assert.ok(text.stdout.length < 1000);
    const json = invoke(true);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(json.stderr, '');
    assert.deepEqual(JSON.parse(json.stdout), {
      success: true,
      message: text.stdout.trimEnd(),
    });
  }
  assert.deepEqual(readdirSync(directory, {recursive: true}), initialFiles);
});

void test('tools list reports every selectable name per harness', () => {
  const json = run('tools', 'list', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stderr, '');
  const body = JSON.parse(json.stdout);
  assert.equal(body.success, true);
  assert.deepEqual(
    body.data.map((entry: {harness: string}) => entry.harness),
    ['claude-code', 'codex', 'opencode'],
  );
  for (const entry of body.data as Array<{
    harness: keyof typeof harnessTools;
    tools: string[];
    alwaysOn: string[];
  }>) {
    const tools = harnessTools[entry.harness];
    assert.deepEqual(
      entry.tools,
      Object.keys(tools).filter(name => Array.isArray(tools[name])),
    );
  }
  assert.deepEqual(body.data[1].alwaysOn, ['edit', 'write']);
  assert.ok(body.data[0].tools.includes('shell'));
  assert.ok(body.data[0].tools.includes('NotebookEdit'));
  assert.ok(!body.data[1].tools.includes('read'));
  assert.ok(body.data[2].tools.includes('codesearch'));
  assert.deepEqual(body.data[2].alwaysOn, []);

  const one = run('tools', 'list', 'codex');
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.stderr, '');
  assert.match(one.stdout, /^codex\n {2}tools: shell, .*, view_image, /);
  assert.match(
    one.stdout,
    /\n {2}always on \(cannot be removed\): edit, write\n$/,
  );
  assert.ok(!/canonical|unavailable|harness-specific/.test(one.stdout));
  assert.ok(!one.stdout.includes('claude-code'));
});

void test('removed setup spelling fails with the replacement command, not an alias', () => {
  for (const args of [
    ['setup', 'ollama'],
    ['setup', 'ollama', '--help'],
  ]) {
    const result = run(...args, '--json');
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const body = JSON.parse(result.stdout);
    assert.equal(body.success, false);
    assert.match(body.errors[0].message, /stratos provider status ollama/);
  }
});
