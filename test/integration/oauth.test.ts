import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, chmod, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {CredentialStore} from '../../src/mcp/credentials.js';
import {startOAuthCallback} from '../../src/mcp/oauth-callback.js';
import {authenticateMcp} from '../../src/mcp/oauth.js';

void test('OAuth callbacks bind different ports, validate state, and close on completion/cancel', async t => {
  const first = await startOAuthCallback();
  const second = await startOAuthCallback();
  t.after(async () => {
    await first.close();
    await second.close();
  });
  assert.notEqual(first.redirectUri, second.redirectUri);
  assert.equal(
    (await fetch(`${first.redirectUri}?state=wrong&code=x`)).status,
    400,
  );
  const response = await fetch(
    `${first.redirectUri}?state=${first.state}&code=accepted`,
  );
  assert.equal(response.status, 200);
  assert.equal(await first.code, 'accepted');
  await first.close();
  await assert.rejects(fetch(first.redirectUri));
  await second.close();
  await assert.rejects(second.code, /cancelled/);
});

void test('SDK OAuth registration, PKCE login, stored reuse, serialized refresh and failure preservation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stratos-oauth-test-'));
  await chmod(directory, 0o700);
  const store = new CredentialStore(directory);
  t.after(() => rm(directory, {recursive: true, force: true}));
  let origin = '';
  let challenge = '';
  let refreshes = 0;
  let opens = 0;
  let failRefresh = false;
  let expiresIn = 3600;
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url!, origin).pathname;
    res.setHeader('Content-Type', 'application/json');
    if (pathname.startsWith('/.well-known/oauth-protected-resource')) {
      res.end(
        JSON.stringify({
          resource: origin + '/mcp',
          authorization_servers: [origin],
        }),
      );
      return;
    }
    if (pathname === '/.well-known/oauth-authorization-server') {
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: origin + '/authorize',
          token_endpoint: origin + '/token',
          registration_endpoint: origin + '/register',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
      );
      return;
    }
    let body = '';
    for await (const part of req) {
      body += part;
    }
    if (pathname === '/register') {
      const metadata = JSON.parse(body);
      res.end(JSON.stringify({...metadata, client_id: 'test-client'}));
      return;
    }
    if (pathname === '/token') {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'refresh_token') {
        refreshes++;
        if (failRefresh) {
          res.writeHead(503).end(
            JSON.stringify({
              error: 'server_error',
              error_description: 'secret-provider-response',
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            access_token: 'refreshed',
            refresh_token: 'rotated',
            expires_in: expiresIn,
            token_type: 'Bearer',
          }),
        );
        return;
      }
      assert.equal(
        createHash('sha256')
          .update(params.get('code_verifier')!)
          .digest('base64url'),
        challenge,
      );
      assert.equal(params.get('code'), 'code');
      res.end(
        JSON.stringify({
          access_token: 'initial',
          refresh_token: 'refresh',
          expires_in: expiresIn,
          token_type: 'Bearer',
        }),
      );
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  t.after(
    () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const browser = async (url: string) => {
    opens++;
    const authorization = new URL(url);
    challenge = authorization.searchParams.get('code_challenge')!;
    assert.equal(
      authorization.searchParams.get('code_challenge_method'),
      'S256',
    );
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set(
      'state',
      authorization.searchParams.get('state')!,
    );
    callback.searchParams.set('code', 'code');
    callback.searchParams.set('iss', origin);
    await fetch(callback);
  };
  const options = {store, openBrowser: browser};
  assert.equal(
    await authenticateMcp(origin + '/mcp', {type: 'oauth'}, options),
    'initial',
  );
  assert.equal(
    await authenticateMcp(origin + '/mcp', {type: 'oauth'}, options),
    'initial',
  );
  assert.equal(opens, 1);
  const record = (await store.list())[0]!;
  await store.save({...record, expiresAt: Date.now() / 1000 + 299});
  assert.deepEqual(
    await Promise.all(
      [1, 2].map(() =>
        authenticateMcp(origin + '/mcp', {type: 'oauth'}, options),
      ),
    ),
    ['refreshed', 'refreshed'],
  );
  assert.equal(refreshes, 1);
  assert.equal((await store.list())[0]!.refreshToken, 'rotated');
  await store.save({...(await store.list())[0]!, expiresAt: 0});
  const before = await readFile(join(directory, 'credentials.json'), 'utf8');
  failRefresh = true;
  await assert.rejects(
    authenticateMcp(origin + '/mcp', {type: 'oauth'}, options),
    error => {
      assert.doesNotMatch(String(error), /secret-provider-response/);
      return true;
    },
  );
  assert.equal(
    await readFile(join(directory, 'credentials.json'), 'utf8'),
    before,
  );
  failRefresh = false;
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  try {
    for (const expiresAt of [Date.now() / 1000 + 301, undefined]) {
      await store.save({...record, expiresAt});
      assert.equal(
        await authenticateMcp(origin + '/mcp', {type: 'oauth'}, options),
        'initial',
      );
    }
    const beforeRefresh = refreshes;
    await store.save({...record, expiresAt: Date.now() / 1000 + 300});
    assert.equal(
      await authenticateMcp(origin + '/mcp', {type: 'oauth'}, options),
      'refreshed',
    );
    assert.equal(refreshes, beforeRefresh + 1);

    for (const lifetime of [0, 299, 300]) {
      expiresIn = lifetime;
      await store.save({...record, expiresAt: 0});
      const attempts: number = refreshes;
      await assert.rejects(
        authenticateMcp(origin + '/mcp', {type: 'oauth'}, options),
        /no more than five minutes/,
      );
      assert.equal(refreshes, attempts + 1, 'Short tokens are not retried');
      assert.equal((await store.list())[0]!.refreshToken, 'rotated');
      assert.equal(opens, 1, 'Short refreshes do not trigger browser sign-in');
    }
    await store.remove(record);
    await assert.rejects(
      authenticateMcp(origin + '/mcp', {type: 'oauth'}, options),
      /no more than five minutes/,
    );
    assert.equal(opens, 2);
    assert.equal((await store.list())[0]!.accessToken, 'initial');
  } finally {
    t.mock.timers.reset();
  }
  await store.remove(record);
  await assert.rejects(
    authenticateMcp(
      origin + '/mcp',
      {type: 'oauth'},
      {
        store,
        openBrowser: async () => {
          throw new Error('browser failed');
        },
      },
    ),
    /Cannot open browser/,
  );
});

void test('OAuth callback timeout and AbortSignal close their listeners', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const callback = await startOAuthCallback();
  t.mock.timers.tick(300000);
  await assert.rejects(callback.code, /five minutes/);
  await callback.close();
  t.mock.timers.reset();
  await assert.rejects(fetch(callback.redirectUri));
  const abort = new AbortController();
  const cancelled = await startOAuthCallback({signal: abort.signal});
  abort.abort();
  await assert.rejects(cancelled.code, /cancelled/);
  await cancelled.close();
  await assert.rejects(fetch(cancelled.redirectUri));
});

void test('credential store preserves concurrent updates and rejects corrupt/unsafe files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stratos-credentials-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const stores = [
    new CredentialStore(directory),
    new CredentialStore(directory),
  ];
  const record = {
    serverUrl: 'https://mcp.example.com',
    authorizationServer: 'https://auth.example.com',
    clientId: 'one',
    accessToken: 'secret',
  };
  await Promise.all(
    stores.map((store, i) => store.save({...record, clientId: String(i)})),
  );
  assert.equal((await stores[0]!.list()).length, 2);
  const file = join(directory, 'credentials.json');
  await chmod(file, 0o644);
  await assert.rejects(stores[0]!.list(), /owner-only/);
  await chmod(file, 0o600);
  const {writeFile} = await import('node:fs/promises');
  await writeFile(file, '{invalid-secret');
  await assert.rejects(stores[0]!.list(), error => {
    assert.match(String(error), /Malformed/);
    assert.doesNotMatch(String(error), /invalid-secret/);
    return true;
  });
});

void test('OAuth discovery cannot reuse stored credentials for another authorization server', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stratos-oauth-binding-'));
  await chmod(directory, 0o700);
  const store = new CredentialStore(directory);
  t.after(() => rm(directory, {recursive: true, force: true}));
  let origin = '';
  let tokenRequests = 0;
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, origin).pathname;
    let body = '';
    for await (const part of req) {
      body += part;
    }
    requests.push(JSON.stringify(req.headers), body);
    res.setHeader('Content-Type', 'application/json');
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      res.end(
        JSON.stringify({
          resource: origin + '/mcp',
          authorization_servers: [origin + '/changed'],
        }),
      );
    } else if (path.startsWith('/.well-known/')) {
      res.end(
        JSON.stringify({
          issuer: origin + '/changed',
          authorization_endpoint: origin + '/authorize',
          token_endpoint: origin + '/token',
          registration_endpoint: origin + '/register',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        }),
      );
    } else {
      if (path === '/token') {
        tokenRequests++;
      }
      res.writeHead(503).end(JSON.stringify({error: 'server_error'}));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  t.after(
    () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const record = {
    serverUrl: origin + '/mcp',
    authorizationServer: origin + '/trusted',
    clientId: 'stored-client',
    clientSecret: 'synthetic-stored-secret',
    accessToken: 'synthetic-stored-access',
    refreshToken: 'synthetic-stored-refresh',
  };
  for (const expiresAt of [0, Date.now() / 1000 + 3600]) {
    await store.save({...record, expiresAt});
    const before = await readFile(join(directory, 'credentials.json'), 'utf8');
    await assert.rejects(
      authenticateMcp(
        record.serverUrl,
        {type: 'oauth'},
        {
          store,
          openBrowser: async () => {
            throw new Error('Unexpected browser sign-in');
          },
        },
      ),
    );
    assert.equal(tokenRequests, 0);
    for (const secret of [
      record.clientSecret,
      record.accessToken,
      record.refreshToken,
    ]) {
      assert.ok(requests.every(request => !request.includes(secret)));
    }
    assert.equal(
      await readFile(join(directory, 'credentials.json'), 'utf8'),
      before,
    );
  }
});

void test('configured OAuth secrets trust first discovery, persist it before sign-in, and reject server changes until logout', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stratos-oauth-first-use-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, {recursive: true, force: true}));
  const store = new CredentialStore(directory);
  let origin = '';
  let issuer = '';
  let opens = 0;
  let failBrowser = true;
  let failExchange = false;
  const tokenRequests: Array<{
    path: string;
    secret: string | null;
    grant: string | null;
  }> = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, origin).pathname;
    res.setHeader('Content-Type', 'application/json');
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      res.end(
        JSON.stringify({
          resource: origin + '/mcp',
          authorization_servers: [issuer],
        }),
      );
      return;
    }
    if (path.startsWith('/.well-known/')) {
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: issuer + '/authorize',
          token_endpoint: issuer + '/token',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        }),
      );
      return;
    }
    let body = '';
    for await (const part of req) {
      body += part;
    }
    if (path.endsWith('/token')) {
      const params = new URLSearchParams(body);
      tokenRequests.push({
        path,
        secret: params.get('client_secret'),
        grant: params.get('grant_type'),
      });
      if (failExchange) {
        res.writeHead(503).end(JSON.stringify({error: 'server_error'}));
        return;
      }
      res.end(
        JSON.stringify({
          access_token: 'synthetic-access',
          refresh_token: 'synthetic-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  issuer = origin + '/first';
  t.after(
    () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const serverUrl = origin + '/mcp';
  const settings = {
    type: 'oauth' as const,
    clientId: 'configured-client',
    clientSecret: 'synthetic-configured-secret',
  };
  const browser = async (url: string) => {
    opens++;
    const binding = await new CredentialStore(directory).find(
      serverUrl,
      issuer,
      settings.clientId,
    );
    assert.ok(binding, 'Binding must exist before browser sign-in');
    if (failBrowser) {
      throw new Error('Synthetic browser failure');
    }
    const authorization = new URL(url);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set(
      'state',
      authorization.searchParams.get('state')!,
    );
    callback.searchParams.set('code', 'synthetic-code');
    callback.searchParams.set('iss', issuer);
    assert.equal((await fetch(callback)).status, 200);
  };
  const login = () =>
    authenticateMcp(serverUrl, settings, {
      store: new CredentialStore(directory),
      openBrowser: browser,
    });
  await assert.rejects(login(), /Cannot open browser/);
  const binding = {
    serverUrl,
    authorizationServer: issuer,
    clientId: settings.clientId,
  };
  assert.deepEqual(await store.list(), [binding]);
  assert.equal(tokenRequests.length, 0);
  const rejectsChanged = async () => {
    const before = await readFile(join(directory, 'credentials.json'), 'utf8');
    const previousOpens = opens;
    const previousRequests = tokenRequests.length;
    issuer = origin + '/changed';
    await assert.rejects(login(), /authorization server changed/);
    assert.equal(opens, previousOpens);
    assert.equal(tokenRequests.length, previousRequests);
    assert.equal(
      await readFile(join(directory, 'credentials.json'), 'utf8'),
      before,
    );
    issuer = origin + '/first';
  };
  await rejectsChanged();
  failBrowser = false;
  failExchange = true;
  await assert.rejects(login(), /authentication failed/);
  await rejectsChanged();
  failExchange = false;
  assert.equal(await login(), 'synthetic-access');
  assert.equal(tokenRequests.at(-1)?.secret, settings.clientSecret);
  assert.equal(tokenRequests.at(-1)?.grant, 'authorization_code');
  const previousOpens = opens;
  assert.equal(await login(), 'synthetic-access');
  assert.equal(opens, previousOpens, 'Fresh credentials need no browser');
  await rejectsChanged();
  await store.save({...(await store.list())[0]!, expiresAt: 0});
  await rejectsChanged();
  assert.equal(await login(), 'synthetic-access');
  assert.equal(tokenRequests.at(-1)?.grant, 'refresh_token');
  assert.equal(opens, previousOpens, 'Refresh needs no browser');
  settings.clientSecret = 'synthetic-rotated-secret';
  await rejectsChanged();
  await store.remove(binding);
  issuer = origin + '/changed';
  assert.equal(await login(), 'synthetic-access');
  assert.equal(tokenRequests.at(-1)?.path, '/changed/token');
  assert.equal(tokenRequests.at(-1)?.secret, settings.clientSecret);
  assert.equal((await store.list())[0]?.authorizationServer, issuer);
});

void test('first-use binding is atomic, adopts existing records, and preserves unrelated credentials', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'stratos-oauth-binding-race-'),
  );
  await chmod(directory, 0o700);
  t.after(() => rm(directory, {recursive: true, force: true}));
  const first = new CredentialStore(directory);
  const second = new CredentialStore(directory);
  const key = {
    serverUrl: 'https://mcp.example.com',
    clientId: 'configured-client',
    authorizationServer: 'https://first.example.com',
  };
  const other = {...key, authorizationServer: 'https://other.example.com'};
  const outcomes = await Promise.allSettled([
    first.bindAuthorizationServer(key),
    second.bindAuthorizationServer(other),
  ]);
  assert.equal(
    outcomes.filter(result => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    outcomes.filter(result => result.status === 'rejected').length,
    1,
  );
  const [bound] = await first.list();
  assert.ok(bound);
  assert.equal((await first.list()).length, 1);
  const existing = {
    ...bound,
    clientSecret: 'synthetic-secret',
    accessToken: 'synthetic-access',
    refreshToken: 'synthetic-refresh',
  };
  await first.save(existing);
  await second.bindAuthorizationServer(bound);
  assert.deepEqual(await first.list(), [existing]);
  await assert.rejects(
    second.bindAuthorizationServer({
      ...bound,
      authorizationServer: 'https://third.example.com',
    }),
    /authorization server changed/,
  );
  assert.deepEqual(await first.list(), [existing]);
  await second.bindAuthorizationServer({
    ...other,
    clientId: 'different-client',
  });
  await second.bindAuthorizationServer({
    ...other,
    serverUrl: 'https://different-mcp.example.com',
  });
  assert.equal((await first.list()).length, 3);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    first.bindAuthorizationServer(
      {...key, clientId: 'cancelled'},
      abort.signal,
    ),
  );
  assert.equal((await first.list()).length, 3);
});
