import type {AgentAdapter} from './adapter.js';
import type {HarnessReadiness} from './availability.js';
import {resolveNativeModel} from '../models/catalog.js';
import {
  ClaudeAdapter,
  claudeTools,
  type ClaudeAdapterOptions,
} from './claude/adapter.js';
import {
  CodexAdapter,
  codexTools,
  type CodexAdapterOptions,
} from './codex/adapter.js';
import {
  OpenCodeAdapter,
  openCodeTools,
  type OpenCodeAdapterOptions,
} from './opencode/adapter.js';
import type {HarnessId} from '../models/candidates.js';
import {preflightClaude} from './claude/preflight.js';
import {preflightCodex} from './codex/preflight.js';
import {preflightOpenCode} from './opencode/preflight.js';
import type {HarnessTools} from './tools.js';

/** Built-in tool controls defined by each harness adapter. */
export const harnessTools: Record<HarnessId, HarnessTools> = {
  'claude-code': claudeTools,
  codex: codexTools,
  opencode: openCodeTools,
};

export function preflightNativeHarness(
  harness: HarnessId,
  options: {
    workingDirectory: string;
    provider?: string;
  },
  signal?: AbortSignal,
): Promise<HarnessReadiness> {
  switch (harness) {
    case 'claude-code':
      return preflightClaude(
        {
          cwd: options.workingDirectory,
          provider: options.provider ?? 'anthropic',
        },
        signal,
      );
    case 'codex':
      return preflightCodex(options, signal);
    case 'opencode':
      return preflightOpenCode(options, signal);
  }
}

/** Internal boundary after harness/provider selection. No provider or credential policy lives here. */
type NativeAgentOptions = {canonicalModel: string; provider: string} & (
  | {
      harness: 'claude-code';
      options: Omit<ClaudeAdapterOptions, 'model' | 'provider'>;
    }
  | {harness: 'codex'; options: Omit<CodexAdapterOptions, 'model' | 'provider'>}
  | {harness: 'opencode'; options: Omit<OpenCodeAdapterOptions, 'model'>}
);

export function createNativeAdapter(
  settings: NativeAgentOptions,
): AgentAdapter<unknown> {
  const model = resolveNativeModel(settings.canonicalModel, settings.provider);
  switch (settings.harness) {
    case 'claude-code':
      return new ClaudeAdapter({
        ...settings.options,
        provider: settings.provider,
        model,
      });
    case 'codex':
      return new CodexAdapter({
        ...settings.options,
        provider: settings.provider,
        model,
      });
    case 'opencode':
      return new OpenCodeAdapter({
        ...settings.options,
        model: {providerID: settings.provider, modelID: model},
      });
  }
}
