import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type {CodexHookFailure} from './hook-failure.js';

/** Internal native payloads, not the public workflow hook/decision API. */
export type CodexHookEvent = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
};
type NativeDecision = Record<string, unknown> | void;
export type CodexHookCallbacks = {
  beforeToolCall?(
    event: CodexHookEvent,
  ): NativeDecision | Promise<NativeDecision>;
  afterToolCall?(
    event: CodexHookEvent,
  ): NativeDecision | Promise<NativeDecision>;
};

/** The caller owns server lifetime and invocation routing. Pass the same failure
 * guard to execute() around SDK execution. No process, files or trust changes.
 */
export async function startCodexHookServer(
  callbacks: CodexHookCallbacks,
  failure: CodexHookFailure,
) {
  const bearerToken = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${bearerToken}`);
  const active = new Set<McpServer>();
  let closing: Promise<void> | undefined;
  const http = createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (
      supplied.length !== authorization.length ||
      !timingSafeEqual(supplied, authorization)
    ) {
      res.writeHead(401).end();
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (closing) {
      res.writeHead(503).end();
      return;
    }
    // Use an independent stateless transport per HTTP request. The callback and
    // failure state remain in this process; MCP session state is unnecessary.
    const mcp = new McpServer(
      {name: 'stratos-codex-hooks', version: '1'},
      {capabilities: {tools: {}}},
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    active.add(mcp);
    const release = () => {
      active.delete(mcp);
      void mcp.close().catch(() => {});
    };
    res.once('close', release);
    // McpServer exposes custom handlers through server. Keep validation inside
    // our failure guard: registerTool's validation errors would fail open in Codex.
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ['before', 'after'].map(name => ({
        name,
        description: 'Internal Codex lifecycle callback.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            toolCallId: {type: 'string'},
            toolName: {type: 'string'},
            input: {},
            output: {},
          },
          required: ['toolCallId', 'toolName', 'input'],
          additionalProperties: false,
        },
      })),
    }));
    mcp.server.setRequestHandler(CallToolRequestSchema, async request => {
      const phase = request.params.name;
      if (phase !== 'before' && phase !== 'after') {
        throw new Error('Unknown Codex callback tool');
      }
      // Validate dispatch and serialize callback results inside the failure guard:
      // neither malformed hook payloads nor serialization failures may fail open.
      const result = await failure.invoke(phase, async () => {
        const input = request.params.arguments;
        if (
          !input ||
          typeof input.toolCallId !== 'string' ||
          typeof input.toolName !== 'string' ||
          !Object.hasOwn(input, 'input')
        ) {
          throw new Error('Invalid Codex hook event');
        }
        const event: CodexHookEvent = {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          input: input.input,
          ...(Object.hasOwn(input, 'output') ? {output: input.output} : {}),
        };
        const decision = await (phase === 'before'
          ? callbacks.beforeToolCall?.(event)
          : callbacks.afterToolCall?.(event));
        if (
          decision !== undefined &&
          (decision === null ||
            typeof decision !== 'object' ||
            Array.isArray(decision))
        ) {
          throw new Error('Invalid native Codex hook decision');
        }
        const serialized = JSON.stringify(decision ?? {});
        if (serialized === undefined) {
          throw new Error('Native Codex hook decision is not serializable');
        }
        return serialized;
      });
      // Failure guard returns a native blocking decision; never use MCP isError
      // for callback exceptions, since Codex treats those as non-blocking.
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result),
          },
        ],
      };
    });
    void (async () => {
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500).end();
        } else {
          res.destroy();
        }
        release();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (!address || typeof address === 'string') {
    http.close();
    throw new Error('Codex callback listener unavailable');
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    bearerToken,
    close(): Promise<void> {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) =>
          http.close(error => (error ? reject(error) : resolve())),
        );
        http.closeAllConnections();
        await Promise.allSettled([...active].map(mcp => mcp.close()));
        await stopped;
      })();
      return closing;
    },
  };
}

/** Codex-native config fragment; does not persist files or grant hook trust. */
export function codexMcpHookConfiguration(serverName: string) {
  return Object.fromEntries(
    [
      ['PreToolUse', 'before'],
      ['PostToolUse', 'after'],
    ].map(([event, tool]) => [
      event!,
      [
        {
          hooks: [
            {
              type: 'mcp_tool',
              server: serverName,
              tool,
              input: {
                toolCallId: '${tool_use_id}',
                toolName: '${tool_name}',
                input: '${tool_input}',
                ...(tool === 'after' ? {output: '${tool_response}'} : {}),
              },
            },
          ],
        },
      ],
    ]),
  );
}
