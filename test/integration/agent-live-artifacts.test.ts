import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, realpath, rm} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';

import {z} from 'zod';

import {createAgent, workflow} from '../../src/index.js';
import {executeWorkflow, getContext} from '../../src/workflows/runtime.js';
import {isolateArtifacts} from '../helpers/artifacts.js';

const configurations = [
  {harness: 'codex', provider: 'azure', model: 'openai/gpt-6-astra'},
  {
    harness: 'claude-code',
    provider: 'anthropic',
    model: 'anthropic/claude-sonnet-4-5',
  },
  {
    harness: 'opencode',
    provider: 'anthropic',
    model: 'anthropic/claude-sonnet-4-5',
  },
] as const;
const recordSchema = z.object({
  timestamp: z.number(),
  workflowName: z.string(),
  executionId: z.string(),
  parentExecutionId: z.string(),
  agentSessionId: z.uuid(),
  event: z.object({type: z.string()}).passthrough(),
});

for (const configuration of configurations) {
  void test(
    `live ${configuration.harness}: persist native events and qualified logs for a child workflow`,
    {
      skip:
        process.env.STRATOS_TEST_ARTIFACT_HARNESS !== configuration.harness &&
        'Opt in with STRATOS_TEST_ARTIFACT_HARNESS and native credentials',
      timeout: 180000,
    },
    async t => {
      const previousHome = homedir();
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), 'stratos-live-artifacts-')),
      );
      const drainArtifacts = await isolateArtifacts(t, directory);
      const env: Record<string, string> = {
        TMPDIR: directory,
        CLAUDE_CODE_TMPDIR: directory,
      };
      if (configuration.harness === 'opencode') {
        Object.assign(env, {
          XDG_DATA_HOME: join(directory, 'data'),
          XDG_STATE_HOME: join(directory, 'state'),
          XDG_CACHE_HOME: join(directory, 'cache'),
          XDG_CONFIG_HOME: join(directory, 'config'),
        });
        if (process.env.STRATOS_TEST_OPENCODE_BINARY) {
          env.PATH = `${dirname(process.env.STRATOS_TEST_OPENCODE_BINARY)}:${process.env.PATH ?? ''}`;
        }
      }
      const original = Object.fromEntries(
        Object.keys(env).map(key => [key, process.env[key]]),
      );
      Object.assign(process.env, env);
      let artifactPath!: string;
      let parentId!: string;
      let childId!: string;
      let tools = 0;
      t.after(async () => {
        try {
          await drainArtifacts();
        } finally {
          for (const [key, value] of Object.entries(original)) {
            if (value === undefined) {
              delete process.env[key];
            } else {
              process.env[key] = value;
            }
          }
          if (configuration.harness === 'claude-code') {
            const projects = join(
              process.env.CLAUDE_CONFIG_DIR ?? join(previousHome, '.claude'),
              'projects',
            );
            // This workspace is unique to the test; leave all other native state alone.
            const suffix = directory.replace(/[^a-zA-Z0-9]/g, '-');
            await rm(join(projects, suffix), {recursive: true, force: true});
          }
          await rm(directory, {recursive: true, force: true});
        }
      });
      const marker = `ARTIFACT_${randomUUID()}`;
      const command = 'printf STRATOS_ARTIFACT_TOOL';
      const empty = z.strictObject({});
      await executeWorkflow(
        workflow({
          input: empty,
          output: empty,
          async run() {
            const parent = getContext();
            parentId = parent.id;
            artifactPath = parent.artifacts!.path;
            console.log('live-parent-log');
            await executeWorkflow(
              workflow({
                input: empty,
                output: empty,
                async run() {
                  childId = getContext().id;
                  console.info('live-child-log');
                  const agent = createAgent({
                    harness: configuration.harness,
                    provider: configuration.provider,
                    model: [configuration.model],
                    effort: 'low',
                    systemPrompt:
                      'Follow instructions precisely. No file inspection.',
                    hooks: {
                      beforeToolCall(event) {
                        if (
                          ['Bash', 'bash'].includes(event.toolName) &&
                          event.input &&
                          typeof event.input === 'object' &&
                          'command' in event.input &&
                          event.input.command === command &&
                          tools === 0
                        ) {
                          tools++;
                          console.log('live-tool-hook');
                          return;
                        }
                        return {
                          action: 'deny',
                          reason:
                            'Only the exact requested command once is allowed',
                        };
                      },
                    },
                  });
                  const cancel = () => agent.cancel();
                  t.signal.addEventListener('abort', cancel, {once: true});
                  try {
                    await agent.execute(
                      `Remember marker ${marker}. Run exactly this command once with Bash: ${command}. Then reply briefly.`,
                    );
                    assert.equal(
                      (
                        await agent.execute(
                          'Reply only with the marker from my previous request, without tools.',
                        )
                      ).trim(),
                      marker,
                    );
                  } finally {
                    t.signal.removeEventListener('abort', cancel);
                  }
                  return {};
                },
              }),
              {},
              'live-child',
              directory,
              undefined,
              {},
              [],
              parent.agentPool,
              parent,
            );
            return {};
          },
        }),
        {},
        'live-parent',
        directory,
      );
      assert.equal(tools, 1);
      const text = await readFile(join(artifactPath, 'events.jsonl'), 'utf8');
      const events = text
        .trim()
        .split('\n')
        .map(line => recordSchema.parse(JSON.parse(line)));
      assert.ok(
        events.every(
          event =>
            event.executionId === childId &&
            event.parentExecutionId === parentId &&
            event.workflowName === 'live-child',
        ),
      );
      assert.equal(new Set(events.map(event => event.agentSessionId)).size, 1);
      for (const type of [
        'model.started',
        'model.completed',
        'tool.started',
        'tool.completed',
      ]) {
        assert.ok(
          events.some(event => event.event.type === type),
          `Missing real ${type} event`,
        );
      }
      assert.ok(text.includes('STRATOS_ARTIFACT_TOOL'));
      if (process.env.ANTHROPIC_API_KEY) {
        assert.ok(!text.includes(process.env.ANTHROPIC_API_KEY));
      }
      const log = await readFile(join(artifactPath, 'run.log'), 'utf8');
      assert.match(log, /live-parent-log/);
      assert.match(log, /live-child-log/);
      assert.match(log, /"agentSessionId":".*".*live-tool-hook/);
      assert.equal(
        JSON.parse(await readFile(join(artifactPath, 'run.json'), 'utf8'))
          .status,
        'success',
      );
      assert.deepEqual((await readdir(artifactPath)).sort(), [
        'events.jsonl',
        'run.json',
        'run.log',
      ]);
      t.diagnostic(
        JSON.stringify({
          harness: configuration.harness,
          realInference: true,
          records: events.length,
          types: [...new Set(events.map(event => event.event.type))],
          sameSessionContinuation: true,
        }),
      );
    },
  );
}
