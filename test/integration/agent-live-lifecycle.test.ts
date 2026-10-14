import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';

import {query, type SDKMessage} from '@anthropic-ai/claude-agent-sdk';
import {z} from 'zod';

import {createAgentWithAdapters} from '../../src/agents/agent.js';
import {ClaudeAdapter} from '../../src/agents/claude/adapter.js';
import type {AgentHooks, ToolCallEvent} from '../../src/agents/hooks.js';
import {
  createNativeAdapter,
  preflightNativeHarness,
} from '../../src/agents/native.js';
import {createAgent, workflow, type Agent} from '../../src/index.js';
import {resolveNativeModel} from '../../src/models/catalog.js';
import {executeWorkflow} from '../../src/workflows/runtime.js';
import {isolateArtifacts} from '../helpers/artifacts.js';

const harnesses = [
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
type Configuration = (typeof harnesses)[number];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return {promise, resolve};
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}
async function contents(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
async function until<T>(
  check: () => Promise<T | undefined>,
  signal: AbortSignal,
): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    await delay(25, undefined, {signal});
  }
}
async function bounded<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
function options(configuration: Configuration) {
  return {
    skip:
      process.env.STRATOS_TEST_LIFECYCLE_HARNESS !== configuration.harness &&
      `Opt in with STRATOS_TEST_LIFECYCLE_HARNESS=${configuration.harness}; real inference and native credentials required`,
    timeout: 180000,
  };
}

async function fixture(t: TestContext, configuration: Configuration) {
  const root = await mkdtemp(join(tmpdir(), 'stratos-live-lifecycle-'));
  const drainArtifacts = await isolateArtifacts(t, join(root, 'artifacts'));
  const work = join(root, 'work');
  const runtime = join(root, 'runtime');
  const previousTmpdir = process.env.TMPDIR;
  const previousPath = process.env.PATH;
  const previousClaudeTmpdir = process.env.CLAUDE_CODE_TMPDIR;
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
    originalError(...args);
  };
  const agents: Agent[] = [];
  const pidFiles: string[] = [];
  const releases: Array<() => void> = [];
  let claudeProject: string | undefined;
  process.env.TMPDIR = runtime;
  if (configuration.harness === 'claude-code') {
    process.env.CLAUDE_CODE_TMPDIR = runtime;
  }
  const binary = process.env.STRATOS_TEST_OPENCODE_BINARY;
  if (configuration.harness === 'opencode' && binary) {
    process.env.PATH = `${dirname(binary)}:${previousPath ?? ''}`;
  }
  t.signal.addEventListener(
    'abort',
    () => {
      for (const release of releases) {
        release();
      }
      for (const agent of agents) {
        agent.cancel();
      }
    },
    {once: true},
  );
  t.after(async () => {
    for (const release of releases) {
      release();
    }
    for (const agent of agents) {
      agent.cancel();
    }
    try {
      const cleanup = await Promise.allSettled(
        pidFiles.map(async file => {
          const value = await contents(file);
          if (value === undefined) {
            return;
          }
          const pid = Number(value);
          assert.ok(Number.isSafeInteger(pid) && pid > 0);
          if (alive(pid)) {
            process.kill(pid, 'SIGKILL');
            await until(
              async () => (alive(pid) ? undefined : true),
              AbortSignal.timeout(5000),
            );
          }
        }),
      );
      const errors = cleanup.flatMap(result =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, 'Live fixture process cleanup failed');
      }
    } finally {
      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpdir;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (previousClaudeTmpdir === undefined) {
        delete process.env.CLAUDE_CODE_TMPDIR;
      } else {
        process.env.CLAUDE_CODE_TMPDIR = previousClaudeTmpdir;
      }
      console.error = originalError;
      try {
        await drainArtifacts();
        if (claudeProject) {
          await rm(claudeProject, {recursive: true, force: true});
        }
      } finally {
        await rm(root, {recursive: true, force: true});
      }
    }
  });
  await Promise.all([mkdir(work), mkdir(runtime, {mode: 0o700})]);
  if (configuration.harness === 'claude-code') {
    claudeProject = join(
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
      'projects',
      (await realpath(work)).replace(/[^a-zA-Z0-9]/g, '-'),
    );
  }
  const signal = (ms = 45000) =>
    AbortSignal.any([t.signal, AbortSignal.timeout(ms)]);
  return {
    work,
    signal,
    gate() {
      const gate = deferred<void>();
      releases.push(() => gate.resolve());
      return gate;
    },
    agent(
      hooks: AgentHooks = {},
      factory?: NonNullable<ConstructorParameters<typeof ClaudeAdapter>[1]>,
    ) {
      const settings = {
        ...configuration,
        model: [configuration.model],
        effort: 'low',
        systemPrompt:
          'Follow the user exactly. Do not inspect files or use tools unless explicitly requested.',
        hooks,
      };
      const agent = factory
        ? createAgentWithAdapters(settings, {
            preflight: preflightNativeHarness,
            createAdapter: settings =>
              settings.harness === 'claude-code'
                ? new ClaudeAdapter(
                    {
                      ...settings.options,
                      provider: settings.provider,
                      model: resolveNativeModel(
                        settings.canonicalModel,
                        settings.provider,
                      ),
                    },
                    factory,
                  )
                : createNativeAdapter(settings),
          })
        : createAgent(settings);
      agents.push(agent);
      return agent;
    },
    async run(run: () => Promise<void>) {
      await executeWorkflow(
        workflow({
          input: z.strictObject({}),
          output: z.object({
            completed: z.boolean().describe('Whether the scenario completed'),
          }),
          async run() {
            await run();
            return {completed: true};
          },
        }),
        {},
        'live-lifecycle',
        work,
      );
    },
    async clean() {
      for (const agent of agents) {
        await assert.rejects(
          agent.execute('Closed workflows must not execute'),
          /closed/,
        );
      }
      assert.deepEqual(
        (await readdir(runtime)).filter(name =>
          /^stratos-(codex|opencode)/.test(name),
        ),
        [],
      );
      assert.deepEqual(
        errors,
        [],
        'Native execution and cleanup diagnostics must not silently pass acceptance',
      );
    },
    async task(name: string) {
      const pidFile = join(work, `${name}.pid`);
      const heartbeat = join(work, `${name}.heartbeat`);
      const release = join(work, `${name}.release`);
      const file = join(work, `${name}.cjs`);
      pidFiles.push(pidFile);
      await writeFile(
        file,
        `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')}, String(process.pid));
fs.renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)});
setInterval(() => {
  fs.appendFileSync(${JSON.stringify(heartbeat)}, '.');
  if (fs.existsSync(${JSON.stringify(release)})) { console.log('RELEASED'); process.exit(0); }
}, 100);
setTimeout(() => { console.error('Fixture safety deadline'); process.exit(2); }, 150000);
`,
        {mode: 0o600},
      );
      return {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`,
        async pid() {
          const value = await contents(pidFile);
          return value === undefined ? undefined : Number(value);
        },
        async heartbeat() {
          return (await contents(heartbeat))?.length ?? 0;
        },
        release: () => writeFile(release, ''),
        async ready(running: Promise<unknown>, background = false) {
          const waiting = new AbortController();
          try {
            return await Promise.race([
              until(
                async () => {
                  const value = await contents(pidFile);
                  if (
                    value === undefined ||
                    !(await contents(heartbeat))?.length
                  ) {
                    return undefined;
                  }
                  const pid = Number(value);
                  assert.ok(Number.isSafeInteger(pid) && pid > 0 && alive(pid));
                  return pid;
                },
                AbortSignal.any([waiting.signal, signal()]),
              ),
              running.then(() => {
                if (!background) {
                  throw new Error(
                    'Turn finished before the controlled task started',
                  );
                }
                return new Promise<never>(() => {});
              }),
            ]);
          } finally {
            waiting.abort();
          }
        },
      };
    },
  };
}
type Task = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['task']>>;

function tools(
  tasks: Task[],
  subagents = 0,
  before?: (task: Task) => Promise<void>,
) {
  const calls = new Map<Task, number>();
  let launches = 0;
  return {
    calls,
    get launches() {
      return launches;
    },
    async beforeToolCall(event: ToolCallEvent) {
      const input = event.input;
      if (input && typeof input === 'object') {
        if (
          ['Agent', 'Task', 'task'].includes(event.toolName) &&
          'prompt' in input &&
          typeof input.prompt === 'string' &&
          tasks.some(
            task =>
              input.prompt &&
              typeof input.prompt === 'string' &&
              input.prompt.includes(task.command),
          ) &&
          launches < subagents
        ) {
          launches++;
          return;
        }
        if (['Bash', 'bash'].includes(event.toolName) && 'command' in input) {
          const task = tasks.find(task => task.command === input.command);
          if (task) {
            calls.set(task, (calls.get(task) ?? 0) + 1);
            if (calls.get(task) === 1) {
              await before?.(task);
              return;
            }
          }
        }
      }
      return {
        action: 'deny' as const,
        reason:
          'Only the exact requested fixture commands, once each, and requested workers are allowed. Do not retry.',
      };
    },
  };
}
async function remember(agent: Agent) {
  const marker = `LIFECYCLE_${randomUUID()}`;
  await agent.execute(`Remember ${marker}. Reply OK without tools.`);
  return marker;
}
async function recall(agent: Agent, marker: string) {
  assert.equal(
    (
      await agent.execute(
        'Reply only with the marker from my first request. Do not use tools.',
      )
    ).trim(),
    marker,
  );
}
function prompt(
  task: Task,
  mode: 'foreground' | 'background' | 'subagent',
  configuration: Configuration,
) {
  if (mode === 'subagent') {
    const background = configuration.harness === 'claude-code';
    return `Launch exactly one general-purpose subagent using ${background ? 'Agent with run_in_background=true' : 'task'}. Tell it to run exactly this command once in foreground Bash with a 120000 ms tool timeout: ${task.command}. Do not run it yourself. ${background ? 'Return after launching without waiting.' : 'Wait for the worker.'}`;
  }
  return `Run exactly this command once with Bash ${mode === 'background' ? 'with run_in_background=true, then return without waiting' : 'in foreground'} with a 120000 ms tool timeout: ${task.command}. No changes or other tools.`;
}

for (const configuration of harnesses) {
  const scenarios =
    configuration.harness === 'claude-code'
      ? (['foreground', 'background', 'subagent'] as const)
      : configuration.harness === 'opencode'
        ? (['foreground', 'subagent'] as const)
        : (['foreground'] as const);
  for (const scenario of scenarios) {
    void test(
      `live ${configuration.harness}: cancel ${scenario} and preserve active independent work`,
      options(configuration),
      async t => {
        const f = await fixture(t, configuration);
        const task = await f.task('owned');
        const otherTask = await f.task('independent');
        const control = tools([task], scenario === 'subagent' ? 1 : 0);
        const otherControl = tools([otherTask]);
        const started = performance.now();
        await f.run(async () => {
          const independent = f.agent(otherControl);
          const otherMarker = await remember(independent);
          const otherRunning = independent.execute(
            prompt(otherTask, 'foreground', configuration),
          );
          let otherSettled = false;
          void otherRunning.then(
            () => {
              otherSettled = true;
            },
            () => {
              otherSettled = true;
            },
          );
          const otherPid = await otherTask.ready(otherRunning);
          try {
            await f.run(async () => {
              const agent = f.agent(control);
              const marker = await remember(agent);
              const background =
                configuration.harness === 'claude-code' &&
                scenario !== 'foreground';
              const running = agent.execute(
                prompt(task, scenario, configuration),
              );
              const pid = await task.ready(running, background);
              if (background) {
                await bounded(running, f.signal());
              }
              assert.ok(alive(pid));
              const rejected = background
                ? undefined
                : assert.rejects(running, /cancel/i);
              const cancelledAt = performance.now();
              assert.equal(agent.cancel(), undefined);
              agent.cancel();
              await bounded(Promise.resolve(rejected), f.signal(10000));
              // Submit immediately, before native task-exit polling.
              const continuation = recall(agent, marker);
              await bounded(continuation, f.signal());
              if (configuration.harness !== 'codex') {
                await until(
                  async () => (alive(pid) ? undefined : true),
                  f.signal(10000),
                );
              }
              assert.equal(control.calls.get(task), 1);
              assert.equal(control.launches, scenario === 'subagent' ? 1 : 0);
              t.diagnostic(
                JSON.stringify({
                  harness: configuration.harness,
                  scenario,
                  cancellationAndContinuationMs:
                    performance.now() - cancelledAt,
                  nativeTaskSurvived: alive(pid),
                  sameConversationMarkerRecall: true,
                }),
              );
            });
            assert.ok(
              alive(otherPid),
              'Other agent task must survive cancellation and workflow closure',
            );
            const heartbeat = await otherTask.heartbeat();
            await until(
              async () =>
                (await otherTask.heartbeat()) > heartbeat ? true : undefined,
              f.signal(5000),
            );
            assert.equal(
              otherSettled,
              false,
              'Other native execution must remain pending',
            );
            await otherTask.release();
            await bounded(otherRunning, f.signal());
            await recall(independent, otherMarker);
            assert.equal(otherControl.calls.get(otherTask), 1);
          } finally {
            independent.cancel();
            await otherRunning.catch(() => {});
          }
        });
        await f.clean();
        t.diagnostic(
          JSON.stringify({
            harness: configuration.harness,
            scenario,
            realInference: true,
            activeIndependentConversationSurvived: true,
            completeScenarioMs: performance.now() - started,
          }),
        );
      },
    );
  }

  void test(
    `live ${configuration.harness}: cancel while native before-tool callback is pending`,
    options(configuration),
    async t => {
      const f = await fixture(t, configuration);
      const task = await f.task('blocked-launch');
      const entered = f.gate();
      const release = f.gate();
      const control = tools([task], 0, async () => {
        entered.resolve();
        await release.promise;
      });
      await f.run(async () => {
        const agent = f.agent(control);
        const marker = await remember(agent);
        const running = agent.execute(
          prompt(task, 'foreground', configuration),
        );
        const rejected = assert.rejects(running, /cancel/i);
        try {
          await bounded(entered.promise, f.signal());
          agent.cancel();
          agent.cancel();
        } finally {
          release.resolve();
        }
        await bounded(rejected, f.signal(15000));
        await recall(agent, marker);
        assert.equal(
          await task.pid(),
          undefined,
          'A pending native tool must not start after cancellation',
        );
        assert.equal(control.calls.get(task), 1);
      });
      await f.clean();
      t.diagnostic(
        JSON.stringify({
          harness: configuration.harness,
          scenario: 'cancel-before-tool-release',
          realInference: true,
        }),
      );
    },
  );

  void test(
    `live ${configuration.harness}: owner success and failure cancel unawaited native work`,
    options(configuration),
    async t => {
      const f = await fixture(t, configuration);
      for (const outcome of ['return', 'throw']) {
        const task = await f.task(`owner-${outcome}`);
        const control = tools([task]);
        let active: Promise<{error?: unknown; value?: string}> | undefined;
        let pid: number | undefined;
        const failure = new Error('Intentional owner failure');
        const owner = f.run(async () => {
          const agent = f.agent(control);
          const running = agent.execute(
            prompt(task, 'foreground', configuration),
          );
          active = running.then(
            value => ({value}),
            error => ({error}),
          );
          pid = await task.ready(running);
          if (outcome === 'throw') {
            throw failure;
          }
        });
        if (outcome === 'throw') {
          await assert.rejects(owner, error => error === failure);
        } else {
          await owner;
        }
        assert.ok(active && pid);
        assert.match(String((await active).error), /cancel|closed/i);
        if (configuration.harness !== 'codex') {
          await until(
            async () => (alive(pid!) ? undefined : true),
            f.signal(10000),
          );
        }
        assert.equal(control.calls.get(task), 1);
        t.diagnostic(
          JSON.stringify({
            harness: configuration.harness,
            scenario: `owner-${outcome}`,
            realInference: true,
            nativeTaskSurvived: alive(pid),
          }),
        );
      }
      await f.clean();
    },
  );

  void test(
    `live ${configuration.harness}: cancel while native after-tool callback is pending`,
    options(configuration),
    async t => {
      const f = await fixture(t, configuration);
      const task = await f.task('completed-tool');
      const entered = f.gate();
      const release = f.gate();
      const control = tools([task]);
      await f.run(async () => {
        const agent = f.agent({
          ...control,
          async afterToolCall() {
            entered.resolve();
            await release.promise;
          },
        });
        const marker = await remember(agent);
        const running = agent.execute(
          prompt(task, 'foreground', configuration),
        );
        const outcome = running.then(
          value => ({value, error: undefined}),
          error => ({value: undefined, error}),
        );
        try {
          await task.ready(running);
          await task.release();
          await bounded(entered.promise, f.signal());
          agent.cancel();
          agent.cancel();
        } finally {
          release.resolve();
        }
        assert.match(
          String((await bounded(outcome, f.signal(15000))).error),
          /cancel/i,
        );
        await recall(agent, marker);
        assert.equal(control.calls.get(task), 1);
      });
      await f.clean();
      t.diagnostic(
        JSON.stringify({
          harness: configuration.harness,
          scenario: 'cancel-after-tool-release',
          realInference: true,
        }),
      );
    },
  );
}

for (const background of ['background', 'subagent'] as const) {
  const configuration = harnesses[1];
  void test(
    `live claude-code: cancel foreground plus earlier ${background} work`,
    options(configuration),
    async t => {
      const f = await fixture(t, configuration);
      const earlier = await f.task('earlier');
      const foreground = await f.task('foreground');
      const control = tools(
        [earlier, foreground],
        background === 'subagent' ? 1 : 0,
      );
      await f.run(async () => {
        const agent = f.agent(control);
        const marker = await remember(agent);
        const launched = agent.execute(
          prompt(earlier, background, configuration),
        );
        const earlierPid = await earlier.ready(launched, true);
        await bounded(launched, f.signal());
        const running = agent.execute(
          prompt(foreground, 'foreground', configuration),
        );
        const foregroundPid = await foreground.ready(running);
        assert.ok(
          alive(earlierPid),
          'Earlier-prompt work must overlap the active foreground turn',
        );
        const rejected = assert.rejects(running, /cancel/i);
        agent.cancel();
        agent.cancel();
        await bounded(rejected, f.signal(15000));
        await recall(agent, marker);
        await until(
          async () =>
            !alive(earlierPid) && !alive(foregroundPid) ? true : undefined,
          f.signal(10000),
        );
        assert.equal(control.calls.get(earlier), 1);
        assert.equal(control.calls.get(foreground), 1);
      });
      await f.clean();
      t.diagnostic(
        JSON.stringify({
          harness: configuration.harness,
          scenario: `foreground-plus-${background}`,
          realInference: true,
        }),
      );
    },
  );
}

void test(
  'live claude-code: cancel an autonomous parent turn after its background worker completes',
  options(harnesses[1]),
  async t => {
    const f = await fixture(t, harnesses[1]);
    const worker = await f.task('worker');
    const autonomous = await f.task('autonomous');
    const control = tools([worker, autonomous], 1);
    const parents: Array<string | null> = [];
    const nativeStates: string[] = [];
    await f.run(async () => {
      const agent = f.agent(
        {
          ...control,
          async beforeToolCall(event) {
            const decision = await control.beforeToolCall(event);
            if (
              ['Agent', 'Task'].includes(event.toolName) &&
              decision?.action !== 'deny' &&
              event.input &&
              typeof event.input === 'object'
            ) {
              return {
                action: 'modify',
                arguments: {
                  ...event.input,
                  prompt: `Run exactly this command once in foreground Bash with timeout 120000: ${worker.command}. Then reply WORKER_DONE. No other tools.`,
                },
              };
            }
            return decision;
          },
        },
        input => {
          const native = query(input);
          return {
            close: () => native.close(),
            interrupt: () => native.interrupt(),
            stopTask: id => native.stopTask(id),
            setMcpServers: servers => native.setMcpServers(servers),
            async *[Symbol.asyncIterator]() {
              for await (const event of native) {
                if (
                  event.type === 'system' &&
                  event.subtype === 'session_state_changed'
                ) {
                  nativeStates.push(event.state);
                }
                if (event.type === 'assistant') {
                  for (const block of event.message.content) {
                    if (
                      block.type === 'tool_use' &&
                      z
                        .object({command: z.literal(autonomous.command)})
                        .safeParse(block.input).success
                    ) {
                      parents.push(event.parent_tool_use_id);
                    }
                  }
                }
                yield event;
              }
            },
          };
        },
      );
      const marker = await remember(agent);
      const launch = agent.execute(
        `${prompt(worker, 'subagent', harnesses[1])} Keep this next instruction for YOUR main thread, do NOT delegate it: when you receive the worker's completion notification, YOU must run this exact command once in foreground Bash with a 120000 ms tool timeout: ${autonomous.command}. Do not run it before the worker completes.`,
      );
      const workerPid = await worker.ready(launch, true);
      await bounded(launch, f.signal());
      assert.ok(alive(workerPid));
      await worker.release();
      const autonomousPid = await autonomous.ready(
        new Promise<never>(() => {}),
      );
      assert.deepEqual(
        parents,
        [null],
        'The controlled follow-up must run in the native main thread, not a subagent',
      );
      // No user execute is pending: this is native notification-triggered work.
      agent.cancel();
      agent.cancel();
      await until(
        async () => (alive(autonomousPid) ? undefined : true),
        f.signal(10000),
      );
      await recall(agent, marker);
      assert.equal(control.calls.get(worker), 1);
      assert.equal(control.calls.get(autonomous), 1);
    });
    await f.clean();
    t.diagnostic(
      JSON.stringify({
        harness: 'claude-code',
        scenario: 'cancel-active-autonomous-parent',
        realInference: true,
        nativeStates,
      }),
    );
  },
);

void test(
  'live claude-code: cancel background subagent while its tool callback is pending',
  options(harnesses[1]),
  async t => {
    const f = await fixture(t, harnesses[1]);
    const task = await f.task('late-subagent-tool');
    const entered = f.gate();
    const release = f.gate();
    const control = tools([task], 1, async () => {
      entered.resolve();
      await release.promise;
    });
    await f.run(async () => {
      const agent = f.agent(control);
      const marker = await remember(agent);
      const launch = agent.execute(prompt(task, 'subagent', harnesses[1]));
      try {
        await bounded(Promise.all([launch, entered.promise]), f.signal());
        agent.cancel();
        agent.cancel();
      } finally {
        release.resolve();
      }
      await recall(agent, marker);
      assert.equal(
        await task.pid(),
        undefined,
        'The background worker must not start a late tool after cancellation',
      );
      assert.equal(control.calls.get(task), 1);
      assert.equal(control.launches, 1);
    });
    await f.clean();
    t.diagnostic(
      JSON.stringify({
        harness: 'claude-code',
        scenario: 'cancel-pending-background-tool',
        realInference: true,
      }),
    );
  },
);

void test(
  'live claude-code: stop a real task discovered while cancellation is in flight',
  options(harnesses[1]),
  async t => {
    const f = await fixture(t, harnesses[1]);
    const first = await f.task('first-background');
    const late = await f.task('late-background');
    const control = tools([first, late]);
    const snapshots: SDKMessage[] = [];
    const stopped: string[] = [];
    const delivered = f.gate();
    let cancelling = false;
    let deliveredLate = false;
    await f.run(async () => {
      const agent = f.agent(control, input => {
        const native = query(input);
        return {
          close: () => native.close(),
          interrupt: () => native.interrupt(),
          setMcpServers: servers => native.setMcpServers(servers),
          async stopTask(id) {
            stopped.push(id);
            cancelling = true;
            await native.stopTask(id);
            await bounded(delivered.promise, f.signal(5000));
          },
          async *[Symbol.asyncIterator]() {
            for await (const event of native) {
              if (cancelling && snapshots.length) {
                // Delay delivery, not native task execution or event contents.
                for (const snapshot of snapshots.splice(0)) {
                  yield snapshot;
                }
                deliveredLate = true;
                delivered.resolve();
              }
              if (
                !cancelling &&
                event.type === 'system' &&
                event.subtype === 'background_tasks_changed' &&
                event.tasks.length > 1
              ) {
                snapshots.push(event);
              } else {
                yield event;
              }
            }
          },
        };
      });
      const marker = await remember(agent);
      const launchedFirst = agent.execute(
        prompt(first, 'background', harnesses[1]),
      );
      const firstPid = await first.ready(launchedFirst, true);
      await bounded(launchedFirst, f.signal());
      const launchedLate = agent.execute(
        prompt(late, 'background', harnesses[1]),
      );
      const latePid = await late.ready(launchedLate, true);
      await bounded(launchedLate, f.signal());
      assert.ok(
        snapshots.length,
        'The real second-task snapshot must be withheld before cancellation',
      );
      assert.ok(alive(firstPid) && alive(latePid));
      agent.cancel();
      agent.cancel();
      await recall(agent, marker);
      await until(
        async () => (!alive(firstPid) && !alive(latePid) ? true : undefined),
        f.signal(10000),
      );
      assert.equal(deliveredLate, true);
      assert.equal(
        new Set(stopped).size,
        2,
        'Both actual native task IDs must receive stopTask',
      );
      assert.equal(control.calls.get(first), 1);
      assert.equal(control.calls.get(late), 1);
    });
    await f.clean();
    t.diagnostic(
      JSON.stringify({
        harness: 'claude-code',
        scenario: 'late-native-snapshot',
        realInference: true,
        controlledEventDelivery: true,
        stoppedNativeTasks: stopped.length,
      }),
    );
  },
);

void test(
  'live claude-code: owner closure stops earlier background shell and subagent work',
  options(harnesses[1]),
  async t => {
    const f = await fixture(t, harnesses[1]);
    for (const mode of ['background', 'subagent'] as const) {
      const task = await f.task(`owner-${mode}`);
      const control = tools([task], mode === 'subagent' ? 1 : 0);
      let pid: number | undefined;
      await f.run(async () => {
        const agent = f.agent(control);
        const running = agent.execute(prompt(task, mode, harnesses[1]));
        pid = await task.ready(running, true);
        await bounded(running, f.signal());
        assert.ok(alive(pid));
        // Return without calling cancel: the workflow owns background-only cleanup.
      });
      assert.ok(pid);
      await until(
        async () => (alive(pid!) ? undefined : true),
        f.signal(10000),
      );
      assert.equal(control.calls.get(task), 1);
    }
    await f.clean();
    t.diagnostic(
      JSON.stringify({
        harness: 'claude-code',
        scenario: 'owner-background-closure',
        realInference: true,
      }),
    );
  },
);
