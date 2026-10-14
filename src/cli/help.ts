import {toolHarnesses} from './tools.js';
import type {HarnessId} from '../models/candidates.js';

const commands: Record<
  string,
  {usage: string; description: string; target?: boolean}
> = {
  list: {
    usage: 'list',
    description:
      'Discover project and user workflows and report build status without building or running them.',
  },
  build: {
    usage: 'build [workflow | --name workflow]',
    description:
      'Validate declared Ollama models, refresh MCP wrappers and build a workflow and its children. Omit the target to build the current project. A manifest-only result prepares MCP wrappers, not a runnable workflow.',
    target: true,
  },
  schema: {
    usage: 'schema <workflow | --name workflow>',
    description:
      'Return workflow input/output JSON Schemas, building if needed without invoking the workflow body.',
    target: true,
  },
  describe: {
    usage: 'describe <workflow | --name workflow>',
    description:
      'Return workflow descriptions and input/output JSON Schemas. Read the manual before running an unfamiliar workflow. May install dependencies, prepare MCP wrappers and evaluate modules, but does not invoke the workflow body.',
    target: true,
  },
  run: {
    usage: 'run <workflow | --name workflow> [--input JSON] [--overrides JSON]',
    description:
      'Execute a workflow, building if needed. --input supplies its input object; --overrides supplies named agent/Decision settings. Execution can have side effects.',
    target: true,
  },
  clean: {
    usage: 'clean [workflow | --name workflow]',
    description:
      'Remove generated artifacts, preserving authored files, dependencies and credentials. Omit the target to clean the current project.',
    target: true,
  },
  mcp: {
    usage: 'mcp <list | login | logout>',
    description:
      'List workflow MCP configurations or manage their OAuth credentials. Use stratos mcp <action> --help for arguments.',
  },
  'mcp list': {
    usage: 'mcp list [--workflow workflow]',
    description:
      'List configured MCP servers qualified by workflow, without authenticating or connecting.',
  },
  'mcp login': {
    usage: 'mcp login <server | --name server> [--workflow workflow]',
    description:
      'Authenticate with a configured OAuth MCP server. --workflow selects the owning workflow when server names are ambiguous.',
    target: true,
  },
  'mcp logout': {
    usage: 'mcp logout <server | --name server> [--workflow workflow]',
    description:
      'Remove local credentials for a configured MCP server. --workflow selects the owning workflow when server names are ambiguous.',
    target: true,
  },
  skill: {
    usage: 'skill <install | status | uninstall>',
    description:
      'Manage the bundled workflow-authoring skill globally for the current user. Use stratos skill <action> --help for arguments.',
  },
  'skill install': {
    usage: 'skill install <--agent names | --all>',
    description:
      'Install the bundled authoring skill for comma-separated codex, claude, gemini, cursor, copilot or opencode targets. --all selects every supported target. Existing unrelated skills are preserved.',
  },
  'skill status': {
    usage: 'skill status [--agent names | --all]',
    description:
      'Inspect authoring-skill installation without changing files. Defaults to every supported target.',
  },
  'skill uninstall': {
    usage: 'skill uninstall <--agent names | --all>',
    description:
      'Remove only Stratos-owned skill links for the selected targets, preserving source files and unrelated skills.',
  },
  provider: {
    usage: 'provider status ollama',
    description:
      'Inspect provider readiness. Only Ollama status is currently supported; no provider setup or installation command is implemented.',
  },
  'provider status': {
    usage: 'provider status ollama',
    description:
      'Read-only Ollama readiness, installed-model metadata and install/start guidance. Uses OLLAMA_HOST (default http://127.0.0.1:11434). Does not install software, start services, pull models or perform inference.',
    target: true,
  },
  tools: {
    usage: 'tools list [claude-code | codex | opencode]',
    description:
      'List agent built-in tool names. Use stratos tools list --help for arguments.',
  },
  'tools list': {
    usage: 'tools list [claude-code | codex | opencode]',
    description:
      'List the built-in tool names allowedTools/disallowedTools accept for each harness, or one harness, and its always-on tools. Read-only; starts no harness.',
    target: true,
  },
};

export function commandHelp(positionals: string[]): string {
  const [action, subcommand, target] = positionals;
  const grouped = ['mcp', 'skill', 'provider', 'tools'].includes(action ?? '');
  const key =
    grouped && subcommand ? `${action} ${subcommand}` : (action ?? '');
  const entry = Object.hasOwn(commands, key) ? commands[key] : undefined;
  if (!entry) {
    throw new Error(`Unknown command ${key}. Run stratos --help.`);
  }
  if (
    positionals.length > key.split(' ').length + (entry.target ? 1 : 0) ||
    (action === 'provider' && target !== undefined && target !== 'ollama') ||
    (action === 'tools' &&
      target !== undefined &&
      !toolHarnesses.includes(target as HarnessId))
  ) {
    throw new Error(`Use stratos ${entry.usage} [--json].`);
  }
  return `Usage: stratos ${entry.usage} [--json]\n\n${entry.description}\n\nOptions:\n  --help  Show this command's help without executing it.\n  --json  Return the common structured result.\n\nThe st alias accepts the same arguments.`;
}
