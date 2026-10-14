import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {z} from 'zod';

import {CodexAdapter} from '../../src/agents/codex/adapter.js';

const requestSchema = z.object({
  model: z.string(),
  instructions: z.string().optional(),
  input: z.array(z.unknown()),
});

void test(
  'native Codex preserves Ollama instructions and conversation across turns',
  {timeout: 60000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'stratos-codex-ollama-'));
    const requests: Array<z.infer<typeof requestSchema>> = [];
    const failures: unknown[] = [];
    const server = createServer((req, res) => {
      void (async () => {
        let text = '';
        for await (const chunk of req) {
          text += chunk;
        }
        if (req.url === '/api/tags') {
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              models: [{name: 'fixture:latest', digest: 'fixture-digest'}],
            }),
          );
          return;
        }
        if (req.url === '/api/show') {
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              capabilities: ['completion', 'tools'],
              parameters: 'num_ctx 65536',
              model_info: {
                'general.architecture': 'fixture',
                'fixture.context_length': 65536,
              },
            }),
          );
          return;
        }
        assert.equal(req.url, '/v1/responses');
        assert.equal(req.headers.authorization, undefined);
        const body = requestSchema.parse(JSON.parse(text));
        requests.push(body);
        const id = `fixture-${requests.length}`;
        const item = {
          type: 'message',
          id: `${id}-message`,
          role: 'assistant',
          status: 'completed',
          content: [{type: 'output_text', text: 'ACK', annotations: []}],
        };
        res.writeHead(200, {'Content-Type': 'text/event-stream'});
        for (const event of [
          {
            type: 'response.created',
            response: {
              id,
              model: body.model,
              status: 'in_progress',
              output: [],
            },
          },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: {...item, status: 'in_progress', content: []},
          },
          {
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: 'ACK',
          },
          {type: 'response.output_item.done', output_index: 0, item},
          {
            type: 'response.completed',
            response: {
              id,
              model: body.model,
              status: 'completed',
              output: [item],
              usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2},
            },
          },
        ]) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        res.end();
      })().catch(error => {
        failures.push(error);
        res.destroy(error);
      });
    });
    t.after(async () => {
      server.closeAllConnections();
      try {
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve())),
        );
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const prompt =
      'Follow only the workflow instructions.\nMarker: "PINE-731".';
    for (const systemPrompt of [prompt, undefined]) {
      await t.test(
        systemPrompt ? 'configured prompt' : 'no configured prompt',
        async () => {
          const start = requests.length;
          const home = join(directory, systemPrompt ? 'configured' : 'default');
          await mkdir(home);
          const adapter = new CodexAdapter({
            provider: 'ollama',
            model: 'fixture:latest',
            workingDirectory: home,
            systemPrompt,
            env: {
              PATH: process.env.PATH ?? '',
              HOME: home,
              CODEX_HOME: home,
              OLLAMA_HOST: `http://127.0.0.1:${address.port}`,
              OPENAI_API_KEY: 'not-for-ollama',
              CODEX_API_KEY: 'not-for-ollama',
            },
            onEvent() {},
            diagnostic(error) {
              failures.push(error);
            },
          });
          const cancel = () => adapter.cancel();
          t.signal.addEventListener('abort', cancel, {once: true});
          try {
            await adapter.initialize();
            assert.equal(
              await adapter.execute('First user turn: MAPLE.'),
              'ACK',
            );
            assert.equal(
              await adapter.execute('Second user turn: remember it.'),
              'ACK',
            );
          } finally {
            t.signal.removeEventListener('abort', cancel);
            await adapter.close();
          }
          assert.deepEqual(failures, []);
          const turns = requests.slice(start);
          assert.equal(turns.length, 2);
          for (const turn of turns) {
            assert.equal(turn.model, 'fixture:latest');
            assert.equal(turn.instructions ?? '', systemPrompt ?? '');
            assert.ok(
              !JSON.stringify(turn.input).includes('PINE-731'),
              'Do not duplicate workflow instructions into a developer message',
            );
          }
          assert.match(
            JSON.stringify(turns[1]!.input),
            /First user turn: MAPLE/,
          );
          assert.match(
            JSON.stringify(turns[1]!.input),
            /Second user turn: remember it/,
          );
        },
      );
    }
  },
);
