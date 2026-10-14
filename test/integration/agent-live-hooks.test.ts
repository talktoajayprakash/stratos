import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import type {AgentAdapter} from '../../src/agents/adapter.js';
import {ClaudeAdapter} from '../../src/agents/claude/adapter.js';
import {CodexAdapter} from '../../src/agents/codex/adapter.js';
import {codexProvider} from '../../src/agents/codex/provider.js';
import type {AgentEventConsumer} from '../../src/agents/events.js';
import type {AgentHooks} from '../../src/agents/hooks.js';
import {OpenCodeAdapter} from '../../src/agents/opencode/adapter.js';
import {AgentSession} from '../../src/agents/session.js';

type Harness = 'claude' | 'codex' | 'opencode';
type Mode = 'allow' | 'deny' | 'modify' | 'throw' | 'block' | 'afterThrow';
const modes: readonly Mode[] = [
  'allow',
  'deny',
  'modify',
  'throw',
  'block',
  'afterThrow',
];
type Common = {
  hooks: AgentHooks;
  onEvent: AgentEventConsumer;
  diagnostic(error: unknown): void;
};
type Prepared = {
  nativePatch?: boolean;
  createAdapter(common: Common): AgentAdapter<unknown>;
  verify?(): Promise<unknown>;
};

async function prepare(harness: Harness, cwd: string): Promise<Prepared> {
  if (harness === 'claude') {
    const provider = process.env.STRATOS_TEST_PROVIDER ?? 'anthropic';
    if (provider !== 'anthropic' && provider !== 'openrouter') {
      throw new Error('Use STRATOS_TEST_PROVIDER=anthropic or openrouter');
    }
    const openrouter = provider === 'openrouter';
    const key = (
      openrouter
        ? process.env.OPENROUTER_API_KEY
        : process.env.STRATOS_TEST_ANTHROPIC_KEY_FILE
          ? await readFile(process.env.STRATOS_TEST_ANTHROPIC_KEY_FILE, 'utf8')
          : process.env.ANTHROPIC_API_KEY
    )?.trim();
    if (!key) {
      throw new Error(
        openrouter
          ? 'Set OPENROUTER_API_KEY for the live check'
          : 'Set ANTHROPIC_API_KEY or STRATOS_TEST_ANTHROPIC_KEY_FILE for the live check',
      );
    }
    return {
      createAdapter: common =>
        new ClaudeAdapter({
          ...common,
          cwd,
          model:
            process.env.STRATOS_TEST_MODEL ??
            (openrouter ? 'anthropic/claude-sonnet-4.6' : 'haiku'),
          pathToClaudeCodeExecutable: process.env.STRATOS_TEST_CLAUDE_BINARY,
          env: {
            ...process.env,
            ...(openrouter
              ? {
                  ANTHROPIC_API_KEY: '',
                  ANTHROPIC_AUTH_TOKEN: key,
                  ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
                }
              : {ANTHROPIC_API_KEY: key}),
          },
        }),
    };
  }
  if (harness === 'codex') {
    await codexProvider({provider: 'azure'});
    const ambientMarker = join(cwd, 'ambient-loaded.txt');
    await mkdir(join(cwd, '.codex'));
    const untrustedScript = `require('node:fs').writeFileSync(${JSON.stringify(ambientMarker)},'loaded')`;
    await writeFile(
      join(cwd, '.codex/config.toml'),
      `[mcp_servers.ambient]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-e", ${JSON.stringify(untrustedScript)}]\n`,
    );
    await writeFile(
      join(cwd, '.codex/hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `${process.execPath} -e '${untrustedScript.replaceAll("'", "'\\''")}'`,
                },
              ],
            },
          ],
        },
      }),
    );
    return {
      createAdapter: common =>
        new CodexAdapter({
          ...common,
          workingDirectory: cwd,
          provider: 'azure',
          model: process.env.STRATOS_TEST_MODEL ?? 'gpt-5.4',
          effort: 'low',
        }),
      verify: () => assert.rejects(readFile(ambientMarker), {code: 'ENOENT'}),
    };
  }
  const model = process.env.STRATOS_TEST_MODEL ?? 'anthropic/claude-sonnet-4.6';
  const provider = process.env.STRATOS_TEST_PROVIDER ?? 'openrouter';
  const nativePatch = /^(?:openai\/)?(?:gpt-|o[134](?:-|$))/.test(model);
  if (provider !== 'azure' && provider !== 'openrouter') {
    throw new Error('Use STRATOS_TEST_PROVIDER=azure or openrouter');
  }
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (provider === 'openrouter' && !key) {
    throw new Error('Set OPENROUTER_API_KEY for the live check');
  }
  const env =
    provider === 'azure'
      ? Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        )
      : {
          OPENROUTER_API_KEY: key!,
          ...(nativePatch
            ? {
                OPENCODE_CONFIG_CONTENT: JSON.stringify({
                  provider: {
                    openrouter: {
                      models: {
                        [model]: {
                          options: {
                            provider: {only: ['azure'], allow_fallbacks: false},
                          },
                        },
                      },
                    },
                  },
                }),
              }
            : {}),
        };
  return {
    nativePatch,
    createAdapter: common =>
      new OpenCodeAdapter({
        ...common,
        workingDirectory: cwd,
        model: {providerID: provider, modelID: model},
        binary: process.env.STRATOS_TEST_OPENCODE_BINARY,
        env,
      }),
  };
}

for (const harness of ['claude', 'codex', 'opencode'] as const) {
  void test(
    `live ${harness}: tool hooks and conversation continuation`,
    {
      skip:
        process.env.STRATOS_TEST_AGENT_HOOKS !== harness &&
        'Opt in with npm run test:agents:<harness>',
      timeout: 600000,
    },
    async t => {
      const selected = (
        process.env.STRATOS_TEST_MODES ?? modes.join(',')
      ).split(',');
      for (const mode of selected) {
        assert.ok(
          modes.includes(mode as Mode),
          `Unknown verification mode: ${mode}`,
        );
      }
      const cwd = await mkdtemp(join(tmpdir(), `stratos-${harness}-adapter-`));
      t.after(() => rm(cwd, {recursive: true, force: true}));
      const {createAdapter, verify, nativePatch} = await prepare(harness, cwd);
      for (const mode of selected) {
        const output = join(cwd, mode + '.txt');
        const quoted = `'${output.replaceAll("'", "'\\''")}'`;
        const marker = randomUUID();
        if (mode === 'block') {
          await writeFile(output, marker);
        }
        const patch = (content: string) =>
          `*** Begin Patch\n*** Add File: ${output}\n+${content}\n*** End Patch`;
        const targetTool = nativePatch
          ? mode === 'block'
            ? 'read'
            : 'apply_patch'
          : harness === 'opencode'
            ? 'bash'
            : 'Bash';
        let calls = 0;
        const original = new Error('LIVE_STRATOS_HOOK_FAILURE');
        const adapter = createAdapter({
          onEvent(event) {
            if (event.type !== 'message.delta') {
              t.diagnostic(`${mode}: ${event.type}`);
            }
          },
          diagnostic(error) {
            t.diagnostic(
              `${mode}: diagnostic ${error instanceof Error ? error.name : 'unknown'}`,
            );
          },
          hooks: {
            beforeToolCall(event) {
              if (event.toolName !== targetTool) {
                return;
              }
              calls++;
              if (mode === 'throw') {
                throw original;
              }
              if (mode === 'deny') {
                return {action: 'deny', reason: 'TEST_DENIED. Do not retry.'};
              }
              if (mode === 'modify') {
                return {
                  action: 'modify',
                  arguments: nativePatch
                    ? {patchText: patch('MODIFIED')}
                    : {
                        command: `printf MODIFIED > ${quoted}`,
                        ...(harness === 'opencode'
                          ? {description: 'Write the temporary fixture result'}
                          : {}),
                      },
                };
              }
            },
            afterToolCall(event) {
              if (event.toolName !== targetTool) {
                return;
              }
              if (mode === 'afterThrow') {
                throw original;
              }
              if (mode === 'block') {
                return {
                  action: 'block',
                  reason:
                    'STRATOS_OUTPUT_BLOCKED. Do not retry; report this reason.',
                };
              }
            },
          },
        });
        const agent = new AgentSession(adapter);
        const timeout = setTimeout(() => agent.cancel(), 300000);
        const cancel = () => agent.cancel();
        t.signal.addEventListener('abort', cancel, {once: true});
        try {
          const execution = agent.execute(
            nativePatch
              ? mode === 'block'
                ? `Use read exactly once to read ${output}. Do not retry. Report the tool result or blocking feedback verbatim.`
                : `Create ${output} using apply_patch with the patch below. You may check the parent directory first if required. Do not use shell commands to edit files. Do not retry a denied call. Report the result or denial.\n${patch('ORIGINAL')}`
              : mode === 'block'
                ? `Use Bash exactly once to execute: cat ${quoted}. Do not use other tools or retry. Report the tool result or blocking feedback verbatim.`
                : `Use Bash exactly once to execute: printf ORIGINAL > ${quoted}. Do not use other tools or retry. Report the result or denial.`,
          );
          if (mode === 'throw' || mode === 'afterThrow') {
            await assert.rejects(execution, error => error === original);
          } else {
            const response = String(await execution);
            if (mode === 'block') {
              assert.ok(!response.includes(marker));
              assert.match(response, /STRATOS_OUTPUT_BLOCKED/);
            }
          }
          assert.ok(calls > 0);
          await verify?.();
          if (mode === 'allow' || mode === 'modify' || mode === 'afterThrow') {
            assert.equal(
              await readFile(output, 'utf8'),
              (mode === 'modify' ? 'MODIFIED' : 'ORIGINAL') +
                (nativePatch ? '\n' : ''),
            );
          } else if (mode !== 'block') {
            await assert.rejects(readFile(output), {code: 'ENOENT'});
          }
          if (mode === 'allow') {
            await agent.execute(
              'Remember marker STRATOS-CONTINUITY-42. Reply only OK.',
            );
            assert.match(
              String(
                await agent.execute(
                  'What marker did I ask you to remember? No tools.',
                ),
              ),
              /STRATOS-CONTINUITY-42/,
            );
          }
          t.diagnostic(`${mode}: passed (${calls} tool calls)`);
        } finally {
          t.signal.removeEventListener('abort', cancel);
          clearTimeout(timeout);
          await agent.close();
        }
      }
    },
  );
}
