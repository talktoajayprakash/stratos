import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {CodexAdapter} from '../../src/agents/codex/adapter.js';
import {harnessTools} from '../../src/agents/native.js';
import {OpenCodeAdapter} from '../../src/agents/opencode/adapter.js';
import {resolveNativeTools} from '../../src/agents/tools.js';

type Tool = {name?: string; type?: string; function?: {name?: string}};

/** Native harness processes send their tool lists to a loopback Ollama fixture. */
void test(
  'native harnesses omit tools removed by canonical selections',
  {timeout: 120000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'stratos-tool-controls-'));
    const sent: string[][] = [];
    const server = createServer((req, res) => {
      void (async () => {
        let text = '';
        for await (const chunk of req) {
          text += chunk;
        }
        const body = text
          ? (JSON.parse(text) as {model?: string; tools?: Tool[]})
          : {};
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/tags') {
          res.end(
            JSON.stringify({
              models: [{name: 'fixture:latest', digest: 'fixture'}],
            }),
          );
          return;
        }
        if (req.url === '/api/show') {
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
        if (body.tools?.length) {
          sent.push(
            body.tools.map(
              tool => tool.function?.name ?? tool.name ?? tool.type!,
            ),
          );
        }
        res.writeHead(200, {'Content-Type': 'text/event-stream'});
        if (req.url === '/v1/responses') {
          const item = {
            type: 'message',
            id: 'fixture-message',
            role: 'assistant',
            status: 'completed',
            content: [{type: 'output_text', text: 'ACK', annotations: []}],
          };
          const response = {id: 'fixture', model: body.model, output: [item]};
          for (const event of [
            {
              type: 'response.created',
              response: {...response, status: 'in_progress', output: []},
            },
            {type: 'response.output_item.done', output_index: 0, item},
            {
              type: 'response.completed',
              response: {
                ...response,
                status: 'completed',
                usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2},
              },
            },
          ]) {
            res.write(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
          }
          res.end();
          return;
        }
        assert.equal(req.url, '/v1/chat/completions');
        const chunk = {
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
        };
        res.write(
          `data: ${JSON.stringify({...chunk, choices: [{index: 0, delta: {role: 'assistant', content: 'ACK'}, finish_reason: null}]})}\n\n`,
        );
        res.end(
          `data: ${JSON.stringify({
            ...chunk,
            choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
          })}\n\ndata: [DONE]\n\n`,
        );
      })().catch(error => res.destroy(error));
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
    const host = `http://127.0.0.1:${address.port}`;

    await t.test('Codex', async () => {
      const run = async (name: string, removedTools: string[]) => {
        const home = join(directory, name);
        await mkdir(home);
        const adapter = new CodexAdapter({
          provider: 'ollama',
          model: 'fixture:latest',
          workingDirectory: home,
          removedTools,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            CODEX_HOME: home,
            OLLAMA_HOST: host,
          },
          onEvent() {},
          diagnostic() {},
        });
        try {
          await adapter.initialize();
          assert.equal(await adapter.execute('Reply ACK.'), 'ACK');
        } finally {
          await adapter.close();
        }
        return sent.at(-1)!;
      };
      const all = await run('codex-default', []);
      const kept = await run(
        'codex-edit',
        resolveNativeTools('codex', harnessTools.codex, ['edit', 'write']),
      );
      const native = [
        'exec_command',
        'write_stdin',
        'view_image',
        'request_user_input',
        'multi_agent_v1',
        'get_goal',
      ];
      assert.deepEqual(
        native.filter(name => !all.includes(name)),
        [],
      );
      assert.deepEqual(
        kept.filter(
          name =>
            [...native, 'web_search'].includes(name) || name.includes('goal'),
        ),
        [],
      );
      assert.deepEqual(
        kept.filter(name => !all.includes(name)),
        [],
      );
      assert.ok(
        kept.some(name => name.startsWith('mcp__stratos_hooks')),
        'Stratos hook MCP tools remain',
      );
    });

    await t.test(
      'OpenCode',
      {
        skip:
          !process.env.STRATOS_TEST_OPENCODE_BINARY &&
          'Opt in with STRATOS_TEST_OPENCODE_BINARY; provider responses are loopback fixtures',
      },
      async () => {
        const run = async (name: string, removedTools: string[]) => {
          const home = join(directory, name);
          await mkdir(home);
          const adapter = new OpenCodeAdapter({
            model: {providerID: 'ollama', modelID: 'fixture:latest'},
            workingDirectory: home,
            binary: process.env.STRATOS_TEST_OPENCODE_BINARY!,
            outputSchema: {
              type: 'object',
              properties: {result: {type: 'string'}},
              required: ['result'],
            },
            removedTools,
            env: {
              OLLAMA_HOST: host,
              HOME: home,
              XDG_DATA_HOME: join(home, 'data'),
              XDG_CACHE_HOME: join(home, 'cache'),
              XDG_STATE_HOME: join(home, 'state'),
              OPENCODE_DISABLE_MODELS_FETCH: 'true',
              OPENCODE_DISABLE_CLAUDE_CODE: 'true',
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                share: 'disabled',
                agent: {title: {disable: true}, summary: {disable: true}},
              }),
            },
            onEvent() {},
            diagnostic() {},
          });
          const before = sent.length;
          try {
            await adapter.initialize();
            await adapter.execute('Reply ACK.').catch(() => {});
          } finally {
            await adapter.close();
          }
          assert.ok(sent.length > before, 'OpenCode sent a tool list');
          return sent.at(-1)!;
        };
        const all = await run('opencode-default', []);
        const kept = await run(
          'opencode-read',
          resolveNativeTools('opencode', harnessTools.opencode, ['read']),
        );
        assert.ok(
          ['bash', 'read', 'task', 'todowrite', 'StructuredOutput'].every(
            name => all.includes(name),
          ),
        );
        assert.deepEqual(kept.sort(), ['StructuredOutput', 'read']);
      },
    );
  },
);
