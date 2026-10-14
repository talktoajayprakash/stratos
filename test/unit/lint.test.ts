import assert from 'node:assert/strict';
import {join} from 'node:path';
import test from 'node:test';

import {ESLint} from 'eslint';

import {PACKAGE_ROOT} from '../../src/paths.js';

const eslint = new ESLint({
  cwd: PACKAGE_ROOT,
  overrideConfig: {
    languageOptions: {
      parserOptions: {
        // These tests replace a file's contents between lintText calls, even in CI.
        disallowAutomaticSingleRunInference: true,
      },
    },
  },
});
const javascript = join(PACKAGE_ROOT, 'scripts/docs/prepare.mjs');
const typescript = join(PACKAGE_ROOT, 'src/agents/agent.ts');

void test('Google lint enforces JavaScript formatting, imports and language conventions', async () => {
  const [valid] = await eslint.lintText(
    "import {basename} from 'node:path';\n\nexport const name = basename('/tmp/fixture');\n",
    {filePath: javascript},
  );
  assert.deepEqual(valid!.messages, []);

  const [invalid] = await eslint.lintText(
    'var name = "fixture"\nif (name == "fixture") console.log(name)\nimport path from "node:path"\nexport default path\n',
    {filePath: javascript},
  );
  const rules = new Set(invalid!.messages.map(message => message.ruleId));
  for (const rule of [
    'prettier/prettier',
    'no-var',
    'eqeqeq',
    'curly',
    'import-x/first',
    'import-x/no-default-export',
  ]) {
    assert.ok(rules.has(rule), `Missing JavaScript enforcement: ${rule}`);
  }

  const [unordered] = await eslint.lintText(
    "import {z} from 'zod';\nimport {basename} from 'node:path';\n\nexport const name = z.string().parse(basename('/tmp/fixture'));\n",
    {filePath: javascript},
  );
  assert.ok(
    unordered!.messages.some(message => message.ruleId === 'import-x/order'),
  );
});

void test('Google lint enforces top-level type imports and checks TypeScript promises', async () => {
  const [valid] = await eslint.lintText(
    "import type {AgentEvent} from './events.js';\n\nexport function observe(event: AgentEvent) {\n  return event.type;\n}\n",
    {filePath: typescript},
  );
  assert.deepEqual(valid!.messages, []);
  const [dynamic] = await eslint.lintText(
    "export async function loadEvents() {\n  return import('./events.js');\n}\n",
    {filePath: typescript},
  );
  assert.deepEqual(dynamic!.messages, []);

  const [invalid] = await eslint.lintText(
    "export function observe(event: import('./events.js').AgentEvent) {\n  return event.type;\n}\n\nexport const value: any = 1;\nPromise.resolve();\n",
    {filePath: typescript},
  );
  const rules = new Set(invalid!.messages.map(message => message.ruleId));
  for (const rule of [
    '@typescript-eslint/consistent-type-imports',
    '@typescript-eslint/no-explicit-any',
    '@typescript-eslint/no-floating-promises',
  ]) {
    assert.ok(rules.has(rule), `Missing TypeScript enforcement: ${rule}`);
  }
});

void test('Google autofix is repeatable and preserves valid source', async () => {
  const fixer = new ESLint({cwd: PACKAGE_ROOT, fix: true});
  const [fixed] = await fixer.lintText('export const name = "fixture"\n', {
    filePath: javascript,
  });
  assert.deepEqual(fixed!.messages, []);
  assert.equal(fixed!.output, "export const name = 'fixture';\n");
  const [again] = await fixer.lintText(fixed!.output!, {filePath: javascript});
  assert.deepEqual(again!.messages, []);
  assert.equal(again!.output, undefined);
});

void test('lint excludes dependencies, generated output and local workflows', async () => {
  for (const file of [
    'node_modules/example/index.js',
    'dist/src/index.js',
    '.generated/workflow.ts',
    'generated/mcp/server.ts',
    '.stratos/workflows/example/workflow.ts',
  ]) {
    assert.equal(await eslint.isPathIgnored(join(PACKAGE_ROOT, file)), true);
  }
  assert.equal(await eslint.isPathIgnored(javascript), false);
  assert.equal(await eslint.isPathIgnored(typescript), false);
});
