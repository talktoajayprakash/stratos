import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

import {ModelUnavailableError} from '../availability.js';

type Usage = {
  output_tokens?: number;
  output_tokens_details?: {thinking_tokens?: number | null} | null;
  server_tool_use?: object | null;
};

function usedOutput(usage: Usage | undefined): boolean {
  return (
    (usage?.output_tokens ?? 0) > 0 ||
    (usage?.output_tokens_details?.thinking_tokens ?? 0) > 0 ||
    Object.values(usage?.server_tool_use ?? {}).some(
      value => typeof value === 'number' && value > 0,
    )
  );
}

/** Control evidence, including work which has no public text/tool event. */
export function isClaudeProgress(
  event: SDKMessage,
  syntheticStream = false,
): boolean {
  if (event.type === 'result') {
    return (
      usedOutput(event.usage) ||
      event.permission_denials.length > 0 ||
      Object.values(event.modelUsage).some(
        usage =>
          usage.outputTokens > 0 ||
          (usage.thinkingTokens ?? 0) > 0 ||
          usage.webSearchRequests > 0,
      )
    );
  }
  if (event.type === 'assistant') {
    return (
      usedOutput(event.message.usage) ||
      event.message.content.some(
        block =>
          block.type !== 'text' ||
          (event.message.model !== '<synthetic>' && block.text.length > 0),
      )
    );
  }
  if (event.type === 'stream_event') {
    const stream = event.event;
    if (stream.type === 'message_start') {
      return usedOutput(stream.message.usage);
    }
    if (stream.type === 'message_delta') {
      return usedOutput(stream.usage);
    }
    if (stream.type === 'content_block_start') {
      return (
        stream.content_block.type !== 'text' ||
        (!syntheticStream && stream.content_block.text.length > 0)
      );
    }
    if (stream.type === 'content_block_delta') {
      if (syntheticStream && stream.delta.type === 'text_delta') {
        return false;
      }
      return Object.entries(stream.delta).some(
        ([key, value]) => key !== 'type' && !!value,
      );
    }
    return false;
  }
  return (
    event.type === 'tool_progress' ||
    event.type === 'tool_use_summary' ||
    (event.type === 'system' &&
      ([
        'task_started',
        'task_progress',
        'task_notification',
        'task_updated',
        'hook_started',
        'hook_progress',
        'hook_response',
        'permission_denied',
        'files_persisted',
        'thinking_tokens',
        'compact_boundary',
      ].includes(event.subtype) ||
        (event.subtype === 'status' && event.status === 'compacting') ||
        (event.subtype === 'background_tasks_changed' &&
          event.tasks.length > 0)))
  );
}

/** The caller supplies only errors belonging to the correlated foreground turn. */
export function claudeResultError(
  result: SDKResultMessage,
  {
    errors = [],
    progressed = false,
  }: {errors?: readonly SDKAssistantMessage[]; progressed?: boolean} = {},
): Error {
  const cause = {assistantErrors: [...errors], result};
  const message =
    (result.subtype === 'success' ? result.result : result.errors.join('\n')) ||
    'Claude execution failed';
  const confirmed =
    result.is_error === true &&
    !progressed &&
    !isClaudeProgress(result) &&
    (result.subtype === 'success' ||
      (result.subtype === 'error_during_execution' &&
        !result.startup_failure_reason)) &&
    errors.length > 0 &&
    errors.every(
      event =>
        event.error === 'model_not_found' &&
        event.parent_tool_use_id === null &&
        !event.subagent_type &&
        !isClaudeProgress(event),
    );
  return confirmed
    ? new ModelUnavailableError(message, {cause})
    : new Error(message, {cause});
}
