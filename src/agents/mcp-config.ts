import {z} from 'zod';

import type {CredentialRecord} from '../mcp/credentials.js';
import {
  authenticateMcpCredentials,
  ensureMcpTokenLifetime,
  type OAuthSettings,
} from '../mcp/oauth.js';
import {interpolateSecretReferences, readSecretFile} from '../secrets.js';
import type {ClaudeAdapterOptions} from './claude/adapter.js';
import type {CodexAdapterOptions} from './codex/adapter.js';
import type {OpenCodeAdapterOptions} from './opencode/adapter.js';

const strings = z.record(z.string(), z.string());
const server = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('http'),
    url: z
      .url()
      .refine(value => ['http:', 'https:'].includes(new URL(value).protocol)),
    headers: strings.optional(),
    auth: z
      .strictObject({
        type: z.literal('oauth'),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        scope: z.string().optional(),
        callbackPort: z.number().int().min(1).max(65535).optional(),
        redirectUri: z.url().optional(),
        clientMetadataUrl: z.url().optional(),
      })
      .optional(),
  }),
  z.strictObject({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: strings.optional(),
  }),
]);
export const mcpConfiguration = z.strictObject({
  servers: z.record(z.string(), server),
});
export type McpConfiguration = z.infer<typeof mcpConfiguration>;
export interface AgentMcpConfigurations {
  claude: NonNullable<ClaudeAdapterOptions['mcpServers']>;
  codex: NonNullable<CodexAdapterOptions['mcpServers']>;
  opencode: NonNullable<OpenCodeAdapterOptions['mcpServers']>;
}

/** Authenticate declared OAuth servers without opening native MCP connections. */
export async function authenticateWorkflowMcps(
  raw: unknown,
  workflowRoot: string,
  signal: AbortSignal,
  secret: (value: string) => void,
): Promise<void> {
  const config = mcpConfiguration.parse(raw ?? {servers: {}});
  const records: CredentialRecord[] = [];
  for (const entry of Object.values(config.servers)) {
    signal.throwIfAborted();
    if (entry.type === 'http' && entry.auth) {
      const record = await authenticateServer(
        entry.url,
        entry.auth,
        workflowRoot,
        signal,
      );
      secret(record.accessToken!);
      records.push(record);
    }
  }
  signal.throwIfAborted();
  // Another server's browser sign-in may have consumed an earlier token's margin.
  records.forEach(ensureMcpTokenLifetime);
}

/** Secrets are resolved only for selected servers, immediately before native initialization. */
export async function prepareAgentMcps(
  raw: unknown,
  allowed: readonly string[],
  workflowRoot: string,
  signal?: AbortSignal,
  secret?: (value: string) => void,
): Promise<AgentMcpConfigurations> {
  const config = mcpConfiguration.parse(raw ?? {servers: {}});
  const result: AgentMcpConfigurations = {
    claude: Object.create(null),
    codex: Object.create(null),
    opencode: Object.create(null),
  };
  for (const name of new Set(allowed)) {
    signal?.throwIfAborted();
    if (!Object.hasOwn(config.servers, name)) {
      throw new Error(`Unknown MCP server: ${name}`);
    }
    const entry = config.servers[name]!;
    if (entry.type === 'http') {
      const headers = await resolveValues(entry.headers ?? {}, workflowRoot);
      if (entry.auth) {
        const record = await authenticateServer(
          entry.url,
          entry.auth,
          workflowRoot,
          signal,
        );
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'authorization') {
            delete headers[key];
          }
        }
        headers.Authorization = `Bearer ${record.accessToken}`;
      }
      for (const [key, value] of Object.entries(headers)) {
        if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || /[\r\n]/.test(value)) {
          throw new Error(`Invalid MCP header for ${name}`);
        }
      }
      for (const value of Object.values(headers)) {
        secret?.(value);
      }
      result.claude[name] = {type: 'http', url: entry.url, headers};
      result.codex[name] = {url: entry.url, http_headers: headers};
      result.opencode[name] = {
        type: 'remote',
        url: entry.url,
        headers,
        oauth: false,
        enabled: true,
      };
    } else {
      const env = await resolveValues(entry.env ?? {}, workflowRoot);
      for (const value of Object.values(env)) {
        secret?.(value);
      }
      result.claude[name] = {
        type: 'stdio',
        command: entry.command,
        args: entry.args ?? [],
        env,
      };
      result.codex[name] = {
        command: entry.command,
        args: entry.args ?? [],
        env,
      };
      result.opencode[name] = {
        type: 'local',
        command: [entry.command, ...(entry.args ?? [])],
        environment: env,
        enabled: true,
      };
    }
  }
  return result;
}

async function authenticateServer(
  url: string,
  auth: OAuthSettings,
  root: string,
  signal?: AbortSignal,
): Promise<CredentialRecord> {
  const secrets = await resolveValues(
    auth.clientSecret ? {clientSecret: auth.clientSecret} : {},
    root,
  );
  return authenticateMcpCredentials(
    url,
    {...auth, clientSecret: secrets.clientSecret},
    {signal},
  );
}

async function resolveValues(
  values: Record<string, string>,
  root: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, template] of Object.entries(values)) {
    result[key] = await interpolateSecretReferences(
      template,
      async (kind, name) => {
        if (kind === 'env') {
          const content = process.env[name];
          if (content === undefined) {
            throw new Error(`Missing MCP environment variable: ${name}`);
          }
          return content;
        }
        try {
          return await readSecretFile(name, root);
        } catch {
          throw new Error(
            `Cannot read MCP secret file for ${key}; check path and owner-only permissions`,
          );
        }
      },
    );
  }
  return result;
}
