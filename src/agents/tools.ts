import type {HarnessId} from '../models/candidates.js';

/**
 * Canonical names for built-in tools that at least two harnesses provide.
 * Harness-only tools are selected by their own names, defined in each adapter.
 * MCP tools are selected by `allowedMcps`.
 */
export const canonicalTools = [
  'shell',
  'read',
  'edit',
  'write',
  'glob',
  'grep',
  'lsp',
  'web_fetch',
  'web_search',
  'subagent',
  'todo',
  'plan_mode',
  'ask_user',
  'skill',
  'notify_user',
] as const;
export type CanonicalTool = (typeof canonicalTools)[number];

/**
 * Native controls for one selectable name. `absent`: the harness has no such
 * built-in tool. `fixed`: the harness always provides it. Selections of either
 * have no effect.
 */
export type NativeTool = readonly string[] | 'absent' | 'fixed';

/** A harness's controls for every canonical name and for its own tool names. */
export type HarnessTools = Record<CanonicalTool, NativeTool> &
  Record<string, NativeTool>;

/**
 * Resolves selections to the native controls to disable. Only removes tools,
 * so selecting a tool never enables one the harness leaves off. Always-on
 * tools and names of other harnesses' tools are ignored. Throws when an
 * excluded tool's control also governs a kept tool.
 */
export function resolveNativeTools(
  harness: HarnessId,
  tools: HarnessTools,
  allowedTools: readonly string[] | undefined,
  disallowedTools: readonly string[] = [],
): string[] {
  const names = Object.keys(tools);
  const excluded = names.filter(
    name =>
      disallowedTools.includes(name) ||
      (allowedTools !== undefined && !allowedTools.includes(name)),
  );
  const natives = (selected: readonly string[]) =>
    selected.flatMap(name => {
      const native = tools[name];
      return !native || typeof native === 'string' ? [] : native;
    });
  const kept = new Set(natives(names.filter(name => !excluded.includes(name))));
  const blocked = excluded.filter(name =>
    natives([name]).some(native => kept.has(native)),
  );
  if (blocked.length) {
    throw new Error(
      `The ${harness} harness cannot remove built-in tools: ${blocked.join(', ')}`,
    );
  }
  return [...new Set(natives(excluded))];
}
