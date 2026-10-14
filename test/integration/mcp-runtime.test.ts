import assert from 'node:assert/strict';
import '../helpers/home.js';
import {createServer} from 'node:http';
import test from 'node:test';

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';

import {workflow} from '../../src/index.js';
import {connectMcp, discoverTools} from '../../src/mcp/client.js';
import {createWorkflowMcp} from '../../src/mcp/runtime.js';
import type {WorkflowMetadata} from '../../src/workflows/discovery.js';
import {executeWorkflow} from '../../src/workflows/runtime.js';

void test(
  'direct MCP detects legacy servers, runs concurrent tools, throws tool errors and closes with workflow',
  {timeout: 30_000},
  async t => {
    let calls = 0;
    let notifyHang!: () => void;
    const hangStarted = new Promise<void>(resolve => {
      notifyHang = resolve;
    });
    const resources: Array<{close(): Promise<void>}> = [];
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const mcp = new McpServer({name: 'fixture', version: '1'});
      mcp.registerTool(
        'double',
        {inputSchema: {value: z.number()}},
        async ({value}) => {
          calls++;
          return {content: [{type: 'text', text: String(value * 2)}]};
        },
      );
      mcp.registerTool('fail', {inputSchema: {}}, async () => {
        calls++;
        return {
          isError: true,
          content: [{type: 'text', text: 'fixture failure'}],
        };
      });
      mcp.registerTool('hang', {inputSchema: {}}, async () => {
        calls++;
        notifyHang();
        return new Promise<never>(() => {});
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      resources.push(mcp);
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await Promise.allSettled(resources.map(resource => resource.close()));
      await new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const metadata: WorkflowMetadata = {
      name: 'fixture',
      shortDescription: 'Test fixture',
      longDescription: 'Exercise this test fixture with schema-valid input.',
      version: '1',
      entrypoint: 'workflow.ts',
      path: process.cwd(),
      root: process.cwd(),
      mcp: {
        servers: {
          fixture: {type: 'http', url: `http://127.0.0.1:${address.port}/mcp`},
        },
      },
    };
    const connection = await connectMcp(
      metadata,
      'fixture',
      new AbortController().signal,
      300000,
    );
    assert.equal(connection.client.getProtocolEra(), 'legacy');
    assert.equal((await discoverTools(connection)).length, 3);
    await connection.close();
    let saved: Awaited<ReturnType<typeof createWorkflowMcp>> | undefined;
    await executeWorkflow(
      workflow({
        input: z.strictObject({}),
        output: z.object({}),
        async run() {
          saved = await createWorkflowMcp('fixture', 300000);
          const results = await Promise.all([
            saved.callTool('double', {value: 2}),
            saved.callTool('double', {value: 3}),
          ]);
          assert.equal((results[0]!.content[0] as {text: string}).text, '4');
          assert.equal((results[1]!.content[0] as {text: string}).text, '6');
          await assert.rejects(
            saved.callTool('fail', {}),
            error => (error as Error).cause !== undefined,
          );
          // Mock only the ready client's request deadline, not HTTP negotiation on a busy runner.
          t.mock.timers.enable({apis: ['setTimeout']});
          try {
            const timedOut = assert.rejects(saved.callTool('hang', {}), {
              code: 'REQUEST_TIMEOUT',
              data: {timeout: 300000},
            });
            await hangStarted;
            t.mock.timers.tick(300000);
            await timedOut;
          } finally {
            t.mock.timers.reset();
          }
          return {};
        },
      }),
      {},
      'fixture',
      process.cwd(),
      metadata,
    );
    assert.equal(calls, 4); // Failed tool execution is not retried.
    await assert.rejects(
      saved!.callTool('double', {value: 1}),
      /closed workflow/,
    );
  },
);
