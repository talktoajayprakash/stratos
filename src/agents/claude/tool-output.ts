import type {BashOutput} from '@anthropic-ai/claude-agent-sdk/sdk-tools';

/** Invalid built-in output shapes are silently ignored by Claude. Never send a
 * generic string and claim withholding succeeded for an unmapped native tool.
 */
export function blockedClaudeOutput(toolName: string, reason: string): unknown {
  if (toolName === 'Bash') {
    return {
      stdout: reason,
      stderr: '',
      interrupted: false,
      isImage: false,
    } satisfies BashOutput;
  }
  if (toolName.startsWith('mcp__')) {
    return reason;
  }
  throw new Error(
    `Claude output blocking is not yet mapped for tool ${toolName}`,
  );
}
