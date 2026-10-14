import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {ClaudeAdapter} from '../../src/agents/claude/adapter.js';
import {CodexAdapter} from '../../src/agents/codex/adapter.js';
import type {AgentHooks} from '../../src/agents/hooks.js';
import {OpenCodeAdapter} from '../../src/agents/opencode/adapter.js';
import {AgentSession} from '../../src/agents/session.js';

void test(
  'live GitHub MCP get_me through Claude, Codex and OpenCode',
  {
    skip:
      process.env.STRATOS_TEST_AGENT_MCP !== '1' &&
      'Opt in with npm run test:agents:mcp',
    timeout: 420000,
  },
  async t => {
    const providerKey = process.env.OPENROUTER_API_KEY?.trim();
    assert.ok(providerKey, 'Set OPENROUTER_API_KEY for the live check');
    const github =
      process.env.GITHUB_TOKEN?.trim() ||
      execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    assert.ok(github, 'Set GITHUB_TOKEN or authenticate gh for the live check');
    const url = 'https://api.githubcopilot.com/mcp/';
    const cwd = await mkdtemp(join(tmpdir(), 'stratos-agent-mcp-'));
    t.after(() => rm(cwd, {recursive: true, force: true}));
    for (const harness of ['claude', 'codex', 'opencode'] as const) {
      const tools: string[] = [];
      const completed: string[] = [];
      const hooks: AgentHooks = {
        beforeToolCall(event) {
          tools.push(event.toolName);
        },
        afterToolCall(event) {
          if (!/get_me/.test(event.toolName)) {
            return;
          }
          assert.equal(event.error, undefined);
          assert.notEqual(
            (event.output as {isError?: boolean} | undefined)?.isError,
            true,
          );
          const output = JSON.stringify(event.output);
          assert.ok(
            output?.includes('"login"') || output?.includes('\\"login\\"'),
            'GitHub must return account data',
          );
          completed.push(event.toolName);
        },
      };
      const common = {hooks, onEvent() {}, diagnostic() {}};
      const adapter =
        harness === 'claude'
          ? new ClaudeAdapter({
              ...common,
              cwd,
              model: 'anthropic/claude-sonnet-4.6',
              pathToClaudeCodeExecutable:
                process.env.STRATOS_TEST_CLAUDE_BINARY,
              env: {
                ...process.env,
                ANTHROPIC_API_KEY: '',
                ANTHROPIC_AUTH_TOKEN: providerKey,
                ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
              },
              mcpServers: {
                github: {
                  type: 'http',
                  url,
                  headers: {Authorization: `Bearer ${github}`},
                },
              },
            })
          : harness === 'codex'
            ? new CodexAdapter({
                ...common,
                workingDirectory: cwd,
                provider: 'azure',
                model: 'gpt-5.4',
                effort: 'low',
                env: {...process.env, STRATOS_GITHUB_TOKEN: github},
                mcpServers: {
                  github: {url, bearer_token_env_var: 'STRATOS_GITHUB_TOKEN'},
                },
              })
            : new OpenCodeAdapter({
                ...common,
                workingDirectory: cwd,
                model: {
                  providerID: 'openrouter',
                  modelID: 'anthropic/claude-sonnet-4.6',
                },
                binary: process.env.STRATOS_TEST_OPENCODE_BINARY,
                env: {OPENROUTER_API_KEY: providerKey},
                mcpServers: {
                  github: {
                    type: 'remote',
                    url,
                    headers: {Authorization: `Bearer ${github}`},
                    oauth: false,
                  },
                },
              });
      const agent = new AgentSession(adapter);
      const timeout = setTimeout(() => agent.cancel(), 120000);
      const cancel = () => agent.cancel();
      t.signal.addEventListener('abort', cancel, {once: true});
      try {
        await agent.execute(
          'Call the GitHub MCP get_me tool exactly once to verify authentication. Do not use shell or other tools except tool discovery if required. Do not print account details; reply DONE after success.',
        );
        assert.ok(
          tools.some(name => /get_me/.test(name)),
          'Actual GitHub get_me hook must be observed',
        );
        assert.ok(
          completed.length > 0,
          'Successful authenticated tool response must be observed',
        );
        t.diagnostic(`${harness}: authenticated get_me passed`);
      } finally {
        t.signal.removeEventListener('abort', cancel);
        clearTimeout(timeout);
        await agent.close();
      }
    }
  },
);
