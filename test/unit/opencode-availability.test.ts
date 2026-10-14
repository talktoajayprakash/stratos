import assert from 'node:assert/strict';
import test from 'node:test';

import {ModelUnavailableError} from '../../src/agents/availability.js';
import {openCodeFailure} from '../../src/agents/opencode/adapter.js';
import {openCodeCatalogs} from '../../src/agents/opencode/preflight.js';
import {openCodeConfiguration} from '../../src/agents/opencode/process.js';

function apiError(data: Record<string, unknown> = {}) {
  return {
    name: 'APIError',
    data: {
      statusCode: 404,
      isRetryable: false,
      responseBody: JSON.stringify({error: {code: 'model_not_found'}}),
      ...data,
    },
  };
}

void test('OpenCode brands only native terminal, structured model_not_found errors and preserves the cause', () => {
  const native = apiError();
  const error = openCodeFailure(native);
  assert.ok(error instanceof ModelUnavailableError);
  assert.equal(error.cause, native);
  for (const ordinary of [
    apiError({statusCode: 401}),
    apiError({statusCode: 429}),
    apiError({statusCode: 500}),
    apiError({isRetryable: true}),
    apiError({isRetryable: undefined}),
    apiError({responseBody: ''}),
    apiError({responseBody: 'model_not_found'}),
    apiError({responseBody: '{}'}),
    apiError({responseBody: '{"error":{"code":"not_found"}}'}),
    {name: 'UnknownError', data: native.data},
    new Error('404 model_not_found'),
    {statusCode: 404, code: 'model_not_found'},
  ]) {
    const result = openCodeFailure(ordinary);
    assert.ok(!(result instanceof ModelUnavailableError));
    assert.equal(result.cause, ordinary);
  }
  assert.ok(
    !(openCodeFailure(native, false) instanceof ModelUnavailableError),
    'Uncorrelated old-turn errors are not evidence',
  );
});

const provider = (id: string, source: string = 'env') => ({
  id,
  source,
  models: {'native-model': {id: 'native-model', providerID: id}},
});

void test('native connected-provider catalogs are exact, independent immutable snapshots', () => {
  const data = {
    all: [
      provider('openrouter'),
      provider('openai', 'api'),
      provider('unconnected'),
    ],
    default: {openrouter: 'native-model'},
    connected: ['openai', 'openrouter'],
  };
  const catalogs = openCodeCatalogs(data);
  assert.deepEqual(
    catalogs.map(catalog => ({...catalog})),
    [
      {
        provider: 'openai',
        source: 'opencode/provider.list:api',
        modelIds: ['native-model'],
        complete: true,
      },
      {
        provider: 'openrouter',
        source: 'opencode/provider.list:env',
        modelIds: ['native-model'],
        complete: true,
      },
    ],
  );
  assert.ok(
    Object.isFrozen(catalogs) &&
      Object.isFrozen(catalogs[0]) &&
      Object.isFrozen(catalogs[0]!.modelIds),
  );
  data.all[1]!.models['native-model'].id = 'changed';
  assert.deepEqual(catalogs[0]!.modelIds, ['native-model']);
  assert.deepEqual(openCodeCatalogs({all: [], connected: [], default: {}}), []);
});

void test('malformed, mismatched and duplicate native catalogs fail closed', () => {
  for (const value of [
    undefined,
    {},
    {all: [], default: {}, connected: ['missing']},
    {all: [provider('p'), provider('p')], default: {}, connected: ['p']},
    {all: [provider('p')], default: {}, connected: ['p', 'p']},
    {
      all: [{...provider('p'), source: undefined}],
      default: {},
      connected: ['p'],
    },
    {
      all: [
        {
          ...provider('p'),
          models: {requested: {id: 'different', providerID: 'p'}},
        },
      ],
      default: {},
      connected: ['p'],
    },
    {
      all: [
        {
          ...provider('p'),
          models: {requested: {id: 'requested', providerID: 'other'}},
        },
      ],
      default: {},
      connected: ['p'],
    },
    {
      all: [{...provider('p'), models: {requested: {}}}],
      default: {},
      connected: ['p'],
    },
  ]) {
    assert.throws(() => openCodeCatalogs(value));
  }
});

void test('inline native provider configuration preserves effective environment precedence without injecting a model', () => {
  const configured = {
    enabled_providers: ['openrouter'],
    provider: {
      openrouter: {
        options: {
          baseURL: 'http://127.0.0.1:1234/v1',
          apiKey: '{env:TEST_TOKEN}',
        },
        models: {independent: {name: 'Independent model'}},
      },
    },
  };
  const options = {
    workingDirectory: '.',
    env: {OPENCODE_CONFIG_CONTENT: JSON.stringify(configured)},
  };
  assert.deepEqual(openCodeConfiguration(options), configured);
  assert.deepEqual(
    openCodeConfiguration({...options, env: {OPENCODE_CONFIG_CONTENT: ''}}),
    {},
  );
  for (const content of [
    'not-json',
    'null',
    '{"enabled_providers":"wrong"}',
    '{"provider":[]}',
  ]) {
    assert.throws(() =>
      openCodeConfiguration({
        ...options,
        env: {OPENCODE_CONFIG_CONTENT: content},
      }),
    );
  }
});
