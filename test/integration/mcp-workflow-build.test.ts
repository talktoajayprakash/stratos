import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  realpath,
  readdir,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {CredentialStore} from '../../src/mcp/credentials.js';
import {PACKAGE_ROOT} from '../../src/paths.js';
import {testHome, waitForRetention} from '../helpers/home.js';
import {mcpAuthFixture} from '../helpers/mcp-auth.js';

void test('installed CLI generates stdio wrappers, checks tool input types, and closes server processes', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'stratos-stdio-workflow-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const dir = join(cwd, '.stratos/workflows/example');
  await mkdir(dir, {recursive: true});
  await writeFile(
    join(dir, 'server.mjs'),
    `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'; import { z } from 'zod';
import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(join(cwd, 'pids'))}, process.pid+'\\n');
const server = new McpServer({name:'fixture',version:'1'});
server.registerTool('double', {inputSchema:{value:z.number().describe('Value to double')}}, async ({value})=>{
appendFileSync(${JSON.stringify(join(cwd, 'called'))}, 'called\\n');
return {content:[{type:'text',text:String(value*2)}]};});
await server.connect(new StdioServerTransport());`,
  );
  await writeFile(
    join(dir, 'workflow.yaml'),
    `name: example\nshortDescription: Stdio test\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: '1'\nmcp:\n  servers:\n    local:\n      type: stdio\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(join(dir, 'server.mjs'))}]\n`,
  );
  const source = `import { workflow } from '@stratoscli/stratos'; import { z } from 'zod'; import createLocal from './generated/mcp/local.js';
export default workflow({input:z.strictObject({}),output:z.object({value:z.number().describe('')}),async run(){const local=await createLocal(); const result=await local.double({value:3}); const part=result.content[0]; if(part?.type!=='text') throw Error('Missing text'); return {value:Number(part.text)};}});`;
  await writeFile(join(dir, 'workflow.ts'), source);
  const exec = promisify(execFile);
  const call = (...args: string[]) =>
    exec(
      process.execPath,
      [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), ...args, '--json'],
      {cwd, maxBuffer: 4 * 1024 * 1024},
    );
  const described = JSON.parse((await call('describe', 'example')).stdout);
  assert.equal(described.data.name, 'example');
  assert.equal(described.data.inputSchema.type, 'object');
  await assert.rejects(stat(join(cwd, 'called')), {code: 'ENOENT'});
  const pids = await readFile(join(cwd, 'pids'), 'utf8');
  assert.ok(pids.trim(), 'Description preparation starts the required MCP');
  for (const pid of pids.trim().split('\n').map(Number)) {
    assert.throws(() => process.kill(pid, 0));
  }
  await call('describe', 'example');
  assert.equal(await readFile(join(cwd, 'pids'), 'utf8'), pids);
  assert.equal(JSON.parse((await call('run', 'example')).stdout).data.value, 6);
  assert.equal(await readFile(join(cwd, 'called'), 'utf8'), 'called\n');
  for (const pid of (await readFile(join(cwd, 'pids'), 'utf8'))
    .trim()
    .split('\n')
    .map(Number)) {
    assert.throws(() => process.kill(pid, 0));
  }
  const wrapper = await readFile(join(dir, 'generated/mcp/local.ts'), 'utf8');
  assert.match(wrapper, /value: number/);
  await writeFile(
    join(dir, 'workflow.ts'),
    source.replace('value:3', "value:'wrong'"),
  );
  await assert.rejects(call('build', 'example'), error =>
    String((error as {stdout: string}).stdout).includes('not assignable'),
  );
});

void test(
  'generated tools isolate repeated schema titles, definitions and required object inputs',
  {timeout: 120_000},
  async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'stratos-mcp-schema-names-'));
    t.after(async () => {
      try {
        await waitForRetention();
      } finally {
        await rm(cwd, {recursive: true, force: true});
      }
    });
    const dir = join(cwd, '.stratos/workflows/example');
    await mkdir(dir, {recursive: true});
    await writeFile(
      join(dir, 'server.mjs'),
      `import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const server=new Server({name:'schema-fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:
['string','number'].map((type,i)=>({name:'tool'+i,inputSchema:{
type:'object',title:'SharedInput',properties:{
value:{type}, metadata:{type:'object',title:'SharedMetadata'},
options:{$ref:'#/$defs/Options'}},
required:['value','options'],additionalProperties:false,
$defs:{Options:{type:'object',properties:{value:{type},next:{$ref:'#/$defs/Options'}},required:['value'],additionalProperties:false}}
}}))}));
server.setRequestHandler(CallToolRequestSchema,async request=>({
content:[{type:'text',text:JSON.stringify(request.params.arguments)}]}));
await server.connect(new StdioServerTransport());`,
    );
    await writeFile(
      join(dir, 'workflow.yaml'),
      `name: example\nshortDescription: Schema naming\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: '1'\nmcp:\n  servers:\n    local:\n      type: stdio\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(join(dir, 'server.mjs'))}]\n`,
    );
    const source = `import {workflow} from '@stratoscli/stratos';import {z} from 'zod';
import createLocal,{type Tool_tool0Input,type Tool_tool1Input} from './generated/mcp/local.js';
const first:Tool_tool0Input={value:'text',metadata:{key:'value'},options:{value:'outer',next:{value:'inner'}}};
const second:Tool_tool1Input={value:42,options:{value:2,next:{value:1}}};
export default workflow({input:z.strictObject({}),output:z.strictObject({verified:z.boolean().describe('')}),
async run(){const local=await createLocal();const a=await local.tool0(first);const b=await local.tool1(second);
return {verified:a.content[0]?.type==='text'&&a.content[0].text===JSON.stringify(first)
&&b.content[0]?.type==='text'&&b.content[0].text===JSON.stringify(second)};}});`;
    await writeFile(join(dir, 'workflow.ts'), source);
    const call = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), ...args, '--json'],
        {cwd, signal: t.signal, timeout: 90_000, maxBuffer: 4 * 1024 * 1024},
      );
    await call('build', 'example');
    assert.equal(
      JSON.parse((await call('run', 'example')).stdout).data.verified,
      true,
    );
    await writeFile(
      join(dir, 'workflow.ts'),
      source.replace("value:'inner'", 'value:99'),
    );
    await assert.rejects(call('build', 'example'), error =>
      String((error as {stdout: string}).stdout).includes('not assignable'),
    );
  },
);

void test(
  'generated input imports preserve exact tool names across catalog additions, reordering and removal',
  {timeout: 240_000},
  async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'stratos-mcp-stable-names-'));
    t.after(async () => {
      try {
        await waitForRetention();
      } finally {
        await rm(cwd, {recursive: true, force: true});
      }
    });
    const dir = join(cwd, '.stratos/workflows/example');
    await mkdir(dir, {recursive: true});
    const cases = [
      ['rename_google_drive_file', 'Tool_rename_google_drive_file'],
      ['foo-bar', 'Tool_foo$2D$bar'],
      ['foo_bar', 'Tool_foo_bar'],
      ['fooBar', 'Tool_fooBar'],
      ['FooBar', 'Tool_FooBar'],
      ['foo$2D$bar', 'Tool_foo$24$2D$24$bar'],
      ['foo.bar', 'Tool_foo$2E$bar'],
      ['9lives', 'Tool_9lives'],
      ['default', 'Tool_default'],
      ['slash/tool', 'Tool_slash$2F$tool'],
      ['space tool', 'Tool_space$20$tool'],
      ['caf\u00e9', 'Tool_caf$E9$'],
      ['cafe\u0301', 'Tool_cafe$301$'],
      ['emoji\u{1F680}', 'Tool_emoji$1F680$'],
      ['__proto__', 'Tool___proto__'],
    ] as const;
    const catalog = join(dir, 'catalog.json');
    const originalNames = cases.map(([name]) => name);
    await writeFile(catalog, JSON.stringify(originalNames));
    await writeFile(
      join(dir, 'server.mjs'),
      `import {readFileSync} from 'node:fs';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const names=JSON.parse(readFileSync(${JSON.stringify(catalog)},'utf8'));
const server=new Server({name:'stable-names',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:names.map(name=>({
name,inputSchema:{type:'object',title:'SharedInput',properties:{
tool:{const:name},value:{$ref:'#/$defs/Input'}},required:['tool','value'],additionalProperties:false,
$defs:{Input:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}}
}))}));
server.setRequestHandler(CallToolRequestSchema,async request=>({
content:[{type:'text',text:JSON.stringify({name:request.params.name,args:request.params.arguments})}]}));
await server.connect(new StdioServerTransport());`,
    );
    await writeFile(
      join(dir, 'workflow.yaml'),
      `name: example\nshortDescription: Stable tool names\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: '1'\nmcp:\n  servers:\n    local:\n      type: stdio\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(join(dir, 'server.mjs'))}]\n`,
    );
    const call = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), ...args, '--json'],
        {cwd, signal: t.signal, timeout: 90_000, maxBuffer: 4 * 1024 * 1024},
      );
    const wrapperPath = join(dir, 'generated/mcp/local.ts');
    const checkNames = async () => {
      const wrapper = await readFile(wrapperPath, 'utf8');
      for (const [name, identifier] of cases) {
        assert.ok(wrapper.includes(`declare namespace ${identifier}Schema {`));
        assert.ok(
          wrapper.includes(
            `export type ${identifier}Input = ${identifier}Schema.InputSchema.Input;`,
          ),
        );
        assert.ok(
          wrapper.includes(
            `[${JSON.stringify(name)}]: (args: ${identifier}Input)`,
          ),
        );
      }
      assert.doesNotMatch(wrapper, /\bTool\d+(?:Input|Schema)\b/);
    };
    assert.equal(
      JSON.parse((await call('build', 'example')).stdout).data.status,
      'prepared',
    );
    await checkNames();
    const source = `import {workflow} from '@stratoscli/stratos';import {z} from 'zod';
import createLocal,{${cases.map(([, identifier]) => `type ${identifier}Input`).join(',')}} from './generated/mcp/local.js';
${cases
  .map(
    ([name, identifier], i) =>
      `const args${i}:${identifier}Input={tool:${JSON.stringify(name)},value:{text:'value'}};`,
  )
  .join('\n')}
export default workflow({input:z.strictObject({}),output:z.strictObject({verified:z.boolean().describe('')}),
async run(){const local=await createLocal();const results=await Promise.all([
${cases
  .map(
    ([name], i) =>
      `local[${JSON.stringify(name)}](args${i}).then(result=>result.content[0]?.type==='text'&&result.content[0].text===JSON.stringify({name:${JSON.stringify(name)},args:args${i}}))`,
  )
  .join(',\n')}
]);return {verified:results.every(Boolean)};}});`;
    await writeFile(join(dir, 'workflow.ts'), source);
    for (const names of [
      originalNames,
      ['unrelated', 'foo-Bar', ...[...originalNames].reverse()],
      [...originalNames].reverse(),
    ]) {
      await writeFile(catalog, JSON.stringify(names));
      await call('build', 'example');
      await checkNames();
      assert.equal(
        JSON.parse((await call('run', 'example')).stdout).data.verified,
        true,
      );
    }
    await writeFile(
      join(dir, 'workflow.ts'),
      source.replace("text:'value'", 'text:99'),
    );
    await assert.rejects(call('build', 'example'), error =>
      String((error as {stdout: string}).stdout).includes('not assignable'),
    );
    await writeFile(join(dir, 'workflow.ts'), source);
    await writeFile(catalog, JSON.stringify(originalNames.slice(1)));
    await assert.rejects(call('build', 'example'), error =>
      String((error as {stdout: string}).stdout).includes(
        'Tool_rename_google_drive_fileInput',
      ),
    );
    assert.ok(
      !(await readFile(wrapperPath, 'utf8')).includes(
        'export type Tool_rename_google_drive_fileInput',
      ),
    );
  },
);

void test(
  'explicit builds prepare manifest-only MCPs, authenticate, refresh every time and invalidate consumers',
  {timeout: 360_000},
  async t => {
    const fixture = await mcpAuthFixture(t);
    const cwd = await realpath(
      await mkdtemp(join(tmpdir(), 'stratos-mcp-authoring-')),
    );
    t.after(async () => {
      try {
        await waitForRetention();
      } finally {
        await rm(cwd, {recursive: true, force: true});
      }
    });
    const root = join(cwd, '.stratos/workflows');
    const dir = join(root, 'child');
    const bin = join(cwd, 'bin');
    await mkdir(dir, {recursive: true});
    await mkdir(bin);
    for (const name of ['open', 'xdg-open']) {
      await writeFile(
        join(bin, name),
        `#!${process.execPath}
const response = await fetch(process.argv[2]);
if (!response.ok) throw new Error('Fixture browser sign-in failed');
`,
        {mode: 0o700},
      );
    }
    const manifest = `name: child\nshortDescription: MCP authoring\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: '1'\nentrypoint: main.ts\nmcp:\n  servers:\n    protected:\n      type: http\n      url: ${fixture.url}\n      auth:\n        type: oauth\n`;
    await writeFile(join(dir, 'workflow.yaml'), manifest);
    const call = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), ...args, '--json'],
        {
          cwd,
          env: {...process.env, PATH: `${bin}:${process.env.PATH}`},
          timeout: 120_000,
          signal: t.signal,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    const expectFailure = (work: Promise<unknown>, message: RegExp) =>
      assert.rejects(work, error => {
        assert.match(String((error as {stdout?: string}).stdout), message);
        return true;
      });
    const builtStatus = async (name: string) => {
      const result = JSON.parse((await call('list')).stdout);
      return result.data.find((entry: {name: string}) => entry.name === name)
        .status;
    };
    const preparation = await call('build', 'child');
    const result = JSON.parse(preparation.stdout);
    assert.match(preparation.stderr, /MCP sign-in required/);
    assert.doesNotMatch(preparation.stdout, /MCP sign-in required/);
    const wrapper = join(dir, 'generated/mcp/protected.ts');
    assert.equal(result.data.status, 'prepared');
    assert.deepEqual(result.data.wrappers, [wrapper]);
    assert.equal(await builtStatus('child'), 'not built');
    await assert.rejects(stat(join(dir, 'dist/.stratos-build.json')), {
      code: 'ENOENT',
    });
    await assert.rejects(stat(join(root, '.generated/child.ts')), {
      code: 'ENOENT',
    });
    assert.equal(fixture.state.logins, 1);
    assert.equal(fixture.state.discoveries, 1);
    assert.equal(fixture.state.calls.length, 0);
    assert.ok(!fixture.state.requests.includes('tools/call'));
    assert.match(await readFile(wrapper, 'utf8'), /value: number/);
    assert.doesNotMatch(
      await readFile(wrapper, 'utf8'),
      /fixture-access|fixture-refresh/,
    );
    assert.match(
      await readFile(join(dir, '.gitignore'), 'utf8'),
      /\/generated\//,
    );
    await expectFailure(call('run', 'child'), /entrypoint is missing/);
    await expectFailure(call('schema', 'child'), /entrypoint is missing/);
    await expectFailure(call('describe', 'child'), /entrypoint is missing/);

    const store = new CredentialStore(join(testHome, '.stratos'));
    const record = (await store.list()).find(
      record => record.serverUrl === fixture.url,
    )!;
    await store.save({...record, expiresAt: 0});
    const renewal = await call('build', '--name', 'child');
    assert.doesNotMatch(renewal.stderr, /MCP sign-in required/);
    assert.equal(
      fixture.state.logins,
      1,
      'Refresh does not ask for browser login',
    );
    assert.equal(fixture.state.refreshes, 1);
    assert.equal(fixture.state.discoveries, 2);
    const source = `import {workflow} from '@stratoscli/stratos'; import {z} from 'zod'; import createMcp from './generated/mcp/protected.js';
export default workflow({input:z.strictObject({}),output:z.strictObject({}),
async run(){const mcp=await createMcp();await mcp.echo({value:3});return {};}});`;
    await writeFile(join(dir, 'main.ts'), source);
    assert.equal(
      JSON.parse((await call('build', 'child')).stdout).data.status,
      'built',
    );
    const compiled = join(dir, 'dist/child/main.js');
    const before = (await stat(compiled)).mtimeMs;
    const beforeWrapper = (await stat(wrapper)).mtimeMs;
    await call('build', 'child');
    assert.equal(
      fixture.state.discoveries,
      4,
      'An unchanged explicit build rediscovers tools',
    );
    assert.ok((await stat(wrapper)).mtimeMs > beforeWrapper);
    assert.equal(
      (await stat(compiled)).mtimeMs,
      before,
      'Identical wrapper content can reuse compiled code',
    );
    await call('schema', 'child');
    assert.equal(
      fixture.state.discoveries,
      4,
      'Cached schema does not rediscover tools',
    );
    await call('run', 'child');
    assert.equal(fixture.state.calls.length, 1);

    fixture.state.input = 'string';
    await expectFailure(call('build', 'child'), /not assignable/);
    assert.match(await readFile(wrapper, 'utf8'), /value: string/);
    assert.equal(await builtStatus('child'), 'not built');
    await expectFailure(call('run', 'child'), /not assignable/);
    assert.equal(
      fixture.state.calls.length,
      1,
      'Stale compiled code must not execute',
    );
    await writeFile(
      join(dir, 'main.ts'),
      source.replace('value:3', "value:'three'"),
    );
    await call('build', 'child');

    const parent = join(root, 'parent');
    await mkdir(parent);
    await writeFile(
      join(parent, 'workflow.yaml'),
      "name: parent\nshortDescription: Parent\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: '1'\n",
    );
    await writeFile(
      join(parent, 'workflow.ts'),
      `import {workflow} from '@stratoscli/stratos';import {z} from 'zod';
import createChild from '../.generated/child.js';
export default workflow({input:z.strictObject({}),output:z.strictObject({}),run:()=>createChild().execute({})});`,
    );
    await call('build', 'parent');
    fixture.state.toolName = 'renamed';
    await expectFailure(
      call('build', 'parent'),
      /Property 'echo' does not exist/,
    );
    assert.equal(await builtStatus('parent'), 'not built');
    assert.doesNotMatch(await readFile(wrapper, 'utf8'), /\["echo"\]/);
    fixture.state.toolName = 'echo';
    await call('build', 'parent');
    const parentBefore = (await stat(join(parent, 'dist/parent/workflow.js')))
      .mtimeMs;
    fixture.state.input = 'both';
    await call('build', 'child');
    assert.equal(
      await builtStatus('parent'),
      'not built',
      'Remote-only child schema changes invalidate compiled parent copies',
    );
    await call('build', 'parent');
    assert.ok(
      (await stat(join(parent, 'dist/parent/workflow.js'))).mtimeMs >
        parentBefore,
    );

    fixture.state.failDiscovery = true;
    await expectFailure(call('build', 'child'), /Command failed/);
    assert.equal(
      await builtStatus('child'),
      'not built',
      'Failed discovery cannot leave an old success record',
    );
    fixture.state.failDiscovery = false;
    const refreshed = (await store.list()).find(
      record => record.serverUrl === fixture.url,
    )!;
    await store.save({...refreshed, expiresAt: 0});
    fixture.state.failRefresh = true;
    await expectFailure(call('build', 'child'), /refresh failed/);
    assert.equal(
      (await store.list()).find(record => record.serverUrl === fixture.url)
        ?.accessToken,
      refreshed.accessToken,
    );
    fixture.state.failRefresh = false;
    await call('build', 'child');

    const unused = join(root, 'unused');
    await mkdir(unused);
    await writeFile(
      join(unused, 'workflow.yaml'),
      manifest.replace('name: child', 'name: unused'),
    );
    await writeFile(
      join(unused, 'main.ts'),
      `import {workflow} from '@stratoscli/stratos';import {z} from 'zod';
export default workflow({input:z.strictObject({}),output:z.strictObject({}),run:()=>({})});`,
    );
    const discoveries = fixture.state.discoveries;
    await call('run', 'unused');
    assert.equal(
      fixture.state.discoveries,
      discoveries,
      'Agent-only/unimported MCPs do not trigger automatic generation',
    );
    await call('build', 'unused');
    assert.equal(fixture.state.discoveries, discoveries + 1);
    await rm(join(unused, 'main.ts'));
    const project = JSON.parse((await call('build')).stdout);
    assert.equal(
      project.data.find((entry: {name: string}) => entry.name === 'unused')
        .status,
      'prepared',
    );
    assert.equal(await builtStatus('unused'), 'not built');

    const broken = join(root, 'aaa-broken');
    await mkdir(broken);
    await writeFile(
      join(broken, 'workflow.yaml'),
      "name: broken\nshortDescription: Invalid source\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: '1'\n",
    );
    await writeFile(
      join(broken, 'workflow.ts'),
      'const value: number = "wrong"; export default value;',
    );
    await assert.rejects(call('build'), error => {
      const result = JSON.parse((error as {stdout: string}).stdout);
      assert.equal(result.success, false);
      assert.match(result.message, /prepared MCP wrappers for 1; failed 1/);
      assert.equal(
        result.data.find((entry: {name: string}) => entry.name === 'broken')
          .success,
        false,
      );
      assert.equal(
        result.data.find((entry: {name: string}) => entry.name === 'unused')
          .status,
        'prepared',
      );
      assert.equal(
        result.data.find((entry: {name: string}) => entry.name === 'child')
          .status,
        'built',
      );
      return true;
    });
    await writeFile(
      join(parent, 'workflow.ts'),
      `import {workflow} from '@stratoscli/stratos';import {z} from 'zod';
import createChild from '../.generated/unused.js';
export default workflow({input:z.strictObject({}),output:z.strictObject({}),run:()=>createChild().execute({})});`,
    );
    await expectFailure(
      call('build', 'parent'),
      /entrypoint is missing.*unused/,
    );
    const beforeInvalid = fixture.state.discoveries;
    for (const name of [
      '',
      '.',
      '..',
      '../escape',
      'bad/name',
      'bad\\name',
      'bad\0name',
    ]) {
      await writeFile(
        join(unused, 'workflow.yaml'),
        manifest
          .replace('name: child', 'name: unused')
          .replace('    protected:', `    ${JSON.stringify(name)}:`),
      );
      await expectFailure(call('build', 'unused'), /wrapper filename/);
    }
    assert.equal(
      fixture.state.discoveries,
      beforeInvalid,
      'Invalid filenames must fail before connecting',
    );
    const multiple =
      manifest.replace('name: child', 'name: unused') +
      `    second:\n      type: http\n      url: ${fixture.url}\n      auth:\n        type: oauth\n`;
    await writeFile(join(unused, 'workflow.yaml'), multiple);
    const all = JSON.parse((await call('build', 'unused')).stdout);
    assert.equal(all.data.status, 'prepared');
    assert.equal(all.data.wrappers.length, 2);
    assert.equal(fixture.state.discoveries, beforeInvalid + 2);
    assert.deepEqual((await readdir(join(unused, 'generated/mcp'))).sort(), [
      'protected.ts',
      'second.ts',
    ]);
    await store.remove(record);
  },
);
