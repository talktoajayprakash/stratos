import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';

export interface OAuthCallback {
  redirectUri: string;
  state: string;
  code: Promise<string>;
  close(): Promise<void>;
}

/** One short-lived listener per sign-in. PKCE and token exchange belong to the MCP SDK. */
export async function startOAuthCallback(
  options: {
    callbackPort?: number;
    redirectUri?: string;
    signal?: AbortSignal;
    issuer?: string;
    requireIssuer?: boolean;
  } = {},
): Promise<OAuthCallback> {
  options.signal?.throwIfAborted();
  const uri = new URL(
    options.redirectUri ??
      `http://127.0.0.1:${options.callbackPort ?? 0}/mcp/oauth/callback`,
  );
  if (
    uri.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname) ||
    uri.username ||
    uri.password ||
    uri.search ||
    uri.hash
  ) {
    throw new Error(
      'OAuth redirect URI must be a loopback HTTP callback without credentials, query or fragment',
    );
  }
  if (
    options.callbackPort !== undefined &&
    options.redirectUri &&
    Number(uri.port || 80) !== options.callbackPort
  ) {
    throw new Error('OAuth callback port conflicts with redirect URI');
  }
  const state = randomBytes(32).toString('hex');
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The caller may still be performing discovery when cancellation occurs.
  void code.catch(() => {});
  const stop = () =>
    (closing ??= new Promise<void>((resolve, reject) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      server.close(error =>
        error &&
        (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
          ? reject(error)
          : resolve(),
      );
      server.closeAllConnections();
    }));
  const finish = (result: string | Error) => {
    if (settled) {
      return;
    }
    settled = true;
    if (result instanceof Error) {
      rejectCode(result);
    } else {
      resolveCode(result);
    }
    void stop().catch(() => {});
  };
  const abort = () => finish(new Error('OAuth authentication cancelled'));
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    const target = new URL(req.url ?? '/', uri.origin);
    if (req.method !== 'GET' || target.pathname !== uri.pathname) {
      res.writeHead(404).end('Not found');
      return;
    }
    const received = target.searchParams.get('state') ?? '';
    if (
      target.searchParams.getAll('state').length !== 1 ||
      Buffer.byteLength(received) !== Buffer.byteLength(state) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(state))
    ) {
      res.writeHead(400).end('Invalid OAuth state');
      return;
    }
    const issuer = target.searchParams.get('iss');
    if (
      (options.requireIssuer && !issuer) ||
      (issuer !== null && issuer !== options.issuer)
    ) {
      res.writeHead(400).end('Invalid OAuth issuer');
      finish(new Error('OAuth authorization issuer mismatch'));
      return;
    }
    if (target.searchParams.has('error')) {
      res.writeHead(400).end('Authorization failed');
      finish(new Error('OAuth authorization was rejected'));
      return;
    }
    const value = target.searchParams.get('code');
    if (!value) {
      res.writeHead(400).end('Missing authorization code');
      return;
    }
    res.end('Authentication complete. You can close this window.');
    // Allow the response to flush before closing this connection.
    res.once('finish', () => finish(value));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(
      Number(uri.port || 80),
      uri.hostname === '[::1]'
        ? '::1'
        : uri.hostname === 'localhost'
          ? '127.0.0.1'
          : uri.hostname,
      resolve,
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await stop();
    throw new Error('OAuth callback failed to bind');
  }
  uri.port = String(address.port);
  timer = setTimeout(
    () =>
      finish(new Error('OAuth authentication timed out after five minutes')),
    5 * 60 * 1000,
  );
  options.signal?.addEventListener('abort', abort, {once: true});
  if (options.signal?.aborted) {
    abort();
  }
  return {
    redirectUri: uri.href,
    state,
    code,
    async close() {
      finish(new Error('OAuth authentication cancelled'));
      await stop();
    },
  };
}
