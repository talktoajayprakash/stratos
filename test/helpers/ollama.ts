import {once} from 'node:events';
import {createServer} from 'node:http';
import type {TestContext} from 'node:test';

export async function ollamaFixture(t: TestContext, prefix = '') {
  const models: Record<string, {capabilities: string[]; remote_host?: string}> =
    {
      'gemma4:26b': {capabilities: ['completion', 'tools', 'thinking']},
      'custom:latest': {capabilities: ['completion', 'tools']},
      'nimble:latest': {capabilities: ['decision']},
      'cloud:latest': {
        capabilities: ['completion', 'tools'],
        remote_host: 'https://cloud.invalid',
      },
      'embed:latest': {capabilities: ['embedding']},
    };
  const requests: Array<{
    path?: string;
    authorization?: string;
    body: unknown;
  }> = [];
  const state: {
    status: number;
    malformed: boolean;
    decisionResponse?: unknown;
  } = {status: 200, malformed: false};
  const server = createServer((req, res) => {
    void (async () => {
      let raw = '';
      for await (const part of req) {
        raw += part;
      }
      const body = raw ? (JSON.parse(raw) as {model: string}) : undefined;
      requests.push({
        path: req.url,
        authorization: req.headers.authorization,
        body,
      });
      const path = req.url?.startsWith(prefix)
        ? req.url.slice(prefix.length)
        : undefined;
      res.setHeader('content-type', 'application/json');
      if (state.status !== 200) {
        res
          .writeHead(state.status)
          .end(JSON.stringify({error: 'upstream-private-diagnostic'}));
      } else if (state.malformed) {
        res.end('{}');
      } else if (path === '/api/version') {
        res.end('{"version":"0.35.1"}');
      } else if (path === '/api/tags') {
        res.end(
          JSON.stringify({
            models: Object.keys(models).map(name => ({
              name,
              digest: `digest-${name}`,
            })),
          }),
        );
      } else if (path === '/api/show' && body && models[body.model]) {
        res.end(
          JSON.stringify({
            ...models[body.model],
            parameters: 'num_ctx 65536',
            model_info: {
              'general.architecture': 'test',
              'test.context_length': 262144,
            },
          }),
        );
      } else if (
        path === '/v1/systemone' &&
        state.decisionResponse !== undefined
      ) {
        res.end(JSON.stringify(state.decisionResponse));
      } else {
        res.writeHead(404).end('{}');
      }
    })().catch(error => res.destroy(error));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing fixture address');
  }
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });
  return {
    server,
    models,
    requests,
    state,
    url: `http://127.0.0.1:${address.port}${prefix}`,
  };
}
