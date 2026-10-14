import type {CommandResult} from './result.js';
import type {HarnessId} from '../models/candidates.js';

export const toolHarnesses: readonly HarnessId[] = [
  'claude-code',
  'codex',
  'opencode',
];
const usage = 'Use stratos tools list [claude-code | codex | opencode].';

/** Lists the built-in tool names `allowedTools`/`disallowedTools` accept. */
export async function toolsCommand(
  action: string | undefined,
  harness: string | undefined,
): Promise<CommandResult> {
  if (
    action !== 'list' ||
    (harness !== undefined && !toolHarnesses.includes(harness as HarnessId))
  ) {
    throw new Error(usage);
  }
  const {harnessTools} = await import('../agents/native.js');
  const data = (harness ? [harness as HarnessId] : toolHarnesses).map(id => {
    const tools = Object.entries(harnessTools[id]);
    return {
      harness: id,
      tools: tools
        .filter(([, native]) => Array.isArray(native))
        .map(([name]) => name),
      alwaysOn: tools
        .filter(([, native]) => native === 'fixed')
        .map(([name]) => name),
    };
  });
  const line = (label: string, names: readonly string[]) =>
    names.length ? [`  ${label}: ${names.join(', ')}`] : [];
  return {
    success: true,
    message: data
      .map(entry =>
        [
          entry.harness,
          ...line('tools', entry.tools),
          ...line('always on (cannot be removed)', entry.alwaysOn),
        ].join('\n'),
      )
      .join('\n'),
    data,
  };
}
