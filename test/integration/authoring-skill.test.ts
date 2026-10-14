import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {parse} from 'yaml';
import {z} from 'zod';

import {PACKAGE_ROOT} from '../../src/paths.js';
import {workspaceName} from '../../src/telemetry/artifact-storage.js';
import {testHome, waitForRetention} from '../helpers/home.js';

const exec = promisify(execFile);
const snippets = (text: string, language: string) =>
  [
    ...text.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g')),
  ].map(match => match[1]!.trim());

void test(
  'authoring skill examples build, compose, run and expose only selected MCP types',
  {timeout: 180_000},
  async t => {
    const skill = join(PACKAGE_ROOT, 'skills/stratos-workflows');
    const main = await readFile(join(skill, 'SKILL.md'), 'utf8');
    const composition = await readFile(
      join(skill, 'references/composition.md'),
      'utf8',
    );
    const mcp = await readFile(join(skill, 'references/mcp.md'), 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(main);
    assert.ok(frontmatter);
    const metadata = z
      .object({name: z.string(), description: z.string().min(1)})
      .parse(parse(frontmatter[1]!));
    assert.equal(metadata.name, 'stratos-workflows');
    assert.match(main, /stratos describe/);
    assert.match(main, /maximum 400/);
    assert.match(main, /maximum 12,000/);
    assert.match(main, /Legacy manifest `description` is rejected/);
    for (const link of main.matchAll(/\]\((references\/[^)]+)\)/g)) {
      await readFile(join(skill, link[1]!.split('#')[0]!));
    }
    const [greet] = snippets(main, 'typescript');
    const [agent, child, decision] = snippets(composition, 'typescript');
    const [lookup] = snippets(mcp, 'typescript');
    assert.ok(greet && agent && child && decision && lookup);
    const [greetYaml] = snippets(main, 'yaml');
    const [agentYaml, decisionYaml] = snippets(composition, 'yaml');
    assert.ok(greetYaml && agentYaml && decisionYaml);

    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'stratos-skill-')));
    t.after(async () => {
      try {
        await waitForRetention();
      } finally {
        await rm(cwd, {recursive: true, force: true});
      }
    });
    const root = join(cwd, '.stratos/workflows');
    const author = async (name: string, source: string, yaml?: string) => {
      const dir = join(root, name);
      await mkdir(dir, {recursive: true});
      await writeFile(
        join(dir, 'workflow.yaml'),
        yaml ??
          `name: ${name}\nshortDescription: Skill example\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: "1"\n`,
      );
      await writeFile(join(dir, 'workflow.ts'), source);
    };
    const call = async (...args: string[]) => {
      const result = await exec(
        process.execPath,
        [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), ...args, '--json'],
        {cwd, signal: t.signal, timeout: 90_000, maxBuffer: 4 * 1024 * 1024},
      );
      return {
        ...result,
        ...z
          .object({success: z.literal(true), data: z.unknown().optional()})
          .parse(JSON.parse(result.stdout)),
      };
    };
    await author('greet', greet, greetYaml);
    const list = z
      .array(z.object({name: z.string(), status: z.string()}))
      .parse((await call('list')).data);
    assert.deepEqual(list, [{name: 'greet', status: 'not built'}]);
    await assert.rejects(readFile(join(root, 'package.json')), {
      code: 'ENOENT',
    });
    await call('build', 'greet');
    const described = z
      .object({
        name: z.literal('greet'),
        shortDescription: z.string().min(1),
        longDescription: z.string().min(1),
        inputSchema: z.unknown(),
        outputSchema: z.unknown(),
      })
      .parse((await call('describe', 'greet')).data);
    assert.match(described.longDescription, /no credentials/);
    assert.deepEqual((await call('schema', 'greet')).data, {
      inputSchema: described.inputSchema,
      outputSchema: described.outputSchema,
    });
    for (const [input, message] of [
      [{name: 'Ada'}, 'Hello, Ada!'],
      [{name: 'Ada', loud: true}, 'HELLO, ADA!'],
    ] as const) {
      const result = await call(
        'run',
        'greet',
        '--input',
        JSON.stringify(input),
      );
      assert.deepEqual(result.data, {message});
      assert.match(result.stderr, /Greeting prepared/);
    }
    await assert.rejects(
      call('run', 'greet', '--input', '{"name":"Ada","typo":true}'),
      error =>
        String((error as {stdout?: string}).stdout).includes(
          'Unrecognized key',
        ),
    );

    await author('parent', child);
    await call('build', 'parent');
    assert.deepEqual(
      (await call('run', 'parent', '--input', '{"name":"Ada"}')).data,
      {message: 'HELLO, ADA!'},
    );
    await author(
      'summary',
      agent,
      `name: summary\nshortDescription: Skill agent example\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: "1"\n${agentYaml}\n`,
    );
    await author(
      'classify',
      decision,
      `name: classify\nshortDescription: Skill decision example\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: "1"\n${decisionYaml}\n`,
    );
    // These examples are compiled, not executed against paid providers.
    await call('build', 'summary');
    await call('build', 'classify');

    const dir = join(root, 'lookup');
    await mkdir(dir);
    await writeFile(
      join(dir, 'server.mjs'),
      `import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const server=new Server({name:'skill-fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:['lookup','unrelated'].map(name=>({
name,inputSchema:{type:'object',properties:{key:{type:'string'}},required:['key']},
outputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}
}))}));
server.setRequestHandler(CallToolRequestSchema,async({params})=>({
content:[{type:'text',text:'fixture'}],structuredContent:{value:'value:'+params.arguments.key}
}));
await server.connect(new StdioServerTransport());`,
    );
    await writeFile(
      join(dir, 'workflow.yaml'),
      `name: lookup\nshortDescription: Skill MCP example\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: "1"\nmcp:\n  servers:\n    catalog:\n      type: stdio\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(join(dir, 'server.mjs'))}]\n`,
    );
    assert.equal(
      z.object({status: z.string()}).parse((await call('build', 'lookup')).data)
        .status,
      'prepared',
    );
    const extraction = snippets(mcp, 'sh').find(code =>
      code.startsWith("awk '"),
    );
    assert.ok(extraction);
    const program = /^awk '\n([\s\S]*)\n' generated\/mcp\/catalog.ts$/.exec(
      extraction,
    );
    assert.ok(program);
    const {stdout: selected} = await exec(
      'awk',
      [program[1]!, 'generated/mcp/catalog.ts'],
      {cwd: dir},
    );
    assert.match(selected, /Tool_lookupInput/);
    assert.match(selected, /Tool_lookupOutput/);
    assert.doesNotMatch(selected, /unrelated|export default|outputSchema/);
    await writeFile(join(dir, 'workflow.ts'), lookup);
    await call('build', 'lookup');
    assert.deepEqual(
      (await call('run', 'lookup', '--input', '{"key":"sample"}')).data,
      {value: 'value:sample'},
    );

    await waitForRetention();
    const artifacts = join(testHome, '.stratos/runs', workspaceName(cwd));
    assert.deepEqual(
      JSON.parse(await readFile(join(artifacts, 'workspace.json'), 'utf8')),
      {path: cwd},
    );
    const runs = (await readdir(artifacts, {withFileTypes: true})).filter(
      entry => entry.isDirectory(),
    );
    const logs = await Promise.all(
      runs.map(entry =>
        readFile(join(artifacts, entry.name, 'run.log'), 'utf8'),
      ),
    );
    assert.ok(logs.some(log => log.includes('Greeting prepared')));
    await call('clean', 'greet');
    assert.equal(
      await readFile(join(root, 'greet/workflow.ts'), 'utf8'),
      greet,
    );
  },
);
