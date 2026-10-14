import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import test from 'node:test';

import {z} from 'zod';

import {createAgent, workflow} from '../../src/index.js';
import {executeWorkflow} from '../../src/workflows/runtime.js';
import {isolateArtifacts} from '../helpers/artifacts.js';

void test(
  'installed OpenCode through public createAgent: catalog filtering, execution fallback and continuation',
  {
    skip:
      !process.env.STRATOS_TEST_OPENCODE_BINARY &&
      'Opt in with STRATOS_TEST_OPENCODE_BINARY; provider responses are loopback fixtures',
    timeout: 90000,
  },
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'stratos-native-selection-'),
    );
    const drainArtifacts = await isolateArtifacts(
      t,
      join(directory, 'artifacts'),
    );
    const native = resolve(process.env.STRATOS_TEST_OPENCODE_BINARY!);
    const work = join(directory, 'work');
    await mkdir(work);
    const requests: Array<{model: string; text: string}> = [];
    const failures: unknown[] = [];
    const marker = 'LOCAL_FIXTURE_PINE8';
    let firstNativePrompt: string | undefined;
    let tools = 0;
    const bodySchema = z.object({
      model: z.string(),
      input: z.unknown().optional(),
    });
    const endpoint = createServer((request, response) => {
      void (async () => {
        try {
          let text = '';
          for await (const chunk of request) {
            text += chunk;
          }
          const data = bodySchema.parse(JSON.parse(text));
          requests.push({model: data.model, text});
          if (data.model === 'openai/gpt-6-sol') {
            firstNativePrompt = text;
            response.writeHead(404, {'content-type': 'application/json'}).end(
              JSON.stringify({
                error: {
                  code: 'model_not_found',
                  type: 'invalid_request_error',
                  param: 'model',
                  message: 'Controlled native rejection',
                },
              }),
            );
            return;
          }
          assert.equal(data.model, 'openai/gpt-6-astra');
          assert.ok(
            firstNativePrompt,
            'The preferred model must have been attempted',
          );
          const output = requests.length === 2 ? 'OK' : marker;
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          });
          const send = (event: Record<string, unknown>) =>
            response.write(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
          send({
            type: 'response.created',
            response: {
              id: `fixture-${requests.length}`,
              model: data.model,
              created_at: 1,
              status: 'in_progress',
              output: [],
            },
          });
          send({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'message',
              id: 'fixture-message',
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          });
          send({
            type: 'response.content_part.added',
            item_id: 'fixture-message',
            output_index: 0,
            content_index: 0,
            part: {type: 'output_text', text: '', annotations: []},
          });
          send({
            type: 'response.output_text.delta',
            item_id: 'fixture-message',
            output_index: 0,
            content_index: 0,
            delta: output,
          });
          send({
            type: 'response.output_text.done',
            item_id: 'fixture-message',
            output_index: 0,
            content_index: 0,
            text: output,
          });
          send({
            type: 'response.completed',
            response: {
              id: `fixture-${requests.length}`,
              model: data.model,
              created_at: 1,
              status: 'completed',
              output: [],
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                input_tokens_details: {cached_tokens: 0},
                output_tokens_details: {reasoning_tokens: 0},
              },
            },
          });
          response.end();
        } catch (error) {
          failures.push(error);
          if (!response.headersSent) {
            response.writeHead(500);
          }
          response.end();
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      endpoint.once('error', reject);
      endpoint.listen(0, '127.0.0.1', resolve);
    });
    const address = endpoint.address();
    assert.ok(address && typeof address !== 'string');
    const env: Record<string, string> = {
      HOME: directory,
      TMPDIR: directory,
      XDG_DATA_HOME: join(directory, 'data'),
      XDG_CONFIG_HOME: join(directory, 'config'),
      XDG_CACHE_HOME: join(directory, 'cache'),
      XDG_STATE_HOME: join(directory, 'state'),
      PATH: `${dirname(native)}:${process.env.PATH}`,
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        enabled_providers: ['openrouter'],
        autoupdate: false,
        share: 'disabled',
        agent: {title: {disable: true}, summary: {disable: true}},
        model: 'openrouter/openai/gpt-6-astra',
        small_model: 'openrouter/openai/gpt-6-astra',
        provider: {
          openrouter: {
            npm: '@ai-sdk/openai',
            options: {
              baseURL: `http://127.0.0.1:${address.port}/v1`,
              apiKey: 'synthetic-local-only',
            },
            models: Object.fromEntries(
              ['openai/gpt-6-sol', 'openai/gpt-6-astra'].map(id => [
                id,
                {name: id, limit: {context: 32768, output: 128}},
              ]),
            ),
          },
        },
      }),
    };
    const previous = Object.fromEntries(
      Object.keys(env).map(key => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    t.after(async () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      endpoint.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        endpoint.close(error => (error ? reject(error) : resolve())),
      );
      try {
        await drainArtifacts();
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    });
    const prompt = `Remember ${marker}; reply OK. No tools.`;
    const definition = workflow({
      input: z.strictObject({}),
      output: z.object({result: z.string().describe('Fixture result')}),
      async run() {
        const agent = createAgent({
          harness: 'opencode',
          provider: 'openrouter',
          model: [
            'openai/stratos-unmapped',
            'openai/gpt-6-sol',
            'openai/gpt-6-astra',
          ],
          systemPrompt:
            'No tools. This is a synthetic local transport fixture.',
          hooks: {
            beforeToolCall: () => {
              tools++;
              return {action: 'deny', reason: 'Fixture tools disabled'};
            },
          },
        });
        assert.equal(requests.length, 0, 'Construction must remain lazy');
        const timer = setTimeout(() => agent.cancel(), 60000);
        try {
          assert.equal((await agent.execute(prompt)).trim(), 'OK');
          assert.equal(requests.length, 2);
          const result = await agent.execute(
            'Recall the marker from the previous turn.',
          );
          return {result: result.trim()};
        } finally {
          clearTimeout(timer);
        }
      },
    });
    assert.deepEqual(
      await executeWorkflow(definition, {}, 'native-fallback', work),
      {result: marker},
    );
    assert.deepEqual(failures, []);
    assert.equal(tools, 0);
    assert.deepEqual(
      requests.map(request => request.model),
      ['openai/gpt-6-sol', 'openai/gpt-6-astra', 'openai/gpt-6-astra'],
    );
    assert.ok(
      requests[0]!.text.includes(prompt) && requests[1]!.text.includes(prompt),
    );
    assert.ok(
      requests[2]!.text.includes(prompt),
      'Native follow-up must retain the successful first request in conversation history',
    );
    assert.deepEqual(
      (await readdir(directory)).filter(name =>
        name.startsWith('stratos-opencode'),
      ),
      [],
    );
    t.diagnostic(
      'Actual production Agent/OpenCode lifecycle; both rejection and successful provider output are synthetic loopback fixtures, not real inference.',
    );
  },
);
