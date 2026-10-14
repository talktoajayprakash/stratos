import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {z} from 'zod';

import {CredentialStore} from '../../src/mcp/credentials.js';
import {createWorkflowMcp} from '../../src/mcp/runtime.js';
import {PACKAGE_ROOT} from '../../src/paths.js';
import {workflow} from '../../src/workflows/definition.js';
import type {WorkflowMetadata} from '../../src/workflows/discovery.js';
import {executeWorkflow, getContext} from '../../src/workflows/runtime.js';
import {testHome, waitForRetention} from '../helpers/home.js';
import {mcpAuthFixture} from '../helpers/mcp-auth.js';

const empty = z.strictObject({});
const metadata = (url: string): WorkflowMetadata => ({
  name: 'preflight',
  shortDescription: 'Test fixture',
  longDescription: 'Exercise this test fixture with schema-valid input.',
  version: '1',
  entrypoint: 'workflow.ts',
  path: testHome,
  root: testHome,
  mcp: {
    servers: {
      protected: {type: 'http', url, auth: {type: 'oauth'}},
      unused: {
        type: 'http',
        url: 'http://127.0.0.1:1/unused',
        headers: {Authorization: '{env:STRATOS_PREFLIGHT_MISSING}'},
      },
      local: {type: 'stdio', command: 'stratos-preflight-must-not-spawn'},
    },
  },
});

void test('workflow preflight refreshes before business logic without discovering tools or starting other MCPs', async t => {
  const fixture = await mcpAuthFixture(t);
  const store = new CredentialStore();
  await store.save({
    serverUrl: fixture.url,
    authorizationServer: fixture.origin,
    clientId: 'fixture-client',
    accessToken: fixture.state.token,
    refreshToken: 'fixture-refresh',
    expiresAt: Date.now() / 1000 + 299,
  });
  let ran = 0;
  const definition = workflow({
    input: empty,
    output: empty,
    async run() {
      ran++;
      assert.equal(fixture.state.refreshes, 1);
      assert.equal(fixture.state.discoveries, 0);
      assert.equal(fixture.state.calls.length, 0);
      assert.equal(getContext().resources.size, 0);
      const record = (await store.list()).find(
        r => r.serverUrl === fixture.url,
      )!;
      assert.ok(record.expiresAt! > Date.now() / 1000 + 300);
      assert.equal(record.accessToken, fixture.state.token);
      const client = await createWorkflowMcp('protected', 300000);
      await client.callTool('echo', {value: 7});
      return {};
    },
  });
  await executeWorkflow(
    definition,
    {},
    'preflight',
    testHome,
    metadata(fixture.url),
  );
  assert.equal(ran, 1);
  assert.equal(fixture.state.refreshes, 1);
  assert.equal(fixture.state.logins, 0);
  assert.deepEqual(fixture.state.calls, [
    {value: 7, token: `Bearer ${fixture.state.token}`},
  ]);
});

void test('preflight failures prevent workflow side effects and invalid input skips authentication', async t => {
  const fixture = await mcpAuthFixture(t);
  const store = new CredentialStore();
  const record = {
    serverUrl: fixture.url,
    authorizationServer: fixture.origin,
    clientId: 'fixture-client',
    accessToken: fixture.state.token,
    refreshToken: 'fixture-refresh',
    expiresAt: 0,
  };
  await store.save(record);
  let ran = false;
  const definition = workflow({
    input: empty,
    output: empty,
    run() {
      ran = true;
      return {};
    },
  });
  const run = (input: unknown = {}) =>
    executeWorkflow(
      definition,
      input,
      'preflight',
      testHome,
      metadata(fixture.url),
    );
  await assert.rejects(run({unexpected: true}));
  assert.equal(fixture.state.requests.length, 0);
  fixture.state.failRefresh = true;
  await assert.rejects(run(), /refresh failed/);
  assert.deepEqual(
    (await store.list()).find(r => r.serverUrl === fixture.url),
    record,
  );
  fixture.state.failRefresh = false;
  fixture.state.expiresIn = 300;
  await assert.rejects(run(), /no more than five minutes/);
  assert.equal(fixture.state.refreshes, 2);
  assert.equal(fixture.state.logins, 0);
  assert.equal(fixture.state.discoveries, 0);
  assert.equal(fixture.state.calls.length, 0);
  assert.equal(ran, false);
});

void test('all declared OAuth credentials still have headroom after the last server authenticates', async t => {
  const first = await mcpAuthFixture(t);
  const second = await mcpAuthFixture(t);
  const store = new CredentialStore();
  const now = Date.now();
  for (const [fixture, expiresAt] of [
    [first, now / 1000 + 301],
    [second, 0],
  ] as const) {
    await store.save({
      serverUrl: fixture.url,
      authorizationServer: fixture.origin,
      clientId: 'fixture-client',
      accessToken: fixture.state.token,
      refreshToken: 'fixture-refresh',
      expiresAt,
    });
  }
  const original = globalThis.fetch;
  t.mock.timers.enable({apis: ['Date'], now});
  t.mock.method(
    globalThis,
    'fetch',
    async (...args: Parameters<typeof fetch>) => {
      const response = await original(...args);
      if (String(args[0]) === `${second.origin}/token`) {
        t.mock.timers.tick(2000);
      }
      return response;
    },
  );
  let ran = false;
  try {
    await assert.rejects(
      executeWorkflow(
        workflow({
          input: empty,
          output: empty,
          run() {
            ran = true;
            return {};
          },
        }),
        {},
        'preflight',
        testHome,
        {
          ...metadata(first.url),
          mcp: {
            servers: {
              first: {type: 'http', url: first.url, auth: {type: 'oauth'}},
              second: {type: 'http', url: second.url, auth: {type: 'oauth'}},
            },
          },
        },
      ),
      /no more than five minutes/,
    );
    assert.equal(first.state.refreshes, 0);
    assert.equal(second.state.refreshes, 1);
    assert.equal(ran, false);
  } finally {
    t.mock.timers.reset();
  }
});

void test(
  'parent cleanup cancels a child waiting for workflow-start authentication',
  {timeout: 15_000},
  async t => {
    let requested!: () => void;
    const request = new Promise<void>(resolve => {
      requested = resolve;
    });
    const server = createServer(() => requested());
    t.after(
      () =>
        new Promise<void>(resolve => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    let ran = false;
    let childResult: Promise<void> | undefined;
    const child = workflow({
      input: empty,
      output: empty,
      run() {
        ran = true;
        return {};
      },
    });
    const failure = new Error('parent failed');
    await assert.rejects(
      executeWorkflow(
        workflow({
          input: empty,
          output: empty,
          async run() {
            const owner = getContext();
            childResult = assert.rejects(
              executeWorkflow(
                child,
                {},
                'child',
                testHome,
                metadata(`http://127.0.0.1:${address.port}/mcp`),
                {},
                [],
                owner.agentPool,
                owner,
              ),
              /discovery failed|cancelled/,
            );
            await request;
            throw failure;
          },
        }),
        {},
        'parent',
        testHome,
      ),
      error => error === failure,
    );
    await childResult;
    assert.equal(ran, false);
  },
);

void test(
  'cached CLI run signs in before its body, reuses fresh credentials and rejects short refreshed tokens',
  {timeout: 120_000},
  async t => {
    const fixture = await mcpAuthFixture(t);
    const cwd = await mkdtemp(join(tmpdir(), 'stratos-workflow-auth-'));
    t.after(async () => {
      try {
        await waitForRetention();
      } finally {
        await rm(cwd, {recursive: true, force: true});
      }
    });
    const directory = join(cwd, '.stratos/workflows/preflight');
    const bin = join(cwd, 'bin');
    await mkdir(directory, {recursive: true});
    await mkdir(bin);
    for (const name of ['open', 'xdg-open']) {
      await writeFile(
        join(bin, name),
        `#!${process.execPath}
const response = await fetch(process.argv[2]);
if (!response.ok) throw new Error('Fixture sign-in failed');
`,
        {mode: 0o700},
      );
    }
    const marker = join(cwd, 'ran');
    await writeFile(
      join(directory, 'workflow.yaml'),
      `name: preflight
shortDescription: Workflow-start authentication
longDescription: Exercise this test fixture with schema-valid input.
version: '1'
mcp:
  servers:
    protected:
      type: http
      url: ${fixture.url}
      auth:
        type: oauth
`,
    );
    await writeFile(
      join(directory, 'workflow.ts'),
      `import {appendFileSync} from 'node:fs';
import {workflow} from '@stratoscli/stratos'; import {z} from 'zod';
export default workflow({input:z.strictObject({}),output:z.strictObject({}),
run(){appendFileSync(${JSON.stringify(marker)},'ran\\n');return {};}});
`,
    );
    const call = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), ...args, '--json'],
        {
          cwd,
          env: {...process.env, PATH: `${bin}:${process.env.PATH}`},
          timeout: 90_000,
          signal: t.signal,
        },
      );
    await call('describe', 'preflight');
    await call('schema', 'preflight');
    assert.equal(
      fixture.state.requests.length,
      0,
      'Description/schema preparation does not run preflight',
    );
    await assert.rejects(readFile(marker), {code: 'ENOENT'});
    const first = await call('run', 'preflight');
    assert.equal(JSON.parse(first.stdout).success, true);
    assert.match(first.stderr, /MCP sign-in required/);
    assert.doesNotMatch(
      first.stdout,
      /MCP sign-in required|fixture-access|fixture-refresh/,
    );
    assert.doesNotMatch(
      first.stderr,
      /not built|fixture-access|fixture-refresh/,
    );
    assert.equal(fixture.state.logins, 1);
    assert.equal(fixture.state.discoveries, 0);
    await call('run', 'preflight');
    assert.equal(fixture.state.logins, 1);
    assert.equal(await readFile(marker, 'utf8'), 'ran\nran\n');
    const store = new CredentialStore();
    const record = (await store.list()).find(r => r.serverUrl === fixture.url)!;
    await store.save({...record, expiresAt: 0});
    fixture.state.expiresIn = 300;
    await assert.rejects(call('run', 'preflight'), error => {
      const result = JSON.parse((error as {stdout: string}).stdout);
      assert.equal(result.success, false);
      assert.match(JSON.stringify(result.errors), /no more than five minutes/);
      assert.doesNotMatch(
        JSON.stringify(result),
        /fixture-access|fixture-refresh/,
      );
      return true;
    });
    assert.equal(fixture.state.refreshes, 1);
    assert.equal(await readFile(marker, 'utf8'), 'ran\nran\n');
  },
);
