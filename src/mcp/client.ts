import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

import {prepareAgentMcps} from '../agents/mcp-config.js';
import type {WorkflowMetadata} from '../workflows/discovery.js';

/** Each factory owns one ready SDK client, never a cross-workflow connection pool. */
export async function connectMcp(
  workflow: WorkflowMetadata,
  name: string,
  signal: AbortSignal,
  timeout: number,
  secret?: (value: string) => void,
) {
  const configs = await prepareAgentMcps(
    workflow.mcp,
    [name],
    workflow.path,
    signal,
    secret,
  );
  signal.throwIfAborted();
  const config = configs.claude[name]!;
  const client = new Client(
    {name: 'stratos', version: '0.0.1'},
    {
      inputRequired: {autoFulfill: false},
      versionNegotiation: {
        mode: 'auto',
        probe: {timeoutMs: timeout, maxRetries: 0},
      },
    },
  );
  const transport =
    config.type === 'http'
      ? new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: {headers: config.headers},
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              signal: AbortSignal.any([
                signal,
                ...(init?.signal ? [init.signal] : []),
              ]),
            }),
        })
      : new StdioClientTransport({
          ...(config as {
            command: string;
            args?: string[];
            env?: Record<string, string>;
          }),
          cwd: workflow.path,
          stderr: 'pipe',
        });
  if (transport instanceof StdioClientTransport) {
    transport.stderr?.on('data', () => {});
  }
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      signal.removeEventListener('abort', abort);
      await client.close();
    })());
  const abort = () => {
    void close().catch(() => {});
  };
  signal.addEventListener('abort', abort, {once: true});
  try {
    await client.connect(transport, {signal, timeout});
    signal.throwIfAborted();
    return {client, close, signal, timeout};
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

export async function discoverTools(
  connection: Awaited<ReturnType<typeof connectMcp>>,
) {
  const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await connection.client.listTools(
      cursor ? {cursor} : undefined,
      {signal: connection.signal, timeout: connection.timeout},
    );
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) {
      throw new Error('MCP returned a repeated tool-list cursor');
    }
    if (cursor) {
      seen.add(cursor);
    }
  } while (cursor);
  return tools;
}
