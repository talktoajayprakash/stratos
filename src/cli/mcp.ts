import type {CommandResult} from './result.js';
import {mcpConfiguration, prepareAgentMcps} from '../agents/mcp-config.js';
import {CredentialStore} from '../mcp/credentials.js';
import {discover, selectWorkflow} from '../workflows/discovery.js';

export async function mcpCommand(
  action: string | undefined,
  name: string | undefined,
  workflowTarget: string | undefined,
  cwd: string,
): Promise<CommandResult> {
  const found = workflowTarget
    ? {workflows: [await selectWorkflow(cwd, workflowTarget)], errors: []}
    : await discover(cwd);
  const entries = found.workflows.flatMap(workflow =>
    Object.entries(
      mcpConfiguration.parse(workflow.mcp ?? {servers: {}}).servers,
    ).map(([name, server]) => ({name, server, workflow})),
  );
  if (action === 'list') {
    if (name) {
      throw new Error('mcp list does not accept a server name');
    }
    const data = entries.map(entry => ({
      name: entry.name,
      workflow: entry.workflow.name,
      path: entry.workflow.path,
      type: entry.server.type,
    }));
    return {
      success: found.errors.length === 0,
      message:
        data.map(entry => `${entry.name} (${entry.workflow})`).join('\n') ||
        'No MCP servers found.',
      data,
      ...(found.errors.length ? {errors: found.errors} : {}),
    };
  }
  if (!['login', 'logout'].includes(action ?? '') || !name) {
    throw new Error(
      'Use stratos mcp list, login --name <server>, or logout --name <server>',
    );
  }
  const matches = entries.filter(entry => entry.name === name);
  if (!matches.length) {
    throw new Error(`MCP server not found: ${name}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `MCP server ${name} is ambiguous; specify --workflow: ${matches.map(entry => entry.workflow.path).join(', ')}`,
    );
  }
  const {server, workflow} = matches[0]!;
  if (server.type !== 'http' || !server.auth) {
    return {
      success: true,
      message: `${name} uses explicit credentials; OAuth ${action} is not needed.`,
    };
  }
  if (action === 'login') {
    await prepareAgentMcps(workflow.mcp, [name], workflow.path);
    return {
      success: true,
      message: `Authenticated ${name} (${workflow.name}).`,
    };
  }
  const store = new CredentialStore();
  const records = (await store.list()).filter(
    record =>
      record.serverUrl === server.url &&
      (!server.auth?.clientId || record.clientId === server.auth.clientId),
  );
  if (records.length > 1) {
    throw new Error(
      'Multiple MCP credential identities match; specify the registered client ID',
    );
  }
  for (const record of records) {
    await store.remove(record);
  }
  return {
    success: true,
    message: `Removed local credentials for ${name} (${workflow.name}).`,
  };
}
