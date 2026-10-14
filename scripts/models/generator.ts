import {execFileSync} from 'node:child_process';
import {readFileSync, realpathSync} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

import {parse} from 'smol-toml';

import type {Counts, MappingSnapshot} from '../../src/models/mapping.js';

export type Classification =
  | {kind: 'mapped'; canonicalId: string}
  | {kind: 'withoutBaseModel' | 'invalidBaseModel' | 'missingCanonicalTarget'};

export function classify(
  data: Record<string, unknown>,
  canonicalIds: ReadonlySet<string>,
): Classification {
  if (!Object.hasOwn(data, 'base_model')) {
    return {kind: 'withoutBaseModel'};
  }
  const target = data.base_model;
  if (typeof target !== 'string' || target.length === 0) {
    return {kind: 'invalidBaseModel'};
  }
  if (!canonicalIds.has(target)) {
    return {kind: 'missingCanonicalTarget'};
  }
  return {kind: 'mapped', canonicalId: target};
}

function counts(): Counts {
  return {
    entries: 0,
    mapped: 0,
    withoutBaseModel: 0,
    invalidBaseModel: 0,
    missingCanonicalTarget: 0,
    readErrors: 0,
    parseErrors: 0,
  };
}

/** Scan an exact, clean source revision. Does not execute any upstream code. */
export function generateMapping(repo: string, commit: string): MappingSnapshot {
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('Supply a full lowercase source commit SHA');
  }
  const root = realpathSync(resolve(repo));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  if (git('rev-parse', 'HEAD') !== commit) {
    throw new Error('Source checkout does not match the pinned commit');
  }
  const ensureClean = () => {
    if (
      git(
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        'models',
        'providers',
      )
    ) {
      throw new Error('Source models/providers contain local changes');
    }
  };
  ensureClean();
  const paths = git('ls-files', '-z', '--', 'models', 'providers')
    .split('\0')
    .filter(Boolean)
    .sort();
  const canonicalPaths = paths.filter(p => /^models\/.+\.toml$/.test(p));
  const providerNames = paths.flatMap(
    p => /^providers\/([^/]+)\/provider\.toml$/.exec(p)?.[1] ?? [],
  );
  if (!canonicalPaths.length || !providerNames.length) {
    throw new Error('Expected Models.dev models and providers');
  }

  const readToml = (source: string) => {
    let text: string;
    try {
      const path = realpathSync(join(root, source));
      const rel = relative(root, path);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error('External symlink');
      }
      text = readFileSync(path, 'utf8');
    } catch {
      return {error: 'read_error' as const};
    }
    try {
      return {data: parse(text)};
    } catch {
      return {error: 'parse_error' as const};
    }
  };

  const models: MappingSnapshot['models'] = Object.create(null);
  for (const path of canonicalPaths) {
    const result = readToml(path);
    if (result.error) {
      throw new Error(`Invalid canonical source: ${path} (${result.error})`);
    }
    models[path.slice('models/'.length, -'.toml'.length)] = Object.create(null);
  }
  const canonicalIds = new Set(Object.keys(models));
  const providers: Record<string, Counts> = Object.create(null);
  for (const provider of providerNames.sort()) {
    providers[provider] = counts();
  }
  const diagnostics: MappingSnapshot['diagnostics'] = [];
  for (const source of paths) {
    const match = /^providers\/([^/]+)\/models\/(.+)\.toml$/.exec(source);
    if (!match) {
      continue;
    }
    const provider = match[1]!;
    const modelId = match[2]!;
    const stats = providers[provider];
    if (!stats) {
      throw new Error(`Missing provider declaration for ${source}`);
    }
    stats.entries++;
    const result = readToml(source);
    if (result.error) {
      stats[result.error === 'read_error' ? 'readErrors' : 'parseErrors']++;
      diagnostics.push({source, code: result.error});
      continue;
    }
    const relationship = classify(result.data!, canonicalIds);
    stats[relationship.kind]++;
    if (relationship.kind === 'mapped') {
      const routes = models[relationship.canonicalId]!;
      (routes[provider] ??= []).push(modelId);
    } else if (relationship.kind !== 'withoutBaseModel') {
      diagnostics.push({
        source,
        code:
          relationship.kind === 'invalidBaseModel'
            ? 'invalid_base_model'
            : 'missing_canonical_target',
      });
    }
  }
  const totals = counts();
  for (const stats of Object.values(providers)) {
    for (const key of Object.keys(totals) as Array<keyof Counts>) {
      totals[key] += stats[key];
    }
  }
  ensureClean();
  return {
    formatVersion: 1,
    policy: 'explicit-base-model-only',
    source: {
      repository: 'https://github.com/anomalyco/models.dev',
      commit,
      commitDate: git('show', '-s', '--format=%cI', commit),
    },
    models: Object.fromEntries(
      Object.keys(models)
        .sort()
        .map(id => [
          id,
          Object.fromEntries(
            Object.keys(models[id]!)
              .sort()
              .map(provider => [provider, models[id]![provider]!.sort()]),
          ),
        ]),
    ),
    coverage: {
      canonicalModels: canonicalIds.size,
      mappedCanonicalModels: Object.values(models).filter(
        p => Object.keys(p).length > 0,
      ).length,
      providers,
      totals,
    },
    diagnostics,
  };
}
