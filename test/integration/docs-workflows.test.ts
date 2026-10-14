import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {parse, stringify} from 'yaml';
import {z} from 'zod';

import {PACKAGE_ROOT} from '../../src/paths.js';
import {waitForRetention} from '../helpers/home.js';

const exec = promisify(execFile);
const manifestSchema = z.object({
  name: z.string(),
  shortDescription: z.string().min(1),
  longDescription: z.string().min(1),
  description: z.never().optional(),
  version: z.string(),
});

function blocks(markdown: string, language: string): string[] {
  return [
    ...markdown.matchAll(
      new RegExp('^```' + language + '\\n([\\s\\S]*?)^```[ \\t]*$', 'gm'),
    ),
  ].map(match => {
    assert.ok(match[1]);
    return match[1];
  });
}

void test(
  'published workflow examples build and code-only tutorials return documented results',
  {timeout: 240_000},
  async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'stratos-docs-workflows-'));
    t.after(async () => {
      try {
        await waitForRetention();
      } finally {
        await rm(cwd, {recursive: true, force: true});
      }
    });
    const root = join(cwd, '.stratos/workflows');
    const authored = new Map<string, z.infer<typeof manifestSchema>>();
    const call = (...args: string[]) =>
      exec(
        process.execPath,
        [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), ...args, '--json'],
        {cwd, signal: t.signal, timeout: 90_000, maxBuffer: 4 * 1024 * 1024},
      );
    const data = async (...args: string[]) => {
      const {stdout} = await call(...args);
      return z
        .object({success: z.literal(true), data: z.unknown()})
        .parse(JSON.parse(stdout)).data;
    };
    const author = async (yaml: string, source: string) => {
      const metadata = manifestSchema.parse(parse(yaml));
      const {name} = metadata;
      authored.set(name, metadata);
      const directory = join(root, name);
      await mkdir(directory, {recursive: true});
      await writeFile(join(directory, 'workflow.yaml'), yaml);
      await writeFile(join(directory, 'workflow.ts'), source);
      return directory;
    };
    const checkDescription = async (name: string) => {
      const metadata = authored.get(name);
      assert.ok(metadata);
      const schemas = z
        .strictObject({
          inputSchema: z.record(z.string(), z.unknown()),
          outputSchema: z.record(z.string(), z.unknown()),
        })
        .parse(await data('schema', name));
      assert.deepEqual(await data('describe', name), {...metadata, ...schemas});
    };
    const checkList = async () => {
      const entries = z
        .array(
          z.strictObject({
            name: z.string(),
            shortDescription: z.string(),
            path: z.string(),
            status: z.enum(['built', 'not built']),
            nextAction: z.string().optional(),
          }),
        )
        .parse(await data('list'));
      assert.deepEqual(
        entries.map(entry => [entry.name, entry.shortDescription]),
        [...authored]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, metadata]) => [name, metadata.shortDescription]),
      );
    };

    for (const [page, count] of [
      ['authoring', 1],
      ['composition', 3],
    ] as const) {
      const markdown = await readFile(
        join(PACKAGE_ROOT, 'docs', `${page}.md`),
        'utf8',
      );
      const manifests = blocks(markdown, 'yaml');
      const sources = blocks(markdown, 'typescript');
      assert.equal(manifests.length, count);
      assert.equal(sources.length, count);
      for (const [index, yaml] of manifests.entries()) {
        await author(yaml, sources[index]!);
      }
    }

    await checkList();
    await assert.rejects(stat(join(root, 'node_modules')), {code: 'ENOENT'});
    await call('build');
    for (const name of authored.keys()) {
      await checkDescription(name);
    }
    assert.deepEqual(await data('run', 'greet', '--input', '{"name":"Ada"}'), {
      message: 'Hello, Ada!',
    });
    assert.deepEqual(
      await data('run', 'greet', '--input', '{"name":"Ada","loud":true}'),
      {message: 'HELLO, ADA!'},
    );
    assert.deepEqual(
      await data('run', 'greet-team', '--input', '{"names":["Ada","Grace"]}'),
      {messages: ['HELLO, ADA!', 'HELLO, GRACE!']},
    );
    assert.deepEqual(
      await data('run', 'greet-team', '--input', '{"names":[]}'),
      {messages: []},
    );
    await assert.rejects(
      call('run', 'greet', '--input', '{"name":"Ada","lodu":true}'),
      error => {
        const {stdout} = z.object({stdout: z.string()}).parse(error);
        const failure = z
          .object({success: z.literal(false), errors: z.array(z.unknown())})
          .parse(JSON.parse(stdout));
        assert.ok(failure.errors.length);
        assert.match(stdout, /lodu/);
        return true;
      },
    );
    const schema = z
      .object({
        inputSchema: z.object({
          required: z.array(z.string()),
          properties: z.object({
            loud: z.object({default: z.boolean()}),
          }),
        }),
      })
      .parse(await data('schema', 'greet'));
    assert.deepEqual(schema.inputSchema.required, ['name']);
    assert.equal(schema.inputSchema.properties.loud.default, false);

    const mcpGuide = await readFile(join(PACKAGE_ROOT, 'docs/mcp.md'), 'utf8');
    const manifests = blocks(mcpGuide, 'yaml');
    const sources = blocks(mcpGuide, 'typescript');
    assert.equal(manifests.length, 1);
    assert.equal(sources.length, 1);
    const metadata = manifestSchema.parse(parse(manifests[0]!));
    const directory = join(root, metadata.name);
    const serverPath = join(directory, 'server.mjs');
    await author(
      stringify({
        ...metadata,
        mcp: {
          servers: {
            catalog: {
              type: 'stdio',
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      }),
      sources[0]!,
    );
    await writeFile(
      serverPath,
      `import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const server = new Server({name:'catalog',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{
  name:'lookup',
  inputSchema:{type:'object',properties:{key:{type:'string'}},required:['key'],additionalProperties:false},
  outputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},
}]}));
server.setRequestHandler(CallToolRequestSchema, async request => ({
  content:[],
  structuredContent:{value:'Found ' + request.params.arguments.key},
}));
await server.connect(new StdioServerTransport());`,
    );
    await call('build', 'catalog-lookup');
    await checkList();
    await checkDescription('catalog-lookup');
    assert.deepEqual(
      await data('run', 'catalog-lookup', '--input', '{"key":"example"}'),
      {value: 'Found example'},
    );
  },
);
