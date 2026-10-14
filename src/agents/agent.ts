import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';

import {z} from 'zod';

import type {AgentAdapter} from './adapter.js';
import {
  agentSettings,
  mergeAgentSettings,
  renderPrompt,
  type AgentOptions,
  type PromptSource,
} from './config.js';
import type {AgentEvent} from './events.js';
import type {AgentHooks} from './hooks.js';
import {prepareAgentMcps, type AgentMcpConfigurations} from './mcp-config.js';
import {
  createNativeAdapter,
  harnessTools,
  preflightNativeHarness,
} from './native.js';
import {AgentSelection, type ReadyCandidate} from './selection.js';
import {AgentSession} from './session.js';
import {resolveNativeTools} from './tools.js';
import {acquireWorktree} from '../git/worktrees/index.js';
import {AgentTrace} from '../telemetry/agent-trace.js';
import {startHarnessTiming} from '../telemetry/harness-timing.js';
import {getContext, bindAgentCallback} from '../workflows/runtime.js';

type NativeAdapterConfig = Parameters<typeof createNativeAdapter>[0];

export interface Agent<T = string> {
  execute(
    prompt: PromptSource,
    templateVariables?: Record<string, unknown>,
  ): Promise<T>;
  cancel(): void;
}

/** Public workflow primitive. Its resource owner is captured at construction. */
export function createAgent<S extends z.ZodType = z.ZodString>(
  options: AgentOptions<S> = {},
): Agent<z.output<S>> {
  return createAgentWithAdapters(options, {
    createAdapter: createNativeAdapter,
    preflight: preflightNativeHarness,
  });
}

/** Internal wiring seam: workflow authors only receive createAgent. */
export function createAgentWithAdapters<S extends z.ZodType = z.ZodString>(
  options: AgentOptions<S>,
  adapters: {
    createAdapter: typeof createNativeAdapter;
    preflight: typeof preflightNativeHarness;
  },
): Agent<z.output<S>> {
  const owner = getContext();
  const named = (id: string): Record<string, unknown> => {
    const configs = z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .parse(owner.workflow?.agents ?? {});
    if (!Object.hasOwn(configs, id)) {
      throw new Error(`Unknown agent config: ${id}`);
    }
    return mergeAgentSettings(configs[id]!, owner.overrides.agents?.[id] ?? {});
  };
  const settings = agentSettings.parse(
    mergeAgentSettings(
      options.configId ? named(options.configId) : {},
      options,
    ),
  );
  if (settings.provider === 'ollama' && settings.effort !== undefined) {
    throw new Error(
      'Ollama agents use model-default thinking; effort overrides are not supported',
    );
  }
  const identity = {
    workflowName: owner.name,
    executionId: owner.id,
    parentExecutionId: owner.parentExecutionId,
    agentSessionId: randomUUID(),
  };
  const bind = <Args extends unknown[], Result>(
    callback: ((...args: Args) => Result) | undefined,
  ) =>
    callback
      ? bindAgentCallback(owner, identity.agentSessionId, callback)
      : undefined;
  const hooks: AgentHooks = {
    onStart: bind(settings.hooks?.onStart),
    onComplete: bind(settings.hooks?.onComplete),
    onError: bind(settings.hooks?.onError),
    beforeToolCall: bind(settings.hooks?.beforeToolCall),
    afterToolCall: bind(settings.hooks?.afterToolCall),
  };
  const root = owner.workflow?.path ?? owner.workingDirectory;
  let cwd = resolve(owner.workingDirectory, settings.workingDirectory ?? '.');
  const outputSchema = settings.outputSchema
    ? z.toJSONSchema(settings.outputSchema, {
        io: 'output',
        target: 'draft-2020-12',
      })
    : undefined;
  let worktree: Awaited<ReturnType<typeof acquireWorktree>> | undefined;
  let mcpConfigs: AgentMcpConfigurations | undefined;
  let firstRequest = true;
  let resolvedSystemPrompt: string | undefined;
  let active: Promise<z.output<S>> | undefined;
  let controller: AbortController | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const diagnostic = bind((error: unknown) =>
    console.error('Agent diagnostic:', error),
  )!;
  const timing = {
    tracer: owner.telemetry.tracer,
    parentContext: owner.traceContext,
    workflowName: owner.name,
    workflowExecutionId: owner.id,
    agentName: settings.configId ?? 'agent',
    agentSessionId: identity.agentSessionId,
    diagnostic,
  };
  const selection = new AgentSelection({
    models: settings.model,
    harness: settings.harness,
    provider: settings.provider,
    async preflight(harness, signal) {
      const finish = startHarnessTiming({
        ...timing,
        harness,
        phase: 'preflight',
        provider: settings.provider,
      });
      try {
        const result = await adapters.preflight(
          harness,
          {workingDirectory: cwd, provider: settings.provider},
          signal,
        );
        finish(
          signal.aborted
            ? 'cancelled'
            : result.available
              ? 'success'
              : 'unavailable',
        );
        return result;
      } catch (error) {
        finish(signal.aborted ? 'cancelled' : 'error');
        throw error;
      }
    },
    createAdapter(candidate, onProgress) {
      // Each native resource owns its trace receiver, so a rejected resource's
      // late events cannot be attributed to its replacement.
      let invocationTrace: AgentTrace | undefined;
      const traces = new Set<AgentTrace>();
      let traceClosed = false;
      const common = {
        systemPrompt: resolvedSystemPrompt,
        hooks,
        onProgress,
        onEvent: (event: AgentEvent) => {
          owner.artifacts?.event(identity, event);
          if (!traceClosed) {
            const target =
              [...traces].reverse().find(trace => trace.owns(event)) ??
              invocationTrace;
            target?.onEvent(event);
          }
        },
        diagnostic,
      };
      const {model, provider, harness} = candidate;
      const native = configuredAdapter(
        {
          candidate,
          settings,
          cwd,
          outputSchema,
          mcpConfigs: mcpConfigs!,
          common,
          onStartup: () =>
            startHarnessTiming({
              ...timing,
              parentContext: invocationTrace?.context ?? owner.traceContext,
              harness,
              provider,
              model,
              phase: 'startup',
            }),
        },
        adapters.createAdapter,
      );
      return {
        async initialize() {
          const signal = controller?.signal;
          const finish = startHarnessTiming({
            ...timing,
            harness,
            provider,
            model,
            phase: 'initialize',
          });
          try {
            await native.initialize();
            finish(signal?.aborted ? 'cancelled' : 'success');
          } catch (error) {
            finish(signal?.aborted ? 'cancelled' : 'error');
            throw error;
          }
        },
        cancel: () => native.cancel(),
        async close() {
          try {
            await native.close();
          } finally {
            traceClosed = true;
            for (const trace of traces) {
              trace.close(Date.now());
            }
            traces.clear();
          }
        },
        async execute(prompt) {
          const selected = {...candidate, effort: settings.effort};
          invocationTrace = new AgentTrace({
            tracer: owner.telemetry.tracer,
            parentContext: owner.traceContext,
            workflowName: owner.name,
            workflowExecutionId: owner.id,
            agentName: settings.configId ?? 'agent',
            configuration: {
              ...selected,
              workingDirectory: cwd,
              worktree: settings.worktree,
              allowedMcps: settings.allowedMcps ?? [],
              allowedTools: settings.allowedTools,
              disallowedTools: settings.disallowedTools,
              candidateCatalogs: selection.modelSupport,
              excludedCandidates: selection.skipped.map(
                ({pair, reason, support}) => ({pair, reason, support}),
              ),
            },
            timestamp: Date.now(),
            input: prompt,
            systemPrompt: resolvedSystemPrompt,
            settings: selected,
            diagnostic,
          });
          traces.add(invocationTrace);
          try {
            const value = await native.execute(prompt);
            const result = settings.outputSchema
              ? await settings.outputSchema.parseAsync(value)
              : z
                  .string()
                  .min(1)
                  .refine(
                    text => text.trim().length > 0,
                    'Agent returned no text',
                  )
                  .parse(value);
            invocationTrace.finish({output: result}, Date.now(), true);
            return result;
          } catch (error) {
            invocationTrace.finish(
              {
                error:
                  error instanceof Error ? error : new Error(String(error)),
                cancelled: controller?.signal.aborted,
              },
              Date.now(),
              true,
            );
            throw error;
          }
        },
      };
    },
  });
  const lifecycle = new AgentSession<z.output<S>>(
    {
      async initialize() {
        let systemPrompt =
          settings.systemPrompt === undefined
            ? undefined
            : await renderPrompt(
                settings.systemPrompt,
                root,
                settings.templateVariables?.systemPrompt,
              );
        if (settings.worktree?.enabled) {
          if (!worktree) {
            worktree = await acquireWorktree(
              cwd,
              settings.worktree,
              message => console.error(message),
              controller?.signal,
            );
            owner.worktrees.releases.add(worktree.release);
            cwd = worktree.path;
          }
          systemPrompt = [
            systemPrompt,
            `Stratos-managed Git worktree ${worktree.name}; source ${worktree.repository}; branch ${worktree.branch}. Stratos manages cleanup.`,
          ]
            .filter(Boolean)
            .join('\n');
        }
        resolvedSystemPrompt = systemPrompt;
        mcpConfigs = await prepareAgentMcps(
          owner.workflow?.mcp,
          settings.allowedMcps ?? [],
          root,
          controller?.signal,
          value => owner.telemetry.addSecret(value),
        );
        await selection.initialize(controller?.signal);
      },
      async execute(prompt) {
        if (!firstRequest && settings.allowedMcps?.length) {
          const refreshed = await prepareAgentMcps(
            owner.workflow?.mcp,
            settings.allowedMcps,
            root,
            controller?.signal,
            value => owner.telemetry.addSecret(value),
          );
          for (const key of ['claude', 'codex', 'opencode'] as const) {
            Object.assign(mcpConfigs![key], refreshed[key]);
          }
        }
        firstRequest = false;
        controller?.signal.throwIfAborted();
        return (await selection.execute(
          prompt,
          controller?.signal,
        )) as z.output<S>;
      },
      cancel() {
        selection.cancel();
      },
      close() {
        return selection.close();
      },
    },
    hooks,
  );
  const cancel = () => {
    controller?.abort(new Error('Agent execution cancelled'));
    lifecycle.cancel();
  };
  owner.resources.add({
    close() {
      if (closing) {
        return closing;
      }
      closed = true;
      closing = (async () => {
        controller?.abort(new Error('Agent execution cancelled'));
        try {
          await lifecycle.close();
        } finally {
          await active?.catch(() => {});
        }
      })();
      return closing;
    },
  });
  return {
    execute(prompt, values) {
      if (closed || owner.closing) {
        return Promise.reject(new Error('Agent belongs to a closed workflow'));
      }
      if (active) {
        return Promise.reject(
          new Error(
            'Agent executions must be sequential; use separate agents for parallel calls',
          ),
        );
      }
      controller = new AbortController();
      const signal = controller.signal;
      const work = Promise.resolve().then(async () => {
        let defaults = settings.templateVariables?.prompt;
        if (typeof prompt === 'object' && 'configId' in prompt) {
          const config = named(prompt.configId);
          const parsed = agentSettings.shape.prompt.parse(config.prompt);
          if (parsed === undefined) {
            throw new Error(`Agent config ${prompt.configId} has no prompt`);
          }
          prompt = parsed;
          defaults = agentSettings.shape.templateVariables.parse(
            config.templateVariables,
          )?.prompt;
        }
        const rendered = await renderPrompt(prompt, root, {
          ...defaults,
          ...values,
        });
        signal.throwIfAborted();
        const release = await owner.agentPool.acquire(signal);
        try {
          signal.throwIfAborted();
          return await lifecycle.execute(rendered);
        } finally {
          release();
        }
      });
      active = work.finally(() => {
        active = undefined;
      });
      return active;
    },
    cancel,
  };
}

function configuredAdapter<S extends z.ZodType>(
  {
    candidate: {model, provider, harness},
    settings,
    cwd,
    outputSchema,
    mcpConfigs,
    common,
    onStartup,
  }: {
    candidate: ReadyCandidate;
    settings: AgentOptions<S>;
    cwd: string;
    outputSchema: Record<string, unknown> | undefined;
    mcpConfigs: AgentMcpConfigurations;
    common: Pick<
      NativeAdapterConfig['options'],
      'hooks' | 'onProgress' | 'onEvent' | 'diagnostic'
    > & {systemPrompt?: string};
    onStartup: () => ReturnType<typeof startHarnessTiming>;
  },
  create: (config: NativeAdapterConfig) => AgentAdapter<unknown>,
): AgentAdapter<unknown> {
  const removedTools = resolveNativeTools(
    harness,
    harnessTools[harness],
    settings.allowedTools,
    settings.disallowedTools,
  );
  if (harness === 'codex') {
    const effort = z
      .enum([
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
        'persistent',
      ])
      .optional()
      .parse(settings.effort);
    return create({
      canonicalModel: model,
      provider,
      harness,
      options: {
        ...common,
        workingDirectory: cwd,
        effort,
        outputSchema,
        mcpServers: mcpConfigs.codex,
        removedTools,
        onStartup,
      },
    });
  } else if (harness === 'claude-code') {
    const effort = z
      .enum(['low', 'medium', 'high', 'max'])
      .optional()
      .parse(settings.effort);
    return create({
      canonicalModel: model,
      provider,
      harness,
      options: {
        ...common,
        cwd,
        effort,
        mcpServers: mcpConfigs.claude,
        ...(removedTools.length ? {disallowedTools: removedTools} : {}),
        outputFormat: settings.outputSchema
          ? {
              type: 'json_schema',
              schema: z.toJSONSchema(settings.outputSchema, {
                io: 'output',
                target: 'draft-7',
              }),
            }
          : undefined,
      },
    });
  } else {
    return create({
      canonicalModel: model,
      provider,
      harness,
      options: {
        ...common,
        workingDirectory: cwd,
        effort: settings.effort,
        outputSchema,
        mcpServers: mcpConfigs.opencode,
        removedTools,
      },
    });
  }
}
