import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {InvalidGrantError} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import {CredentialStore, type CredentialRecord} from './credentials.js';
import {startOAuthCallback} from './oauth-callback.js';

export interface OAuthSettings {
  type: 'oauth';
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  callbackPort?: number;
  redirectUri?: string;
  clientMetadataUrl?: string;
}
const fresh = (record?: CredentialRecord) =>
  !!record?.accessToken &&
  (record.expiresAt === undefined ||
    record.expiresAt > Date.now() / 1000 + 300);
export function ensureMcpTokenLifetime(record: CredentialRecord): void {
  if (!fresh(record)) {
    throw new Error(
      'MCP OAuth access token has no more than five minutes remaining; authentication cannot proceed safely',
    );
  }
}
const clientInfo = (record: CredentialRecord): OAuthClientInformationMixed => ({
  client_id: record.clientId,
  issuer: record.authorizationServer,
  client_secret: record.clientSecret,
  ...(record.tokenEndpointAuthMethod
    ? {token_endpoint_auth_method: record.tokenEndpointAuthMethod}
    : {}),
});
function withTokens(
  record: CredentialRecord,
  tokens: OAuthTokens,
): CredentialRecord {
  return {
    ...record,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? record.refreshToken,
    expiresAt:
      tokens.expires_in === undefined
        ? undefined
        : Date.now() / 1000 + tokens.expires_in,
    scope: tokens.scope ?? record.scope,
  };
}

export async function authenticateMcp(
  ...args: Parameters<typeof authenticateMcpCredentials>
): Promise<string> {
  return (await authenticateMcpCredentials(...args)).accessToken!;
}

/** Shared explicit/on-demand OAuth flow. No file/refresh lock spans browser sign-in. */
export async function authenticateMcpCredentials(
  serverUrl: string,
  settings: OAuthSettings,
  options: {
    store?: CredentialStore;
    signal?: AbortSignal;
    openBrowser?: (url: string) => Promise<void>;
  } = {},
): Promise<CredentialRecord> {
  const store = options.store ?? new CredentialStore();
  const fetchFn: typeof fetch = (url, init) =>
    fetch(url, {
      ...init,
      signal: options.signal
        ? AbortSignal.any([
            options.signal,
            ...(init?.signal ? [init.signal] : []),
          ])
        : init?.signal,
    });
  let discovery;
  try {
    discovery = await discoverOAuthServerInfo(serverUrl, {fetchFn});
  } catch {
    throw new Error('MCP OAuth authorization-server discovery failed');
  }
  options.signal?.throwIfAborted();
  if (settings.clientId && settings.clientSecret !== undefined) {
    await store.bindAuthorizationServer(
      {
        serverUrl,
        authorizationServer: discovery.authorizationServerUrl,
        clientId: settings.clientId,
      },
      options.signal,
    );
  }
  let record = await store.find(
    serverUrl,
    discovery.authorizationServerUrl,
    settings.clientId,
  );
  if (fresh(record)) {
    options.signal?.throwIfAborted();
    return record!;
  }
  if (record?.refreshToken) {
    const key = record;
    const refreshed = await store.refreshLock(
      key,
      async () => {
        record = await store.find(
          serverUrl,
          key.authorizationServer,
          key.clientId,
        );
        if (fresh(record)) {
          return record;
        }
        if (!record?.refreshToken) {
          return undefined;
        }
        try {
          const tokens = await refreshAuthorization(
            discovery.authorizationServerUrl,
            {
              metadata: discovery.authorizationServerMetadata,
              clientInformation: clientInfo(record),
              refreshToken: record.refreshToken,
              resource: new URL(serverUrl),
              fetchFn,
            },
          );
          record = withTokens(record, tokens);
          await store.save(record, options.signal);
          return record;
        } catch (error) {
          if (!(error instanceof InvalidGrantError)) {
            throw new Error(
              'MCP OAuth token refresh failed; stored credentials were preserved',
            );
          }
          record = {
            ...record,
            accessToken: undefined,
            refreshToken: undefined,
            expiresAt: undefined,
          };
          await store.save(record, options.signal);
          return undefined;
        }
      },
      options.signal,
    );
    if (refreshed) {
      options.signal?.throwIfAborted();
      ensureMcpTokenLifetime(refreshed);
      return refreshed;
    }
  }
  const abort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, abort.signal])
    : abort.signal;
  const metadata = discovery.authorizationServerMetadata;
  const callback = await startOAuthCallback({
    callbackPort: settings.callbackPort,
    redirectUri: settings.redirectUri,
    signal,
    issuer: metadata?.issuer,
    requireIssuer:
      !!metadata &&
      'authorization_response_iss_parameter_supported' in metadata &&
      metadata.authorization_response_iss_parameter_supported === true,
  });
  void callback.code.catch(() => abort.abort());
  let verifier: string | undefined;
  let information: OAuthClientInformationMixed | undefined = settings.clientId
    ? {
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        issuer: discovery.authorizationServerUrl,
      }
    : record
      ? clientInfo(record)
      : undefined;
  if (
    record?.clientSecretExpiresAt &&
    record.clientSecretExpiresAt <= Date.now() / 1000 &&
    !settings.clientId
  ) {
    information = undefined;
  }
  const base = (): CredentialRecord => ({
    serverUrl,
    authorizationServer: discovery.authorizationServerUrl,
    clientId: information!.client_id,
    clientSecret: information!.client_secret,
    clientSecretExpiresAt:
      'client_secret_expires_at' in information! &&
      typeof information!.client_secret_expires_at === 'number'
        ? information!.client_secret_expires_at
        : undefined,
    tokenEndpointAuthMethod:
      'token_endpoint_auth_method' in information!
        ? information!.token_endpoint_auth_method
        : undefined,
  });
  const provider: OAuthClientProvider = {
    redirectUrl: callback.redirectUri,
    clientMetadataUrl: settings.clientMetadataUrl,
    clientMetadata: {
      client_name: 'Stratos',
      redirect_uris: [callback.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: settings.scope,
    },
    state: () => callback.state,
    discoveryState: () => discovery,
    clientInformation: () => information,
    async saveClientInformation(info) {
      information = info;
      record = base();
      await store.save(record, signal);
    },
    tokens: () => undefined, // Refresh is handled above under a dedicated lock.
    async saveTokens(tokens) {
      record = withTokens(base(), tokens);
      await store.save(record, signal);
    },
    async redirectToAuthorization(url) {
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Invalid OAuth authorization URL');
      }
      console.error(
        'MCP sign-in required. Complete authentication in your browser to continue.',
      );
      try {
        await (options.openBrowser
          ? options.openBrowser(url.href)
          : launchBrowser(url.href, signal));
      } catch {
        throw new Error('Cannot open browser for MCP authentication');
      }
    },
    saveCodeVerifier(value) {
      verifier = value;
    },
    codeVerifier() {
      if (!verifier) {
        throw new Error('Missing OAuth PKCE verifier');
      }
      return verifier;
    },
  };
  const authFetch: typeof fetch = (url, init) =>
    fetchFn(url, {...init, signal});
  try {
    const result = await auth(provider, {
      serverUrl,
      scope: settings.scope,
      fetchFn: authFetch,
    });
    if (result === 'REDIRECT') {
      const code = await callback.code;
      await auth(provider, {
        serverUrl,
        authorizationCode: code,
        scope: settings.scope,
        fetchFn: authFetch,
      });
    }
    if (!record?.accessToken) {
      throw new Error('MCP OAuth did not provide an access token');
    }
  } catch (error) {
    // SDK/provider responses may contain secrets: never forward raw response bodies.
    if (
      error instanceof Error &&
      [
        'Cannot open browser for MCP authentication',
        'OAuth authentication timed out after five minutes',
        'OAuth authentication cancelled',
        'OAuth authorization was rejected',
        'OAuth authorization issuer mismatch',
      ].includes(error.message)
    ) {
      throw error;
    }
    throw new Error('MCP OAuth authentication failed');
  } finally {
    await callback.close();
  }
  options.signal?.throwIfAborted();
  ensureMcpTokenLifetime(record!);
  return record!;
}
async function launchBrowser(url: string, signal?: AbortSignal): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'linux'
        ? 'xdg-open'
        : undefined;
  if (!command) {
    throw new Error('Unsupported browser-launch platform');
  }
  await promisify(execFile)(command, [url], {signal});
}
