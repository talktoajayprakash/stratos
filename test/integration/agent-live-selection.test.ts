import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {z} from 'zod';

import {createAgent, workflow} from '../../src/index.js';
import {executeWorkflow} from '../../src/workflows/runtime.js';
import {isolateArtifacts} from '../helpers/artifacts.js';

void test(
  'live production Codex: independent catalog, actual inference and same-conversation continuation',
  {
    skip:
      process.env.STRATOS_TEST_CODEX_LIVE !== '1' &&
      'Opt in with STRATOS_TEST_CODEX_LIVE=1 and direct Azure Foundry credentials',
    timeout: 120000,
  },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'stratos-live-selection-'));
    const drainArtifacts = await isolateArtifacts(
      t,
      join(directory, 'artifacts'),
    );
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = directory;
    let tools = 0;
    t.after(async () => {
      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpdir;
      }
      try {
        await drainArtifacts();
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    });
    const definition = workflow({
      input: z.strictObject({}),
      output: z.object({result: z.string().describe('Recalled marker')}),
      async run() {
        const agent = createAgent({
          harness: 'codex',
          provider: 'azure',
          model: [
            'openai/stratos-intentionally-unmapped',
            'openai/gpt-6-astra',
          ],
          systemPrompt: 'Reply briefly. Never use tools or access files.',
          effort: 'low',
          hooks: {
            beforeToolCall: () => {
              tools++;
              return {action: 'deny', reason: 'No tools in this live check'};
            },
          },
        });
        const timer = setTimeout(() => agent.cancel(), 90000);
        try {
          const first = performance.now();
          const response = await agent.execute(
            'Remember marker PINE8. Reply exactly OK. Do not use tools.',
          );
          assert.equal(response.trim(), 'OK');
          const second = performance.now();
          const recalled = await agent.execute(
            'Reply only with the marker from the preceding request. Do not use tools.',
          );
          t.diagnostic(
            JSON.stringify({
              firstExecuteIncludingDiscoveryMs: second - first,
              continuationMs: performance.now() - second,
              realInferenceRequests: 2,
              harness: 'codex',
            }),
          );
          return {result: recalled.trim()};
        } finally {
          clearTimeout(timer);
        }
      },
    });
    assert.deepEqual(
      await executeWorkflow(definition, {}, 'live-selection', directory),
      {result: 'PINE8'},
    );
    assert.equal(tools, 0);
    assert.deepEqual(
      (await readdir(directory)).filter(name =>
        name.startsWith('stratos-codex'),
      ),
      [],
    );
  },
);
