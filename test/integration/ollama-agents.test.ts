import assert from 'node:assert/strict';
import {once} from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {catalogSupport} from '../../src/agents/availability.js';
import {CodexAdapter} from '../../src/agents/codex/adapter.js';
import {codexOllamaCatalog} from '../../src/agents/codex/ollama.js';
import {preflightCodex} from '../../src/agents/codex/preflight.js';
import {
  ollamaCatalog,
  ollamaUrl,
  readOllamaModels,
} from '../../src/agents/ollama.js';
import {OpenCodeAdapter} from '../../src/agents/opencode/adapter.js';
import {openCodeOllama} from '../../src/agents/opencode/ollama.js';
import {preflightOpenCode} from '../../src/agents/opencode/preflight.js';

void test('Ollama origin validates without leaking credential-bearing input', () => {
  assert.equal(ollamaUrl({}), 'http://127.0.0.1:11434');
  assert.equal(ollamaUrl({OLLAMA_HOST: 'localhost'}), 'http://localhost:11434');
  assert.equal(
    ollamaUrl({OLLAMA_HOST: 'https://localhost'}),
    'https://localhost',
  );
  assert.equal(
    ollamaUrl({OLLAMA_HOST: 'localhost:1234'}),
    'http://localhost:1234',
  );
  for (const value of [
    'file:///tmp',
    'http://secret@localhost',
    'http://localhost/?key=secret',
    'http://localhost/v1',
    'http://localhost/#secret',
  ]) {
    assert.throws(
      () => ollamaUrl({OLLAMA_HOST: value}),
      error => {
        assert(error instanceof Error);
        assert.ok(!String(error).includes('secret'));
        return true;
      },
    );
  }
});

void test('installed inventory drives local harness catalogs, excluding decision-only and remote models', async t => {
  const requests: Array<{
    path?: string;
    model?: string;
    auth?: string;
    maxTokens?: number;
  }> = [];
  let parameters: string | undefined = 'num_ctx 65536\nnum_predict 4096';
  let status = 200;
  let malformed = false;
  let duplicate = false;
  let stalled = false;
  const server = createServer((req, res) => {
    void (async () => {
      let body = '';
      for await (const part of req) {
        body += part;
      }
      const model = body
        ? (JSON.parse(body) as {model: string}).model
        : undefined;
      requests.push({
        path: req.url,
        model,
        auth: req.headers.authorization,
        maxTokens: body
          ? (JSON.parse(body) as {max_tokens?: number}).max_tokens
          : undefined,
      });
      server.emit('discovery');
      if (stalled) {
        return;
      }
      if (status !== 200) {
        res.writeHead(status).end('private upstream diagnostic');
        return;
      }
      const names = ['team/custom:latest', 'decision:latest', 'remote:latest'];
      if (duplicate) {
        names.push(names[0]!);
      }
      if (req.url === '/v1/chat/completions') {
        const chunk = {
          id: 'ollama-loopback',
          object: 'chat.completion.chunk',
          created: 1,
          model,
        };
        res.writeHead(200, {'content-type': 'text/event-stream'});
        res.write(
          `data: ${JSON.stringify({
            ...chunk,
            choices: [
              {
                index: 0,
                delta: {role: 'assistant', content: 'OLLAMA_LOOPBACK_RESULT'},
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        res.end(
          `data: ${JSON.stringify({
            ...chunk,
            choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
          })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          malformed
            ? {}
            : req.url === '/api/tags'
              ? {
                  models: names.map(name => ({name, digest: `digest-${name}`})),
                }
              : {
                  capabilities:
                    model === 'decision:latest'
                      ? ['decision']
                      : ['completion', 'tools', 'vision'],
                  parameters,
                  model_info:
                    model === 'team/custom:latest'
                      ? {
                          'general.architecture': 'test',
                          'test.context_length': 262144,
                        }
                      : undefined,
                  ...(model === 'remote:latest'
                    ? {remote_host: 'https://cloud.invalid'}
                    : {}),
                },
        ),
      );
    })().catch(error => res.destroy(error));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const env = {OLLAMA_HOST: `http://127.0.0.1:${address.port}`};
  const directory = await mkdtemp(join(tmpdir(), 'stratos-ollama-test-'));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
    await rm(directory, {recursive: true, force: true});
  });
  const models = await readOllamaModels(env);
  assert.deepEqual(models, [
    {
      id: 'team/custom:latest',
      digest: 'digest-team/custom:latest',
      capabilities: ['completion', 'tools', 'vision'],
      context: 65536,
      output: 4096,
    },
  ]);
  assert.ok(Object.isFrozen(models) && Object.isFrozen(models[0]));
  const catalog = ollamaCatalog(models);
  for (const harness of ['codex', 'opencode'] as const) {
    assert.equal(
      catalogSupport({harness, model: 'team/custom'}, catalog).status,
      'listed',
    );
    assert.equal(
      catalogSupport({harness, model: 'absent'}, catalog).status,
      'not-listed',
    );
  }
  assert.equal(
    catalogSupport({harness: 'claude-code', model: 'team/custom'}, catalog)
      .status,
    'incompatible-harness',
  );
  const configuration = await openCodeOllama(
    {small_model: 'azure/private', provider: {azure: {}}},
    env,
  );
  assert.deepEqual(configuration.enabled_providers, ['ollama']);
  assert.deepEqual(Object.keys(configuration.provider!), ['ollama']);
  assert.equal(
    configuration.provider!.ollama!.options!.baseURL,
    `${env.OLLAMA_HOST}/v1`,
  );
  assert.equal(configuration.provider!.ollama!.options!.apiKey, '');
  assert.deepEqual(Object.keys(configuration.provider!.ollama!.models!), [
    'team/custom:latest',
  ]);
  await t.test('Ollama output settings map to OpenCode budgets', async () => {
    for (const [value, expected] of [
      [undefined, 0],
      [-1, 0],
      [2048, 2048],
      [131072, 65536],
      [0, 65536],
      [-2, 65536],
    ] as const) {
      parameters = `num_ctx 65536${value === undefined ? '' : `\nnum_predict ${value}`}`;
      const config = await openCodeOllama({}, env);
      assert.deepEqual(
        config.provider!.ollama!.models!['team/custom:latest']!.limit,
        {context: 65536, output: expected},
        `num_predict ${value}`,
      );
    }
    parameters = undefined;
    const config = await openCodeOllama({}, env);
    assert.deepEqual(
      config.provider!.ollama!.models!['team/custom:latest']!.limit,
      {context: 262144, output: 0},
    );
    parameters = 'num_ctx 65536\nnum_predict 4096';
  });
  await assert.rejects(
    openCodeOllama({disabled_providers: ['ollama']}, env),
    /disabled/,
  );
  await assert.rejects(
    openCodeOllama(
      {provider: {ollama: {options: {baseURL: 'https://other.invalid'}}}},
      env,
    ),
    /configure its origin with OLLAMA_HOST/,
  );
  const path = await codexOllamaCatalog(directory, 'team/custom:latest', env);
  const native = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(native.models[0].context_window, 65536);
  assert.equal(native.models[0].slug, 'team/custom:latest');
  await assert.rejects(
    codexOllamaCatalog(directory, 'absent', env),
    /not installed/,
  );
  const readiness = await preflightCodex({
    provider: 'ollama',
    workingDirectory: directory,
    binary: process.execPath,
    env: {
      ...env,
      CODEX_HOME: join(directory, 'nonexistent'),
      CODEX_API_KEY: 'do-not-send',
    },
  });
  assert.deepEqual(readiness, {available: true, catalogs: [catalog]});
  assert.ok(
    requests.every(
      r => !r.auth && ['/api/tags', '/api/show'].includes(r.path!),
    ),
  );
  await t.test(
    'installed OpenCode does not forward saved credentials to Ollama',
    {
      skip:
        !process.env.STRATOS_TEST_OPENCODE_BINARY &&
        'Opt in with an installed binary; provider responses are synthetic loopback fixtures',
      timeout: 60000,
    },
    async () => {
      const data = join(directory, 'data');
      await mkdir(join(data, 'opencode'), {recursive: true});
      await writeFile(
        join(data, 'opencode', 'auth.json'),
        JSON.stringify({
          ollama: {
            type: 'api',
            key: 'synthetic-saved-key-must-not-be-forwarded',
          },
        }),
      );
      const options = {
        workingDirectory: directory,
        binary: process.env.STRATOS_TEST_OPENCODE_BINARY!,
        env: {
          ...env,
          HOME: directory,
          XDG_DATA_HOME: data,
          XDG_CACHE_HOME: join(directory, 'cache'),
          XDG_STATE_HOME: join(directory, 'state'),
          OPENCODE_DISABLE_MODELS_FETCH: 'true',
          OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: '0',
          OPENCODE_DISABLE_CLAUDE_CODE: 'true',
          OPENAI_API_KEY: 'synthetic-hosted-key-must-not-be-forwarded',
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            share: 'disabled',
            agent: {title: {disable: true}, summary: {disable: true}},
          }),
        },
      };
      const ready = await preflightOpenCode({...options, provider: 'ollama'});
      assert.ok(ready.available, ready.available ? '' : ready.reason);
      assert.deepEqual(
        ready.catalogs.map(c => c.provider),
        ['ollama'],
      );
      assert.ok(ready.catalogs[0]!.modelIds.includes('team/custom:latest'));
      assert.ok(
        requests.every(r => ['/api/tags', '/api/show'].includes(r.path!)),
      );
      parameters = 'num_ctx 65536\nnum_predict -1';
      const native = new OpenCodeAdapter({
        ...options,
        model: {providerID: 'ollama', modelID: 'team/custom:latest'},
        onEvent() {},
        diagnostic() {},
      });
      try {
        await native.initialize();
        const timeout = setTimeout(() => native.cancel(), 30000);
        try {
          assert.equal(
            await native.execute(
              'Reply with the fixture result, without tools.',
            ),
            'OLLAMA_LOOPBACK_RESULT',
          );
        } finally {
          clearTimeout(timeout);
        }
      } finally {
        await native.close();
      }
      const inference = requests.filter(r => r.path === '/v1/chat/completions');
      assert.equal(inference.length, 1);
      assert.equal(inference[0]!.model, 'team/custom:latest');
      assert.equal(inference[0]!.maxTokens, 32000);
      parameters = 'num_ctx 65536\nnum_predict 4096';
      assert.ok(requests.every(r => !r.auth));
    },
  );
  duplicate = true;
  await assert.rejects(readOllamaModels(env), /Duplicate/);
  duplicate = false;
  malformed = true;
  await assert.rejects(readOllamaModels(env));
  malformed = false;
  status = 503;
  await assert.rejects(readOllamaModels(env), error => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Ollama discovery /api/tags failed (HTTP 503)');
    return true;
  });
  status = 200;
  stalled = true;
  const controller = new AbortController();
  const pending = readOllamaModels(env, controller.signal);
  controller.abort(new Error('stop-discovery'));
  await assert.rejects(pending, /stop-discovery/);

  const adapter = new CodexAdapter({
    provider: 'ollama',
    model: 'team/custom:latest',
    workingDirectory: directory,
    env,
    binary: process.execPath,
    onEvent() {},
    diagnostic() {},
  });
  const before = new Set(await readdir(tmpdir()));
  const started = once(server, 'discovery');
  const initializing = adapter.initialize();
  await started;
  adapter.cancel();
  await assert.rejects(initializing, /cancelled/);
  await adapter.close();
  const leaked = (await readdir(tmpdir())).filter(
    name => !before.has(name) && name.startsWith('stratos-codex-'),
  );
  assert.deepEqual(leaked, []);
});
