import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {CredentialStore} from '../../src/mcp/credentials.js';
import {PACKAGE_ROOT} from '../../src/paths.js';

void test('MCP CLI lists qualified names, rejects ambiguity, and removes only selected local credentials', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'stratos-mcp-cli-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const home = join(cwd, 'home');
  await mkdir(join(home, '.stratos'), {recursive: true, mode: 0o700});
  for (const name of ['one', 'two']) {
    const dir = join(cwd, '.stratos/workflows', name);
    await mkdir(dir, {recursive: true});
    await writeFile(
      join(dir, 'workflow.yaml'),
      `name: ${name}\nshortDescription: MCP fixture\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: '1'\nmcp:\n  servers:\n    github:\n      type: http\n      url: https://${name}.example.com/mcp\n      auth:\n        type: oauth\n`,
    );
  }
  const exec = promisify(execFile);
  const call = async (...args: string[]) =>
    exec(
      process.execPath,
      [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), 'mcp', ...args, '--json'],
      {cwd, env: {...process.env, HOME: home}},
    );
  const list = JSON.parse((await call('list')).stdout);
  assert.equal(list.data.length, 2);
  assert.match(list.message, /github \(one\)/);
  await assert.rejects(access(join(cwd, '.stratos/workflows/node_modules')));
  await assert.rejects(call('logout', '--name', 'github'), error =>
    String((error as {stdout: string}).stdout).includes('ambiguous'),
  );
  const store = new CredentialStore(join(home, '.stratos'));
  for (const name of ['one', 'two']) {
    await store.save({
      serverUrl: `https://${name}.example.com/mcp`,
      authorizationServer: 'https://auth.example.com',
      clientId: name,
      accessToken: 'not-for-output',
    });
  }
  const logout = await call('logout', '--name', 'github', '--workflow', 'one');
  assert.equal(JSON.parse(logout.stdout).success, true);
  assert.doesNotMatch(logout.stdout, /not-for-output/);
  assert.equal((await store.list())[0]?.clientId, 'two');
  assert.equal((await store.list()).length, 1);
});

void test('MCP CLI reports discovery errors, validates actions and keeps explicit credentials out of OAuth', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'stratos-mcp-cli-errors-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const home = join(cwd, 'home');
  await mkdir(home);
  const run = promisify(execFile);
  const call = (...args: string[]) =>
    run(
      process.execPath,
      [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), 'mcp', ...args, '--json'],
      {cwd, env: {...process.env, HOME: home}},
    );
  const rejects = (args: string[], expected: RegExp) =>
    assert.rejects(call(...args), error => {
      assert.ok(error instanceof Error && 'stdout' in error);
      const result = JSON.parse(String(error.stdout));
      assert.equal(result.success, false);
      assert.match(result.errors[0].message, expected);
      return true;
    });
  assert.equal(
    JSON.parse((await call('list')).stdout).message,
    'No MCP servers found.',
  );
  await rejects(['list', 'extra'], /does not accept/);
  await rejects(['unknown'], /Use stratos mcp/);
  await rejects(['login'], /Use stratos mcp/);
  await rejects(['logout', 'missing'], /not found/);
  const workflow = join(cwd, '.stratos/workflows/explicit');
  await mkdir(workflow, {recursive: true});
  await writeFile(
    join(workflow, 'workflow.yaml'),
    'name: explicit\nshortDescription: Fixture\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: "1"\nmcp:\n  servers:\n    local:\n      type: stdio\n      command: never-start-this-command\n',
  );
  for (const action of ['login', 'logout']) {
    const result = JSON.parse(
      (await call(action, 'local', '--workflow', 'explicit')).stdout,
    );
    assert.equal(result.success, true);
    assert.match(result.message, /explicit credentials/);
  }
  const broken = join(cwd, '.stratos/workflows/broken');
  await mkdir(broken);
  await writeFile(join(broken, 'workflow.yaml'), 'name: [');
  await rejects(['list'], /YAMLParseError/);
});

void test('MCP CLI requires an unambiguous OAuth identity and never deletes other clients', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'stratos-mcp-cli-identities-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const home = join(cwd, 'home');
  await mkdir(home);
  const path = join(cwd, '.stratos/workflows/oauth');
  await mkdir(path, {recursive: true});
  const manifest =
    'name: oauth\nshortDescription: Fixture\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: "1"\nmcp:\n  servers:\n    remote:\n      type: http\n      url: https://fixture.example.com/mcp\n      auth:\n        type: oauth\n';
  await writeFile(join(path, 'workflow.yaml'), manifest);
  const store = new CredentialStore(join(home, '.stratos'));
  for (const clientId of ['one', 'two']) {
    await store.save({
      serverUrl: 'https://fixture.example.com/mcp',
      authorizationServer: 'https://auth.example.com',
      clientId,
      accessToken: 'synthetic-token',
    });
  }
  const run = promisify(execFile);
  const logout = () =>
    run(
      process.execPath,
      [
        join(PACKAGE_ROOT, 'dist/src/cli/main.js'),
        'mcp',
        'logout',
        'remote',
        '--json',
      ],
      {cwd, env: {...process.env, HOME: home}},
    );
  await assert.rejects(logout(), error => {
    assert.ok(error instanceof Error && 'stdout' in error);
    assert.match(String(error.stdout), /Multiple MCP credential identities/);
    return true;
  });
  assert.equal((await store.list()).length, 2);
  await writeFile(
    join(path, 'workflow.yaml'),
    manifest + '        clientId: one\n',
  );
  assert.equal(JSON.parse((await logout()).stdout).success, true);
  assert.deepEqual(
    (await store.list()).map(record => record.clientId),
    ['two'],
  );
  assert.equal(JSON.parse((await logout()).stdout).success, true);
  assert.deepEqual(
    (await store.list()).map(record => record.clientId),
    ['two'],
  );
});
