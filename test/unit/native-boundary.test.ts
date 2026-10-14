import assert from 'node:assert/strict';
import test from 'node:test';

import {ClaudeAdapter} from '../../src/agents/claude/adapter.js';
import {CodexAdapter} from '../../src/agents/codex/adapter.js';
import {
  createNativeAdapter,
  preflightNativeHarness,
} from '../../src/agents/native.js';
import {OpenCodeAdapter} from '../../src/agents/opencode/adapter.js';
import {testHome} from '../helpers/home.js';

void test('native boundary constructs each selected harness without starting inference', async () => {
  const common = {diagnostic: () => {}, onEvent: () => {}};
  const configurations: Array<Parameters<typeof createNativeAdapter>[0]> = [
    {
      harness: 'codex',
      provider: 'azure',
      canonicalModel: 'openai/gpt-5.4',
      options: {...common, workingDirectory: testHome},
    },
    {
      harness: 'claude-code',
      provider: 'anthropic',
      canonicalModel: 'anthropic/claude-sonnet-4-5',
      options: {...common, cwd: testHome},
    },
    {
      harness: 'opencode',
      provider: 'azure',
      canonicalModel: 'openai/gpt-5.4',
      options: {...common, workingDirectory: testHome},
    },
  ];
  const classes = [CodexAdapter, ClaudeAdapter, OpenCodeAdapter];
  for (const [index, configuration] of configurations.entries()) {
    const adapter = createNativeAdapter(configuration);
    try {
      assert.ok(adapter instanceof classes[index]!);
      await assert.rejects(
        adapter.execute('Must not reach a model'),
        /initialized/,
      );
    } finally {
      await adapter.close();
    }
  }
  assert.throws(
    () =>
      createNativeAdapter({
        harness: 'codex',
        provider: 'unknown-provider',
        canonicalModel: 'openai/gpt-5.4',
        options: {...common, workingDirectory: testHome},
      }),
    /provider/i,
  );
});

void test('native preflight dispatch preserves an already-aborted caller without starting a process', async () => {
  const reason = new Error('stop before native discovery');
  for (const harness of ['codex', 'claude-code', 'opencode'] as const) {
    await assert.rejects(
      preflightNativeHarness(
        harness,
        {workingDirectory: testHome},
        AbortSignal.abort(reason),
      ),
      error => error === reason,
    );
  }
});
