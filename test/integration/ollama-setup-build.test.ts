import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {readOllamaInventory} from '../../src/agents/ollama.js';
import {PACKAGE_ROOT} from '../../src/paths.js';
import {validateWorkflowOllama} from '../../src/workflows/ollama.js';
import {testHome, waitForRetention} from '../helpers/home.js';
import {ollamaFixture} from '../helpers/ollama.js';

void test('build validates declared agent/Decision local IDs, capabilities and exact endpoints without inference', async t => {
  const f = await ollamaFixture(t);
  const base = {
    name: 'test',
    shortDescription: 'Test fixture',
    longDescription: 'Exercise this test fixture with schema-valid input.',
    version: '1',
    entrypoint: 'workflow.ts',
    path: '',
    root: '',
  };
  const env = {OLLAMA_HOST: f.url};
  const agent = (model: string[]) => ({
    ...base,
    agents: {analyst: {provider: 'ollama', harness: 'codex', model}},
  });
  await validateWorkflowOllama(agent(['gemma4:26b', 'custom']), env);
  assert.equal(f.requests.filter(r => r.path === '/api/tags').length, 1);
  const decision = {
    ...base,
    decision: {decision: {provider: 'ollama', model: 'nimble'}},
  };
  await validateWorkflowOllama(decision, {OLLAMA_HOST: new URL(f.url).host});
  assert.equal(f.requests.filter(r => r.path === '/api/tags').length, 2);
  await validateWorkflowOllama(
    {
      ...base,
      decision: {partial: {provider: 'ollama'}},
    },
    env,
  );
  const count = f.requests.length;
  for (const host of [
    '',
    'not a host',
    'http://secret@localhost',
    `${f.url}/prefix`,
  ]) {
    await assert.rejects(
      validateWorkflowOllama(decision, {OLLAMA_HOST: host}),
      error =>
        error instanceof Error &&
        /OLLAMA_HOST/.test(error.message) &&
        !error.message.includes('secret'),
    );
  }
  await assert.rejects(
    validateWorkflowOllama(
      {
        ...base,
        decision: {
          decision: {provider: 'ollama', model: 'nimble', baseUrl: ''},
        },
      },
      env,
    ),
    /Invalid Ollama discovery base URL/,
  );
  assert.equal(
    f.requests.length,
    count,
    'Invalid configured endpoints do not fall back',
  );
  await assert.rejects(
    validateWorkflowOllama(agent(['gemma4:26b', 'absent']), env),
    /agents.analyst.*absent:latest.*not installed.*stratos provider status ollama/,
  );
  await assert.rejects(
    validateWorkflowOllama(agent(['cloud']), env),
    /cloud-backed/,
  );
  await assert.rejects(
    validateWorkflowOllama(agent(['nimble']), env),
    /completion and tools/,
  );
  await assert.rejects(
    validateWorkflowOllama(agent(['embed']), env),
    /completion and tools/,
  );
  await assert.rejects(
    validateWorkflowOllama(agent(['bad model']), env),
    /Invalid Ollama/,
  );
  await validateWorkflowOllama(
    {
      ...base,
      decision: {
        decision: {provider: 'ollama', model: 'nimble', baseUrl: f.url},
      },
    },
    {OLLAMA_HOST: 'invalid://must-not-override-explicit-url'},
  );
  await assert.rejects(
    validateWorkflowOllama(
      {
        ...base,
        decision: {
          decision: {provider: 'ollama', model: 'gemma4:26b', baseUrl: f.url},
        },
      },
      env,
    ),
    /decision capabilities/,
  );
  const before = f.requests.length;
  await validateWorkflowOllama(
    {
      ...base,
      agents: {remote: {provider: 'azure', model: ['openai/gpt-6-astra']}},
    },
    env,
  );
  assert.equal(
    f.requests.length,
    before,
    'Other providers do not probe Ollama',
  );
  await validateWorkflowOllama(
    {...base, agents: {partial: {provider: 'ollama'}}},
    env,
  );
  assert.ok(
    f.requests.length > before,
    'Known Ollama provider still checks the server without guessing a model',
  );
  await assert.rejects(
    validateWorkflowOllama(
      {...base, agents: {partial: {provider: 'ollama'}}},
      {OLLAMA_HOST: 'http://127.0.0.1:1'},
    ),
    /stratos provider status ollama/,
  );
  await assert.rejects(
    validateWorkflowOllama({
      ...base,
      decision: {partial: {provider: 'ollama', baseUrl: 'http://127.0.0.1:1'}},
    }),
    /stratos provider status ollama/,
  );
  assert.ok(
    f.requests.every(r => ['/api/tags', '/api/show'].includes(r.path!)),
  );
  await assert.rejects(
    validateWorkflowOllama(agent(['gemma4:26b']), {
      OLLAMA_HOST: 'http://127.0.0.1:1',
    }),
    /stratos provider status ollama --json/,
  );
  await assert.rejects(
    validateWorkflowOllama({
      ...base,
      agents: {analyst: {provider: 'ollama', effort: 'low'}},
    }),
    /leave effort unset/,
  );
  await assert.rejects(
    validateWorkflowOllama({
      ...base,
      agents: {analyst: {provider: 'ollama', harness: 'claude-code'}},
    }),
    /requires codex or opencode/,
  );
  const prefixed = await ollamaFixture(t, '/local');
  await validateWorkflowOllama(
    {
      ...base,
      decision: {
        decision: {provider: 'ollama', model: 'nimble', baseUrl: prefixed.url},
      },
    },
    {OLLAMA_HOST: 'invalid://must-not-override-prefix'},
  );
  assert.ok(prefixed.requests.every(r => r.path?.startsWith('/local/api/')));
  await assert.rejects(
    readOllamaInventory('https://user:private-password@host'),
    /Invalid Ollama discovery base URL/,
  );
  const abort = new AbortController();
  abort.abort(new Error('cancel inventory'));
  await assert.rejects(
    readOllamaInventory(f.url, abort.signal),
    /cancel inventory/,
  );
});

void test(
  'CLI provider status/build diagnose readiness and recheck cached/child builds without running workflow bodies',
  {timeout: 180000},
  async t => {
    const f = await ollamaFixture(t);
    const directory = await mkdtemp(join(tmpdir(), 'stratos-ollama-build-'));
    t.after(async () => {
      try {
        await waitForRetention();
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    });
    const root = join(directory, '.stratos/workflows');
    const work = join(root, 'local');
    await mkdir(work, {recursive: true});
    const env = {...process.env, HOME: testHome, OLLAMA_HOST: f.url};
    const call = async (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
      try {
        return await promisify(execFile)(
          process.execPath,
          [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), ...args, '--json'],
          {
            cwd: directory,
            env: {...env, ...overrides},
            timeout: 90000,
            signal: t.signal,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
      } catch (error) {
        const failure = error as Error & {stdout?: string};
        throw new Error(failure.stdout || failure.message, {cause: error});
      }
    };
    const manifest = (model = 'gemma4:26b') =>
      `name: local\nshortDescription: Local fixture\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: "1"\nagents:\n  analyst:\n    provider: ollama\n    harness: opencode\n    model: [${model}]\n`;
    await writeFile(join(work, 'workflow.yaml'), manifest());
    await writeFile(
      join(work, 'workflow.ts'),
      `import {workflow} from '@stratoscli/stratos'; import {z} from 'zod';
export default workflow({input:z.strictObject({}),output:z.strictObject({}),run(){ throw new Error('BODY_MUST_NOT_RUN'); }});`,
    );
    const setup = JSON.parse(
      (await call(['provider', 'status', 'ollama'])).stdout,
    );
    assert.equal(setup.data.status, 'ready');
    assert.equal(setup.data.models.length, 5);
    const text = await promisify(execFile)(
      process.execPath,
      [
        join(PACKAGE_ROOT, 'dist/src/cli/main.js'),
        'provider',
        'status',
        'ollama',
      ],
      {cwd: directory, env, signal: t.signal},
    );
    assert.equal(text.stderr, '');
    assert.match(text.stdout, /Ollama 0.35.1 is reachable/);
    const beforeHelp = f.requests.length;
    await call(['provider', 'status', 'ollama', '--help']);
    await assert.rejects(
      call(['setup', 'ollama']),
      /stratos provider status ollama/,
    );
    assert.equal(
      f.requests.length,
      beforeHelp,
      'Help and removed commands do not probe the provider',
    );
    for (const args of [
      ['provider'],
      ['provider', 'status'],
      ['provider', 'unknown', 'ollama'],
      ['provider', 'status', 'unknown'],
      ['provider', 'status', 'ollama', '--input', '{}'],
      ['provider', 'status', 'ollama', '--name', 'x'],
    ]) {
      await assert.rejects(call(args), /success":false/);
    }
    await assert.rejects(
      call(['provider', 'status', 'ollama'], {
        OLLAMA_HOST: 'http://127.0.0.1:1',
      }),
      /OLLAMA_SETUP_REQUIRED/,
    );
    await assert.rejects(
      call(['build', 'local'], {OLLAMA_HOST: 'http://127.0.0.1:1'}),
      /stratos provider status ollama/,
    );
    await assert.rejects(stat(join(root, 'node_modules')), {code: 'ENOENT'});
    assert.equal(
      JSON.parse((await call(['build', 'local'])).stdout).success,
      true,
    );
    for (const alias of ['stratos', 'st']) {
      const installed = await promisify(execFile)(
        join(root, 'node_modules/.bin', alias),
        ['provider', 'status', 'ollama', '--json'],
        {cwd: directory, env, signal: t.signal},
      );
      assert.equal(installed.stderr, '');
      assert.deepEqual(JSON.parse(installed.stdout), setup);
    }
    const record = join(work, 'dist/.stratos-build.json');
    await stat(record);
    const version = await readFile(record, 'utf8');
    const count = f.requests.length;
    await call(['list']);
    await call(['schema', 'local']);
    assert.equal(
      f.requests.length,
      count,
      'list/schema do not require the Ollama service',
    );
    await call(['build', 'local']);
    assert.ok(
      f.requests.length > count,
      'Explicit cached build rechecks installed models',
    );
    assert.equal(await readFile(record, 'utf8'), version);
    delete f.models['gemma4:26b'];
    await assert.rejects(
      call(['build', 'local']),
      /not installed.*stratos provider status ollama/,
    );
    await assert.rejects(stat(record), {code: 'ENOENT'});
    // Implicit compilation must not block a later effective runtime override.
    await call(['schema', 'local']);
    f.models['gemma4:26b'] = {capabilities: ['completion', 'tools']};
    await call(['build', 'local']);
    const parent = join(root, 'parent');
    await mkdir(parent);
    await writeFile(
      join(parent, 'workflow.yaml'),
      'name: parent\nshortDescription: Parent fixture\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: "1"\n',
    );
    await writeFile(
      join(parent, 'workflow.ts'),
      `import {workflow} from '@stratoscli/stratos'; import {z} from 'zod'; import createChild from '../.generated/local.js';
export default workflow({input:z.strictObject({}),output:z.strictObject({}),run(){return createChild().execute({});}});`,
    );
    await call(['build', 'parent']);
    delete f.models['gemma4:26b'];
    await assert.rejects(
      call(['build', 'parent']),
      /local: agents.analyst.*not installed/,
    );
    await assert.rejects(stat(join(parent, 'dist/.stratos-build.json')), {
      code: 'ENOENT',
    });
    const independent = join(root, 'independent');
    await mkdir(independent);
    await writeFile(
      join(independent, 'workflow.yaml'),
      'name: independent\nshortDescription: Independent fixture\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: "1"\n',
    );
    await writeFile(
      join(independent, 'workflow.ts'),
      `import {workflow} from '@stratoscli/stratos'; import {z} from 'zod';
export default workflow({input:z.strictObject({}),output:z.strictObject({}),run(){ return {}; }});`,
    );
    await assert.rejects(call(['build']), /success":false/);
    await stat(join(independent, 'dist/.stratos-build.json'));
    await rm(join(work, 'workflow.ts'));
    await assert.rejects(call(['build', 'local']), /not installed/);
    await assert.rejects(
      call(['build', 'local'], {OLLAMA_HOST: 'http://127.0.0.1:1'}),
      /stratos provider status ollama --json/,
    );
    assert.ok(
      f.requests.every(r =>
        ['/api/version', '/api/tags', '/api/show'].includes(r.path!),
      ),
    );
  },
);
