import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  access,
} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import test from 'node:test';

import {parse, stringify} from 'smol-toml';

import {ModelUnavailableError} from '../../src/agents/availability.js';
import {
  CodexAdapter,
  type CodexAdapterOptions,
} from '../../src/agents/codex/adapter.js';
import {readCodexCatalog} from '../../src/agents/codex/catalog.js';
import {preflightCodex} from '../../src/agents/codex/preflight.js';
import {createNativeAdapter} from '../../src/agents/native.js';

const require = createRequire(import.meta.url);
const nativeFixture = `
import {appendFileSync, readFileSync, existsSync, lstatSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
const config = JSON.parse(readFileSync(process.env.FIXTURE_CONFIG, 'utf8'));
const args = process.argv.slice(2);
const record = data => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(data) + '\\n');
const home = process.env.CODEX_HOME;
record({kind:'process', args, home, cwd:process.cwd(), pid:process.pid,
  mode:statSync(home).mode & 0o777, authLink:existsSync(join(home,'auth.json')) && lstatSync(join(home,'auth.json')).isSymbolicLink(),
  hasKey:Boolean(process.env.CODEX_API_KEY), hasOpenaiKey:Boolean(process.env.OPENAI_API_KEY),
  hasAzureKey:Boolean(process.env.AZURE_TEST_KEY), userHome:process.env.HOME,
  config:existsSync(join(home,'config.toml')) ? readFileSync(join(home,'config.toml'),'utf8') : undefined});
if (args.includes('--version')) {
  console.log('codex-cli fixture');
  process.exit(config.versionCode ?? 0);
}
if (args.includes('status')) {
  const present = existsSync(join(home, 'auth.json'));
  console.error(config.statusText ?? (present ? 'Logged in using ChatGPT' : 'Not logged in'));
  process.exit(config.statusCode ?? (present ? 0 : 1));
}
if (args.includes('exec')) {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  record({kind:'execute', prompt});
  if (config.hook) {
    const {Client} = await import(config.clientModule);
    const {StreamableHTTPClientTransport} = await import(config.transportModule);
    const setting = args.find(value => value.startsWith('mcp_servers.stratos_hooks.url='));
    const url = JSON.parse(setting.slice(setting.indexOf('=') + 1));
    const client = new Client({name:'codex-fixture',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {requestInit:{
      headers:{Authorization:'Bearer ' + process.env.STRATOS_HOOK_TOKEN}}}));
    const decision = await client.callTool({name:'before',arguments:{
      toolCallId:'denied',toolName:'Bash',input:{command:'never-executed'}}});
    record({kind:'hook', decision:JSON.parse(decision.content[0].text)});
    await client.close();
  }
  for (const event of config.events ?? []) console.log(JSON.stringify(event));
  if (config.stall) await new Promise(() => setInterval(() => {}, 1000));
  process.exitCode = config.exitCode ?? 0;
} else {
  if (!args.includes('app-server')) throw new Error('Unexpected native command');
  process.on('SIGTERM', () => {
    record({kind:'termination',signal:'SIGTERM',pid:process.pid});
    if (!config.ignoreTerm) process.exit(0);
  });
  setInterval(() => {}, 1000);
  let pageIndex = 0;
  const reply = value => console.log(JSON.stringify(value));
  createInterface({input:process.stdin}).on('line', line => {
    const request = JSON.parse(line); record({kind:'request', ...request});
    if (request.method === 'initialize') {
      reply({id:request.id,result:config.badInitialize ? null : {userAgent:'fixture'}});
    } else if (request.method === 'model/list') {
      if (config.stall) return;
      if (config.exitEarly) process.exit(12);
      if (config.closeStream) {process.stdout.end(); return;}
      if (config.invalidJson) {console.log('not-json'); return;}
      if (config.badNotification) {reply({params:{}}); return;}
      if (config.notice) reply({method:'catalog/notice',params:{}});
      const id = config.wrongId ? request.id + 100 : request.id;
      if (config.noResult) {reply({id}); return;}
      if (config.rpcError) {reply({id,error:config.rpcError}); return;}
      const result = (config.pages ?? [{data:[],nextCursor:null}])[pageIndex++];
      reply({id,result,...(config.bothResultAndError ? {error:{code:-1,message:'bad envelope'}} : {})});
    } else if (request.method !== 'initialized') {
      throw new Error('Unexpected RPC method: ' + request.method);
    }
  });
}
`;

type Row = Record<string, unknown>;
type Fixture = {
  root: string;
  binary: string;
  auth: string;
  env: Record<string, string>;
  configure(config: Record<string, unknown>): Promise<void>;
  rows(): Promise<Row[]>;
};
async function fixture(
  config: Record<string, unknown>,
  work: (value: Fixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(process.cwd(), '.codex-catalog-test-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    const auth = join(root, 'saved-auth');
    const binary = join(root, 'codex-fixture.mjs');
    const configPath = join(root, 'fixture.json');
    const log = join(root, 'fixture.jsonl');
    await mkdir(auth, {mode: 0o700});
    const configure = (value: Record<string, unknown>) =>
      writeFile(
        configPath,
        JSON.stringify({
          clientModule:
            require.resolve('@modelcontextprotocol/sdk/client/index.js'),
          transportModule:
            require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'),
          ...value,
        }),
        {mode: 0o600},
      );
    await configure(config);
    await writeFile(binary, `#!${process.execPath}\n${nativeFixture}`, {
      mode: 0o700,
    });
    await writeFile(log, '', {mode: 0o600});
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: root,
      CODEX_HOME: auth,
      TMPDIR: root,
      FIXTURE_CONFIG: configPath,
      FIXTURE_LOG: log,
    };
    await work({
      root,
      binary,
      auth,
      env,
      configure,
      rows: async () =>
        (await readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line): Row => JSON.parse(line)),
    });
  } finally {
    if (previous === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previous;
    }
    await rm(root, {recursive: true, force: true});
  }
}

const savedLogin = {
  tokens: {
    access_token: 'fixture-access',
    id_token: 'fixture-id',
    refresh_token: 'fixture-refresh',
  },
};
const completion = {
  type: 'turn.completed',
  usage: {
    input_tokens: 1,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
  },
};
const answer = {
  type: 'item.completed',
  item: {id: 'answer', type: 'agent_message', text: 'fixture answer'},
};
const discover = (
  value: Fixture,
  overrides: Partial<Parameters<typeof readCodexCatalog>[0]> = {},
) =>
  readCodexCatalog({
    binary: value.binary,
    env: value.env,
    cwd: value.root,
    timeoutMs: 3_000,
    shutdownMs: 200,
    ...overrides,
  });
async function stopped(value: Fixture): Promise<void> {
  for (const row of await value.rows()) {
    const pid = row.pid;
    if (row.kind === 'process' && typeof pid === 'number') {
      assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
    }
  }
}
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    assert(
      Date.now() < deadline,
      'Fixture did not reach the expected boundary',
    );
    // Native readiness must not depend on the discovery timer mocked by the deadline test.
    await new Promise(resolve => setImmediate(resolve));
  }
}

void test('Codex catalog paginates native IDs including hidden models, without requesting a model or prompt', async () => {
  await fixture(
    {
      notice: true,
      pages: [
        {data: [{id: 'picker-only', model: 'native-a'}], nextCursor: 'second'},
        {
          data: [{model: 'native-a'}, {model: 'hidden-b', hidden: true}],
          nextCursor: null,
        },
      ],
    },
    async value => {
      const catalog = await discover(value);
      assert.deepEqual(catalog, {
        provider: 'openai',
        source: 'codex-app-server/model/list',
        modelIds: ['native-a', 'hidden-b'],
        complete: true,
      });
      assert(Object.isFrozen(catalog));
      assert(Object.isFrozen(catalog.modelIds));
      const rows = await value.rows();
      const requests = rows.filter(row => row.kind === 'request');
      assert.deepEqual(
        requests.map(row => row.method),
        ['initialize', 'initialized', 'model/list', 'model/list'],
      );
      assert.deepEqual(
        requests
          .filter(row => row.method === 'model/list')
          .map(row => row.params),
        [
          {cursor: null, limit: 100, includeHidden: true},
          {cursor: 'second', limit: 100, includeHidden: true},
        ],
      );
      const args = rows[0]?.args;
      assert(Array.isArray(args));
      assert(args.includes('model_provider="openai"'));
      assert(args.includes('features.hooks=false'));
      assert(args.includes('mcp_servers={}'));
      assert(
        !args.some(
          arg =>
            typeof arg === 'string' &&
            (arg === '--model' || arg.startsWith('model=')),
        ),
      );
      await stopped(value);
    },
  );
});

void test('Codex complete empty native catalog is not replaced with packaged or requested models', async () => {
  await fixture({}, async value => {
    assert.deepEqual((await discover(value)).modelIds, []);
    await stopped(value);
  });
});

for (const [name, page] of [
  ['missing data', {nextCursor: null}],
  ['missing cursor', {data: []}],
  ['nonarray data', {data: {}, nextCursor: null}],
  ['empty cursor', {data: [], nextCursor: ''}],
  ['nonstring cursor', {data: [], nextCursor: 2}],
  ['only picker ID', {data: [{id: 'picker'}], nextCursor: null}],
  ['empty model', {data: [{model: '  '}], nextCursor: null}],
  ['null record', {data: [null], nextCursor: null}],
] as const) {
  void test(`Codex catalog rejects ${name} and cleans its process`, async () => {
    await fixture({pages: [page]}, async value => {
      await assert.rejects(
        discover(value),
        error =>
          error instanceof Error &&
          assert.deepEqual(error.cause, page) === undefined,
      );
      await stopped(value);
    });
  });
}

void test('Codex rejects pagination cycles and preserves native RPC policy errors', async () => {
  const page = {data: [{model: 'native-a'}], nextCursor: 'repeat'};
  await fixture({pages: [page, page]}, async value => {
    await assert.rejects(discover(value), /repeated.*cursor/);
    await stopped(value);
  });
  const rpcError = {
    code: -32600,
    message: 'Provider policy rejected route',
    data: {policy: 'fixture'},
  };
  await fixture({rpcError}, async value => {
    await assert.rejects(
      discover(value),
      error =>
        error instanceof Error &&
        assert.deepEqual(error.cause, rpcError) === undefined,
    );
    await stopped(value);
  });
});

for (const option of [
  'badInitialize',
  'wrongId',
  'invalidJson',
  'noResult',
  'bothResultAndError',
  'badNotification',
  'exitEarly',
  'closeStream',
]) {
  void test(`Codex RPC rejects ${option} instead of treating discovery as complete`, async () => {
    await fixture({[option]: true}, async value => {
      await assert.rejects(discover(value));
      await stopped(value);
    });
  });
}

void test('Codex discovery observes cancellation before spawn and while awaiting native metadata', async () => {
  await fixture({stall: true}, async value => {
    const reason = new Error('cancel metadata');
    await assert.rejects(
      discover(value, {signal: AbortSignal.abort(reason)}),
      error => error === reason,
    );
    assert.deepEqual(await value.rows(), []);
    const controller = new AbortController();
    const running = discover(value, {signal: controller.signal});
    const rejection = assert.rejects(running, error => error === reason);
    await waitFor(async () =>
      (await value.rows()).some(row => row.method === 'model/list'),
    );
    controller.abort(reason);
    await rejection;
    await stopped(value);
  });
});

void test('Codex metadata cancellation preserves null reasons and observes cancellation during shutdown', async () => {
  await fixture({ignoreTerm: true}, async value => {
    const controller = new AbortController();
    const running = discover(value, {
      signal: controller.signal,
      shutdownMs: 300,
    });
    const rejection = assert.rejects(running, error => error === null);
    await waitFor(async () =>
      (await value.rows()).some(row => row.kind === 'termination'),
    );
    controller.abort(null);
    await rejection;
    await stopped(value);
  });
});

void test(
  'Codex discovery deadline and owned-process SIGKILL escalation are bounded',
  {timeout: 15_000},
  async t => {
    await fixture({stall: true, ignoreTerm: true}, async value => {
      const controller = new AbortController();
      t.mock.timers.enable({apis: ['setTimeout']});
      const running = discover(value, {
        signal: controller.signal,
        timeoutMs: 500,
        shutdownMs: 50,
      });
      const rejected = assert.rejects(running, {name: 'TimeoutError'});
      try {
        await waitFor(async () =>
          (await value.rows()).some(row => row.method === 'model/list'),
        );
        t.mock.timers.tick(499);
        assert(!(await value.rows()).some(row => row.kind === 'termination'));
        t.mock.timers.tick(1);
        await waitFor(async () =>
          (await value.rows()).some(row => row.kind === 'termination'),
        );
        t.mock.timers.tick(50);
        await rejected;
        await stopped(value);
      } finally {
        t.mock.timers.reset();
        controller.abort();
        await running.catch(() => {});
      }
    });
  },
);

void test('Codex preflight isolates auth-only configuration, retains source credentials, and never starts execution', async () => {
  await fixture(
    {pages: [{data: [{model: 'native-a'}], nextCursor: null}]},
    async value => {
      await writeFile(
        join(value.auth, 'auth.json'),
        JSON.stringify(savedLogin),
        {mode: 0o600},
      );
      await writeFile(
        join(value.auth, 'config.toml'),
        'model="must-not-be-copied"\n',
      );
      await writeFile(
        join(value.auth, 'hooks.json'),
        '{"hooks":{"SessionStart":[{"command":"must-not-run"}]}}',
      );
      const result = await preflightCodex({
        workingDirectory: value.root,
        binary: value.binary,
        env: value.env,
      });
      assert(result.available);
      assert.equal(result.catalogs[0]?.complete, true);
      const rows = await value.rows();
      const processes = rows.filter(row => row.kind === 'process');
      assert.equal(processes.length, 3);
      for (const row of processes) {
        assert.notEqual(row.home, value.auth);
        assert.equal(row.home, row.cwd);
        assert.equal(row.home, row.userHome);
        assert.equal(row.mode, 0o700);
        assert.equal(typeof row.home, 'string');
        await assert.rejects(access(String(row.home)));
      }
      assert.equal(processes[1]?.authLink, true);
      assert.equal(processes[2]?.authLink, true);
      assert.deepEqual(
        JSON.parse(await readFile(join(value.auth, 'auth.json'), 'utf8')),
        savedLogin,
      );
      assert(!rows.some(row => row.kind === 'execute'));
      assert(
        !(await readdir(value.root)).some(name =>
          name.startsWith('stratos-codex-preflight-'),
        ),
      );
      await stopped(value);
    },
  );
});

void test('Codex missing binary and positively absent native login are the only preflight absence results', async () => {
  await fixture({}, async value => {
    const options = {workingDirectory: value.root, env: value.env};
    const missingBinary = await preflightCodex({
      ...options,
      binary: join(value.root, 'missing'),
    });
    assert(!missingBinary.available);
    assert.equal(missingBinary.reason, 'harness-missing');
    const missingAuth = await preflightCodex({
      ...options,
      binary: value.binary,
    });
    assert(!missingAuth.available);
    assert.equal(missingAuth.reason, 'authentication-missing');
    assert(!(await value.rows()).some(row => row.method === 'model/list'));
    await stopped(value);
  });
});

void test('Codex malformed auth, unknown auth failures, provider/config errors are fatal and do not leak diagnostics', async () => {
  await fixture({}, async value => {
    const options = {
      workingDirectory: value.root,
      binary: value.binary,
      env: value.env,
    };
    await assert.rejects(
      preflightCodex({...options, provider: 'other'}),
      /Unsupported Codex provider/,
    );
    assert.deepEqual(await value.rows(), []);
    for (const auth of [
      '{malformed-private-content',
      '{}',
      'null',
      '{"OPENAI_API_KEY":17}',
    ]) {
      await writeFile(join(value.auth, 'auth.json'), auth);
      await assert.rejects(preflightCodex(options), error => {
        assert(error instanceof Error);
        assert(!String(error).includes('malformed-private-content'));
        return true;
      });
    }
    await rm(join(value.auth, 'auth.json'));
    await value.configure({
      statusCode: 1,
      statusText: 'Invalid credentials: never-expose-this-diagnostic',
    });
    await assert.rejects(preflightCodex(options), error => {
      assert(error instanceof Error);
      assert(!JSON.stringify(error).includes('never-expose-this-diagnostic'));
      return /status check failed/.test(error.message);
    });
    await value.configure({versionCode: 2});
    await assert.rejects(preflightCodex(options), /version check failed/);
    await stopped(value);
  });
});

void test('Codex configured API keys use partial native metadata, not inferred API-account entitlement', async () => {
  await fixture({}, async value => {
    const options = {
      workingDirectory: value.root,
      binary: value.binary,
      env: value.env,
    };
    for (const auth of [
      {apiKey: 'fixture-explicit'},
      {env: {...value.env, CODEX_API_KEY: 'fixture-codex'}},
      {env: {...value.env, OPENAI_API_KEY: 'fixture-openai'}},
    ]) {
      const result = await preflightCodex({...options, ...auth});
      assert(result.available);
      assert.equal(result.catalogs[0]?.complete, false);
    }
    await writeFile(
      join(value.auth, 'auth.json'),
      '{"OPENAI_API_KEY":"fixture-saved"}',
    );
    const saved = await preflightCodex(options);
    assert(saved.available);
    assert.equal(saved.catalogs[0]?.complete, false);
    await stopped(value);
  });
});

void test('Codex preflight cancellation during discovery stops native work and removes the private home', async () => {
  await fixture({stall: true}, async value => {
    await writeFile(join(value.auth, 'auth.json'), JSON.stringify(savedLogin));
    const controller = new AbortController();
    const reason = new Error('cancel preflight');
    const running = preflightCodex(
      {workingDirectory: value.root, binary: value.binary, env: value.env},
      controller.signal,
    );
    const rejection = assert.rejects(running, error => error === reason);
    await waitFor(async () =>
      (await value.rows()).some(row => row.method === 'model/list'),
    );
    controller.abort(reason);
    await rejection;
    assert(
      !(await readdir(value.root)).some(name =>
        name.startsWith('stratos-codex-preflight-'),
      ),
    );
    await stopped(value);
  });
});

void test('Codex Azure uses the same isolated provider in discovery and native execution, without saved login or ambient MCPs', async () => {
  await fixture(
    {
      pages: [{data: [{model: 'gpt-5.4'}], nextCursor: null}],
      events: [
        {type: 'thread.started', thread_id: 'azure-thread'},
        answer,
        completion,
      ],
    },
    async value => {
      const nativeConfig = {
        model_provider: 'openai',
        model_providers: {
          azure: {
            name: 'Azure Foundry',
            base_url: 'https://example.invalid/openai/v1',
            env_key: 'AZURE_TEST_KEY',
            request_max_retries: 0,
          },
        },
        mcp_servers: {ambient: {command: 'must-not-run'}},
        features: {apps: true},
      };
      await writeFile(join(value.auth, 'config.toml'), stringify(nativeConfig));
      await writeFile(
        join(value.auth, 'auth.json'),
        'malformed-not-an-azure-login',
      );
      const env = {
        ...value.env,
        AZURE_TEST_KEY: 'fixture-azure',
        OPENAI_API_KEY: 'other',
        CODEX_API_KEY: 'other',
      };
      const readiness = await preflightCodex({
        workingDirectory: value.root,
        binary: value.binary,
        provider: 'azure',
        env,
      });
      assert(readiness.available);
      assert.deepEqual(readiness.catalogs, [
        {
          provider: 'azure',
          source: 'codex-app-server/model/list',
          modelIds: ['gpt-5.4'],
          complete: false,
        },
      ]);
      const resource = createNativeAdapter({
        harness: 'codex',
        provider: 'azure',
        canonicalModel: 'openai/gpt-5.4',
        options: {
          workingDirectory: value.root,
          binary: value.binary,
          env,
          systemPrompt: 'Azure workflow instructions.',
          onEvent() {},
          diagnostic() {},
        },
      });
      try {
        await resource.initialize();
        assert.equal(await resource.execute('first'), 'fixture answer');
        await writeFile(
          join(value.auth, 'config.toml'),
          'invalid later change',
        );
        assert.equal(await resource.execute('second'), 'fixture answer');
      } finally {
        await resource.close();
      }
      const processes = (await value.rows()).filter(
        row => row.kind === 'process',
      );
      assert.equal(processes.length, 4);
      for (const row of processes) {
        assert.equal(row.authLink, false);
        assert.equal(row.hasKey, false);
        assert.equal(row.hasOpenaiKey, false);
        assert.equal(row.hasAzureKey, true);
        const args = row.args as string[];
        assert.ok(!args.includes('status'));
        if (!args.includes('--version')) {
          assert.ok(args.includes('model_provider="azure"'));
          const config = parse(String(row.config));
          assert.equal(config.model_provider, 'azure');
          assert.equal(config.mcp_servers, undefined);
          assert.equal(config.features, undefined);
          assert.ok(!JSON.stringify(row).includes('fixture-azure'));
        }
        if (args.includes('exec')) {
          assert.ok(args.includes('gpt-5.4'));
          assert.ok(
            args.includes(
              'developer_instructions="Azure workflow instructions."',
            ),
          );
          assert.ok(!args.some(arg => arg.startsWith('instructions=')));
        }
        await assert.rejects(access(String(row.home)));
      }
      assert.equal(
        await readFile(join(value.auth, 'auth.json'), 'utf8'),
        'malformed-not-an-azure-login',
      );
      await stopped(value);
    },
  );
});

void test('Codex Azure missing credentials cannot use saved ChatGPT login or an OpenAI key', async () => {
  await fixture({}, async value => {
    await writeFile(
      join(value.auth, 'config.toml'),
      stringify({
        model_providers: {
          azure: {
            base_url: 'https://example.invalid/openai/v1',
            env_key: 'AZURE_TEST_KEY',
          },
        },
      }),
    );
    await writeFile(join(value.auth, 'auth.json'), JSON.stringify(savedLogin));
    const options = {
      provider: 'azure',
      workingDirectory: value.root,
      binary: value.binary,
      env: {
        ...value.env,
        CODEX_API_KEY: 'not-azure',
        OPENAI_API_KEY: 'not-azure',
      },
    };
    const result = await preflightCodex(options);
    assert(!result.available);
    assert.equal(result.reason, 'authentication-missing');
    assert.ok(!(await value.rows()).some(row => row.method === 'model/list'));
    await assert.rejects(
      adapter(value, options),
      /Azure authentication is not configured/,
    );
    await stopped(value);
  });
});

async function adapter(
  value: Fixture,
  options: Partial<CodexAdapterOptions> = {},
): Promise<CodexAdapter> {
  const resource = new CodexAdapter({
    workingDirectory: value.root,
    binary: value.binary,
    env: value.env,
    model: 'native-fixture',
    onEvent() {},
    diagnostic() {},
    ...options,
  });
  await resource.initialize();
  return resource;
}

void test('Codex production stream ignores transient native errors when normal completion follows, and resumes its thread', async () => {
  await fixture(
    {
      events: [
        {type: 'thread.started', thread_id: 'fixture-thread'},
        {type: 'turn.started'},
        {type: 'error', message: 'retryable transport warning'},
        answer,
        completion,
      ],
    },
    async value => {
      let progress = 0;
      const startup: string[] = [];
      const resource = await adapter(value, {
        systemPrompt: 'OpenAI workflow instructions.',
        onProgress: () => progress++,
        onStartup() {
          startup.push('start');
          return outcome => {
            assert.equal(progress, startup.filter(s => s === 'success').length);
            startup.push(outcome);
          };
        },
      });
      try {
        assert.equal(await resource.execute('first'), 'fixture answer');
        assert.equal(await resource.execute('second'), 'fixture answer');
        assert.equal(progress, 2);
        assert.deepEqual(startup, ['start', 'success', 'start', 'success']);
        const processes = (await value.rows()).filter(
          row => row.kind === 'process',
        );
        assert(Array.isArray(processes[1]?.args));
        assert(processes[1].args.includes('resume'));
        assert(processes[1].args.includes('fixture-thread'));
        assert(
          processes.every(
            row =>
              Array.isArray(row.args) &&
              row.args.includes('model_provider="openai"') &&
              row.args.includes(
                'developer_instructions="OpenAI workflow instructions."',
              ) &&
              !row.args.some(arg => String(arg).startsWith('instructions=')),
          ),
        );
      } finally {
        await resource.close();
      }
      await stopped(value);
    },
  );
});

void test('Codex production preserves terminal native errors over later SDK exit errors without branding model rejection', async () => {
  const failure = {
    type: 'turn.failed',
    error: {message: 'model not found', code: 'invalid_request_error'},
  };
  await fixture(
    {exitCode: 1, events: [{type: 'error', message: 'transient'}, failure]},
    async value => {
      let progress = 0;
      const startup: string[] = [];
      const resource = await adapter(value, {
        onProgress: () => progress++,
        onStartup: () => outcome => startup.push(outcome),
      });
      try {
        await assert.rejects(resource.execute('fixture'), error => {
          assert(error instanceof Error);
          assert(!(error instanceof ModelUnavailableError));
          assert.deepEqual(error.cause, failure);
          return true;
        });
        assert.equal(progress, 0);
        assert.deepEqual(startup, ['error']);
      } finally {
        await resource.close();
      }
      await stopped(value);
    },
  );
});

void test('Codex production retains generic native error causes and rejects empty successful text', async () => {
  const native = {
    type: 'error',
    message: 'invalid_request_error',
    code: 'unknown-native-error',
  };
  await fixture({exitCode: 1, events: [native]}, async value => {
    const resource = await adapter(value);
    try {
      await assert.rejects(
        resource.execute('fixture'),
        error =>
          error instanceof Error &&
          assert.deepEqual(error.cause, native) === undefined,
      );
      await value.configure({events: [completion]});
      await assert.rejects(resource.execute('continue'), /returned no text/);
    } finally {
      await resource.close();
    }
  });
});

void test('Codex missing startup boundary is incomplete and failed observers remain soft', async () => {
  await fixture({events: [answer, completion]}, async value => {
    const outcomes: string[] = [];
    const resource = await adapter(value, {
      onStartup: () => outcome => {
        outcomes.push(outcome);
        throw new Error('observer failure');
      },
      diagnostic() {
        throw new Error('diagnostic failure');
      },
    });
    try {
      assert.equal(await resource.execute('fixture'), 'fixture answer');
      assert.deepEqual(outcomes, ['incomplete']);
    } finally {
      await resource.close();
    }
    await stopped(value);
  });
});

void test('Codex cancellation before turn.started closes startup without inventing readiness', async () => {
  await fixture({stall: true, events: []}, async value => {
    const outcomes: string[] = [];
    const resource = await adapter(value, {
      onStartup: () => outcome => outcomes.push(outcome),
    });
    try {
      const execution = resource.execute('fixture');
      const rejection = assert.rejects(execution);
      await waitFor(async () =>
        (await value.rows()).some(row => row.kind === 'process'),
      );
      resource.cancel();
      await rejection;
      assert.deepEqual(outcomes, ['cancelled']);
    } finally {
      await resource.close();
    }
    await stopped(value);
  });
});

void test('Codex updated reasoning pins synchronously and cancellation still permits same-thread continuation', async () => {
  await fixture(
    {
      stall: true,
      events: [
        {type: 'thread.started', thread_id: 'cancel-thread'},
        {type: 'turn.started'},
        {
          type: 'item.updated',
          item: {id: 'reasoning', type: 'reasoning', text: 'fixture thought'},
        },
      ],
    },
    async value => {
      let progress = 0;
      const resource = await adapter(value, {
        onProgress() {
          progress++;
        },
      });
      try {
        const running = resource.execute('cancel fixture');
        const rejection = assert.rejects(running);
        await waitFor(async () => progress > 0);
        resource.cancel();
        await rejection;
        assert.equal(progress, 1);
        await value.configure({events: [answer, completion]});
        assert.equal(
          await resource.execute('continue fixture'),
          'fixture answer',
        );
        const processes = (await value.rows()).filter(
          row => row.kind === 'process',
        );
        assert(Array.isArray(processes[1]?.args));
        assert(processes[1].args.includes('resume'));
        assert(processes[1].args.includes('cancel-thread'));
      } finally {
        await resource.close();
      }
      await stopped(value);
    },
  );
});

void test('Codex progress precedes user hooks even for denied attempts and remains independent of soft telemetry', async () => {
  await fixture({hook: true, events: [answer, completion]}, async value => {
    const order: string[] = [];
    const resource = await adapter(value, {
      onProgress() {
        order.push('progress');
      },
      hooks: {
        beforeToolCall() {
          assert.equal(order[0], 'progress');
          order.push('hook');
          return {action: 'deny', reason: 'fixture denial'};
        },
      },
      onEvent() {
        throw new Error('soft observer');
      },
    });
    try {
      assert.equal(await resource.execute('fixture'), 'fixture answer');
      assert.deepEqual(order, ['progress', 'hook', 'progress']);
      const hook = (await value.rows()).find(row => row.kind === 'hook');
      assert.deepEqual(hook?.decision, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'fixture denial',
        },
      });
    } finally {
      await resource.close();
    }
    await stopped(value);
  });
});
