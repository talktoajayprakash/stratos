import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {z} from 'zod';

import {PACKAGE_ROOT} from '../../src/paths.js';
import {workflowHash} from '../../src/workflows/discovery.js';
import {waitForRetention} from '../helpers/home.js';

void test(
  'generated MCP outputs preserve envelopes, validate declared schemas and invalidate changed consumers',
  {timeout: 240_000},
  async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'stratos-mcp-outputs-'));
    t.after(async () => {
      try {
        await waitForRetention();
      } finally {
        await rm(cwd, {recursive: true, force: true});
      }
    });
    const dir = join(cwd, '.stratos/workflows/example');
    await mkdir(dir, {recursive: true});
    const statePath = join(cwd, 'state.json');
    const state = {
      output: 'string',
      schema: true,
      mode: 'valid',
      externalRef: false,
    };
    const save = () => writeFile(statePath, JSON.stringify(state));
    await save();
    await writeFile(
      join(dir, 'server.mjs'),
      `import {appendFileSync,readFileSync} from 'node:fs';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const state=JSON.parse(readFileSync(${JSON.stringify(statePath)},'utf8'));
const schema=type=>({type:'object',title:'SharedRoot',
properties:{value:{type},nested:{$ref:'#/$defs/Node'},items:{type:'array',items:{type}},optional:{type:['string','null']}},
required:['value','nested','items'],additionalProperties:false,
$defs:{Node:{type:'object',title:'SharedNode',properties:{value:{type},next:{$ref:'#/$defs/Node'}},required:['value'],additionalProperties:false}}});
const server=new Server({name:'output-fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
{name:'typed-tool',inputSchema:schema('boolean'),...(state.schema?{outputSchema:state.externalRef
?{type:'object',properties:{value:{$ref:'https://invalid.example/output.json'}}}:schema(state.output)}:{})},
{name:'typed_tool',inputSchema:schema('string'),outputSchema:schema('number')},
{name:'generic',inputSchema:{type:'object'}},
{name:'generic-structured',inputSchema:{type:'object'}}
]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
appendFileSync(${JSON.stringify(join(cwd, 'calls'))},request.params.name+'\\n');
const content=[{type:'text',text:'not JSON: human-readable content is preserved'}];
if(request.params.name==='generic')return {content};
if(request.params.name==='generic-structured')return {content,structuredContent:{untyped:true}};
if(state.mode==='error')return {content,isError:true};
if(state.mode==='missing')return {content};
const type=request.params.name==='typed-tool'?state.output:'number';
const value=state.mode==='invalid'?false:type==='string'?'answer':42;
return {content,structuredContent:{value,nested:{value,next:{value}},items:[value],optional:null},_meta:{fixture:true}};
});
await server.connect(new StdioServerTransport());`,
    );

    await writeFile(
      join(dir, 'workflow.yaml'),
      `name: example\nshortDescription: MCP output types\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: '1'\nmcp:\n  servers:\n    local:\n      type: stdio\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(join(dir, 'server.mjs'))}]\n`,
    );
    const call = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), ...args, '--json'],
        {cwd, signal: t.signal, timeout: 90_000, maxBuffer: 4 * 1024 * 1024},
      );
    const expectFailure = (work: Promise<unknown>, pattern: RegExp) =>
      assert.rejects(work, error => {
        assert.match(String((error as {stdout?: string}).stdout), pattern);
        return true;
      });
    await call('build', 'example');
    const wrapperPath = join(dir, 'generated/mcp/local.ts');
    let wrapper = await readFile(wrapperPath, 'utf8');
    assert.match(wrapper, /export type Tool_typed\$2D\$toolOutput = /);
    assert.match(wrapper, /export type Tool_typed_toolOutput = /);
    assert.doesNotMatch(
      wrapper,
      /export type Tool_generic(?:Output|\$2D\$structuredOutput)/,
    );
    const source = `import {workflow} from '@stratoscli/stratos';import {z} from 'zod';
import createLocal,{type Tool_typed$2D$toolInput,type Tool_typed$2D$toolOutput,type Tool_typed_toolOutput} from './generated/mcp/local.js';
const args:Tool_typed$2D$toolInput={value:true,nested:{value:false},items:[true]};
export default workflow({input:z.strictObject({}),output:z.strictObject({verified:z.boolean().describe('')}),
async run(){
const local=await createLocal();
const a=await local['typed-tool'](args);
const b=await local.typed_tool({value:'input',nested:{value:'input'},items:[]});
const first:Tool_typed$2D$toolOutput=a.structuredContent;
const second:Tool_typed_toolOutput=b.structuredContent;
const text:string=first.value;
const nested:string=first.nested.next!.value;
const item:string=first.items[0]!;
const number:number=second.value;
const generic=await local.generic({});
const untyped=await local['generic-structured']({});
// @ts-expect-error Undeclared structured output remains unknown, not any.
const notTyped:{untyped:boolean}=untyped.structuredContent;
// @ts-expect-error Output fields are typed, not any.
const notNumber:number=first.value;
return {verified:text==='answer'&&nested==='answer'&&item==='answer'&&number===42
&&first.optional===null&&a._meta?.fixture===true
&&a.content[0]?.type==='text'&&a.content[0].text==='not JSON: human-readable content is preserved'
&&generic.structuredContent===undefined
&&JSON.stringify(untyped.structuredContent)==='{"untyped":true}'};
}});`;
    await writeFile(join(dir, 'workflow.ts'), source);
    await call('build', 'example');
    assert.equal(
      JSON.parse((await call('run', 'example')).stdout).data.verified,
      true,
    );

    const authoredHash = await workflowHash(dir);
    state.output = 'number';
    await save();
    assert.equal(await workflowHash(dir), authoredHash);
    await expectFailure(
      call('run', 'example'),
      /does not match the tool's output schema/,
    );
    await expectFailure(call('build', 'example'), /not assignable/);
    state.output = 'string';
    state.schema = false;
    await save();
    await expectFailure(call('build', 'example'), /Tool_typed\$2D\$toolOutput/);
    wrapper = await readFile(wrapperPath, 'utf8');
    assert.doesNotMatch(wrapper, /export type Tool_typed\$2D\$toolOutput/);
    state.schema = true;
    await save();
    await call('build', 'example');

    const countCalls = async () =>
      (await readFile(join(cwd, 'calls'), 'utf8')).trim().split('\n').length;
    for (const [mode, message] of [
      ['missing', /did not return structured content/],
      ['invalid', /does not match the tool's output schema/],
      ['error', /MCP tool local.typed-tool failed/],
    ] as const) {
      state.mode = mode;
      await save();
      const before = await countCalls();
      await expectFailure(call('run', 'example'), message);
      assert.equal(await countCalls(), before + 1, 'No failed-call retry');
    }
    state.mode = 'valid';
    state.externalRef = true;
    await save();
    wrapper = await readFile(wrapperPath, 'utf8');
    await expectFailure(call('build', 'example'), /resolve|resolver/i);
    assert.equal(await readFile(wrapperPath, 'utf8'), wrapper);
    await assert.rejects(readFile(join(dir, 'dist/.stratos-build.json')), {
      code: 'ENOENT',
    });
  },
);

void test(
  'modern MCP wrappers preserve array, scalar, null and unconstrained outputs',
  {timeout: 120_000},
  async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'stratos-mcp-modern-outputs-'));
    t.after(async () => {
      try {
        await waitForRetention();
      } finally {
        await rm(cwd, {recursive: true, force: true});
      }
    });
    const outputs = [
      {
        name: 'array',
        schema: {type: 'array', items: {type: 'number'}},
        value: [1, 2],
      },
      {name: 'scalar', schema: {type: 'string'}, value: 'text'},
      {name: 'null', schema: {type: 'null'}, value: null},
      {name: 'anything', schema: {}, value: true},
    ];
    const methods: string[] = [];
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      try {
        let body = '';
        for await (const chunk of req) {
          body += String(chunk);
        }
        const request = z
          .object({
            id: z.union([z.string(), z.number()]),
            method: z.string(),
            params: z.object({name: z.string().optional()}).optional(),
          })
          .parse(JSON.parse(body));
        methods.push(request.method);
        let result: object;
        switch (request.method) {
          case 'server/discover':
            result = {
              supportedVersions: ['2026-07-28'],
              capabilities: {tools: {}},
              ttlMs: 0,
              cacheScope: 'private',
            };
            break;
          case 'tools/list':
            result = {
              tools: outputs.map(output => ({
                name: output.name,
                inputSchema: {type: 'object'},
                outputSchema: output.schema,
              })),
              ttlMs: 0,
              cacheScope: 'private',
            };
            break;
          case 'tools/call': {
            const output = outputs.find(
              output => output.name === request.params?.name,
            );
            assert.ok(output);
            result = {
              content: [{type: 'text', text: 'unchanged'}],
              structuredContent: output.value,
            };
            break;
          }
          default:
            throw new Error(`Unexpected fixture method: ${request.method}`);
        }
        res.writeHead(200, {'Content-Type': 'application/json'}).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {resultType: 'complete', ...result},
          }),
        );
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise<void>(resolve => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const dir = join(cwd, '.stratos/workflows/example');
    await mkdir(dir, {recursive: true});
    await writeFile(
      join(dir, 'workflow.yaml'),
      `name: example\nshortDescription: Modern output schemas\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: '1'\nmcp:\n  servers:\n    local:\n      type: http\n      url: http://127.0.0.1:${address.port}/mcp\n`,
    );
    await writeFile(
      join(dir, 'workflow.ts'),
      `import {workflow} from '@stratoscli/stratos';import {z} from 'zod';
import createLocal,{type Tool_arrayOutput,type Tool_scalarOutput,type Tool_nullOutput,type Tool_anythingOutput} from './generated/mcp/local.js';
const unrestricted:Tool_anythingOutput=42;
export default workflow({input:z.strictObject({}),output:z.strictObject({verified:z.boolean().describe('')}),
async run(){
const local=await createLocal();
const array:Tool_arrayOutput=(await local.array({})).structuredContent;
const scalar:Tool_scalarOutput=(await local.scalar({})).structuredContent;
const nil:Tool_nullOutput=(await local.null({})).structuredContent;
const any=await local.anything({});
const numbers:number[]=array;
const text:string=scalar;
const nothing:null=nil;
// @ts-expect-error An unconstrained output does not promise object fields.
const notTyped:{field:string}=any.structuredContent;
return {verified:numbers[1]===2&&text==='text'&&nothing===null
&&any.structuredContent===true&&unrestricted===42&&any.content[0]?.type==='text'&&any.content[0].text==='unchanged'};
}});`,
    );
    const {stdout} = await promisify(execFile)(
      process.execPath,
      [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), 'run', 'example', '--json'],
      {cwd, signal: t.signal, timeout: 90_000, maxBuffer: 4 * 1024 * 1024},
    );
    assert.equal(JSON.parse(stdout).data.verified, true);
    assert.ok(methods.includes('server/discover'));
    assert.ok(!methods.includes('initialize'));
    assert.equal(methods.filter(method => method === 'tools/call').length, 4);
  },
);
