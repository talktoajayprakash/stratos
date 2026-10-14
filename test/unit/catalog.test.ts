import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {
  claudeProviderEnvironment,
  loadCatalog,
  readCatalog,
  resolveNativeModel,
} from '../../src/models/catalog.js';
import {providerModelId} from '../../src/models/mapping.js';

void test('catalog is loaded once and includes both packaged mapping tables', () => {
  assert.equal(loadCatalog(), loadCatalog());
  assert.ok(Object.keys(loadCatalog().models.models).length > 0);
  assert.ok(loadCatalog().providers.claude.providers['amazon-bedrock']);
  assert.equal(loadCatalog().providers.codex.providers.azure, 'azure');
});

void test('Ollama uses provider-native names and its latest tag convention only', () => {
  assert.equal(resolveNativeModel('gemma4:26b', 'ollama'), 'gemma4:26b');
  assert.equal(resolveNativeModel('my-model', 'ollama'), 'my-model:latest');
  assert.equal(
    resolveNativeModel('team/custom', 'ollama'),
    'team/custom:latest',
  );
  assert.equal(
    resolveNativeModel('host:123/team/custom', 'ollama'),
    'host:123/team/custom:latest',
  );
  assert.throws(
    () => resolveNativeModel('gemma4:26b', 'openai'),
    /No declared/,
  );
  for (const model of ['', ' local', 'local ', 'local:', 'local?key', 'a\nb']) {
    assert.throws(() => resolveNativeModel(model, 'ollama'), /Invalid Ollama/);
  }
});

void test('multiple declared native IDs use the first catalog entry without mutating or inferring a route', () => {
  const catalog = loadCatalog().models;
  const canonical = 'anthropic/claude-sonnet-4-6';
  const candidates = catalog.models[canonical]!['amazon-bedrock']!;
  assert.ok(candidates.length > 1);
  const before = [...candidates];
  assert.equal(resolveNativeModel(canonical, 'amazon-bedrock'), candidates[0]);
  assert.deepEqual(candidates, before);
  assert.equal(
    providerModelId(catalog, 'missing/model', 'amazon-bedrock'),
    undefined,
  );
  assert.throws(
    () => resolveNativeModel('missing/model', 'amazon-bedrock'),
    /No declared native model mapping/,
  );
});

void test('explicit Claude backend clears conflicting flags without mutating credentials or process state', () => {
  const env = {
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    AWS_REGION: 'test-region',
    AWS_PROFILE: 'test',
  };
  const selected = claudeProviderEnvironment('amazon-bedrock', env);
  assert.equal(selected.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(selected.CLAUDE_CODE_USE_VERTEX, '0');
  assert.equal(selected.CLAUDE_CODE_USE_FOUNDRY, '0');
  assert.equal(selected.AWS_REGION, 'test-region');
  assert.equal(selected.AWS_PROFILE, 'test');
  assert.equal(env.CLAUDE_CODE_USE_VERTEX, '1');
  assert.deepEqual(claudeProviderEnvironment(undefined, env), env);
  assert.equal(
    claudeProviderEnvironment('anthropic', env).CLAUDE_CODE_USE_VERTEX,
    '0',
  );
  assert.equal(
    claudeProviderEnvironment('google-vertex-anthropic', env)
      .CLAUDE_CODE_USE_VERTEX,
    '1',
  );
  assert.throws(
    () => claudeProviderEnvironment('unknown', env),
    /No Claude Code provider mapping/,
  );
});

void test('missing or incompatible packaged mappings fail at startup', t => {
  const dir = mkdtempSync(join(tmpdir(), 'stratos-catalog-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  assert.throws(() => readCatalog(dir));
  writeFileSync(
    join(dir, 'model-mapping.v1.json'),
    JSON.stringify({formatVersion: 2}),
  );
  assert.throws(() => readCatalog(dir));
  writeFileSync(
    join(dir, 'model-mapping.v1.json'),
    JSON.stringify(loadCatalog().models),
  );
  writeFileSync(
    join(dir, 'provider-mapping.v1.json'),
    JSON.stringify({formatVersion: 9}),
  );
  assert.throws(() => readCatalog(dir));
});
