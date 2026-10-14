import assert from 'node:assert/strict';
import {
  appendFile,
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

import {createAgentWithAdapters} from '../../src/agents/agent.js';
import {CodexAdapter} from '../../src/agents/codex/adapter.js';
import type {AgentEvent} from '../../src/agents/events.js';
import {workflow} from '../../src/index.js';
import {executeWorkflow, getContext} from '../../src/workflows/runtime.js';
import {isolateArtifacts} from '../helpers/artifacts.js';
import {traceSpans} from '../helpers/otlp.js';

void test('production routing keeps delayed and nested task events with their original invocation through owner cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stratos-activity-'));
  const drain = await isolateArtifacts(t, directory);
  t.after(async () => {
    try {
      await drain();
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
  const traceDirectory = join(directory, 'traces');
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    errors.push(args);
  });
  const nativeEvents: AgentEvent[] = [];
  let artifactPath!: string;
  let childId!: string;
  let parentId!: string;
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
                  harness: 'codex',
                  model: ['openai/gpt-6-astra'],
                },
                {
                  async preflight() {
                    return {
                      available: true,
                      catalogs: [
                        {
                          provider: 'openai',
                          source: 'fixture',
                          modelIds: ['gpt-6-astra'],
                          complete: true,
                        },
                      ],
                    };
                  },
                  createAdapter(settings) {
                    let turn = 0;
                    const emit = (event: AgentEvent) => {
                      nativeEvents.push(event);
                      return settings.options.onEvent(event);
                    };
                    return {
                      async initialize() {},
                      cancel() {},
                      async execute() {
                        if (++turn === 1) {
                          await emit({
                            type: 'tool.started',
                            toolCallId: 'spawn',
                            toolName: 'spawn',
                            input: {},
                            timestamp: Date.now(),
                          });
                          await emit({
                            type: 'background.started',
                            taskId: 'outer',
                            parentToolCallId: 'spawn',
                            timestamp: Date.now(),
                          });
                          await emit({
                            type: 'tool.completed',
                            toolCallId: 'spawn',
                            timestamp: Date.now(),
                          });
                        } else {
                          await emit({
                            type: 'background.activity',
                            taskId: 'outer',
                            progress: 'still working',
                            timestamp: Date.now(),
                          });
                          await emit({
                            type: 'background.started',
                            taskId: 'inner',
                            parentTaskId: 'outer',
                            timestamp: Date.now(),
                          });
                          await emit({
                            type: 'model.started',
                            modelCallId: 'nested',
                            parentTaskId: 'inner',
                            timestamp: Date.now(),
                          });
                          await emit({
                            type: 'model.completed',
                            modelCallId: 'nested',
                            timestamp: Date.now(),
                          });
                          await emit({
                            type: 'background.completed',
                            taskId: 'inner',
                            timestamp: Date.now(),
                            output: 'done',
                          });
                        }
                        return `turn ${turn}`;
                      },
                      async close() {
                        await emit({
                          type: 'background.completed',
                          taskId: 'outer',
                          timestamp: Date.now(),
                          cancelled: true,
                        });
                        await emit({
                          type: 'background.started',
                          taskId: 'missing-end',
                          timestamp: Date.now(),
                        });
                      },
                    };
                  },
                },
              );
              assert.equal(await agent.execute('first'), 'turn 1');
              assert.equal(await agent.execute('second'), 'turn 2');
              return {};
            },
          }),
          {},
          'child',
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
    'parent',
    directory,
    {
      name: 'parent',
      shortDescription: 'Test fixture',
      longDescription: 'Exercise this test fixture with schema-valid input.',
      version: '1',
      entrypoint: 'workflow.ts',
      path: directory,
      root: directory,
      otel: {traces: {exporter: {type: 'file', path: traceDirectory}}},
    },
  );
  const events = (await readFile(join(artifactPath, 'events.jsonl'), 'utf8'))
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
  assert.equal(events.length, nativeEvents.length);
  assert.ok(
    events.every(
      e => e.executionId === childId && e.parentExecutionId === parentId,
    ),
  );
  assert.equal(new Set(events.map(e => e.agentSessionId)).size, 1);
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
  const attr = (span: (typeof spans)[number], key: string) =>
    span.attributes.find(attribute => attribute.key === key)?.value.stringValue;
  const first = spans.find(
    span => attr(span, 'stratos.agent.input') === 'first',
  )!;
  const second = spans.find(
    span => attr(span, 'stratos.agent.input') === 'second',
  )!;
  const spawn = spans.find(span => span.name === 'execute_tool spawn')!;
  const outer = spans.find(span => attr(span, 'stratos.task.id') === 'outer')!;
  const inner = spans.find(span => attr(span, 'stratos.task.id') === 'inner')!;
  const model = spans.find(span => span.name === 'chat model')!;
  assert.equal(spawn.parentSpanId, first.spanId);
  assert.equal(outer.parentSpanId, spawn.spanId);
  assert.equal(inner.parentSpanId, outer.spanId);
  assert.equal(model.parentSpanId, inner.spanId);
  assert.equal(attr(outer, 'stratos.completion.status'), 'cancelled');
  const incomplete = spans.find(
    span => attr(span, 'stratos.task.id') === 'missing-end',
  )!;
  assert.equal(incomplete.parentSpanId, second.spanId);
  assert.equal(attr(incomplete, 'stratos.completion.status'), 'incomplete');
  assert.equal(new Set(spans.map(span => span.traceId)).size, 1);
  assert.deepEqual(errors, []);
});

for (const malformed of [false, true]) {
  void test(`Codex owned transcript collection: ${malformed ? 'malformed observation stays soft' : 'nested ancestry, offsets, partial writes and final close'}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'stratos-codex-activity-'));
    const events: AgentEvent[] = [];
    const errors: unknown[] = [];
    const row = (type: string, payload: Record<string, unknown>) =>
      JSON.stringify({type, payload, timestamp: new Date().toISOString()});
    const meta = (id: string, parent?: string) =>
      row('session_meta', {
        id,
        source: parent
          ? {subagent: {thread_spawn: {parent_thread_id: parent}}}
          : 'cli',
      });
    const root = [
      meta('root'),
      row('event_msg', {type: 'task_started', turn_id: 'root-turn'}),
      row('compacted', {message: 'root compaction'}),
    ];
    const child = [
      meta('child', 'root'),
      ...root,
      row('event_msg', {type: 'task_started', turn_id: 'child-turn'}),
    ];
    const grandchild = [
      meta('grandchild', 'child'),
      ...child,
      row('event_msg', {type: 'task_started', turn_id: 'grandchild-turn'}),
    ];
    const fixtures = {
      'root.jsonl': malformed ? '{invalid}\n' : root.join('\n') + '\n',
      'child.jsonl': child.join('\n') + '\n',
      'grandchild.jsonl': grandchild.join('\n') + '\n' + '{"type":',
      'unrelated.jsonl':
        [
          meta('unrelated', 'unknown'),
          row('event_msg', {type: 'task_started', turn_id: 'unrelated'}),
        ].join('\n') + '\n',
    };
    const binary = join(directory, 'codex-fixture');
    const homeFile = join(directory, 'home');
    await writeFile(
      binary,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.CODEX_HOME;
fs.writeFileSync(${JSON.stringify(homeFile)}, home);
const sessions = path.join(home, 'sessions');
fs.mkdirSync(sessions, {recursive: true});
for (const [name, content] of Object.entries(${JSON.stringify(fixtures)})) {
  const file = path.join(sessions, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
}
process.stdin.resume();
process.stdin.on('end', () => {
  for (const event of [
    {type: 'thread.started', thread_id: 'root'},
    {type: 'turn.started'},
    {type: 'item.completed', item: {type: 'agent_message', id: 'answer', text: 'fixture answer'}},
    {type: 'turn.completed', usage: {input_tokens: 0, cached_input_tokens: 0, output_tokens: 0}},
  ]) console.log(JSON.stringify(event));
});
`,
      {mode: 0o700},
    );
    const adapter = new CodexAdapter({
      model: 'fixture',
      apiKey: 'fixture',
      binary,
      workingDirectory: directory,
      onEvent: event => {
        events.push(event);
      },
      diagnostic: error => {
        errors.push(error);
      },
    });
    t.after(async () => {
      try {
        await adapter.close();
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    });
    await adapter.initialize();
    assert.equal(await adapter.execute('first'), 'fixture answer');
    const home = await readFile(homeFile, 'utf8');
    if (malformed) {
      assert.ok(errors.length > 0);
      assert.ok(
        errors.every(
          error =>
            error instanceof Error &&
            error.message === 'Codex transcript telemetry unavailable',
        ),
      );
      assert.deepEqual(
        events.map(event => event.type),
        ['message.delta'],
      );
    } else {
      assert.deepEqual(
        events
          .filter(event => event.type === 'background.started')
          .map(event => [event.taskId, event.parentTaskId]),
        [
          ['child', undefined],
          ['grandchild', 'child'],
        ],
      );
      assert.equal(
        events.filter(event => event.type === 'compaction.completed').length,
        1,
      );
      assert.ok(!events.some(event => event.type === 'background.completed'));
      await appendFile(
        join(home, 'sessions', 'child.jsonl'),
        row('event_msg', {
          type: 'task_complete',
          turn_id: 'child-turn',
          last_agent_message: 'child done',
        }) + '\n',
      );
      assert.equal(await adapter.execute('second'), 'fixture answer');
      assert.equal(
        events.filter(event => event.type === 'background.started').length,
        2,
      );
      assert.equal(
        events.filter(event => event.type === 'background.completed').length,
        1,
      );
      await writeFile(
        join(home, 'sessions', 'grandchild.jsonl'),
        [
          ...grandchild,
          row('event_msg', {type: 'turn_aborted', turn_id: 'grandchild-turn'}),
        ].join('\n') + '\n',
      );
      await adapter.close();
      assert.ok(
        events.some(
          event =>
            event.type === 'background.completed' &&
            event.taskId === 'grandchild' &&
            event.cancelled,
        ),
      );
      assert.equal(
        events.filter(event => event.type === 'compaction.completed').length,
        1,
      );
      assert.deepEqual(errors, []);
      await assert.rejects(readFile(join(home, 'sessions', 'root.jsonl')), {
        code: 'ENOENT',
      });
    }
  });
}
