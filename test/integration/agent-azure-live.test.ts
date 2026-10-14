import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {z} from 'zod';

import {createAgent, workflow} from '../../src/index.js';
import {executeWorkflow, getContext} from '../../src/workflows/runtime.js';
import {isolateArtifacts} from '../helpers/artifacts.js';
import {traceSpans} from '../helpers/otlp.js';

for (const harness of ['codex', 'opencode'] as const) {
  void test(
    `live Azure ${harness}: public agent, remote MCP, tools, structured continuation and provider traces`,
    {
      skip:
        process.env.STRATOS_TEST_AZURE_HARNESS !== harness &&
        'Opt in with STRATOS_TEST_AZURE_HARNESS and configured Azure/GitHub credentials',
      timeout: 180000,
    },
    async t => {
      const githubToken = process.env.STRATOS_TEST_GITHUB_TOKEN;
      assert.ok(
        githubToken,
        'STRATOS_TEST_GITHUB_TOKEN is required for the read-only GitHub MCP check',
      );
      const directory = await mkdtemp(
        join(tmpdir(), `stratos-azure-${harness}-`),
      );
      let drain: (() => Promise<void>) | undefined;
      const work = join(directory, 'work');
      const runtime = join(directory, 'runtime');
      const traces = join(directory, 'traces');
      const originalTmp = process.env.TMPDIR;
      let artifactPath: string | undefined;
      const timings: number[] = [];
      let passed = false;
      t.after(async () => {
        try {
          await drain?.();
          const archiveRoot = process.env.STRATOS_TEST_AZURE_EVIDENCE;
          if (archiveRoot) {
            await mkdir(archiveRoot, {recursive: true, mode: 0o700});
            const archive = await mkdtemp(join(archiveRoot, `${harness}-`));
            if (artifactPath) {
              await cp(artifactPath, join(archive, 'run'), {recursive: true});
            }
            if ((await readdir(directory)).includes('traces')) {
              await cp(traces, join(archive, 'traces'), {recursive: true});
            }
            await writeFile(
              join(archive, 'result.json'),
              JSON.stringify({
                harness,
                provider: 'azure',
                model: 'openai/gpt-5.4',
                passed,
                timings,
                timingScope:
                  'Per execute call including preparation; overlapping native spans are not additive',
              }),
              {mode: 0o600},
            );
          }
        } finally {
          if (originalTmp === undefined) {
            delete process.env.TMPDIR;
          } else {
            process.env.TMPDIR = originalTmp;
          }
          await rm(directory, {recursive: true, force: true});
        }
      });
      drain = await isolateArtifacts(t, join(directory, 'artifacts'));
      await mkdir(work);
      await mkdir(runtime);
      process.env.TMPDIR = runtime;
      const marker = randomUUID();
      const observed = `fixture-${randomUUID()}`;
      const command = 'cat input.txt | tee output.txt';
      await writeFile(join(work, 'input.txt'), observed + '\n');
      let shellCalls = 0;
      let mcpCalls = 0;
      const output = z.strictObject({
        observed: z.string().describe('Trimmed shell-tool output'),
        marker: z.string().describe('Token retained across both turns'),
        packageName: z.string().describe('Name in the public package manifest'),
      });
      const definition = workflow({
        input: z.strictObject({}),
        output,
        async run() {
          artifactPath = getContext().artifacts!.path;
          const agent = createAgent({
            harness,
            provider: 'azure',
            model: ['openai/gpt-5.4'],
            effort: 'low',
            allowedMcps: ['github'],
            outputSchema: output,
            systemPrompt:
              'Perform only the requested synthetic check. Never inspect environment, credentials or other files.',
            hooks: {
              beforeToolCall(event) {
                if (event.toolName === 'StructuredOutput') {
                  return;
                }
                const args = z
                  .record(z.string(), z.unknown())
                  .parse(event.input);
                if (
                  ['bash', 'Bash'].includes(event.toolName) &&
                  args.command === command &&
                  shellCalls === 0
                ) {
                  shellCalls++;
                  return;
                }
                if (
                  event.toolName.endsWith('get_file_contents') &&
                  mcpCalls === 0 &&
                  args.owner === 'talktoajayprakash' &&
                  args.repo === 'stratos' &&
                  args.path === 'package.json'
                ) {
                  mcpCalls++;
                  return;
                }
                return {
                  action: 'deny',
                  reason:
                    'Only the specified shell command and public package.json MCP read are allowed, once each',
                };
              },
            },
          });
          const cancel = () => agent.cancel();
          t.signal.addEventListener('abort', cancel, {once: true});
          try {
            const start = performance.now();
            const first = await agent.execute(
              `Run exactly this shell command once: ${command}\n` +
                'Use the GitHub MCP get_file_contents tool to read package.json from talktoajayprakash/stratos on main. ' +
                `Return observed as the trimmed shell output, marker as ${marker}, and packageName as the fetched package's name. Remember all three values.`,
            );
            timings.push(performance.now() - start);
            assert.deepEqual(first, {
              observed,
              marker,
              packageName: '@stratoscli/stratos',
            });
            const next = performance.now();
            const recalled = await agent.execute(
              'Return the same three values from your previous response without shell, file or MCP calls.',
            );
            timings.push(performance.now() - next);
            return recalled;
          } finally {
            t.signal.removeEventListener('abort', cancel);
          }
        },
      });
      assert.deepEqual(
        await executeWorkflow(definition, {}, 'azure-live', work, {
          name: 'azure-live',
          shortDescription: 'Test fixture',
          longDescription:
            'Exercise this test fixture with schema-valid input.',
          version: '1',
          entrypoint: 'workflow.ts',
          path: work,
          root: work,
          mcp: {
            servers: {
              github: {
                type: 'http',
                url: 'https://api.githubcopilot.com/mcp/',
                headers: {Authorization: `Bearer ${githubToken}`},
              },
            },
          },
          otel: {traces: {exporter: {type: 'file', path: traces}}},
        }),
        {observed, marker, packageName: '@stratoscli/stratos'},
      );
      assert.equal(shellCalls, 1);
      assert.equal(mcpCalls, 1);
      assert.equal(
        await readFile(join(work, 'output.txt'), 'utf8'),
        observed + '\n',
      );
      const spans = (
        await Promise.all(
          (await readdir(traces)).map(async file =>
            (await readFile(join(traces, file), 'utf8'))
              .trim()
              .split('\n')
              .flatMap(line => traceSpans(JSON.parse(line))),
          ),
        )
      ).flat();
      const attribute = (span: (typeof spans)[number], key: string) =>
        span.attributes.find(a => a.key === key)?.value.stringValue;
      const agents = spans.filter(s => s.name.startsWith('invoke_agent '));
      const models = spans.filter(s => s.name.startsWith('chat '));
      const preparation = spans.filter(s => s.name.startsWith('harness.'));
      const workflowSpan = spans.find(s => s.name === 'workflow azure-live');
      assert.ok(workflowSpan);
      assert.equal(agents.length, 2);
      assert.ok(models.length >= 2);
      assert.equal(
        preparation.filter(s => s.name === `harness.preflight ${harness}`)
          .length,
        1,
      );
      assert.equal(
        preparation.filter(s => s.name === `harness.initialize ${harness}`)
          .length,
        1,
      );
      assert.equal(
        preparation.filter(s => s.name === `harness.startup ${harness}`).length,
        harness === 'codex' ? 2 : 0,
      );
      for (const span of preparation) {
        assert.equal(attribute(span, 'stratos.completion.status'), 'success');
        assert.equal(attribute(span, 'gen_ai.provider.name'), 'azure');
        assert.equal(span.traceId, agents[0]!.traceId);
        if (span.name === 'harness.startup codex') {
          assert.ok(agents.some(agent => agent.spanId === span.parentSpanId));
          assert.equal(
            attribute(span, 'stratos.harness.ready_boundary'),
            'codex.turn.started',
          );
        } else {
          assert.equal(span.parentSpanId, workflowSpan.spanId);
        }
      }
      assert.equal(
        new Set(preparation.map(s => attribute(s, 'stratos.agent.session.id')))
          .size,
        1,
      );
      for (const span of [...agents, ...models]) {
        assert.equal(attribute(span, 'gen_ai.provider.name'), 'azure');
        assert.equal(span.status.code ?? 0, 0);
      }
      assert.ok(artifactPath);
      const text = await readFile(join(artifactPath, 'events.jsonl'), 'utf8');
      const events = text
        .trim()
        .split('\n')
        .map(line =>
          z
            .object({
              agentSessionId: z.string(),
              event: z.object({type: z.string()}),
            })
            .parse(JSON.parse(line)),
        );
      assert.equal(new Set(events.map(e => e.agentSessionId)).size, 1);
      for (const type of [
        'model.started',
        'model.completed',
        'tool.started',
        'tool.completed',
      ]) {
        assert.ok(
          events.some(e => e.event.type === type),
          `Missing ${type}`,
        );
      }
      for (const secret of [githubToken, process.env.AZURE_API_KEY].filter(
        Boolean,
      )) {
        assert.ok(!text.includes(secret!));
        assert.ok(!JSON.stringify(spans).includes(secret!));
      }
      assert.deepEqual(await readdir(runtime), []);
      passed = true;
      t.diagnostic(
        JSON.stringify({
          harness,
          provider: 'azure',
          sameSession: true,
          remoteMcp: true,
          models: models.length,
          timings,
          preparation: preparation.map(span => ({
            name: span.name,
            startTimeUnixNano: span.startTimeUnixNano,
            endTimeUnixNano: span.endTimeUnixNano,
          })),
        }),
      );
    },
  );
}
