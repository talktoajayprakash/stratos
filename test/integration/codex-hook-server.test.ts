import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {CodexHookFailure} from '../../src/agents/codex/hook-failure.js';
import {
  startCodexHookServer,
  codexMcpHookConfiguration,
} from '../../src/agents/codex/hook-server.js';
const args = {
  toolCallId: 'call-1',
  toolName: 'Bash',
  input: {command: 'original'},
};
async function connect(
  server: Awaited<ReturnType<typeof startCodexHookServer>>,
) {
  const client = new Client({name: 'test', version: '1'});
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {headers: {Authorization: `Bearer ${server.bearerToken}`}},
    }),
  );
  return client;
}
function decision(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as Array<{type: string; text: string}>;
  assert.equal(content[0]?.type, 'text');
  return JSON.parse(content[0]!.text);
}
void test('real MCP negotiation, authenticated discovery, closure callbacks and concurrent routing', async () => {
  const guard = new CodexHookFailure();
  const marker = 'captured';
  const seen: string[] = [];
  const server = await startCodexHookServer(
    {
      beforeToolCall: async e => {
        await new Promise(r => setTimeout(r, e.toolCallId === 'slow' ? 20 : 0));
        seen.push(e.toolCallId);
        return {marker, id: e.toolCallId};
      },
      afterToolCall: e => ({output: e.output}),
    },
    guard,
  );
  const client = await connect(server);
  try {
    assert.equal((await fetch(server.url, {method: 'POST'})).status, 401);
    assert.deepEqual(
      (await client.listTools()).tools.map(t => t.name),
      ['before', 'after'],
    );
    const results = await Promise.all(
      ['slow', 'fast'].map(toolCallId =>
        client.callTool({name: 'before', arguments: {...args, toolCallId}}),
      ),
    );
    assert.deepEqual(seen, ['fast', 'slow']);
    assert.deepEqual(
      results.map(r => decision(r)),
      [
        {marker, id: 'slow'},
        {marker, id: 'fast'},
      ],
    );
    assert.equal(
      decision(
        await client.callTool({
          name: 'after',
          arguments: {...args, output: 'done'},
        }),
      ).output,
      'done',
    );
  } finally {
    await client.close();
    await server.close();
    await server.close();
  }
  await assert.rejects(fetch(server.url));
});
void test('callback rejection aborts invocation but returns native denial, preserving original error', async () => {
  const guard = new CodexHookFailure();
  const original = new Error('original', {cause: new Error('cause')});
  const server = await startCodexHookServer(
    {
      beforeToolCall: () => {
        throw original;
      },
    },
    guard,
  );
  const client = await connect(server);
  try {
    await assert.rejects(
      guard.execute(async signal => {
        const result = await client.callTool({name: 'before', arguments: args});
        assert(!result.isError);
        assert.equal(
          decision(result).hookSpecificOutput.permissionDecision,
          'deny',
        );
        assert.equal(signal.aborted, true);
      }),
      e => e === original,
    );
  } finally {
    await client.close();
    await server.close();
  }
});
void test('after rejection, invalid event and unserializable decision fail closed', async () => {
  for (const mode of [
    'after',
    'invalid',
    'serialization',
    'undefinedSerialization',
  ]) {
    const guard = new CodexHookFailure();
    const server = await startCodexHookServer(
      {
        beforeToolCall: () =>
          mode === 'undefinedSerialization'
            ? {toJSON: () => undefined}
            : {bad: 1n},
        afterToolCall: () => {
          throw new Error('after');
        },
      },
      guard,
    );
    const client = await connect(server);
    try {
      await assert.rejects(
        guard.execute(async () => {
          const result = await client.callTool({
            name: mode === 'after' ? 'after' : 'before',
            arguments: mode === 'invalid' ? {} : args,
          });
          assert(!result.isError);
          if (mode === 'after') {
            assert.equal(decision(result).decision, 'block');
          } else {
            assert.equal(
              decision(result).hookSpecificOutput.permissionDecision,
              'deny',
            );
          }
        }),
      );
    } finally {
      await client.close();
      await server.close();
    }
  }
});
void test('undefined callback allows; explicit deny does not abort; config uses only MCP hooks', async () => {
  const guard = new CodexHookFailure();
  const server = await startCodexHookServer(
    {
      beforeToolCall: () => ({
        hookSpecificOutput: {permissionDecision: 'deny'},
      }),
    },
    guard,
  );
  const client = await connect(server);
  try {
    await guard.execute(async signal => {
      assert.deepEqual(
        decision(await client.callTool({name: 'after', arguments: args})),
        {},
      );
      await client.callTool({name: 'before', arguments: args});
      assert(!signal.aborted);
    });
  } finally {
    await client.close();
    await server.close();
  }
  const config = codexMcpHookConfiguration('internal');
  assert.deepEqual(Object.keys(config), ['PreToolUse', 'PostToolUse']);
  assert(!JSON.stringify(config).includes('"type":"command"'));
});
