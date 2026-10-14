import {
  SpanStatusCode,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

import type {EventDiagnostic} from '../agents/events.js';

type TimingOptions = {
  tracer: Tracer;
  parentContext: Context;
  workflowName: string;
  workflowExecutionId: string;
  agentName: string;
  agentSessionId: string;
  harness: string;
  phase: 'preflight' | 'initialize' | 'startup';
  provider?: string;
  model?: string;
  diagnostic: EventDiagnostic;
};
type Outcome = 'success' | 'unavailable' | 'error' | 'cancelled' | 'incomplete';

/** Internal observation only; never exports native configuration or error text. */
export function startHarnessTiming(options: TimingOptions) {
  let span: Span | undefined;
  let ended = false;
  const safely = (operation: () => void) => {
    try {
      operation();
    } catch {
      try {
        options.diagnostic(new Error('Harness timing telemetry failed'));
      } catch {
        // Telemetry and diagnostics must not affect harness execution.
      }
    }
  };
  safely(() => {
    span = options.tracer.startSpan(
      `harness.${options.phase} ${options.harness}`,
      {
        attributes: {
          'stratos.harness.name': options.harness,
          'stratos.harness.phase': options.phase,
          'stratos.workflow.name': options.workflowName,
          'stratos.workflow.execution.id': options.workflowExecutionId,
          'stratos.agent.session.id': options.agentSessionId,
          'gen_ai.agent.name': options.agentName,
          ...(options.provider
            ? {'gen_ai.provider.name': options.provider}
            : {}),
          ...(options.model ? {'gen_ai.request.model': options.model} : {}),
          ...(options.phase === 'startup'
            ? {'stratos.harness.ready_boundary': 'codex.turn.started'}
            : {}),
        },
      },
      options.parentContext,
    );
  });
  return (outcome: Outcome) => {
    if (ended) {
      return;
    }
    ended = true;
    safely(() => {
      span?.setAttribute('stratos.completion.status', outcome);
      if (outcome === 'cancelled' || outcome === 'incomplete') {
        span?.setAttribute(
          'stratos.completion.reason',
          outcome === 'cancelled'
            ? 'Agent execution cancelled'
            : 'Native readiness was not observed',
        );
      }
      span?.setStatus({
        code:
          outcome === 'error' || outcome === 'unavailable'
            ? SpanStatusCode.ERROR
            : outcome === 'success'
              ? SpanStatusCode.OK
              : SpanStatusCode.UNSET,
      });
    });
    safely(() => span?.end());
  };
}
