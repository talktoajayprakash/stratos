import assert from 'node:assert/strict';
import '../helpers/home.js';
import test from 'node:test';

import type {SDKMessage} from '@anthropic-ai/claude-agent-sdk';
import {z} from 'zod';

import {createAgentWithAdapters} from '../../src/agents/agent.js';
import type {HarnessReadiness} from '../../src/agents/availability.js';
import {ClaudeAdapter} from '../../src/agents/claude/adapter.js';
import {codexToolConfig} from '../../src/agents/codex/adapter.js';
import {agentSettings} from '../../src/agents/config.js';
import {
  harnessTools,
  type createNativeAdapter,
} from '../../src/agents/native.js';
import {resolveNativeTools} from '../../src/agents/tools.js';
import {workflow} from '../../src/index.js';
import type {HarnessId} from '../../src/models/candidates.js';
import {executeWorkflow} from '../../src/workflows/runtime.js';

type NativeOptions = Parameters<typeof createNativeAdapter>[0];

/** Every Claude Code tool Stratos can remove, in mapping order. */
const claudeTools = Object.values(harnessTools['claude-code']).flat();
const claudeExcept = (...kept: string[]) =>
  claudeTools.filter(tool => !kept.includes(tool));
const resolve = (
  harness: HarnessId,
  allowed?: readonly string[],
  disallowed?: readonly string[],
) => resolveNativeTools(harness, harnessTools[harness], allowed, disallowed);

void test('canonical and harness-specific names resolve to native controls', () => {
  assert.equal(claudeTools.length, 39);
  assert.deepEqual(resolve('claude-code'), []);
  assert.deepEqual(
    resolve('claude-code', ['read', 'grep', 'shell', 'Monitor'], ['shell']),
    claudeExcept('Read', 'Grep', 'Monitor'),
  );
  assert.deepEqual(
    resolve('claude-code', undefined, [
      'subagent',
      'edit',
      'NotebookEdit',
      'view_image',
    ]),
    ['Edit', 'Agent', 'SendMessage', 'ListAgents', 'NotebookEdit'],
  );
  assert.deepEqual(resolve('codex', ['shell', 'edit', 'write', 'goals']), [
    'web_search',
    'features.standalone_web_search',
    'features.multi_agent',
    'features.multi_agent_v2',
    'tools.update_plan.enabled',
    'tools.experimental_request_user_input.enabled',
    'cloud.skills.enabled',
    'features.send_message_to_user_async',
    'features.view_image',
    'features.memories',
    'features.sleep_tool',
    'features.tool_suggest',
    'features.image_generation',
    'features.request_permissions_tool',
    'features.current_time_reminder',
    'features.token_budget',
    'features.deferred_executor',
    'features.code_mode',
    'features.agent_message_board',
  ]);
  assert.deepEqual(resolve('codex', undefined, ['read', 'Monitor']), []);
  assert.deepEqual(resolve('opencode', ['read', 'edit', 'write', 'skill']), [
    'bash',
    'glob',
    'grep',
    'lsp',
    'webfetch',
    'websearch',
    'task',
    'todowrite',
    'plan_exit',
    'question',
    'codesearch',
  ]);
  assert.deepEqual(resolve('opencode', undefined, ['edit', 'write']), ['edit']);
});

void test('always-on tools are implicit and selecting them has no effect', () => {
  assert.deepEqual(
    resolve('codex', ['shell'], undefined),
    resolve('codex', ['shell', 'edit', 'write'], undefined),
  );
  assert.ok(
    !resolve('codex', ['shell'], undefined).includes('features.shell_tool'),
  );
  assert.deepEqual(resolve('codex', undefined, ['edit', 'write']), []);
  assert.deepEqual(
    resolve('codex', ['shell', 'edit'], ['edit']),
    resolve('codex', ['shell'], undefined),
  );
});

void test('a tool whose control also governs a kept tool is a configuration error', () => {
  for (const [harness, allowed, disallowed, blocked] of [
    // OpenCode's edit permission also governs write.
    ['opencode', ['edit'], undefined, 'write'],
    ['opencode', undefined, ['write'], 'write'],
  ] as const) {
    assert.throws(
      () => resolve(harness, allowed, disallowed),
      new RegExp(
        `${harness} harness cannot remove built-in tools: ${blocked}$`,
      ),
    );
  }
});

void test('tool settings accept canonical and harness-specific names only', () => {
  assert.deepEqual(
    agentSettings.parse({
      model: ['openai/gpt-6-sol'],
      allowedTools: [
        'shell',
        'web_fetch',
        'NotebookEdit',
        'goals',
        'codesearch',
      ],
      disallowedTools: [],
    }).allowedTools,
    ['shell', 'web_fetch', 'NotebookEdit', 'goals', 'codesearch'],
  );
  for (const tools of [
    ['Bash'],
    ['bash'],
    ['mcp'],
    ['notebook_edit'],
    ['DesignSync'],
    ['EndConversation'],
    ['features.goals'],
  ]) {
    assert.throws(() =>
      agentSettings.parse({model: ['openai/gpt-6-sol'], allowedTools: tools}),
    );
    assert.throws(() =>
      agentSettings.parse({
        model: ['openai/gpt-6-sol'],
        disallowedTools: tools,
      }),
    );
  }
});

void test('Codex removals become native config without dropping Stratos features', () => {
  assert.deepEqual(codexToolConfig(), {
    features: {hooks: true, apps: false},
  });
  assert.deepEqual(
    codexToolConfig([
      'features.shell_tool',
      'web_search',
      'tools.experimental_request_user_input.enabled',
      'tools.update_plan.enabled',
      'cloud.skills.enabled',
    ]),
    {
      features: {hooks: true, apps: false, shell_tool: false},
      web_search: 'disabled',
      tools: {
        experimental_request_user_input: {enabled: false},
        update_plan: {enabled: false},
      },
      cloud: {skills: {enabled: false}},
    },
  );
});

function ready(harness: HarnessId): HarnessReadiness {
  return {
    available: true,
    catalogs: [
      harness === 'claude-code'
        ? {
            provider: 'anthropic',
            source: 'fixture',
            complete: true,
            modelIds: ['claude-haiku-4-5'],
          }
        : {
            provider: 'openai',
            source: 'fixture',
            complete: true,
            modelIds: ['gpt-6-sol'],
          },
    ],
  };
}

void test('workflow.yaml tool lists reach each native adapter with field precedence', async () => {
  const options: NativeOptions[] = [];
  const adapters = {
    async preflight(harness: HarnessId) {
      return ready(harness);
    },
    createAdapter(settings: NativeOptions) {
      options.push(settings);
      return {
        async initialize() {},
        async execute() {
          return 'OK';
        },
        cancel() {},
        async close() {},
      };
    },
  };
  const definition = workflow({
    input: z.strictObject({}),
    output: z.strictObject({
      errors: z.array(z.string()).describe('Configuration errors'),
    }),
    async run() {
      const errors: string[] = [];
      for (const configId of ['claude', 'codex', 'opencode', 'override']) {
        await createAgentWithAdapters({configId}, adapters).execute('go');
      }
      await createAgentWithAdapters(
        {configId: 'opencode', allowedTools: ['edit']},
        adapters,
      )
        .execute('go')
        .catch((error: Error) => errors.push(error.message));
      return {errors};
    },
  });
  const cwd = process.cwd();
  const result = await executeWorkflow(
    definition,
    {},
    'tools',
    cwd,
    {
      path: cwd,
      root: cwd,
      name: 'tools',
      shortDescription: 'Test fixture',
      longDescription: 'Exercise this test fixture with schema-valid input.',
      version: '1',
      entrypoint: 'workflow.ts',
      agents: {
        claude: {
          harness: 'claude-code',
          model: ['anthropic/claude-haiku-4-5'],
          allowedTools: ['read', 'grep'],
        },
        codex: {
          harness: 'codex',
          model: ['openai/gpt-6-sol'],
          disallowedTools: ['shell', 'web_search', 'read'],
        },
        opencode: {
          harness: 'opencode',
          model: ['openai/gpt-6-sol'],
          disallowedTools: ['todo', 'subagent'],
        },
        override: {
          harness: 'claude-code',
          model: ['anthropic/claude-haiku-4-5'],
          allowedTools: ['shell'],
        },
      },
    },
    {agents: {override: {disallowedTools: ['skill']}}},
  );
  assert.deepEqual(result, {
    errors: ['The opencode harness cannot remove built-in tools: write'],
  });
  const [claude, codex, opencode, override] = options.map(o => o.options);
  // Claude allowedTools only removes tools, so it never turns on a default-off tool.
  assert.deepEqual(
    [
      (claude as {tools?: string[]}).tools,
      (claude as {disallowedTools?: string[]}).disallowedTools,
    ],
    [undefined, claudeExcept('Read', 'Grep')],
  );
  assert.deepEqual((codex as {removedTools?: string[]}).removedTools, [
    'features.shell_tool',
    'web_search',
    'features.standalone_web_search',
  ]);
  assert.deepEqual((opencode as {removedTools?: string[]}).removedTools, [
    'task',
    'todowrite',
  ]);
  assert.deepEqual(
    (override as {disallowedTools?: string[]}).disallowedTools,
    claudeExcept('Bash', 'PowerShell'),
  );
  assert.equal(options.length, 4);
});

void test('Claude adapter passes removed tools to the SDK query', async () => {
  for (const selection of [{}, {disallowedTools: ['Bash', 'Agent']}]) {
    let captured: Record<string, unknown> | undefined;
    const adapter = new ClaudeAdapter(
      {
        cwd: process.cwd(),
        provider: 'anthropic',
        model: 'native-fixture-model',
        ...selection,
        onEvent() {},
        diagnostic() {},
      },
      input => {
        captured = input.options as Record<string, unknown>;
        return {
          async interrupt() {},
          async stopTask() {},
          async setMcpServers() {
            return {added: [], removed: [], errors: {}};
          },
          close() {},
          async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
        };
      },
    );
    await adapter.initialize();
    await adapter.close();
    assert.deepEqual(
      [captured?.tools, captured?.disallowedTools],
      [undefined, (selection as {disallowedTools?: string[]}).disallowedTools],
    );
  }
});
