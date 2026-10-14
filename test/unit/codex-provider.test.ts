import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {stringify} from 'smol-toml';

import {
  codexProvider,
  codexProviderId,
} from '../../src/agents/codex/provider.js';

void test('Codex Azure reads only the selected native provider and does not inherit OpenAI authentication', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stratos-azure-config-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const config = {
    model_provider: 'openai',
    model_providers: {
      azure: {
        base_url: 'https://example.invalid/openai/v1',
        env_key: 'AZURE_TEST_KEY',
      },
      other: {base_url: 'https://other.invalid', env_key: 'OTHER_KEY'},
    },
    mcp_servers: {ambient: {command: 'never-run'}},
    features: {hooks: true},
  };
  const path = join(directory, 'config.toml');
  await writeFile(path, stringify(config));
  const env = {
    CODEX_HOME: directory,
    AZURE_TEST_KEY: 'azure-fixture',
    CODEX_API_KEY: 'never-use-codex-key',
    OPENAI_API_KEY: 'never-use-openai-key',
  };
  const resolved = await codexProvider({provider: 'azure', env});
  assert.equal(resolved.id, 'azure');
  assert.equal(resolved.hasApiKey, true);
  assert.deepEqual(resolved.env, {
    CODEX_HOME: directory,
    AZURE_TEST_KEY: 'azure-fixture',
  });
  assert.deepEqual(resolved.config, {
    model_provider: 'azure',
    model_providers: {
      azure: {
        name: 'Azure Foundry',
        base_url: 'https://example.invalid/openai/v1',
        env_key: 'AZURE_TEST_KEY',
        wire_api: 'responses',
        requires_openai_auth: false,
        supports_websockets: false,
      },
    },
  });
  assert.ok(!JSON.stringify(resolved.config).includes('azure-fixture'));
  assert.equal(
    (await codexProvider({provider: 'azure', env, apiKey: 'override'})).env
      .AZURE_TEST_KEY,
    'override',
  );
  assert.equal(env.CODEX_API_KEY, 'never-use-codex-key');
  assert.equal(env.AZURE_TEST_KEY, 'azure-fixture');
  assert.equal(await readFile(path, 'utf8'), stringify(config));
  const noAzure = await codexProvider({
    provider: 'azure',
    env: {
      CODEX_HOME: directory,
      OPENAI_API_KEY: 'not-azure',
    },
  });
  assert.equal(noAzure.hasApiKey, false);
  await assert.rejects(
    codexProvider({provider: 'azure', env: {...env, AZURE_TEST_KEY: '  '}}),
    /key is empty/,
  );
});

void test('Codex Azure fails closed on unsupported configuration without exposing TOML or secrets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stratos-azure-invalid-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const options = {provider: 'azure', env: {CODEX_HOME: directory}};
  await assert.rejects(
    codexProvider(options),
    /Configure \[model_providers.azure\]/,
  );
  const path = join(directory, 'config.toml');
  await writeFile(path, 'credential="PRIVATE-SENTINEL\n');
  await assert.rejects(codexProvider(options), error => {
    assert(error instanceof Error);
    assert.equal(
      String(error),
      'Error: Invalid Codex native configuration TOML',
    );
    assert.equal(error.cause, undefined);
    return true;
  });
  const base = {
    base_url: 'https://example.invalid/openai/v1',
    env_key: 'AZURE_TEST_KEY',
  };
  for (const invalid of [
    {model_providers: {}},
    {model_providers: {azure: {...base, base_url: 'http://example.invalid'}}},
    {
      model_providers: {
        azure: {...base, base_url: 'https://PRIVATE-SENTINEL@example.invalid'},
      },
    },
    {
      model_providers: {
        azure: {
          ...base,
          base_url: 'https://example.invalid?key=PRIVATE-SENTINEL',
        },
      },
    },
    {model_providers: {azure: {...base, wire_api: 'chat'}}},
    {model_providers: {azure: {...base, requires_openai_auth: true}}},
    {model_providers: {azure: {...base, env_key: 'OPENAI_API_KEY'}}},
    {model_providers: {azure: {...base, env_key: 'CODEX_API_KEY'}}},
    {model_providers: {azure: {...base, env_key: 'HOME'}}},
    {model_providers: {azure: {...base, env_key: 'STRATOS_HOOK_TOKEN'}}},
    {
      model_providers: {
        azure: {...base, experimental_bearer_token: 'PRIVATE-SENTINEL'},
      },
    },
    {model_providers: {azure: {...base, auth: {command: 'never-run'}}}},
    {model_providers: {azure: {...base, request_max_retries: -1}}},
  ]) {
    await writeFile(path, stringify(invalid));
    await assert.rejects(codexProvider(options), error => {
      assert(error instanceof Error);
      assert.match(String(error), /Invalid Codex Azure provider configuration/);
      assert.ok(!String(error).includes('PRIVATE-SENTINEL'));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

void test('Codex OpenAI defaults remain unchanged and unsupported providers fail before configuration reads', async () => {
  assert.equal(codexProviderId(), 'openai');
  assert.equal(codexProviderId('azure'), 'azure');
  assert.throws(() => codexProviderId('other'), /Unsupported Codex provider/);
  assert.deepEqual(await codexProvider({env: {}, apiKey: 'fixture'}), {
    id: 'openai',
    env: {CODEX_API_KEY: 'fixture'},
    config: {model_provider: 'openai'},
    hasApiKey: true,
  });
});

void test('Codex Ollama is keyless, uses the local origin and never reads hosted configuration', async () => {
  const env = {
    CODEX_HOME: '/does/not/exist',
    CODEX_API_KEY: 'do-not-forward',
    OPENAI_API_KEY: 'do-not-forward',
    OLLAMA_HOST: '127.0.0.1:11435',
  };
  const provider = await codexProvider({
    provider: 'ollama',
    env,
    apiKey: 'ignore',
  });
  assert.equal(provider.id, codexProviderId('ollama'));
  assert.equal(provider.hasApiKey, false);
  assert.equal(provider.env.CODEX_API_KEY, undefined);
  assert.equal(provider.env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, 'do-not-forward');
  assert.deepEqual(provider.config, {
    model_provider: 'stratos-ollama',
    web_search: 'disabled',
    model_providers: {
      'stratos-ollama': {
        name: 'Ollama',
        base_url: 'http://127.0.0.1:11435/v1',
        wire_api: 'responses',
        requires_openai_auth: false,
        supports_websockets: false,
      },
    },
  });
});
