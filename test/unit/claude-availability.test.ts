import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';

import type {
  HookInput,
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultSuccess,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import {ModelUnavailableError} from '../../src/agents/availability.js';
import {
  ClaudeAdapter,
  type ClaudeAdapterOptions,
} from '../../src/agents/claude/adapter.js';
import {
  claudeResultError,
  isClaudeProgress,
} from '../../src/agents/claude/availability.js';
import {
  claudeExecutable,
  preflightClaude,
} from '../../src/agents/claude/preflight.js';
import {loadCatalog} from '../../src/models/catalog.js';
import {providerModelIds} from '../../src/models/mapping.js';

const cwd = process.cwd();
const envelope = {uuid: randomUUID(), session_id: 'fixture-session'};
const usage: SDKResultSuccess['usage'] = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: {ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0},
  fallback_credit: {status: {type: 'not_applied', reason: 'not_enabled'}},
  inference_geo: '',
  iterations: [],
  output_tokens_details: {thinking_tokens: 0},
  server_tool_use: {web_fetch_requests: 0, web_search_requests: 0},
  service_tier: 'standard',
  speed: 'standard',
};
const assistant = (
  overrides: Partial<SDKAssistantMessage> = {},
): SDKAssistantMessage => ({
  ...envelope,
  type: 'assistant',
  parent_tool_use_id: null,
  error: 'model_not_found',
  message: {
    id: 'native-message',
    type: 'message',
    role: 'assistant',
    model: '<synthetic>',
    content: [
      {type: 'text', text: 'Native diagnostic: model not found', citations: []},
    ],
    usage,
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
  },
  ...overrides,
});
const result = (
  id?: string,
  overrides: Partial<SDKResultSuccess> = {},
): SDKResultSuccess => ({
  ...envelope,
  type: 'result',
  subtype: 'success',
  is_error: true,
  result: 'Native diagnostic',
  duration_ms: 0,
  duration_api_ms: 0,
  num_turns: 1,
  stop_reason: null,
  total_cost_usd: 0,
  usage,
  modelUsage: {},
  permission_denials: [],
  user_message_uuid: id,
  ...overrides,
});
const stream = (
  event: Extract<SDKMessage, {type: 'stream_event'}>['event'],
): SDKMessage => ({
  ...envelope,
  type: 'stream_event',
  parent_tool_use_id: null,
  event,
});
const hookStarted: SDKMessage = {
  ...envelope,
  type: 'system',
  subtype: 'hook_started',
  hook_id: 'managed',
  hook_name: 'managed',
  hook_event: 'SessionStart',
};
const tasks = (...ids: string[]): SDKMessage => ({
  ...envelope,
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: ids.map(task_id => ({
    task_id,
    task_type: 'shell',
    description: 'owned task',
  })),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return {promise, resolve};
}
type Emit = (message: SDKMessage) => void;
type Factory = NonNullable<ConstructorParameters<typeof ClaudeAdapter>[1]>;

function fixture(
  settings: {
    adapter?: Partial<ClaudeAdapterOptions>;
    startup?: SDKMessage[];
    onPrompt?: (
      message: SDKUserMessage,
      emit: Emit,
      options: Options,
    ) => void | Promise<void>;
    onInterrupt?: (
      emit: Emit,
      prompt: SDKUserMessage | undefined,
    ) => void | Promise<void>;
    onStopTask?: (id: string, emit: Emit) => void | Promise<void>;
    closeError?: Error;
  } = {},
) {
  const state = {
    prompts: [] as SDKUserMessage[],
    options: undefined as Options | undefined,
    progress: 0,
    queries: 0,
    closed: 0,
    interrupts: 0,
    stopped: [] as string[],
    events: [] as unknown[],
  };
  const firstPrompt = deferred<SDKUserMessage>();
  const queue: SDKMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let streamFailure: unknown;
  let pump: Promise<void> | undefined;
  const emit: Emit = message => {
    queue.push(message);
    wake?.();
  };
  const native: Factory = ({prompt, options}) => {
    assert.notEqual(typeof prompt, 'string');
    if (typeof prompt === 'string') {
      throw new Error('Fixture needs streaming input');
    }
    state.queries++;
    state.options = options;
    for (const event of settings.startup ?? []) {
      emit(event);
    }
    pump = (async () => {
      for await (const message of prompt) {
        state.prompts.push(message);
        firstPrompt.resolve(message);
        await settings.onPrompt?.(message, emit, options ?? {});
      }
    })().catch(error => {
      streamFailure = error;
      wake?.();
    });
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended || queue.length) {
          const event = queue.shift();
          if (event) {
            yield event;
          } else if (streamFailure) {
            throw streamFailure;
          } else {
            await new Promise<void>(resolve => {
              wake = resolve;
            });
          }
        }
      },
      async interrupt() {
        state.interrupts++;
        const message = state.prompts.at(-1);
        if (settings.onInterrupt) {
          await settings.onInterrupt(emit, message);
        } else {
          emit(result(message?.uuid, {is_error: true, result: 'Interrupted'}));
        }
      },
      async stopTask(id) {
        state.stopped.push(id);
        await settings.onStopTask?.(id, emit);
      },
      async setMcpServers() {
        return {added: [], removed: [], errors: {}};
      },
      close() {
        state.closed++;
        ended = true;
        wake?.();
        if (settings.closeError) {
          throw settings.closeError;
        }
      },
    };
  };
  const adapter = new ClaudeAdapter(
    {
      cwd,
      provider: 'anthropic',
      model: 'native-fixture-model',
      onEvent: event => {
        state.events.push(event);
      },
      diagnostic() {},
      onProgress: () => {
        state.progress++;
      },
      ...settings.adapter,
    },
    native,
  );
  return {
    adapter,
    state,
    emit,
    firstPrompt: firstPrompt.promise,
    async close() {
      try {
        await adapter.close();
      } finally {
        await pump;
      }
    },
  };
}

function preflightFixture(
  status: unknown = {loggedIn: true, apiProvider: 'firstParty'},
) {
  const calls: Array<{
    executable: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv | undefined;
  }> = [];
  const dependencies: NonNullable<Parameters<typeof preflightClaude>[2]> = {
    executable: () => '/fixture/claude',
    async run(executable, args, options) {
      calls.push({executable, args, env: options.env});
      return {
        stdout: args.includes('--version')
          ? '2.1.281 (Claude Code)\n'
          : JSON.stringify(status),
      };
    },
  };
  return {dependencies, calls};
}
const preflightEnv = Object.fromEntries(
  loadCatalog().providers.claude.backendFlags.map(flag => [flag, '0']),
);

void test('Claude readiness resolves the SDK bundled executable, never the global CLI', () => {
  const executable = claudeExecutable();
  assert.ok(existsSync(executable));
  assert.match(executable, /claude-agent-sdk-[^/\\]+[/\\]claude(?:\.exe)?$/);
});

void test('Claude official-command fixture exercises subprocess launch, JSON status and exit 1 without a query', async () => {
  const directory = `.claude-availability-${randomUUID()}`;
  await mkdir(directory);
  const executable = join(cwd, directory, 'claude.mjs');
  try {
    await writeFile(
      executable,
      `
      import assert from 'node:assert/strict';
      const args = process.argv.slice(2);
      if (args[0] === '--version') {
        assert.deepEqual(args, ['--version']);
        console.log('2.1.281 (fixture)');
      } else {
        assert.deepEqual(args, ['--setting-sources', '', 'auth', 'status']);
        const loggedIn = process.env.STRATOS_CLAUDE_AUTH_FIXTURE !== 'missing';
        console.log(JSON.stringify({ loggedIn, apiProvider: 'firstParty' }));
        process.exitCode = loggedIn ? 0 : 1;
      }
    `,
    );
    const options = {
      cwd,
      provider: 'anthropic',
      pathToClaudeCodeExecutable: executable,
    };
    assert.equal((await preflightClaude(options)).available, true);
    const missing = await preflightClaude({
      ...options,
      env: {STRATOS_CLAUDE_AUTH_FIXTURE: 'missing'},
    });
    assert.equal(missing.available, false);
    if (!missing.available) {
      assert.equal(missing.reason, 'authentication-missing');
      assert.ok('code' in missing.error);
      assert.equal(missing.error.code, 1);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

void test('Claude inference-free preflight snapshots exact provider mappings independently of requested models', async () => {
  const {dependencies, calls} = preflightFixture({
    loggedIn: true,
    apiProvider: 'firstParty',
    email: 'private@example.invalid',
  });
  const ready = await preflightClaude(
    {cwd, provider: 'anthropic', env: preflightEnv},
    undefined,
    dependencies,
  );
  assert.ok(ready.available);
  const mapping = loadCatalog().models;
  assert.deepEqual(ready.catalogs[0], {
    provider: 'anthropic',
    source: 'packaged-provider-mapping',
    complete: false,
    modelIds: [
      ...new Set(
        Object.keys(mapping.models)
          .filter(id => id.split('/')[0] === 'anthropic')
          .flatMap(id => [...providerModelIds(mapping, id, 'anthropic')]),
      ),
    ],
  });
  assert.deepEqual(
    calls.map(call => call.args),
    [['--version'], ['--setting-sources', '', 'auth', 'status']],
  );
  assert.ok(calls.every(call => call.executable === '/fixture/claude'));
  assert.equal(
    JSON.stringify(ready).includes('private@example.invalid'),
    false,
  );
  assert.ok(Object.isFrozen(ready.catalogs[0]?.modelIds));
  assert.ok(Object.isFrozen(ready.catalogs));
});

void test('Claude provider-auth fixtures do not require Anthropic login for Bedrock or Vertex', async () => {
  for (const [provider, apiProvider] of [
    ['amazon-bedrock', 'bedrock'],
    ['google-vertex-anthropic', 'vertex'],
  ] as const) {
    const {dependencies, calls} = preflightFixture({
      loggedIn: true,
      authMethod: 'third_party',
      apiProvider,
    });
    const ready = await preflightClaude(
      {cwd, provider, env: preflightEnv},
      undefined,
      dependencies,
    );
    assert.ok(ready.available);
    assert.equal(ready.catalogs[0]?.provider, provider);
    assert.ok(ready.catalogs[0]?.modelIds.length);
    assert.equal(
      calls.at(-1)?.env?.[
        provider === 'amazon-bedrock'
          ? 'CLAUDE_CODE_USE_BEDROCK'
          : 'CLAUDE_CODE_USE_VERTEX'
      ],
      '1',
    );
    const inherited = await preflightClaude(
      {
        cwd,
        env: {
          ...preflightEnv,
          [provider === 'amazon-bedrock'
            ? 'CLAUDE_CODE_USE_BEDROCK'
            : 'CLAUDE_CODE_USE_VERTEX']: '1',
        },
      },
      undefined,
      dependencies,
    );
    assert.ok(inherited.available);
    assert.equal(inherited.catalogs[0]?.provider, provider);
  }
});

void test('Claude auth absence skips only a definite native first-party absence, retaining exit 1', async () => {
  const nativeError = Object.assign(new Error('Auth status exited 1'), {
    code: 1,
    stdout: '{"loggedIn":false,"apiProvider":"firstParty"}',
  });
  const {dependencies} = preflightFixture();
  dependencies.run = async (_binary, args) => {
    if (args.includes('--version')) {
      return {stdout: 'version'};
    }
    throw nativeError;
  };
  const ready = await preflightClaude(
    {cwd, provider: 'anthropic'},
    undefined,
    dependencies,
  );
  assert.equal(ready.available, false);
  if (ready.available) {
    assert.fail('Expected missing authentication');
  }
  assert.equal(ready.reason, 'authentication-missing');
  assert.equal(ready.error, nativeError);
  for (const status of [
    {loggedIn: false, apiProvider: 'bedrock'},
    {loggedIn: true},
  ]) {
    await assert.rejects(
      preflightClaude(
        {cwd, provider: 'amazon-bedrock'},
        undefined,
        preflightFixture(status).dependencies,
      ),
      /cannot establish authentication/,
    );
  }
});

void test('Claude mismatched, unsupported and ambiguous native backends surface instead of routing elsewhere', async () => {
  for (const status of [
    {loggedIn: true, apiProvider: 'bedrock'},
    {loggedIn: true, apiProvider: 'gateway'},
  ]) {
    await assert.rejects(
      preflightClaude(
        {cwd, provider: 'anthropic'},
        undefined,
        preflightFixture(status).dependencies,
      ),
      /provider|backend/,
    );
  }
  await assert.rejects(
    preflightClaude(
      {cwd, env: {...preflightEnv, CLAUDE_CODE_USE_FOUNDRY: '1'}},
      undefined,
      preflightFixture().dependencies,
    ),
    /Unsupported/,
  );
  await assert.rejects(
    preflightClaude(
      {cwd, env: {...preflightEnv, CLAUDE_CODE_USE_BEDROCK: '1'}},
      undefined,
      preflightFixture({loggedIn: false}).dependencies,
    ),
    /cannot establish authentication/,
  );
});

void test('Claude missing executable is bounded to resolution/launch, not authentication or packaged catalog reads', async () => {
  for (const code of ['ENOENT', 'MODULE_NOT_FOUND', 'EACCES']) {
    const error = Object.assign(new Error('Native launch failure'), {code});
    const {dependencies} = preflightFixture();
    dependencies.run = async () => {
      throw error;
    };
    if (code === 'EACCES') {
      await assert.rejects(
        preflightClaude({cwd}, undefined, dependencies),
        actual => actual === error,
      );
    } else {
      const ready = await preflightClaude({cwd}, undefined, dependencies);
      assert.equal(ready.available, false);
      if (!ready.available) {
        assert.equal(ready.reason, 'harness-missing');
        assert.equal(ready.error, error);
      }
    }
  }
  const error = Object.assign(new Error('Unrelated file missing'), {
    code: 'ENOENT',
  });
  const auth = preflightFixture();
  auth.dependencies.run = async (_binary, args) => {
    if (args.includes('--version')) {
      return {stdout: 'version'};
    }
    throw error;
  };
  await assert.rejects(
    preflightClaude({cwd}, undefined, auth.dependencies),
    actual => actual === error,
  );
  const catalog = preflightFixture();
  catalog.dependencies.catalog = () => {
    throw error;
  };
  await assert.rejects(
    preflightClaude({cwd}, undefined, catalog.dependencies),
    actual => actual === error,
  );
  await assert.rejects(
    preflightClaude(
      {cwd: join(cwd, `missing-${randomUUID()}`)},
      undefined,
      preflightFixture().dependencies,
    ),
    {code: 'ENOENT'},
  );
});

void test('Claude malformed auth, contradictory exits, policy and transport errors stay errors', async () => {
  for (const status of [
    null,
    {},
    {loggedIn: 'true'},
    {loggedIn: true, apiProvider: 1},
  ]) {
    await assert.rejects(
      preflightClaude({cwd}, undefined, preflightFixture(status).dependencies),
      /Invalid|unsupported/,
    );
  }
  for (const code of [1, 2, 'EACCES']) {
    const error = Object.assign(new Error('Native policy/transport error'), {
      code,
      stdout: '{"loggedIn":true}',
    });
    const {dependencies} = preflightFixture();
    dependencies.run = async (_binary, args) => {
      if (args.includes('--version')) {
        return {stdout: 'version'};
      }
      throw error;
    };
    await assert.rejects(
      preflightClaude({cwd}, undefined, dependencies),
      actual => actual === error,
    );
  }
  const {dependencies} = preflightFixture();
  dependencies.run = async () => ({stdout: 'not JSON'});
  await assert.rejects(
    preflightClaude({cwd}, undefined, dependencies),
    SyntaxError,
  );
});

void test('Claude preflight abort preserves caller reason before commands and during native auth', async () => {
  for (const early of [true, false]) {
    const controller = new AbortController();
    const reason = new Error('Preflight cancelled');
    const {dependencies, calls} = preflightFixture();
    if (early) {
      controller.abort(reason);
    } else {
      dependencies.run = async (_binary, args) => {
        if (args.includes('--version')) {
          return {stdout: 'version'};
        }
        controller.abort(reason);
        throw new Error('Native AbortError');
      };
    }
    await assert.rejects(
      preflightClaude({cwd}, controller.signal, dependencies),
      error => error === reason,
    );
    assert.equal(calls.length, 0);
  }
});

void test('only a native model_not_found and correlated failed final authorize fallback; diagnostics are not output', async () => {
  const nativeError = assistant();
  let final: SDKResultSuccess | undefined;
  const f = fixture({
    onPrompt(message, emit) {
      emit({...nativeError, user_message_uuid: message.uuid});
      final = result(message.uuid);
      emit(final);
    },
  });
  try {
    await f.adapter.initialize();
    assert.equal(f.state.prompts.length, 0);
    assert.equal(f.state.options?.model, 'native-fixture-model');
    assert.equal(f.state.options?.includeHookEvents, true);
    assert.equal(Object.hasOwn(f.state.options ?? {}, 'onProgress'), false);
    await assert.rejects(f.adapter.execute('first'), error => {
      assert.ok(error instanceof ModelUnavailableError);
      assert.deepEqual(error.cause, {
        assistantErrors: [
          {...nativeError, user_message_uuid: f.state.prompts[0]?.uuid},
        ],
        result: final,
      });
      return true;
    });
    assert.equal(f.state.progress, 0);
    assert.deepEqual(f.state.events, []);
  } finally {
    await f.close();
  }
});

void test('Claude result classification never matches names, prose, HTTP status or mixed native errors', () => {
  for (const errors of [
    [],
    [assistant({error: 'unknown'})],
    [assistant({error: 'authentication_failed'})],
    [assistant(), assistant({error: 'rate_limit'})],
    [assistant({parent_tool_use_id: 'subagent'})],
  ]) {
    const error = claudeResultError(
      result(undefined, {api_error_status: 404, result: 'model not found'}),
      {errors},
    );
    assert.ok(!(error instanceof ModelUnavailableError));
    assert.deepEqual(
      (error.cause as {assistantErrors: unknown}).assistantErrors,
      errors,
    );
  }
  assert.ok(
    !(
      claudeResultError(result(undefined, {is_error: false}), {
        errors: [assistant()],
      }) instanceof ModelUnavailableError
    ),
  );
  const failed: Extract<
    SDKMessage,
    {
      subtype:
        | 'error_during_execution'
        | 'error_max_turns'
        | 'error_max_budget_usd'
        | 'error_max_structured_output_retries';
    }
  > = {
    ...result(),
    subtype: 'error_during_execution',
    errors: ['Native policy failure'],
    startup_failure_reason: 'managed_settings_invalid',
  };
  assert.ok(
    !(
      claudeResultError(failed, {errors: [assistant()]}) instanceof
      ModelUnavailableError
    ),
  );
  assert.ok(
    !(
      claudeResultError(
        {
          ...failed,
          subtype: 'error_max_turns',
          startup_failure_reason: undefined,
        },
        {errors: [assistant()]},
      ) instanceof ModelUnavailableError
    ),
  );
});

void test('Claude synthetic assistant errors cannot become successful output through a contradictory final flag', async () => {
  const f = fixture({
    onPrompt(message, emit) {
      emit(assistant());
      emit(result(message.uuid, {is_error: false}));
    },
  });
  try {
    await f.adapter.initialize();
    await assert.rejects(
      f.adapter.execute('work'),
      error =>
        error instanceof Error && !(error instanceof ModelUnavailableError),
    );
    assert.equal(f.state.progress, 0);
    assert.deepEqual(f.state.events, []);
  } finally {
    await f.close();
  }
});

void test('Claude ignores other-turn/subagent errors and requires result correlation', async () => {
  for (const mode of [
    'other-turn',
    'subagent',
    'other-turn-unstamped',
    'no-result-id',
  ]) {
    const f = fixture({
      onPrompt(message, emit) {
        if (mode === 'subagent') {
          emit(
            assistant({
              parent_tool_use_id: 'child',
              user_message_uuid: message.uuid,
            }),
          );
        } else {
          emit(assistant({user_message_uuid: 'another-turn'}));
          if (mode === 'other-turn-unstamped') {
            emit(assistant());
          }
        }
        emit(result(mode === 'no-result-id' ? undefined : message.uuid));
      },
    });
    try {
      await f.adapter.initialize();
      await assert.rejects(
        f.adapter.execute(mode),
        error =>
          error instanceof Error && !(error instanceof ModelUnavailableError),
      );
    } finally {
      await f.close();
    }
  }
  for (const batched of [true, false]) {
    const f = fixture({
      onPrompt(message, emit) {
        emit(
          assistant(
            batched
              ? {
                  user_message_uuid: 'last-in-batch',
                  user_message_uuids: [message.uuid!, 'last-in-batch'],
                }
              : {user_message_uuid: message.uuid},
          ),
        );
        emit(assistant());
        emit(result(undefined, {user_message_uuids: [message.uuid!]}));
      },
    });
    try {
      await f.adapter.initialize();
      await assert.rejects(
        f.adapter.execute('correlated'),
        ModelUnavailableError,
      );
    } finally {
      await f.close();
    }
  }
});

void test('Claude autonomous task results do not finish or fail the pending user turn', async () => {
  for (const is_error of [false, true]) {
    const f = fixture({
      onPrompt(message, emit) {
        emit(
          result(undefined, {
            is_error,
            result: 'Stopped background agent',
            origin: {kind: 'task-notification'},
          }),
        );
        emit(result(message.uuid, {is_error: false, result: 'User response'}));
      },
    });
    try {
      await f.adapter.initialize();
      assert.equal(await f.adapter.execute('first'), 'User response');
      assert.equal(await f.adapter.execute('continue'), 'User response');
      assert.equal(f.state.queries, 1);
      assert.equal(f.state.closed, 0);
    } finally {
      await f.close();
    }
  }
});

void test('Claude task-notification turns that consume the explicit prompt still deliver its correlated result', async () => {
  const f = fixture({
    onPrompt(message, emit) {
      emit(
        result(undefined, {
          user_message_uuids: [message.uuid!],
          is_error: false,
          result: 'Folded user response',
          origin: {kind: 'task-notification'},
        }),
      );
    },
  });
  try {
    await f.adapter.initialize();
    assert.equal(await f.adapter.execute('continue'), 'Folded user response');
  } finally {
    await f.close();
  }
});

const progressEvents: SDKMessage[] = [
  assistant({
    error: undefined,
    message: {
      ...assistant().message,
      model: 'real-model',
      content: [{type: 'text', text: ' ', citations: []}],
    },
  }),
  assistant({message: {...assistant().message, model: 'real-model'}}),
  assistant({
    error: undefined,
    message: {
      ...assistant().message,
      content: [{type: 'thinking', thinking: '', signature: ''}],
    },
  }),
  stream({
    type: 'content_block_delta',
    index: 0,
    delta: {type: 'text_delta', text: 'x'},
  }),
  stream({
    type: 'content_block_start',
    index: 0,
    content_block: {type: 'thinking', thinking: '', signature: ''},
  }),
  stream({
    type: 'content_block_start',
    index: 0,
    content_block: {type: 'tool_use', id: 'tool', name: 'Read', input: {}},
  }),
  stream({
    type: 'content_block_delta',
    index: 0,
    delta: {type: 'thinking_delta', thinking: 'reasoning', estimated_tokens: 1},
  }),
  {
    ...envelope,
    type: 'tool_progress',
    tool_name: 'Read',
    tool_use_id: 'tool',
    parent_tool_use_id: null,
    elapsed_time_seconds: 1,
  },
  {
    ...envelope,
    type: 'system',
    subtype: 'task_started',
    task_id: 'task',
    description: 'startup work',
  },
  tasks('background'),
  hookStarted,
  {
    ...hookStarted,
    subtype: 'hook_progress' as const,
    stdout: '',
    stderr: '',
    output: '',
  },
  {
    ...hookStarted,
    subtype: 'hook_response' as const,
    stdout: '',
    stderr: '',
    output: '',
    outcome: 'success' as const,
  },
  {
    ...envelope,
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: 1,
    estimated_tokens_delta: 1,
  },
  {
    ...envelope,
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Read',
    tool_use_id: 'denied',
    message: 'Denied',
  },
  {
    ...envelope,
    type: 'system',
    subtype: 'files_persisted',
    files: [{filename: 'file', file_id: 'file'}],
    failed: [],
    processed_at: '',
  },
  {
    ...envelope,
    type: 'tool_use_summary',
    summary: '',
    preceding_tool_use_ids: ['tool'],
  },
  {...envelope, type: 'system', subtype: 'status', status: 'compacting'},
];
for (const [index, progress] of progressEvents.entries()) {
  void test(`Claude real output, reasoning, tool or background evidence ${index} permanently prevents fallback`, async () => {
    const f = fixture({
      onPrompt(message, emit) {
        emit(progress);
        emit(assistant({user_message_uuid: message.uuid}));
        emit(result(message.uuid));
      },
    });
    try {
      await f.adapter.initialize();
      await assert.rejects(
        f.adapter.execute('work'),
        error =>
          error instanceof Error && !(error instanceof ModelUnavailableError),
      );
      assert.ok(f.state.progress > 0);
    } finally {
      await f.close();
    }
  });
}

void test('Claude output usage, server-side work and permission denials independently prevent fallback', async () => {
  const counters: Array<Partial<SDKResultSuccess>> = [
    {usage: {...usage, output_tokens: 1}},
    {usage: {...usage, output_tokens_details: {thinking_tokens: 1}}},
    {
      usage: {
        ...usage,
        server_tool_use: {web_fetch_requests: 1, web_search_requests: 0},
      },
    },
    {
      modelUsage: {
        native: {
          inputTokens: 0,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0,
          contextWindow: 1,
          maxOutputTokens: 1,
        },
      },
    },
    {
      permission_denials: [
        {tool_name: 'Read', tool_use_id: 'denied', tool_input: {}},
      ],
    },
  ];
  for (const counter of counters) {
    const f = fixture({
      onPrompt(message, emit) {
        emit(assistant());
        emit(result(message.uuid, counter));
      },
    });
    try {
      await f.adapter.initialize();
      await assert.rejects(
        f.adapter.execute('work'),
        error =>
          error instanceof Error && !(error instanceof ModelUnavailableError),
      );
      assert.ok(f.state.progress > 0);
    } finally {
      await f.close();
    }
  }
});

void test('Claude startup managed-hook work pins before execute; pure request starts and synthetic streams do not', async () => {
  const started = stream({
    type: 'message_start',
    message: {...assistant().message, model: 'real-model', content: []},
  });
  assert.equal(isClaudeProgress(started), false);
  assert.equal(
    isClaudeProgress(
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: {type: 'text', text: '', citations: []},
      }),
    ),
    false,
  );
  const f = fixture({
    startup: [hookStarted],
    onPrompt(message, emit) {
      emit(assistant());
      emit(result(message.uuid));
    },
  });
  try {
    await f.adapter.initialize();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.progress, 1);
    assert.equal(f.state.prompts.length, 0);
    await assert.rejects(
      f.adapter.execute('work'),
      error =>
        error instanceof Error && !(error instanceof ModelUnavailableError),
    );
  } finally {
    await f.close();
  }
  const synthetic = fixture({
    onPrompt(message, emit) {
      emit(stream({type: 'message_start', message: assistant().message}));
      emit(
        stream({
          type: 'content_block_delta',
          index: 0,
          delta: {type: 'text_delta', text: 'Native diagnostic'},
        }),
      );
      emit(assistant());
      emit(result(message.uuid));
    },
  });
  try {
    await synthetic.adapter.initialize();
    await assert.rejects(
      synthetic.adapter.execute('failed'),
      ModelUnavailableError,
    );
    assert.equal(synthetic.state.progress, 0);
    assert.deepEqual(synthetic.state.events, []);
  } finally {
    await synthetic.close();
  }
});

const toolInput = (
  hook_event_name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure',
  tool_name = 'Read',
): HookInput => {
  const base = {
    session_id: 'fixture-session',
    transcript_path: 'fixture-transcript',
    cwd,
    tool_name,
    tool_use_id: 'tool',
    tool_input: {file_path: 'file'},
  };
  if (hook_event_name === 'PostToolUse') {
    return {...base, hook_event_name, tool_response: 'content'};
  }
  if (hook_event_name === 'PostToolUseFailure') {
    return {...base, hook_event_name, error: 'Tool failed'};
  }
  return {...base, hook_event_name};
};
async function invokeToolHook(
  options: Options,
  name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure',
  toolName = 'Read',
) {
  const hook = options.hooks?.[name]?.[0]?.hooks[0];
  assert.ok(hook);
  return hook(toolInput(name, toolName), 'tool', {
    signal: new AbortController().signal,
  });
}

void test('Claude structured output delivery bypasses author tool hooks only with an output schema', async () => {
  const calls: string[] = [];
  const structured = fixture({
    adapter: {
      outputFormat: {type: 'json_schema', schema: {type: 'object'}},
      hooks: {
        beforeToolCall() {
          calls.push('before');
          return {action: 'deny', reason: 'No tools'};
        },
        afterToolCall() {
          calls.push('after');
          return {action: 'block', reason: 'No tools'};
        },
      },
    },
    async onPrompt(message, emit, options) {
      assert.deepEqual(
        await invokeToolHook(options, 'PreToolUse', 'StructuredOutput'),
        {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        },
      );
      assert.deepEqual(
        await invokeToolHook(options, 'PostToolUse', 'StructuredOutput'),
        {},
      );
      assert.deepEqual(
        await invokeToolHook(options, 'PostToolUseFailure', 'StructuredOutput'),
        {},
      );
      emit(
        result(message.uuid, {
          is_error: false,
          result: '',
          structured_output: {answer: 42},
        }),
      );
    },
  });
  try {
    await structured.adapter.initialize();
    assert.deepEqual(await structured.adapter.execute('structured'), {
      answer: 42,
    });
    assert.deepEqual(calls, []);
  } finally {
    await structured.close();
  }

  const plain = fixture({
    adapter: {
      hooks: {
        beforeToolCall() {
          return {action: 'deny', reason: 'No tools'};
        },
      },
    },
  });
  try {
    await plain.adapter.initialize();
    assert.deepEqual(
      await invokeToolHook(
        plain.state.options!,
        'PreToolUse',
        'StructuredOutput',
      ),
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'No tools',
        },
      },
    );
  } finally {
    await plain.close();
  }
});

void test('Claude tool attempts pin before user hooks, including denial and post-tool hooks', async () => {
  for (const name of [
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
  ] as const) {
    const order: string[] = [];
    const f = fixture({
      adapter: {
        onProgress: () => {
          order.push('progress');
        },
        hooks: {
          beforeToolCall() {
            order.push('before');
            return {action: 'deny', reason: 'Denied'};
          },
          afterToolCall() {
            order.push('after');
          },
        },
      },
      async onPrompt(message, emit, options) {
        const decision = await invokeToolHook(options, name);
        if (name === 'PreToolUse') {
          assert.deepEqual(decision, {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Denied',
            },
          });
        }
        emit(assistant());
        emit(result(message.uuid));
      },
    });
    try {
      await f.adapter.initialize();
      await assert.rejects(
        f.adapter.execute('hook'),
        error =>
          error instanceof Error && !(error instanceof ModelUnavailableError),
      );
      assert.deepEqual(order.slice(0, 2), [
        'progress',
        name === 'PreToolUse' ? 'before' : 'after',
      ]);
    } finally {
      await f.close();
    }
  }
});

void test('Claude hook failures remain original even if the native final claims model_not_found', async () => {
  const failure = new Error('User hook failed');
  const f = fixture({
    adapter: {
      hooks: {
        beforeToolCall() {
          throw failure;
        },
      },
    },
    onInterrupt() {},
    async onPrompt(message, emit, options) {
      await invokeToolHook(options, 'PreToolUse');
      emit(assistant());
      emit(result(message.uuid));
    },
  });

  try {
    await f.adapter.initialize();
    await assert.rejects(f.adapter.execute('hook'), error => error === failure);
    assert.equal(f.state.interrupts, 1);
  } finally {
    await f.close();
  }
});

void test('Claude tool-hook startup work pins without a pending execute and startup failures remain original', async () => {
  const failure = new Error('Startup hook failed');
  const f = fixture({
    adapter: {
      hooks: {
        beforeToolCall() {
          throw failure;
        },
      },
    },
  });
  try {
    await f.adapter.initialize();
    assert.ok(f.state.options);
    await invokeToolHook(f.state.options, 'PreToolUse');
    assert.equal(f.state.progress, 1);
    await assert.rejects(
      f.adapter.execute('must not submit'),
      error => error === failure,
    );
    assert.equal(f.state.prompts.length, 0);
  } finally {
    await f.close();
  }
});

void test('Claude structured success and sequential continuation retain the same query; empty text fails explicitly', async () => {
  for (const structured of [false, true]) {
    const f = fixture({
      adapter: structured
        ? {outputFormat: {type: 'json_schema', schema: {type: 'object'}}}
        : {},
      onPrompt(message, emit) {
        emit(
          result(message.uuid, {
            is_error: false,
            result: '',
            ...(structured ? {structured_output: {answer: 42}} : {}),
          }),
        );
      },
    });
    try {
      await f.adapter.initialize();
      for (const prompt of ['first', 'continue']) {
        if (structured) {
          assert.deepEqual(await f.adapter.execute(prompt), {answer: 42});
        } else {
          await assert.rejects(f.adapter.execute(prompt), /no assistant text/);
        }
      }
      assert.equal(f.state.queries, 1);
      assert.deepEqual(
        f.state.prompts.map(message => message.message.content),
        ['first', 'continue'],
      );
    } finally {
      await f.close();
    }
  }
});

void test('Claude overlap rejects and cancellation preserves a safely interrupted native conversation', async () => {
  const f = fixture({
    onPrompt(message, emit) {
      if (message.message.content === 'continue') {
        emit(result(message.uuid, {is_error: false, result: 'continued'}));
      }
    },
  });
  try {
    await f.adapter.initialize();
    const first = f.adapter.execute('first');
    await assert.rejects(f.adapter.execute('overlap'), /sequential/);
    await f.firstPrompt;
    f.adapter.cancel();
    await assert.rejects(first, /execution cancelled/);
    assert.equal(await f.adapter.execute('continue'), 'continued');
    assert.equal(f.state.closed, 0);
    assert.equal(f.state.queries, 1);
  } finally {
    await f.close();
  }
});

void test('Claude cancellation blocks autonomous prompt submission until an explicit continuation', async () => {
  const f = fixture({
    onPrompt(message, emit) {
      emit(result(message.uuid, {is_error: false, result: 'continued'}));
    },
  });
  try {
    await f.adapter.initialize();
    assert.equal(await f.adapter.execute('first'), 'continued');
    const submit = f.state.options?.hooks?.UserPromptSubmit?.[0]?.hooks[0];
    assert.ok(submit);
    const input: HookInput = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'fixture-session',
      transcript_path: 'fixture-transcript',
      cwd,
      prompt: 'Native task notification',
    };
    const signal = new AbortController().signal;
    assert.deepEqual(await submit(input, undefined, {signal}), {});
    f.adapter.cancel();
    await new Promise(resolve => setImmediate(resolve));
    // Current native builds omit source even for task notifications.
    assert.deepEqual(await submit(input, undefined, {signal}), {
      decision: 'block',
      reason: 'Agent execution cancelled',
    });
    assert.equal(await f.adapter.execute('continue'), 'continued');
    assert.deepEqual(await submit(input, undefined, {signal}), {});
    assert.equal(f.state.queries, 1);
  } finally {
    await f.close();
  }
});

void test('Claude interrupts native notification work without a pending execute and gates immediate continuation', async () => {
  let finish!: () => void;
  const interrupted = deferred<void>();
  const f = fixture({
    onPrompt(message, emit) {
      emit(result(message.uuid, {is_error: false, result: 'continued'}));
    },
    onInterrupt(emit) {
      finish = () =>
        emit(
          result(undefined, {
            is_error: true,
            origin: {kind: 'task-notification'},
          }),
        );
      interrupted.resolve();
    },
  });
  try {
    await f.adapter.initialize();
    await f.adapter.execute('first');
    const submit = f.state.options?.hooks?.UserPromptSubmit?.[0]?.hooks[0];
    assert.ok(submit);
    await submit(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'fixture-session',
        transcript_path: 'fixture-transcript',
        cwd,
        prompt: 'Native notification',
      },
      undefined,
      {signal: new AbortController().signal},
    );
    f.adapter.cancel();
    f.adapter.cancel();
    await interrupted.promise;
    const continued = f.adapter.execute('continue');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
      f.state.prompts.length,
      1,
      'The new prompt must wait for native cancellation completion',
    );
    finish();
    assert.equal(await continued, 'continued');
    assert.equal(f.state.interrupts, 1);
    assert.equal(f.state.queries, 1);
    assert.equal(f.state.closed, 0);
  } finally {
    await f.close();
  }
});

void test('Claude cancellation waits for owned background task removal and rejects overlap while stopping', async () => {
  const stopped = deferred<void>();
  let release!: () => void;
  const f = fixture({
    onPrompt(_message, emit) {
      emit(tasks('first'));
    },
    onStopTask(id, emit) {
      if (id === 'first') {
        emit(tasks('late'));
      } else {
        release = () => emit(tasks());
        stopped.resolve();
      }
    },
  });
  try {
    await f.adapter.initialize();
    const pending = f.adapter.execute('background');
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    await f.firstPrompt;
    await new Promise(resolve => setImmediate(resolve));
    f.adapter.cancel();
    await stopped.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    await assert.rejects(f.adapter.execute('too early'), /sequential/);
    release();
    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(f.state.stopped, ['first', 'late']);
  } finally {
    await f.close();
  }
});

void test('Claude owner closure drains background cancellation before closing its control channel', async () => {
  const requested = deferred<void>();
  const release = deferred<void>();
  const diagnostics: unknown[] = [];
  const f = fixture({
    adapter: {
      diagnostic: error => {
        diagnostics.push(error);
      },
    },
    onPrompt(message, emit) {
      emit(tasks('earlier'));
      emit(result(message.uuid, {is_error: false, result: 'launched'}));
    },
    async onStopTask(_id, emit) {
      requested.resolve();
      await release.promise;
      emit(tasks());
    },
  });
  try {
    await f.adapter.initialize();
    assert.equal(await f.adapter.execute('launch'), 'launched');
    f.adapter.cancel();
    await requested.promise;
    const closing = f.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
      f.state.closed,
      0,
      'Do not break an in-flight stopTask control',
    );
    await assert.rejects(f.adapter.execute('closed'), /closed/);
    release.resolve();
    await closing;
    assert.equal(f.state.closed, 1);
    assert.deepEqual(diagnostics, []);
  } finally {
    release.resolve();
    await f.close();
  }
});

void test('Claude failed cancellation preserves both errors and invalidates the broken native query', async () => {
  const nativeError = new Error('Interrupt transport failed');
  const f = fixture({
    onInterrupt() {
      throw nativeError;
    },
  });
  try {
    await f.adapter.initialize();
    const pending = f.adapter.execute('work');
    await f.firstPrompt;
    f.adapter.cancel();
    await assert.rejects(pending, error => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /conversation closed/);
      assert.match(String(error.errors[0]), /cancelled/);
      assert.ok(error.errors[1] instanceof AggregateError);
      assert.equal(error.errors[1].errors[0], nativeError);
      return true;
    });

    assert.equal(f.state.closed, 1);
    await assert.rejects(f.adapter.execute('unsafe continuation'), /closed/);
  } finally {
    await f.close();
  }
});

void test('Claude hook plus cancellation plus native close failure preserves every error', async () => {
  const hookError = new Error('Hook failed');
  const interruptError = new Error('Interrupt failed');
  const closeError = new Error('Close failed');
  const f = fixture({
    adapter: {
      hooks: {
        beforeToolCall() {
          throw hookError;
        },
      },
    },
    onInterrupt() {
      throw interruptError;
    },
    closeError,
    async onPrompt(_message, _emit, options) {
      await invokeToolHook(options, 'PreToolUse');
    },
  });
  await f.adapter.initialize();
  await assert.rejects(f.adapter.execute('hook'), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], hookError);
    assert.ok(error.errors[1] instanceof AggregateError);
    assert.equal(error.errors[1].errors[0], interruptError);
    assert.equal(error.errors[2], closeError);
    return true;
  });
  await assert.rejects(f.close(), error => error === closeError);
  assert.equal(f.state.closed, 1);
});

void test('Claude cleanup failure stays observable and close is idempotent even after a model rejection', async () => {
  const failure = new Error('Native close failed');
  const f = fixture({
    closeError: failure,
    onPrompt(message, emit) {
      emit(assistant());
      emit(result(message.uuid));
    },
  });
  await f.adapter.initialize();
  await assert.rejects(f.adapter.execute('work'), ModelUnavailableError);
  await assert.rejects(f.close(), error => error === failure);
  await assert.rejects(f.close(), error => error === failure);
  assert.equal(f.state.closed, 1);
});
