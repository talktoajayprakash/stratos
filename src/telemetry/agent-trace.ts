import {
  trace,
  SpanKind,
  SpanStatusCode,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

import type {
  AgentEvent,
  EventDiagnostic,
  ModelSettings,
  TokenUsage,
} from '../agents/events.js';

type Completion = {
  output?: unknown;
  error?: Error;
  cancelled?: boolean;
  reason?: string;
  incomplete?: boolean;
};
type TraceOwner = {workflowName: string; workflowExecutionId: string};
type AgentTraceOptions = TraceOwner & {
  tracer: Tracer;
  parentContext: Context;
  agentName: string;
  timestamp: number;
  input: string;
  systemPrompt?: string;
  configuration?: Record<string, unknown>;
  settings?: ModelSettings;
  diagnostic: EventDiagnostic;
};

/** One invocation's observation consumer. Parent context is captured explicitly,
 * so late/HTTP callbacks do not depend on process-global or ambient context.
 * The owner creates workflow spans; adapters never receive OTEL objects.
 */
export class AgentTrace {
  private span: Span | undefined;
  private parent: Context;
  private readonly open = new Map<string, Span>();
  private readonly contexts = new Map<string, Context>();
  private readonly taskSpans = new Set<string>();
  private ended = false;
  private closed = false;

  constructor(private readonly options: AgentTraceOptions) {
    this.parent = options.parentContext;
    this.safely(() => {
      this.span = this.start(
        `invoke_agent ${options.agentName}`,
        options.timestamp,
        {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.agent.name': options.agentName,
          'stratos.agent.input': options.input,
          ...(options.configuration
            ? {
                'stratos.agent.configuration': JSON.stringify(
                  options.configuration,
                ),
              }
            : {}),
          'gen_ai.input.messages': JSON.stringify([
            {role: 'user', parts: [{type: 'text', content: options.input}]},
          ]),
          ...(options.systemPrompt !== undefined
            ? {
                'gen_ai.system_instructions': JSON.stringify([
                  {type: 'text', content: options.systemPrompt},
                ]),
              }
            : {}),
        },
        options.parentContext,
      );
      this.settings(this.span, options.settings);
      this.parent = trace.setSpan(options.parentContext, this.span);
    });
  }

  readonly onEvent = (event: AgentEvent): void => {
    if (
      this.closed ||
      !this.span ||
      (this.ended &&
        !this.owns(event) &&
        !event.type.startsWith('background.') &&
        !event.type.startsWith('compaction.'))
    ) {
      return;
    }
    this.safely(() => this.observe(event));
  };

  get context(): Context {
    return this.parent;
  }

  owns(event: AgentEvent): boolean {
    const key = this.key(event);
    return !!(
      (key && this.open.has(key)) ||
      (event.parentTaskId &&
        this.contexts.has(`background:${event.parentTaskId}`)) ||
      (event.parentToolCallId &&
        this.contexts.has(`tool:${event.parentToolCallId}`)) ||
      (event.parentCompactionId &&
        this.contexts.has(`compaction:${event.parentCompactionId}`))
    );
  }

  private key(event: AgentEvent): string | undefined {
    if ('toolCallId' in event) {
      return `tool:${event.toolCallId}`;
    }
    if ('modelCallId' in event) {
      return `model:${event.modelCallId}`;
    }
    if ('compactionId' in event) {
      return `compaction:${event.compactionId}`;
    }
    if ('taskId' in event) {
      return `background:${event.taskId}`;
    }
    return undefined;
  }

  close(timestamp: number): void {
    this.closed = true;
    for (const child of this.open.values()) {
      this.safely(() => {
        try {
          this.complete(
            child,
            {
              incomplete: true,
              reason:
                'Native completion was not observed before adapter closure',
            },
            timestamp,
          );
        } finally {
          child.end(new Date(timestamp));
        }
      });
    }
    this.open.clear();
    this.contexts.clear();
    this.taskSpans.clear();
  }

  finish(completion: Completion, timestamp: number, retainTasks = false): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    // End every started child even if another span operation fails.
    for (const [key, child] of this.open) {
      if (retainTasks && this.taskSpans.has(key)) {
        continue;
      }
      this.safely(() => {
        try {
          this.complete(
            child,
            {
              error: completion.error,
              cancelled: completion.cancelled,
              reason: completion.reason,
              incomplete: !completion.error && !completion.cancelled,
            },
            timestamp,
          );
        } finally {
          child.end(new Date(timestamp));
        }
      });
      this.open.delete(key);
    }
    if (this.span) {
      this.safely(() => {
        try {
          this.complete(
            this.span!,
            completion,
            timestamp,
            'stratos.agent.output',
          );
        } finally {
          this.span!.end(new Date(timestamp));
        }
      });
    }
  }

  private observe(event: AgentEvent): void {
    let key: string;
    switch (event.type) {
      case 'message.delta':
        return; // Activity consumer owns deltas; do not duplicate content on spans.
      case 'tool.started':
        this.begin(
          `tool:${event.toolCallId}`,
          `execute_tool ${event.toolName}`,
          event,
          {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': event.toolName,
            'gen_ai.tool.call.id': event.toolCallId,
            'gen_ai.tool.call.arguments': JSON.stringify(event.input),
          },
        );
        return;
      case 'model.started': {
        const span = this.begin(
          `model:${event.modelCallId}`,
          `chat ${event.settings?.model ?? 'model'}`,
          event,
          {
            'gen_ai.operation.name': 'chat',
            'stratos.model_call.id': event.modelCallId,
            'stratos.input.scope':
              'observed conversation; not exact provider request',
            'stratos.timing.scope': event.reconstructed
              ? 'transcript interval; may include tool execution'
              : 'harness model events; not exact API latency',
            ...(event.input !== undefined
              ? {'gen_ai.input.messages': JSON.stringify(event.input)}
              : {}),
          },
          SpanKind.CLIENT,
        );
        if (span) {
          this.settings(span, event.settings);
        }
        return;
      }
      case 'compaction.started':
        this.begin(`compaction:${event.compactionId}`, 'compaction', event, {
          'stratos.operation': 'compaction',
          'stratos.compaction.id': event.compactionId,
          ...(event.input !== undefined
            ? {'stratos.compaction.input': JSON.stringify(event.input)}
            : {}),
        });
        return;
      case 'background.started':
        this.begin(`background:${event.taskId}`, 'background task', event, {
          'stratos.operation': 'background',
          'stratos.task.id': event.taskId,
          ...(event.parentTaskId !== undefined
            ? {'stratos.task.parent_id': event.parentTaskId}
            : {}),
          ...(event.description !== undefined
            ? {'stratos.task.description': event.description}
            : {}),
        });
        return;
      case 'background.activity':
        if (!this.open.has(`background:${event.taskId}`)) {
          this.missing(event);
          return;
        }
        this.open.get(`background:${event.taskId}`)!.addEvent(
          'activity',
          {
            ...(event.progress !== undefined
              ? {'stratos.task.progress': JSON.stringify(event.progress)}
              : {}),
          },
          new Date(event.timestamp),
        );
        return;
      case 'tool.completed':
        key = `tool:${event.toolCallId}`;
        break;
      case 'model.completed':
        key = `model:${event.modelCallId}`;
        break;
      case 'compaction.completed':
        key = `compaction:${event.compactionId}`;
        break;
      case 'background.completed':
        key = `background:${event.taskId}`;
        break;
    }
    const span = this.open.get(key);
    if (!span) {
      if (
        event.type === 'compaction.completed' ||
        event.type === 'background.completed'
      ) {
        this.missing(event);
        return;
      }
      throw new Error(`No start event for ${key}`);
    } // Do not invent missing start times.
    try {
      if (event.reconstructed) {
        span.setAttribute('stratos.reconstructed', true);
      }

      if ('usage' in event) {
        this.usage(span, event.usage);
      }
      this.complete(
        span,
        event,
        event.timestamp,
        event.type === 'tool.completed'
          ? 'gen_ai.tool.call.result'
          : event.type === 'model.completed'
            ? 'gen_ai.output.messages'
            : 'stratos.output',
      );
    } finally {
      this.open.delete(key);
      span.end(new Date(event.timestamp));
    }
  }

  private missing(event: AgentEvent): void {
    // An observed endpoint is not evidence of a start time or duration.
    const span = this.ended
      ? trace.getSpan(this.options.parentContext)
      : this.span;
    span?.addEvent(
      event.type,
      {
        'stratos.observation.missing_start': true,
        'stratos.observation': JSON.stringify(event),
        'stratos.workflow.execution_id': this.options.workflowExecutionId,
        'stratos.agent.invocation_span_id': this.span?.spanContext().spanId,
        ...(event.reconstructed ? {'stratos.reconstructed': true} : {}),
        ...('error' in event && event.error
          ? {
              'error.type': event.error.name,
              'stratos.observation.error':
                event.error.stack ?? event.error.message,
            }
          : {}),
      },
      new Date(event.timestamp),
    );
  }

  private begin(
    key: string,
    name: string,
    event: AgentEvent,
    attributes: Record<string, string | undefined>,
    kind = SpanKind.INTERNAL,
  ) {
    if (this.open.has(key)) {
      throw new Error(`Duplicate start event for ${key}`);
    }
    const parentKey =
      event.parentCompactionId &&
      this.contexts.has(`compaction:${event.parentCompactionId}`)
        ? `compaction:${event.parentCompactionId}`
        : event.parentTaskId &&
            this.contexts.has(`background:${event.parentTaskId}`)
          ? `background:${event.parentTaskId}`
          : event.parentToolCallId
            ? `tool:${event.parentToolCallId}`
            : undefined;
    const parent = parentKey
      ? (this.contexts.get(parentKey) ?? this.parent)
      : this.parent;
    const span = this.start(
      name,
      event.timestamp,
      {
        ...attributes,
        ...(event.reconstructed ? {'stratos.reconstructed': true} : {}),
        ...(event.parentTaskId
          ? {'stratos.task.parent_id': event.parentTaskId}
          : {}),
        ...(event.parentToolCallId
          ? {'stratos.tool.parent_id': event.parentToolCallId}
          : {}),
      },
      parent,
      kind,
    );
    this.open.set(key, span);
    this.contexts.set(key, trace.setSpan(parent, span));
    if (
      key.startsWith('background:') ||
      key.startsWith('compaction:') ||
      event.parentTaskId ||
      (parentKey && this.taskSpans.has(parentKey))
    ) {
      this.taskSpans.add(key);
    }
    return span;
  }

  private start(
    name: string,
    timestamp: number,
    attributes: Record<string, string | boolean | undefined>,
    parent: Context,
    kind = SpanKind.INTERNAL,
  ) {
    return this.options.tracer.startSpan(
      name,
      {
        kind,
        startTime: new Date(timestamp),
        attributes: {
          ...attributes,
          'stratos.workflow.name': this.options.workflowName,
          'stratos.workflow.execution_id': this.options.workflowExecutionId,
          'stratos.workflow.execution.id': this.options.workflowExecutionId,
        },
      },
      parent,
    );
  }

  private complete(
    span: Span,
    result: Completion,
    timestamp: number,
    outputKey = 'stratos.output',
  ) {
    if (result.reason !== undefined) {
      span.setAttribute('stratos.completion.reason', result.reason);
    }
    if (result.incomplete) {
      span.setAttribute('stratos.completion.status', 'incomplete');
    } else if (result.cancelled) {
      span.setAttribute('stratos.completion.status', 'cancelled');
      span.setAttribute(
        'stratos.completion.reason',
        result.reason ?? result.error?.message ?? 'Cancelled',
      );
    } else if (result.error) {
      span.recordException(result.error, new Date(timestamp));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: result.error.message,
      });
      span.setAttribute('error.type', result.error.name);
      span.setAttribute('stratos.completion.status', 'error');
    } else {
      span.setAttribute(
        'stratos.completion.status',
        result.cancelled ? 'cancelled' : 'success',
      );
    }
    if (result.output !== undefined) {
      span.setAttribute(outputKey, JSON.stringify(result.output));
      if (outputKey === 'stratos.agent.output') {
        span.setAttribute(
          'gen_ai.output.messages',
          JSON.stringify([
            {
              role: 'assistant',
              parts: [
                {
                  type: 'text',
                  content:
                    typeof result.output === 'string'
                      ? result.output
                      : JSON.stringify(result.output),
                },
              ],
            },
          ]),
        );
      }
    }
  }

  private settings(span: Span, settings?: ModelSettings) {
    if (!settings) {
      return;
    }
    span.setAttributes({
      'gen_ai.request.model': settings.model,
      'gen_ai.provider.name': settings.provider,
      'gen_ai.request.temperature': settings.temperature,
      'gen_ai.request.max_tokens': settings.maxOutputTokens,
      'stratos.model.effort': settings.effort,
    });
  }

  private usage(span: Span, usage?: TokenUsage) {
    if (!usage) {
      return;
    }
    span.setAttributes({
      'gen_ai.usage.input_tokens': usage.inputTokens,
      'gen_ai.usage.output_tokens': usage.outputTokens,
      'gen_ai.usage.cache_read.input_tokens': usage.cacheReadInputTokens,
    });
  }

  private safely(work: () => void) {
    try {
      work();
    } catch (error) {
      try {
        this.options.diagnostic(error);
      } catch {
        /* Soft diagnostics. */
      }
    }
  }
}
