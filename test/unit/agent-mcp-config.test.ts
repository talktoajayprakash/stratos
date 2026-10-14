import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {
  mcpConfiguration,
  prepareAgentMcps,
} from '../../src/agents/mcp-config.js';

void test('MCP selections resolve env/file credentials and translate native transports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stratos-mcp-config-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  process.env.STRATOS_MCP_TEST_TOKEN = 'test-token';
  t.after(() => {
    delete process.env.STRATOS_MCP_TEST_TOKEN;
  });
  await writeFile(join(root, 'secret'), 'local-token\n', {mode: 0o600});
  const config = {
    servers: {
      remote: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: {Authorization: 'Bearer {env:STRATOS_MCP_TEST_TOKEN}'},
      },
      local: {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: {KEY: '{file:secret}'},
      },
      unused: {
        type: 'http',
        url: 'https://example.com/unused',
        headers: {Authorization: '{env:STRATOS_MISSING_TOKEN}'},
      },
    },
  };
  const result = await prepareAgentMcps(config, ['remote', 'local'], root);
  assert.equal(
    (result.claude.remote as {headers: Record<string, string>}).headers
      .Authorization,
    'Bearer test-token',
  );
  assert.equal(
    (result.codex.remote as {http_headers: Record<string, string>}).http_headers
      .Authorization,
    'Bearer test-token',
  );
  assert.deepEqual((result.opencode.local as {command: string[]}).command, [
    'node',
    'server.js',
  ]);
  assert.equal(
    (result.opencode.local as {environment: Record<string, string>}).environment
      .KEY,
    'local-token',
  );
  assert.equal(Object.hasOwn(result.claude, 'unused'), false);
  assert.equal(
    Object.keys((await prepareAgentMcps(config, [], root)).codex).length,
    0,
  );
  await assert.rejects(
    prepareAgentMcps(config, ['missing'], root),
    /Unknown MCP/,
  );
  await assert.rejects(
    prepareAgentMcps(config, ['unused'], root),
    /Missing MCP environment/,
  );
  await chmod(join(root, 'secret'), 0o644);
  await assert.rejects(
    prepareAgentMcps(config, ['local'], root),
    /owner-only permissions/,
  );
});

void test('MCP auth and malformed headers fail before starting native harnesses', async () => {
  assert.ok(
    mcpConfiguration.parse({
      servers: {
        x: {type: 'http', url: 'https://example.com', auth: {type: 'oauth'}},
      },
    }),
  );
  await assert.rejects(
    prepareAgentMcps(
      {
        servers: {
          x: {
            type: 'http',
            url: 'https://example.com',
            headers: {Authorization: 'secret\r\nInjected: true'},
          },
        },
      },
      ['x'],
      '.',
    ),
    error => {
      assert.match(String(error), /Invalid MCP header/);
      assert.doesNotMatch(String(error), /secret|Injected/);
      return true;
    },
  );
  await assert.rejects(
    prepareAgentMcps(
      {servers: {x: {type: 'stdio', command: 'node', auth: {type: 'oauth'}}}},
      ['x'],
      '.',
    ),
  );
});
