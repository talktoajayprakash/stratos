import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import type {TestContext} from 'node:test';

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';

/** Local OAuth/MCP fixture, not external-provider authentication evidence. */
export async function mcpAuthFixture(t: TestContext) {
  const state = {
    token: 'fixture-access-1',
    refreshes: 0,
    logins: 0,
    discoveries: 0,
    calls: [] as Array<{value: string | number; token: string}>,
    input: 'number' as 'number' | 'string' | 'both',
    toolName: 'echo',
    failDiscovery: false,
    failRefresh: false,
    expiresIn: 3600,
    requests: [] as string[],
  };
  const resources: McpServer[] = [];
  let origin = '';
  let challenge = '';
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, origin).pathname;
      state.requests.push(`${req.method} ${path}`);
      const json = (value: unknown, code = 200) => {
        res
          .writeHead(code, {'content-type': 'application/json'})
          .end(JSON.stringify(value));
      };
      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        json({resource: `${origin}/mcp`, authorization_servers: [origin]});
        return;
      }
      if (path === '/.well-known/oauth-authorization-server') {
        json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
        return;
      }
      if (path === '/authorize') {
        state.logins++;
        const url = new URL(req.url!, origin);
        challenge = url.searchParams.get('code_challenge')!;
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        callback.searchParams.set('code', 'fixture-code');
        callback.searchParams.set('iss', origin);
        res.writeHead(302, {location: callback.href}).end();
        return;
      }
      if (
        path === '/mcp' &&
        req.headers.authorization !== `Bearer ${state.token}`
      ) {
        json({error: 'unauthorized'}, 401);
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      if (path === '/register') {
        json({...JSON.parse(body), client_id: 'fixture-client'});
        return;
      }
      if (path === '/token') {
        const params = new URLSearchParams(body);
        if (params.get('grant_type') === 'refresh_token') {
          state.refreshes++;
          if (state.failRefresh) {
            json({error: 'server_error'}, 503);
            return;
          }
          state.token = `fixture-access-${state.refreshes + 1}`;
        } else if (
          createHash('sha256')
            .update(params.get('code_verifier') ?? '')
            .digest('base64url') !== challenge
        ) {
          json({error: 'invalid_grant'}, 400);
          return;
        }
        json({
          access_token: state.token,
          refresh_token: 'fixture-refresh',
          expires_in: state.expiresIn,
          token_type: 'Bearer',
        });
        return;
      }
      if (path !== '/mcp') {
        json({}, 404);
        return;
      }
      const message = JSON.parse(body);
      state.requests.push(message.method);
      if (message.method === 'tools/list') {
        state.discoveries++;
        if (state.failDiscovery) {
          json({error: 'unavailable'}, 503);
          return;
        }
      }
      const mcp = new McpServer({name: 'auth-fixture', version: '1'});
      mcp.registerTool(
        state.toolName,
        {
          description: 'Echo the supplied value',
          inputSchema: {
            value:
              state.input === 'number'
                ? z.number().describe('Value')
                : state.input === 'string'
                  ? z.string().describe('Value')
                  : z.union([z.number(), z.string()]).describe('Value'),
          },
        },
        async ({value}) => {
          state.calls.push({value, token: req.headers.authorization!});
          return {content: [{type: 'text', text: String(value)}]};
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      resources.push(mcp);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, message);
    } catch (error) {
      t.diagnostic(String(error));
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    }
  });
  t.after(async () => {
    await Promise.all(resources.map(resource => resource.close()));
    await new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing fixture address');
  }
  origin = `http://127.0.0.1:${address.port}`;
  return {url: `${origin}/mcp`, origin, state};
}
