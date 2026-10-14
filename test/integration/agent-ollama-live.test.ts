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
    `live Ollama ${harness}: tools, hooks, continuity, grounded output and traces`,
    {
      skip:
        process.env.STRATOS_TEST_OLLAMA_AGENT_HARNESS !== harness &&
        'Opt in with STRATOS_TEST_OLLAMA_AGENT_HARNESS and a local tool-capable model',
      timeout: 360000,
    },
    async t => {
      const model = process.env.STRATOS_TEST_OLLAMA_AGENT_MODEL;
      assert.ok(
        model,
        'Set STRATOS_TEST_OLLAMA_AGENT_MODEL to an installed native name',
      );
      const directory = await mkdtemp(
        join(tmpdir(), `stratos-ollama-${harness}-`),
      );
      const work = join(directory, 'work');
      const runtime = join(directory, 'runtime');
      const traces = join(directory, 'traces');
      const originalTmp = process.env.TMPDIR;
      let artifactPath: string | undefined;
      let drain: (() => Promise<void>) | undefined;
      let passed = false;
      const timings: Array<{phase: string; milliseconds: number}> = [];
      t.after(async () => {
        try {
          await drain?.();
          const destination = process.env.STRATOS_TEST_OLLAMA_AGENT_EVIDENCE;
          if (destination) {
            await mkdir(destination, {recursive: true, mode: 0o700});
            const archive = await mkdtemp(join(destination, `${harness}-`));
            if (artifactPath) {
              await cp(artifactPath, join(archive, 'run'), {recursive: true});
            }
            if ((await readdir(directory)).includes('traces')) {
              await cp(traces, join(archive, 'traces'), {recursive: true});
            }
            await cp(work, join(archive, 'workspace'), {recursive: true});
            await writeFile(
              join(archive, 'result.json'),
              JSON.stringify({harness, model, passed, timings}),
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
      await mkdir(work);
      await mkdir(runtime);
      drain = await isolateArtifacts(t, join(directory, 'artifacts'));
      process.env.TMPDIR = runtime;
      const observed = `observed-${randomUUID()}`;
      const marker = `marker-${randomUUID()}`;
      const instructionMarker = `instruction-${randomUUID()}`;
      await writeFile(join(work, 'input.txt'), observed);
      const command = 'cat input.txt | tee output.txt';
      const denied = 'echo forbidden > blocked.txt';
      let toolCalls = 0;
      let denials = 0;
      let mcpCalls = 0;
      let mcpResults = 0;
      const token = process.env.STRATOS_TEST_GITHUB_TOKEN;
      const output = z.strictObject({
        category: z
          .enum(['bug', 'feature', 'question'])
          .describe('Reported issue intent'),
        evidence: z
          .string()
          .describe('Verbatim supporting quotation from the supplied issue'),
      });
      const issue =
        'Click Export PDF. Expected: a PDF is downloaded. Actual: the app crashes.';
      const definition = workflow({
        input: z.strictObject({}),
        output,
        async run() {
          artifactPath = getContext().artifacts!.path;
          const text = createAgent({
            harness,
            provider: 'ollama',
            model: [model],
            allowedMcps: token ? ['github'] : [],
            systemPrompt: `Only perform the synthetic checks requested. Never inspect credentials, environment or other files. Use real tools, not simulated outputs. The instruction-only marker is "${instructionMarker}". If asked for it, return exactly the entire marker, including its instruction- prefix, without quotation marks or tools.`,
            hooks: {
              beforeToolCall(event) {
                const input = z
                  .record(z.string(), z.unknown())
                  .parse(event.input);
                if (
                  ['bash', 'Bash'].includes(event.toolName) &&
                  input.command === command
                ) {
                  toolCalls++;
                  return;
                }
                if (
                  event.toolName.endsWith('get_file_contents') &&
                  input.owner === 'talktoajayprakash' &&
                  input.repo === 'stratos' &&
                  input.path === 'package.json'
                ) {
                  mcpCalls++;
                  return;
                }
                denials++;
                return {
                  action: 'deny',
                  reason:
                    'This operation is not allowed in the synthetic check.',
                };
              },
              afterToolCall(event) {
                if (event.toolName.endsWith('get_file_contents')) {
                  assert.equal(event.error, undefined);
                  assert.ok(
                    JSON.stringify(event.output).includes(
                      '@stratoscli/stratos',
                    ),
                  );
                  mcpResults++;
                }
              },
            },
          });
          const structured = createAgent({
            harness,
            provider: 'ollama',
            model: [model],
            outputSchema: output,
            hooks: {
              beforeToolCall(event) {
                if (event.toolName === 'StructuredOutput') {
                  return;
                }
                return {
                  action: 'deny',
                  reason: 'Use only the supplied evidence.',
                };
              },
            },
          });
          const cancel = () => {
            text.cancel();
            structured.cancel();
          };
          t.signal.addEventListener('abort', cancel, {once: true});
          const timed = async <T>(phase: string, action: () => Promise<T>) => {
            const start = performance.now();
            try {
              return await action();
            } finally {
              timings.push({phase, milliseconds: performance.now() - start});
            }
          };
          try {
            const instructions = await timed('instructions', () =>
              text.execute(
                'Return the instruction-only marker. Do not use tools.',
              ),
            );
            assert.ok(instructions.includes(instructionMarker));
            const first = await timed('tools', () =>
              text.execute(
                `Run exactly this shell command: ${command}\nReply with the observed file contents. Also remember this marker for later: ${marker}`,
              ),
            );
            assert.ok(first.includes(observed));
            assert.equal(
              await readFile(join(work, 'output.txt'), 'utf8'),
              observed,
            );
            assert.ok(toolCalls > 0);
            const recall = await timed('continuity', () =>
              text.execute(
                'Reply with the marker and observed file contents from the previous turn. Do not call tools.',
              ),
            );
            assert.ok(recall.includes(marker) && recall.includes(observed));
            await timed('denial', () =>
              text.execute(
                `Attempt exactly this shell command once: ${denied}. If a hook denies it, stop and report the denial; do not try alternatives.`,
              ),
            );
            assert.ok(denials > 0);
            assert.ok(!(await readdir(work)).includes('blocked.txt'));
            if (token) {
              const result = await timed('remote-mcp', () =>
                text.execute(
                  'Use GitHub MCP get_file_contents to read package.json from talktoajayprakash/stratos on main. Reply with the package name.',
                ),
              );
              assert.ok(result.includes('@stratoscli/stratos'));
              assert.ok(mcpCalls > 0 && mcpResults > 0);
            }
            return await timed('structured', () =>
              structured.execute(
                `Classify this report. Return category and a verbatim quote as evidence. Do not use tools: ${issue}`,
              ),
            );
          } finally {
            t.signal.removeEventListener('abort', cancel);
          }
        },
      });
      const result = await executeWorkflow(
        definition,
        {},
        'ollama-live',
        work,
        {
          name: 'ollama-live',
          shortDescription: 'Test fixture',
          longDescription:
            'Exercise this test fixture with schema-valid input.',
          version: '1',
          entrypoint: 'workflow.ts',
          path: work,
          root: work,
          mcp: {
            servers: token
              ? {
                  github: {
                    type: 'http',
                    url: 'https://api.githubcopilot.com/mcp/',
                    headers: {
                      Authorization: `Bearer ${token}`,
                      'X-MCP-Tools': 'get_file_contents',
                      'X-MCP-Readonly': 'true',
                    },
                  },
                }
              : {},
          },
          otel: {traces: {exporter: {type: 'file', path: traces}}},
        },
      );
      const parsed = output.parse(result);
      assert.equal(parsed.category, 'bug');
      assert.ok(parsed.evidence && issue.includes(parsed.evidence));
      const spans = (
        await Promise.all(
          (await readdir(traces)).map(async name =>
            (await readFile(join(traces, name), 'utf8'))
              .trim()
              .split('\n')
              .flatMap(line => traceSpans(JSON.parse(line))),
          ),
        )
      ).flat();
      const attr = (span: (typeof spans)[number], name: string) =>
        span.attributes.find(a => a.key === name)?.value.stringValue;
      for (const prefix of [
        'invoke_agent ',
        'chat ',
        `harness.preflight ${harness}`,
        `harness.initialize ${harness}`,
      ]) {
        const selected = spans.filter(span => span.name.startsWith(prefix));
        assert.ok(selected.length > 0, prefix);
        assert.ok(
          selected.every(
            span => attr(span, 'gen_ai.provider.name') === 'ollama',
          ),
        );
      }
      assert.deepEqual(await readdir(runtime), []);
      assert.ok(artifactPath);
      const events = await readFile(join(artifactPath, 'events.jsonl'), 'utf8');
      assert.ok(
        events.includes('"tool.started"') &&
          events.includes('"model.completed"'),
      );
      if (token) {
        assert.ok(!events.includes(token));
        for (const name of await readdir(traces)) {
          assert.ok(
            !(await readFile(join(traces, name), 'utf8')).includes(token),
          );
        }
      }
      passed = true;
    },
  );
}
