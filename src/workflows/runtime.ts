import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {subscribe} from 'node:diagnostics_channel';
import {join} from 'node:path';

import {
  context as otelContext,
  trace,
  SpanStatusCode,
  type Context,
  type Span,
} from '@opentelemetry/api';

import {inspectWorkflow, type WorkflowDefinition} from './definition.js';
import type {WorkflowMetadata} from './discovery.js';
import {closeAgentAdapters} from '../agents/cleanup.js';
import {authenticateWorkflowMcps} from '../agents/mcp-config.js';
import {loadAgentPool, type AgentPool} from '../agents/pool.js';
import type {DecisionSettings} from '../decision/runtime.js';
import {reconcileWorktrees} from '../git/worktrees/index.js';
import {loadCatalog} from '../models/catalog.js';
import {RunArtifacts} from '../telemetry/artifacts.js';
import {RunTelemetry} from '../telemetry/export.js';

export interface WorkflowOverrides {
  agents?: Record<string, Record<string, unknown>>;
  decision?: Record<string, DecisionSettings>;
}

interface ExecutionContext {
  telemetry: RunTelemetry;
  artifacts?: RunArtifacts;
  parentExecutionId?: string;
  worktrees: {safe: boolean; releases: Set<(safe: boolean) => Promise<void>>};
  traceContext: Context;
  agentPool: AgentPool;
  id: string;
  name: string;
  workingDirectory: string;
  closing: boolean;
  resources: Set<{close(): Promise<void>}>;
  workflow?: WorkflowMetadata;
  overrides: WorkflowOverrides;
  ancestors: string[];
}
const storage = new AsyncLocalStorage<{
  context: ExecutionContext;
  agentSessionId?: string;
}>();
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
  subscribe(`console.${level}`, args => {
    const current = storage.getStore();
    if (!current || !Array.isArray(args)) {
      return;
    }
    const {context, agentSessionId} = current;
    context.artifacts?.log(
      {
        workflowName: context.name,
        executionId: context.id,
        parentExecutionId: context.parentExecutionId,
        agentSessionId,
      },
      level,
      args,
    );
  });
}

export function bindAgentCallback<Args extends unknown[], Result>(
  owner: ExecutionContext,
  agentSessionId: string,
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  return storage.run({context: owner, agentSessionId}, () =>
    AsyncLocalStorage.bind(callback),
  );
}

export function getContext(): ExecutionContext {
  const context = storage.getStore()?.context;
  if (!context || context.closing) {
    throw new Error('No active workflow execution');
  }
  return context;
}

export {inspectWorkflow};

/** Internal bridge entry: both this function and workflow primitives use the root SDK. */
export async function executeWorkflow(
  definition: WorkflowDefinition,
  input: unknown,
  name: string,
  workingDirectory: string,
  workflow?: WorkflowMetadata,
  overrides: WorkflowOverrides = {},
  ancestors: string[] = [],
  pool?: AgentPool,
  parent?: ExecutionContext,
): Promise<unknown> {
  if (parent?.closing) {
    throw new Error('Parent workflow is closed');
  }
  loadCatalog();
  inspectWorkflow(definition);
  const parsed = await definition.input.parseAsync(input);
  if (workflow && ancestors.includes(workflow.path)) {
    throw new Error(
      `Workflow cycle: ${[...ancestors, workflow.path].join(' -> ')}`,
    );
  }
  if (!parent) {
    await reconcileWorktrees(workingDirectory, message =>
      console.error(message),
    );
  }
  const agentPool = pool ?? (await loadAgentPool());
  const runTelemetry = parent?.telemetry ?? new RunTelemetry();
  const executionId = randomUUID();
  const exporter = (
    workflow?.otel as {traces?: {exporter?: unknown}} | undefined
  )?.traces?.exporter;
  const inheritedTrace = await runTelemetry.context(
    parent?.traceContext ?? otelContext.active(),
    exporter,
    workingDirectory,
    workflow?.path ?? workingDirectory,
    name,
    executionId,
  );
  if (parent?.closing) {
    throw new Error('Parent workflow is closed');
  }
  const artifacts = parent
    ? parent.artifacts
    : await RunArtifacts.create(
        workingDirectory,
        name,
        executionId,
        runTelemetry,
      );
  artifacts?.enter(executionId);
  let outcome: 'success' | 'error' = 'error';
  let span: Span | undefined;
  const telemetry = (action: () => void) => {
    try {
      action();
    } catch (error) {
      try {
        console.error('Workflow telemetry failed:', error);
      } catch {
        // Diagnostic failures must not change the workflow result.
      }
    }
  };
  telemetry(() => {
    span = runTelemetry.tracer.startSpan(
      `workflow ${name}`,
      {
        attributes: {
          'stratos.workflow.name': name,
          'stratos.workflow.description': workflow?.shortDescription ?? '',
          'stratos.workflow.input': JSON.stringify(parsed),
          'stratos.workflow.overrides': JSON.stringify(overrides),
        },
      },
      inheritedTrace,
    );
  });
  const context: ExecutionContext = {
    telemetry: runTelemetry,
    artifacts,
    parentExecutionId: parent?.id,
    worktrees: parent?.worktrees ?? {safe: true, releases: new Set()},
    traceContext: span ? trace.setSpan(inheritedTrace, span) : inheritedTrace,
    agentPool,
    id: executionId,
    name,
    workingDirectory,
    closing: false,
    resources: new Set(),
    workflow,
    overrides,
    ancestors: workflow ? [...ancestors, workflow.path] : ancestors,
  };
  telemetry(() => {
    span?.setAttribute('stratos.workflow.execution.id', context.id);
  });
  const childResource = {
    async close() {
      context.closing = true;
      await closeAgentAdapters(context.resources, error => {
        context.worktrees.safe = false;
        console.error('Workflow cleanup failed:', error);
      });
    },
  };
  parent?.resources.add(childResource);
  return storage.run({context}, async () => {
    try {
      if (parent?.closing) {
        throw new Error('Parent workflow is closed');
      }
      if (workflow?.mcp !== undefined) {
        const abort = new AbortController();
        const authentication = authenticateWorkflowMcps(
          workflow.mcp,
          workflow.path,
          abort.signal,
          value => runTelemetry.addSecret(value),
        );
        const resource = {
          async close() {
            abort.abort(new Error('Workflow MCP authentication cancelled'));
            await authentication.catch(() => {});
          },
        };
        context.resources.add(resource);
        try {
          await authentication;
          abort.signal.throwIfAborted();
        } finally {
          context.resources.delete(resource);
        }
      }
      if (context.closing || parent?.closing) {
        throw new Error('Workflow is closed');
      }
      const output = await definition.output.parseAsync(
        await definition.run(parsed),
      );
      outcome = 'success';
      telemetry(() => {
        span?.setAttribute('stratos.workflow.output', JSON.stringify(output));
        span?.setAttribute('stratos.completion.status', 'success');
        span?.setStatus({code: SpanStatusCode.OK});
      });
      return output;
    } catch (error) {
      telemetry(() => {
        span?.setAttribute('stratos.completion.status', 'error');
        if (error instanceof Error) {
          span?.recordException(error);
        }
        span?.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
      });
      throw error;
    } finally {
      context.closing = true;
      await closeAgentAdapters(context.resources, error => {
        context.worktrees.safe = false;
        console.error('Workflow cleanup failed:', error);
      });
      if (!parent) {
        for (const release of context.worktrees.releases) {
          try {
            await release(context.worktrees.safe);
          } catch (error) {
            console.error('Worktree cleanup failed:', error);
          }
        }
        context.worktrees.releases.clear();
      }
      parent?.resources.delete(childResource);
      telemetry(() => {
        span?.end();
      });
      if (!parent) {
        await runTelemetry.close();
      }
      await artifacts?.leave(executionId, outcome);
    }
  });
}

/** Internal target binding used by generated wrappers, not arbitrary-name author invocation. */
export function createChildWorkflow<I, O>(
  directory: string,
  options: {overrides?: WorkflowOverrides} = {},
) {
  const owner = getContext();
  return {
    async execute(input: I): Promise<O> {
      if (owner.closing) {
        throw new Error('Child belongs to a closed workflow');
      }
      if (!owner.workflow) {
        throw new Error('Child workflow requires discovery-root context');
      }
      const {readWorkflow} = await import('./discovery.js');
      const {buildWorkflow, loadDefinition} = await import('./build.js');
      const child = await readWorkflow(join(owner.workflow.root, directory));
      if (child.root !== owner.workflow.root) {
        throw new Error('Child workflows must share the parent discovery root');
      }
      if (owner.ancestors.includes(child.path)) {
        throw new Error(
          `Workflow cycle: ${[...owner.ancestors, child.path].join(' -> ')}`,
        );
      }
      await buildWorkflow(child);
      if (owner.closing) {
        throw new Error('Parent workflow is closed');
      }
      const definition = await loadDefinition(child);
      return executeWorkflow(
        definition,
        input,
        child.name,
        owner.workingDirectory,
        child,
        options.overrides,
        owner.ancestors,
        owner.agentPool,
        owner,
      ) as Promise<O>;
    },
  };
}

export {createWorkflowMcp} from '../mcp/runtime.js';
export type {McpToolResult} from '../mcp/runtime.js';
