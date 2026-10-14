import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';

import type {OpencodeClient} from '@opencode-ai/sdk/v2';
import {z} from 'zod';

import {createAgentWithAdapters} from '../../src/agents/agent.js';
import {codexBinary} from '../../src/agents/codex/preflight.js';
import type {AgentEvent} from '../../src/agents/events.js';
import {
  createNativeAdapter,
  preflightNativeHarness,
} from '../../src/agents/native.js';
import {OpenCodeAdapter} from '../../src/agents/opencode/adapter.js';
import {startOpenCodeServer} from '../../src/agents/opencode/process.js';
import {workflow} from '../../src/index.js';
import {resolveNativeModel} from '../../src/models/catalog.js';
import {executeWorkflow, getContext} from '../../src/workflows/runtime.js';
import {isolateArtifacts} from '../helpers/artifacts.js';
import {traceSpans} from '../helpers/otlp.js';

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

for (const configuration of configurations) {
  const cases =
    configuration.harness === 'claude-code'
      ? (['compaction', 'subagent', 'background-shell'] as const)
      : (['compaction', 'subagent'] as const);
  for (const scenario of cases) {
    void test(
      `live ${configuration.harness} activity: ${scenario}`,
      {
        skip:
          process.env.STRATOS_TEST_ACTIVITY_HARNESS !== configuration.harness &&
          'Opt in with STRATOS_TEST_ACTIVITY_HARNESS and real native credentials',
        timeout: 180000,
      },
      async t => {
        const directory = await realpath(
          await mkdtemp(join(tmpdir(), 'stratos-live-activity-')),
        );
        const drain = await isolateArtifacts(t, directory);
        t.after(async () => {
          try {
            await drain();
          } finally {
            if (
              configuration.harness === 'claude-code' &&
              !process.env.ANTHROPIC_API_KEY
            ) {
              await rm(
                join(
                  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
                  'projects',
                  directory.replace(/[^a-zA-Z0-9]/g, '-'),
                ),
                {recursive: true, force: true},
              );
            }
            await rm(directory, {recursive: true, force: true});
          }
        });
        const events: AgentEvent[] = [];
        const diagnostics: unknown[] = [];
        const marker = `ACTIVITY_${randomUUID()}`;
        const traceDirectory = join(directory, 'traces');
        const env = {
          TMPDIR: directory,
          CLAUDE_CODE_TMPDIR: directory,
          ...(process.env.ANTHROPIC_API_KEY
            ? {CLAUDE_CONFIG_DIR: join(directory, 'claude')}
            : {}),
          XDG_DATA_HOME: join(directory, 'data'),
          XDG_STATE_HOME: join(directory, 'state'),
          XDG_CACHE_HOME: join(directory, 'cache'),
        };
        t.after(() =>
          t.diagnostic(
            JSON.stringify({
              harness: configuration.harness,
              scenario,
              observedTypes: [...new Set(events.map(event => event.type))],
            }),
          ),
        );
        let artifactPath!: string;
        let childId!: string;
        let parentId!: string;
        let opencode: OpencodeClient | undefined;
        const compactBinary = join(directory, 'codex-compact');
        if (configuration.harness === 'codex' && scenario === 'compaction') {
          await writeFile(
            compactBinary,
            `#!/bin/sh\nexec '${codexBinary().replaceAll("'", "'\\''")}' "$@" -c model_auto_compact_token_limit=1000 -c model_auto_compact_token_limit_scope=total\n`,
            {mode: 0o700},
          );
        }
        const worker = join(directory, 'activity-worker.cjs');
        const proof = join(directory, 'proof');
        const release = join(directory, 'release');
        await writeFile(
          worker,
          `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(proof)}, 'started');
console.log('activity started');
const finish = () => {
  fs.appendFileSync(${JSON.stringify(proof)}, '\\ncompleted');
  console.log(${JSON.stringify(marker)});
};
${
  scenario === 'background-shell'
    ? `
const deadline = setTimeout(() => { console.error('Activity fixture release timed out'); process.exit(1); }, 45000);
const check = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) {
    clearInterval(check);
    clearTimeout(deadline);
    finish();
  }
}, 25);
`
    : 'setTimeout(finish, 1000);'
}
`,
        );
        const empty = z.strictObject({});
        await executeWorkflow(
          workflow({
            input: empty,
            output: empty,
            async run() {
              const parent = getContext();
              parentId = parent.id;
              artifactPath = parent.artifacts!.path;
              await executeWorkflow(
                workflow({
                  input: empty,
                  output: empty,
                  async run() {
                    childId = getContext().id;
                    const agent = createAgentWithAdapters(
                      {
                        harness: configuration.harness,
                        provider: configuration.provider,
                        model: [configuration.model],
                        effort: 'low',
                        systemPrompt:
                          'Follow the request exactly. Use only the requested tools in this disposable test workspace. Do not inspect unrelated files.',
                      },
                      {
                        preflight: preflightNativeHarness,
                        createAdapter(settings) {
                          const options = {
                            env: Object.assign(
                              Object.fromEntries(
                                Object.entries(process.env).filter(
                                  (entry): entry is [string, string] =>
                                    entry[1] !== undefined,
                                ),
                              ),
                              env,
                            ),
                            onEvent(event: AgentEvent) {
                              events.push(event);
                              return settings.options.onEvent(event);
                            },
                            diagnostic(error: unknown) {
                              diagnostics.push(error);
                              settings.options.diagnostic(error);
                            },
                          };
                          if (settings.harness === 'opencode') {
                            return new OpenCodeAdapter(
                              {
                                ...settings.options,
                                ...options,
                                binary:
                                  process.env.STRATOS_TEST_OPENCODE_BINARY,
                                model: {
                                  providerID: settings.provider,
                                  modelID: resolveNativeModel(
                                    settings.canonicalModel,
                                    settings.provider,
                                  ),
                                },
                              },
                              async (...args) => {
                                const server = await startOpenCodeServer(
                                  ...args,
                                );
                                opencode = server.client;
                                return server;
                              },
                            );
                          }
                          if (settings.harness === 'codex') {
                            return createNativeAdapter({
                              ...settings,
                              options: {
                                ...settings.options,
                                ...options,
                                ...(scenario === 'compaction'
                                  ? {binary: compactBinary}
                                  : {}),
                              },
                            });
                          }
                          return createNativeAdapter({
                            ...settings,
                            options: {
                              ...settings.options,
                              ...options,
                            },
                          });
                        },
                      },
                    );
                    const cancel = () => agent.cancel();
                    t.signal.addEventListener('abort', cancel, {once: true});
                    try {
                      if (scenario === 'compaction') {
                        await agent.execute(
                          `Remember the marker ${marker}. Reply only OK.`,
                        );
                        if (configuration.harness === 'claude-code') {
                          // Native /compact succeeds without assistant text; retain
                          // the public execute contract and then continue the session.
                          await assert.rejects(
                            agent.execute('/compact Preserve the marker.'),
                            /Claude returned no assistant text/,
                          );
                        } else if (configuration.harness === 'opencode') {
                          assert.ok(opencode);
                          const {data} = await opencode.session.list(
                            {},
                            {throwOnError: true},
                          );
                          const session = data!.find(
                            session => !session.parentID,
                          )!;
                          assert.ok(session);
                          await opencode.session.summarize(
                            {
                              sessionID: session.id,
                              providerID: configuration.provider,
                              modelID: resolveNativeModel(
                                configuration.model,
                                configuration.provider,
                              ),
                              auto: false,
                            },
                            {throwOnError: true, signal: t.signal},
                          );
                        }
                        const output = await agent.execute(
                          'Return only the marker I asked you to remember. No tools.',
                        );
                        assert.ok(
                          output.includes(marker),
                          'Conversation survives native compaction',
                        );
                        assert.equal(
                          events.some(e => e.type === 'compaction.started'),
                          configuration.harness !== 'codex',
                          'Do not invent a Codex compaction start',
                        );
                        assert.ok(
                          events.some(e => e.type === 'compaction.completed'),
                          'Native compaction completion observed',
                        );
                      } else {
                        const command = `${process.execPath} ${worker}`;
                        const prompt =
                          scenario === 'background-shell'
                            ? `Run exactly this command once using Bash with run_in_background=true: ${command}. Do not wait for it, stop it or call TaskOutput. Reply briefly after launching it.`
                            : `Delegate to exactly one ${configuration.harness === 'opencode' ? 'general subagent with the task tool' : 'subagent'}: run exactly this shell command once: ${command}. The subagent must wait for the command to finish and report its output. Do not run it yourself. Wait for the subagent and reply with its result.`;
                        await agent.execute(prompt);
                        if (scenario === 'background-shell') {
                          assert.ok(
                            !events.some(
                              event => event.type === 'background.completed',
                            ),
                            'Background completion must be observed after foreground return',
                          );
                          await writeFile(release, '');
                        }
                        assert.ok(
                          events.some(
                            event => event.type === 'background.started',
                          ),
                          'Native task start observed after the request',
                        );
                        while (
                          !events.some(e => e.type === 'background.completed')
                        ) {
                          await delay(25, undefined, {signal: t.signal});
                        }
                        assert.equal(
                          await readFile(proof, 'utf8'),
                          'started\ncompleted',
                        );
                        const started = events.filter(
                          e => e.type === 'background.started',
                        );
                        assert.ok(started.length > 0);
                        assert.ok(
                          started.some(start =>
                            events.some(
                              end =>
                                end.type === 'background.completed' &&
                                end.taskId === start.taskId &&
                                !end.error &&
                                !end.cancelled,
                            ),
                          ),
                          'Real task has a successful native completion',
                        );
                      }
                    } finally {
                      t.signal.removeEventListener('abort', cancel);
                    }
                    return {};
                  },
                }),
                {},
                'activity-child',
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
          'activity-parent',
          directory,
          {
            name: 'activity-parent',
            shortDescription: 'Test fixture',
            longDescription:
              'Exercise this test fixture with schema-valid input.',
            version: '1',
            entrypoint: 'workflow.ts',
            path: directory,
            root: directory,
            otel: {traces: {exporter: {type: 'file', path: traceDirectory}}},
          },
        );
        const persisted = (
          await readFile(join(artifactPath, 'events.jsonl'), 'utf8')
        )
          .trim()
          .split('\n')
          .map(line =>
            z
              .object({
                executionId: z.string(),
                parentExecutionId: z.string(),
                agentSessionId: z.string(),
                event: z.object({type: z.string()}),
              })
              .parse(JSON.parse(line)),
          );
        assert.equal(persisted.length, events.length);
        assert.ok(
          persisted.every(
            row =>
              row.executionId === childId && row.parentExecutionId === parentId,
          ),
        );
        assert.equal(new Set(persisted.map(row => row.agentSessionId)).size, 1);
        const spans = (
          await Promise.all(
            (await readdir(traceDirectory)).map(async file =>
              (await readFile(join(traceDirectory, file), 'utf8'))
                .trim()
                .split('\n')
                .flatMap(line => traceSpans(JSON.parse(line))),
            ),
          )
        ).flat();
        const operation =
          scenario === 'compaction' ? 'compaction' : 'background task';
        const attribute = (span: (typeof spans)[number], key: string) =>
          span.attributes.find(item => item.key === key)?.value.stringValue;
        for (const start of events.filter(
          event =>
            event.type === 'background.started' ||
            event.type === 'compaction.started',
        )) {
          const span = spans.find(
            span =>
              attribute(
                span,
                start.type === 'background.started'
                  ? 'stratos.task.id'
                  : 'stratos.compaction.id',
              ) ===
              (start.type === 'background.started'
                ? start.taskId
                : start.compactionId),
          );
          assert.ok(span);
          assert.equal(attribute(span, 'stratos.completion.status'), 'success');
          const parent = start.parentTaskId
            ? spans.find(
                span =>
                  attribute(span, 'stratos.task.id') === start.parentTaskId,
              )
            : start.parentToolCallId
              ? spans.find(
                  span =>
                    attribute(span, 'gen_ai.tool.call.id') ===
                    start.parentToolCallId,
                )
              : undefined;
          if (parent) {
            assert.equal(span.parentSpanId, parent.spanId);
          } else {
            assert.ok(
              spans.some(
                parent =>
                  parent.spanId === span.parentSpanId &&
                  parent.name.startsWith('invoke_agent'),
              ),
            );
          }
        }
        if (configuration.harness === 'codex' && scenario === 'compaction') {
          assert.ok(
            events.some(
              event =>
                event.type === 'compaction.completed' && event.reconstructed,
            ),
          );
          const observations = spans.flatMap(span =>
            z
              .array(
                z.object({
                  name: z.string(),
                  attributes: z.array(
                    z.object({
                      key: z.string(),
                      value: z.looseObject({boolValue: z.boolean().optional()}),
                    }),
                  ),
                }),
              )
              .parse(span.events ?? []),
          );
          assert.ok(
            observations.some(
              event =>
                event.name === 'compaction.completed' &&
                event.attributes.some(
                  attribute =>
                    attribute.key === 'stratos.observation.missing_start' &&
                    attribute.value.boolValue === true,
                ),
            ),
          );
          assert.ok(
            !spans.some(span => span.name === 'compaction'),
            'No invented compaction duration',
          );
        } else {
          assert.ok(
            spans.some(span => span.name === operation),
            `Exported real ${operation} span`,
          );
        }
        const spanIds = new Set(spans.map(span => span.spanId));
        assert.ok(
          spans.every(
            span => !span.parentSpanId || spanIds.has(span.parentSpanId),
          ),
        );
        assert.equal(new Set(spans.map(span => span.traceId)).size, 1);
        assert.deepEqual(diagnostics, []);
        t.diagnostic(
          JSON.stringify({
            harness: configuration.harness,
            scenario,
            realInference: true,
            eventTypes: [...new Set(events.map(event => event.type))],
            events: events.length,
            spans: spans.length,
          }),
        );
      },
    );
  }
}
