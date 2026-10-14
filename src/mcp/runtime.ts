import type {Client, Tool} from '@modelcontextprotocol/client';
import {SpanKind, SpanStatusCode, type Span} from '@opentelemetry/api';

import {connectMcp} from './client.js';
import {getContext} from '../workflows/runtime.js';

export type McpToolResult = Awaited<ReturnType<Client['callTool']>>;
/** Internal binding used only by generated workflow-local MCP factories. */
export async function createWorkflowMcp(name: string, timeout: number) {
  const owner = getContext();
  if (!owner.workflow) {
    throw new Error('MCP requires workflow metadata');
  }
  const abort = new AbortController();
  let connection: Awaited<ReturnType<typeof connectMcp>> | undefined;
  let pending: Promise<unknown> | undefined;
  let closed = false;
  const calls = new Set<Promise<unknown>>();
  const resource = {
    async close() {
      closed = true;
      abort.abort(new Error('Workflow MCP cancelled'));
      await pending?.catch(() => {});
      try {
        await connection?.close();
      } finally {
        await Promise.allSettled(calls);
      }
    },
  };
  owner.resources.add(resource);
  try {
    const initialization = connectMcp(
      owner.workflow,
      name,
      abort.signal,
      timeout,
      value => owner.telemetry.addSecret(value),
    );
    pending = initialization;
    connection = await initialization;
    if (closed || owner.closing) {
      throw new Error('MCP belongs to a closed workflow');
    }
  } catch (error) {
    await resource.close().catch(() => {});
    owner.resources.delete(resource);
    throw error;
  }
  function callTool(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult>;
  function callTool<Output>(
    tool: string,
    args: Record<string, unknown>,
    definition: Tool & Required<Pick<Tool, 'outputSchema'>>,
  ): Promise<McpToolResult & {structuredContent: Output}>;
  function callTool(
    tool: string,
    args: Record<string, unknown>,
    definition?: Tool,
  ): Promise<McpToolResult> {
    if (closed || owner.closing) {
      return Promise.reject(new Error('MCP belongs to a closed workflow'));
    }
    let span: Span | undefined;
    const telemetry = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        try {
          console.error('MCP telemetry failed:', error);
        } catch {
          // Diagnostic failures must not change the tool result.
        }
      }
    };
    telemetry(() => {
      span = owner.telemetry.tracer.startSpan(
        `execute_tool ${tool}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': tool,
            'gen_ai.tool.call.arguments': JSON.stringify(args),
            'stratos.mcp.server': name,
            'stratos.workflow.name': owner.name,
            'stratos.workflow.execution.id': owner.id,
          },
        },
        owner.traceContext,
      );
    });
    const work = (async () => {
      try {
        const result = await connection!.client.callTool(
          {name: tool, arguments: args},
          {signal: abort.signal, timeout, toolDefinition: definition},
        );
        if (result.isError) {
          throw new Error(`MCP tool ${name}.${tool} failed`, {cause: result});
        }
        telemetry(() => {
          span?.setAttribute('gen_ai.tool.call.result', JSON.stringify(result));
          span?.setStatus({code: SpanStatusCode.OK});
        });
        return result;
      } catch (error) {
        telemetry(() => {
          span?.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        throw error;
      } finally {
        telemetry(() => span?.end());
      }
    })();
    const tracked = work.finally(() => calls.delete(tracked));
    calls.add(tracked);
    return tracked;
  }
  return {callTool};
}
