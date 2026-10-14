import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';

import {classify} from '../../scripts/models/generator.js';
import {
  canonicalModelId,
  providerModelIds,
  type MappingSnapshot,
} from '../../src/models/mapping.js';
import {PACKAGE_ROOT} from '../../src/paths.js';

const canonicalIds = new Set(['author/model-4-6', 'other/model']);

void test('requires an explicit link even when filenames or display names match', () => {
  for (const data of [
    {},
    {name: 'author/model-4-6'},
    {id: 'author/model-4-6'},
  ]) {
    assert.deepEqual(classify(data, canonicalIds), {kind: 'withoutBaseModel'});
  }
  assert.deepEqual(
    classify(Object.create({base_model: 'author/model-4-6'}), canonicalIds),
    {kind: 'withoutBaseModel'},
  );
});

void test('accepts exactly declared canonical targets, including different namespaces', () => {
  assert.deepEqual(
    classify(
      {base_model: 'other/model', name: 'author/model-4-6'},
      canonicalIds,
    ),
    {kind: 'mapped', canonicalId: 'other/model'},
  );
});

void test('invalid explicit links never fall back to inferred names', () => {
  for (const base_model of [null, '', 1, [], {}, false]) {
    assert.deepEqual(classify({base_model}, canonicalIds), {
      kind: 'invalidBaseModel',
    });
  }
});

void test('does not normalize spelling, dates, namespace, case, whitespace, or variants', () => {
  for (const base_model of [
    'author/model-4.6',
    'author/model-4-6-20260926',
    'elsewhere/model-4-6',
    'author/Model-4-6',
    ' author/model-4-6',
    'author/model-4-6:free',
    'author/model-4-6-pro',
  ]) {
    assert.deepEqual(classify({base_model}, canonicalIds), {
      kind: 'missingCanonicalTarget',
    });
  }
});

const snapshot = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'data/models/model-mapping.v1.json'), 'utf8'),
) as MappingSnapshot;

void test('checked-in snapshot is explicit-only and records the pinned source', () => {
  assert.equal(snapshot.formatVersion, 1);
  assert.equal(snapshot.policy, 'explicit-base-model-only');
  assert.equal(
    snapshot.source.repository,
    'https://github.com/anomalyco/models.dev',
  );
  assert.match(snapshot.source.commit, /^[0-9a-f]{40}$/);
  assert.ok(!Number.isNaN(Date.parse(snapshot.source.commitDate)));
  const {coverage} = snapshot;
  assert.equal(coverage.canonicalModels, Object.keys(snapshot.models).length);
  assert.equal(
    coverage.mappedCanonicalModels,
    Object.values(snapshot.models).filter(p => Object.keys(p).length > 0)
      .length,
  );
  for (const key of Object.keys(coverage.totals) as Array<
    keyof typeof coverage.totals
  >) {
    assert.equal(
      coverage.totals[key],
      Object.values(coverage.providers).reduce((sum, s) => sum + s[key], 0),
    );
  }
  assert.equal(
    snapshot.diagnostics.length,
    coverage.totals.readErrors +
      coverage.totals.parseErrors +
      coverage.totals.invalidBaseModel +
      coverage.totals.missingCanonicalTarget,
  );
});

void test('translates dotted OpenRouter IDs using explicit links, not normalization', () => {
  assert.deepEqual(
    providerModelIds(snapshot, 'anthropic/claude-sonnet-4-6', 'openrouter'),
    ['anthropic/claude-sonnet-4.6'],
  );
  assert.equal(
    canonicalModelId(snapshot, 'openrouter', 'anthropic/claude-sonnet-4.6'),
    'anthropic/claude-sonnet-4-6',
  );
  assert.deepEqual(
    providerModelIds(snapshot, 'anthropic/claude-sonnet-4-6', 'anthropic'),
    [],
  );
  assert.equal(
    canonicalModelId(snapshot, 'anthropic', 'claude-sonnet-4-6'),
    undefined,
  );
});

void test('reconciles Qwen/Alibaba only when upstream declares the relationship', () => {
  assert.deepEqual(
    providerModelIds(snapshot, 'alibaba/qwen3.8-27b', 'openrouter'),
    ['qwen/qwen3.8-27b'],
  );
  assert.equal(
    canonicalModelId(snapshot, 'openrouter', 'qwen/qwen3.8-27b'),
    'alibaba/qwen3.8-27b',
  );
  assert.equal(
    canonicalModelId(
      snapshot,
      'openrouter',
      'qwen/qwen-2.5-coder-32b-instruct',
    ),
    undefined,
  );
});

void test('preserves every provider variant rather than selecting or stripping suffixes', () => {
  assert.deepEqual(
    providerModelIds(snapshot, 'google/gemma-4-31b-it', 'openrouter'),
    ['google/gemma-4-31b-it', 'google/gemma-4-31b-it:free'],
  );
  assert.equal(
    canonicalModelId(snapshot, 'openrouter', 'google/gemma-4-31b-it:free'),
    'google/gemma-4-31b-it',
  );
});

void test('unknown IDs do not become an identity mapping or resolve inherited object properties', () => {
  for (const unknown of [
    'missing/model',
    'constructor',
    '__proto__',
    'toString',
  ]) {
    assert.deepEqual(providerModelIds(snapshot, unknown, 'openrouter'), []);
    assert.deepEqual(
      providerModelIds(snapshot, 'anthropic/claude-sonnet-4-6', unknown),
      [],
    );
    assert.equal(canonicalModelId(snapshot, unknown, 'model'), undefined);
  }
});

void test('snapshot routes are unique, deterministic, reversible, and match every provider total', () => {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  assert.deepEqual(
    Object.keys(snapshot.models),
    Object.keys(snapshot.models).sort(),
  );
  for (const [canonical, providers] of Object.entries(snapshot.models)) {
    assert.deepEqual(Object.keys(providers), Object.keys(providers).sort());
    for (const [provider, ids] of Object.entries(providers)) {
      assert.deepEqual(ids, [...ids].sort());
      for (const id of ids) {
        const key = JSON.stringify([provider, id]);
        assert.ok(!seen.has(key), `Duplicate provider/model pair: ${key}`);
        seen.add(key);
        counts.set(provider, (counts.get(provider) ?? 0) + 1);
        assert.equal(canonicalModelId(snapshot, provider, id), canonical);
      }
    }
  }
  assert.equal(seen.size, snapshot.coverage.totals.mapped);
  for (const [provider, stats] of Object.entries(snapshot.coverage.providers)) {
    assert.equal(counts.get(provider) ?? 0, stats.mapped);
    assert.equal(
      stats.entries,
      stats.mapped +
        stats.withoutBaseModel +
        stats.invalidBaseModel +
        stats.missingCanonicalTarget +
        stats.readErrors +
        stats.parseErrors,
    );
  }
});
