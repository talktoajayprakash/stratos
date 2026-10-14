import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {z} from 'zod';

import {createAgentWithAdapters} from '../../src/agents/agent.js';
import type {AgentEventConsumer} from '../../src/agents/events.js';
import {withFileLock} from '../../src/file-lock.js';
import {workflow} from '../../src/index.js';
import {
  runName,
  workspaceName,
  readJson,
  type RunMetadata,
} from '../../src/telemetry/artifact-storage.js';
import {RunArtifacts} from '../../src/telemetry/artifacts.js';
import {RunTelemetry} from '../../src/telemetry/export.js';
import {cleanRuns} from '../../src/telemetry/retention.js';
import {executeWorkflow, getContext} from '../../src/workflows/runtime.js';
import {testHome, waitForRetention} from '../helpers/home.js';

const empty = z.strictObject({});
const definition = (run: () => Promise<{}>) =>
  workflow({input: empty, output: empty, run});
const root = join(testHome, '.stratos/runs');
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return {promise, resolve};
};
async function metadata(path: string) {
  return JSON.parse(
    await readFile(join(path, 'run.json'), 'utf8'),
  ) as RunMetadata;
}
async function makeRun(
  workspace: string,
  index: number,
  status: 'running' | 'success' = 'success',
  storage = root,
) {
  const parent = join(storage, workspaceName(workspace));
  await mkdir(parent, {recursive: true});
  await writeFile(
    join(parent, 'workspace.json'),
    JSON.stringify({path: workspace}),
  );
  const data: RunMetadata = {
    version: 1,
    workflowName: 'retention',
    executionId: randomUUID(),
    startedAt: new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString(),
    status,
    ...(status === 'success'
      ? {completedAt: new Date(Date.UTC(2020, 0, 1, 0, 1, index)).toISOString()}
      : {}),
  };
  const path = join(parent, runName(data));
  await mkdir(path);
  await writeFile(join(path, 'run.json'), JSON.stringify(data));
  return path;
}

void test('approved workspace identity, UTF-8 limits, run names and owner-only files', async () => {
  const telemetry = new RunTelemetry();
  const paths = ['/work/a-b', '/work/a/b', '/' + '界'.repeat(120)];
  const created: string[] = [];
  try {
    for (const workspace of paths) {
      const id = randomUUID();
      const run = await RunArtifacts.create(
        workspace,
        '../workflow\n' + 'w'.repeat(400),
        id,
        telemetry,
      );
      assert.ok(run);
      created.push(run.path);
      run.enter(id);
      assert.ok(run.path.endsWith('-' + id));
      const segments = run.path.split('/');
      assert.ok(segments.every(segment => Buffer.byteLength(segment) <= 255));
      assert.match(
        segments.at(-1)!,
        /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-/,
      );
      const parent = join(run.path, '..');
      assert.deepEqual(await readJson(join(parent, 'workspace.json')), {
        path: workspace,
      });
      for (const name of ['run.json', 'run.log', 'events.jsonl']) {
        assert.equal((await stat(join(run.path, name))).mode & 0o777, 0o600);
      }
      assert.equal((await stat(run.path)).mode & 0o777, 0o700);
      await run.leave(id, 'success');
    }
    assert.match(created[1]!, new RegExp('/\\-work-a-b-[a-f0-9]{12}/'));
    assert.notEqual(
      created[0]!.split('/').at(-2),
      created[1]!.split('/').at(-2),
    );
    assert.match(workspaceName(paths[2]!), /-[a-f0-9]{12}$/);
  } finally {
    await telemetry.close();
    await waitForRetention();
  }
});

void test('console capture preserves qualifiers, native formatting, nested ownership and concurrent JSONL writes', async () => {
  let path!: string;
  let parentId!: string;
  let childId!: string;
  const before = console.log;
  const secret = 'private-artifact-fixture';
  await executeWorkflow(
    definition(async () => {
      const parent = getContext();
      path = parent.artifacts!.path;
      parentId = parent.id;
      parent.telemetry.addSecret(secret);
      const object = {answer: 42, apiKey: secret};
      console.log('%s: %d %o', 'value', 42, object);
      object.answer = 99;
      console.info('multi\nline');
      console.error(
        new Error(`failure ${secret}`, {cause: new Error('cause')}),
      );
      await Promise.all(
        Array.from({length: 50}, async (_, index) => {
          parent.artifacts!.event(
            {
              workflowName: parent.name,
              executionId: parent.id,
              agentSessionId: 'logical-session',
            },
            {
              type: 'message.delta',
              timestamp: 100 + index,
              text: `${index}:${secret}`,
            },
          );
          await Promise.resolve();
        }),
      );
      await executeWorkflow(
        definition(async () => {
          childId = getContext().id;
          console.warn('child-message');
          console.debug('debug-message');
          return {};
        }),
        {},
        'child',
        testHome,
        undefined,
        {},
        [],
        parent.agentPool,
        parent,
      );
      return {};
    }),
    {},
    'parent',
    testHome,
  );
  assert.equal(console.log, before);
  const log = await readFile(join(path, 'run.log'), 'utf8');
  assert.match(log, /value: 42/);
  assert.match(log, /answer: 42/);
  assert.doesNotMatch(log, /answer: 99/);
  assert.ok(log.includes(parentId) && log.includes(childId));
  assert.match(log, new RegExp(`"parentExecutionId":"${parentId}"`));
  assert.ok(
    log
      .split('\n')
      .filter(line => line.endsWith('multi') || line.endsWith('line'))
      .every(line => line.includes('"workflowName":"parent"')),
  );
  assert.match(log, /Error: failure \[redacted\]/);
  assert.match(log, /cause/);
  assert.ok(!log.includes(secret));
  const events = (await readFile(join(path, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(events.length, 50);
  assert.deepEqual(
    events.map(event => event.timestamp),
    Array.from({length: 50}, (_, i) => 100 + i),
  );
  assert.ok(
    events.every(
      event =>
        event.executionId === parentId &&
        event.agentSessionId === 'logical-session' &&
        event.event.text.endsWith('[redacted]'),
    ),
  );
  assert.equal((await metadata(path)).status, 'success');
  assert.deepEqual((await readdir(path)).sort(), [
    'events.jsonl',
    'run.json',
    'run.log',
  ]);
});

void test('all agent events persist through startup, repeated calls, idle background work and close, with stable session IDs', async () => {
  let path!: string;
  let parentId!: string;
  const emitters: AgentEventConsumer[] = [];
  await executeWorkflow(
    definition(async () => {
      const owner = getContext();
      path = owner.artifacts!.path;
      parentId = owner.id;
      const adapters: Parameters<typeof createAgentWithAdapters>[1] = {
        async preflight() {
          return {
            available: true,
            catalogs: [
              {
                provider: 'openai',
                source: 'fixture',
                modelIds: ['gpt-6-astra'],
                complete: true,
              },
            ],
          };
        },
        createAdapter({options}) {
          const send = options.onEvent;
          emitters.push(send);
          return {
            async initialize() {
              await send({
                type: 'background.started',
                timestamp: 1,
                taskId: 'startup',
              });
            },
            async execute() {
              await options.hooks?.beforeToolCall?.({
                toolCallId: 'tool',
                toolName: 'fixture',
                input: {},
              });
              await send({type: 'message.delta', timestamp: 2, text: 'hello'});
              return 'hello';
            },
            cancel() {},
            async close() {
              await send({
                type: 'background.completed',
                timestamp: 4,
                taskId: 'startup',
              });
            },
          };
        },
      };
      const a = createAgentWithAdapters(
        {
          model: ['openai/gpt-6-astra'],
          hooks: {
            beforeToolCall() {
              console.log('bound-tool-hook');
            },
          },
        },
        adapters,
      );
      const b = createAgentWithAdapters(
        {model: ['openai/gpt-6-astra']},
        adapters,
      );
      await a.execute('one');
      await a.execute('two');
      await b.execute('other');
      await emitters[0]!({
        type: 'background.activity',
        timestamp: 3,
        taskId: 'startup',
        progress: 'idle activity',
      });
      return {};
    }),
    {},
    'agent-events',
    testHome,
  );
  const events = (await readFile(join(path, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(events.length, 8);
  const ids = new Set(events.map(event => event.agentSessionId));
  assert.equal(ids.size, 2);
  assert.equal(events[0].agentSessionId, events[2].agentSessionId);
  assert.ok(events.every(event => event.executionId === parentId));
  assert.equal(
    events.filter(event => event.event.type === 'background.completed').length,
    2,
  );
  assert.match(
    await readFile(join(path, 'run.log'), 'utf8'),
    /"agentSessionId":".*".*bound-tool-hook/,
  );
  const before = await readFile(join(path, 'events.jsonl'), 'utf8');
  await emitters[0]!({
    type: 'message.delta',
    timestamp: 5,
    text: 'after closure',
  });
  assert.equal(await readFile(join(path, 'events.jsonl'), 'utf8'), before);
});

void test('unawaited child keeps the whole group active after parent return; caught child failure does not fail parent metadata', async () => {
  const entered = deferred();
  const release = deferred();
  let child!: Promise<unknown>;
  let path!: string;
  try {
    await executeWorkflow(
      definition(async () => {
        const parent = getContext();
        path = parent.artifacts!.path;
        child = executeWorkflow(
          definition(async () => {
            entered.resolve();
            await release.promise;
            console.log('late child output');
            return {};
          }),
          {},
          'late-child',
          testHome,
          undefined,
          {},
          [],
          parent.agentPool,
          parent,
        );
        await entered.promise;
        return {};
      }),
      {},
      'early-parent',
      testHome,
    );
    assert.equal((await metadata(path)).status, 'running');
    await cleanRuns(root, {maxRunsPerWorkspace: 0, maxRunsTotal: 0});
    assert.equal((await metadata(path)).status, 'running');
  } finally {
    release.resolve();
    await child;
  }
  assert.equal((await metadata(path)).status, 'success');
  assert.match(
    await readFile(join(path, 'run.log'), 'utf8'),
    /late child output/,
  );
  await executeWorkflow(
    definition(async () => {
      const parent = getContext();
      path = parent.artifacts!.path;
      await assert.rejects(
        executeWorkflow(
          definition(async () => {
            throw new Error('caught');
          }),
          {},
          'failed-child',
          testHome,
          undefined,
          {},
          [],
          parent.agentPool,
          parent,
        ),
      );
      return {};
    }),
    {},
    'successful-parent',
    testHome,
  );
  assert.equal((await metadata(path)).status, 'success');
  await assert.rejects(
    executeWorkflow(
      definition(async () => {
        path = getContext().artifacts!.path;
        throw new Error('uncaught');
      }),
      {},
      'failed-parent',
      testHome,
    ),
    /uncaught/,
  );
  assert.equal((await metadata(path)).status, 'error');
});

void test('both retention limits apply, oldest completed groups go first, active/unknown/symlink data survives', async () => {
  await waitForRetention();
  const space = await mkdtemp(join(testHome, 'retention-'));
  const storage = join(space, 'runs');
  const roots: string[] = [];
  const active: string[] = [];
  for (let w = 0; w < 3; w++) {
    const workspace = join(space, String(w));
    roots.push(join(storage, workspaceName(workspace)));
    for (let i = 0; i < 5; i++) {
      const path = await makeRun(
        workspace,
        w * 10 + i,
        i === 0 ? 'running' : 'success',
        storage,
      );
      if (i === 0) {
        active.push(path);
      }
    }
  }
  const unknown = join(roots[0]!, 'unknown');
  await mkdir(unknown);
  await writeFile(join(unknown, 'keep'), 'user data');
  await promisify(execFile)('mkfifo', [join(unknown, 'run.json')]);
  const outside = join(space, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep'), 'outside');
  await symlink(outside, join(roots[0]!, 'linked-run'));
  await cleanRuns(storage, {maxRunsPerWorkspace: 3, maxRunsTotal: 6});
  for (const path of active) {
    assert.equal((await metadata(path)).status, 'running');
  }
  assert.equal(await readFile(join(unknown, 'keep'), 'utf8'), 'user data');
  assert.equal((await stat(join(unknown, 'run.json'))).isFIFO(), true);
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'outside');
  const kept: RunMetadata[] = [];
  for (const parent of roots) {
    for (const entry of await readdir(parent, {withFileTypes: true})) {
      if (entry.isDirectory() && entry.name !== 'unknown') {
        kept.push(await metadata(join(parent, entry.name)));
      }
    }
  }
  assert.equal(kept.length, 6);
  const completed = kept.filter(run => run.status !== 'running');
  assert.ok(
    completed.every(
      run =>
        run.startedAt >= new Date(Date.UTC(2020, 0, 1, 0, 0, 14)).toISOString(),
    ),
  );
  assert.equal(completed.length, 3);
  await cleanRuns(storage, {maxRunsPerWorkspace: 0, maxRunsTotal: 0});
  for (const path of active) {
    assert.equal((await metadata(path)).status, 'running');
  }
});

void test('concurrent cleanup processes enforce the default global 100 limit without deleting active or newest runs', async () => {
  const storage = await mkdtemp(join(testHome, 'global-runs-'));
  const paths: string[] = [];
  for (let index = 0; index < 110; index++) {
    paths.push(
      await makeRun(
        `/global/${Math.floor(index / 10)}`,
        index,
        'success',
        storage,
      ),
    );
  }
  const module = new URL('../../src/telemetry/retention.js', import.meta.url)
    .href;
  await Promise.all(
    Array.from({length: 3}, () =>
      promisify(execFile)(process.execPath, [
        '--input-type=module',
        '-e',
        `import { cleanRuns } from ${JSON.stringify(module)}; await cleanRuns(${JSON.stringify(storage)}, {maxRunsPerWorkspace:10,maxRunsTotal:100});`,
      ]),
    ),
  );
  for (const path of paths.slice(0, 10)) {
    await assert.rejects(stat(path), {code: 'ENOENT'});
  }
  for (const path of paths.slice(10)) {
    assert.equal((await metadata(path)).status, 'success');
  }
});

void test('simultaneous processes claim colliding workspace names without mixing identities or records', async () => {
  const storageName = `/simultaneous/${randomUUID()}`;
  const spaces = [storageName + '/a-b', storageName + '/a/b'];
  const module = new URL('../../src/workflows/runtime.js', import.meta.url)
    .href;
  const results = await Promise.all(
    Array.from({length: 6}, (_, index) =>
      promisify(execFile)(process.execPath, [
        '--input-type=module',
        '-e',
        `
    import { executeWorkflow, getContext } from ${JSON.stringify(module)};
    import { z } from 'zod';
    let path;
    await executeWorkflow({input:z.strictObject({}),output:z.object({}),async run(){
      path=getContext().artifacts.path; console.error('process-${index}'); return {};
    }}, {}, 'concurrent', ${JSON.stringify(spaces[index % 2])});
    process.stdout.write(JSON.stringify(path));
  `,
      ]),
    ),
  );
  const paths = results.map(result => JSON.parse(result.stdout) as string);
  assert.equal(new Set(paths).size, 6);
  for (const [index, path] of paths.entries()) {
    assert.deepEqual(await readJson(join(path, '../workspace.json')), {
      path: spaces[index % 2],
    });
    const log = await readFile(join(path, 'run.log'), 'utf8');
    assert.match(log, new RegExp(`process-${index}`));
    assert.equal(log.trim().split('\n').length, 1);
  }
});

void test('write and initialization failures are reported without failing workflow output or another artifact stream', async t => {
  await waitForRetention();
  const probe = await open(join(testHome, 'handle-probe'), 'w');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const write = prototype.writeFile;
  await probe.close();
  const mocked = t.mock.method(
    prototype,
    'writeFile',
    async function (
      this: FileHandle,
      ...args: Parameters<FileHandle['writeFile']>
    ) {
      if (String(args[0]).includes('force-write-failure')) {
        throw new Error('Sensitive disk diagnostic');
      }
      return write.apply(this, args);
    },
  );
  let path!: string;
  try {
    assert.deepEqual(
      await executeWorkflow(
        definition(async () => {
          const owner = getContext();
          path = owner.artifacts!.path;
          console.log('force-write-failure');
          owner.artifacts!.event(
            {workflowName: owner.name, executionId: owner.id},
            {type: 'message.delta', timestamp: 1, text: 'still-persisted'},
          );
          return {};
        }),
        {},
        'write-error',
        testHome,
      ),
      {},
    );
    assert.equal((await metadata(path)).status, 'success');
    assert.match(
      await readFile(join(path, 'events.jsonl'), 'utf8'),
      /still-persisted/,
    );
  } finally {
    mocked.mock.restore();
  }
  const unusable = await mkdtemp(join(testHome, 'unusable-'));
  await mkdir(join(unusable, '.stratos'));
  await writeFile(join(unusable, '.stratos/runs'), 'not a directory');
  const previous = process.env.HOME;
  process.env.HOME = unusable;
  try {
    assert.deepEqual(
      await executeWorkflow(
        definition(async () => {
          assert.equal(getContext().artifacts, undefined);
          console.log('continues without artifacts');
          return {};
        }),
        {},
        'unwritable',
        testHome,
      ),
      {},
    );
  } finally {
    process.env.HOME = previous;
  }
});

void test('detached cleanup outlives its launching process and waits safely for a competing cleaner lock', async () => {
  const storage = await mkdtemp(join(testHome, 'detached-runs-'));
  const path = await makeRun('/detached', 0, 'success', storage);
  const module = new URL('../../src/telemetry/retention.js', import.meta.url)
    .href;
  await withFileLock(join(storage, '.lock'), async () => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {launchRetention} from ${JSON.stringify(module)}; launchRetention(${JSON.stringify(storage)}, {maxRunsPerWorkspace:0,maxRunsTotal:0});`,
      ],
      {stdio: ['ignore', 'ignore', 'inherit']},
    );
    const [code] = await once(child, 'exit', {
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(code, 0);
    assert.equal(
      (await metadata(path)).status,
      'success',
      'Cleanup must not delete through another process lock',
    );
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Detached cleanup did not finish');
});

void test('hashed identity collisions, symlinked metadata and invalid settings fail softly without overwriting', async () => {
  const workspace = '/collision/a/b';
  for (const name of [
    workspaceName(workspace),
    workspaceName(workspace, true),
  ]) {
    const target = join(root, name);
    await mkdir(target);
    await writeFile(
      join(target, 'workspace.json'),
      JSON.stringify({path: '/different'}),
    );
  }
  const telemetry = new RunTelemetry();
  assert.equal(
    await RunArtifacts.create(workspace, 'collision', randomUUID(), telemetry),
    undefined,
  );
  const name = workspaceName('/symlinked');
  await mkdir(join(root, name));
  const outside = join(testHome, 'outside.json');
  await writeFile(outside, JSON.stringify({path: '/symlinked'}));
  await symlink(outside, join(root, name, 'workspace.json'));
  assert.equal(
    await RunArtifacts.create('/symlinked', 'symlink', randomUUID(), telemetry),
    undefined,
  );
  await writeFile(
    join(testHome, '.stratos/settings.json'),
    '{"logging":{"retention":{"maxRunsTotal":-1}}}',
  );
  let path!: string;
  try {
    await executeWorkflow(
      definition(async () => {
        path = getContext().artifacts!.path;
        return {};
      }),
      {},
      'bad-settings',
      testHome,
    );
    assert.equal((await metadata(path)).status, 'success');
  } finally {
    await rm(join(testHome, '.stratos/settings.json'));
    await telemetry.close();
  }
  assert.equal(
    await readFile(outside, 'utf8'),
    JSON.stringify({path: '/symlinked'}),
  );
});

void test('detached default cleanup enforces 10 per workspace after final artifacts are saved', async () => {
  await waitForRetention();
  const workspace = join(testHome, 'default-retention');
  for (let i = 0; i < 12; i++) {
    await makeRun(workspace, i);
  }
  await executeWorkflow(
    definition(async () => {
      console.log('final record');
      return {};
    }),
    {},
    'latest',
    workspace,
  );
  await waitForRetention();
  const parent = join(root, workspaceName(workspace));
  const directories = (await readdir(parent, {withFileTypes: true})).filter(
    entry => entry.isDirectory(),
  );
  assert.equal(directories.length, 10);
  const latest = directories
    .map(entry => entry.name)
    .sort()
    .at(-1)!;
  assert.match(
    await readFile(join(parent, latest, 'run.log'), 'utf8'),
    /final record/,
  );
  assert.equal((await metadata(join(parent, latest))).status, 'success');
});
