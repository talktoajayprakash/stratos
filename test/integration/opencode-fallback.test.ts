import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';

import type {Config} from '@opencode-ai/sdk/v2';

import {ModelUnavailableError} from '../../src/agents/availability.js';
import {OpenCodeAdapter} from '../../src/agents/opencode/adapter.js';
import {preflightOpenCode} from '../../src/agents/opencode/preflight.js';

const rejection = {
  name: 'APIError',
  data: {
    message: 'Controlled native model rejection',
    statusCode: 404,
    isRetryable: false,
    responseBody: JSON.stringify({error: {code: 'model_not_found'}}),
  },
};

type FixtureRecord =
  | {
      type: 'startup';
      pid: number;
      config: Config;
      env: Record<string, string>;
      path?: never;
      method?: never;
      body?: never;
    }
  | {
      type: 'request';
      method: string;
      path: string;
      body?: {messageID: string; parts: Array<{text: string}>};
      pid?: never;
      config?: never;
      env?: never;
    };

async function fixture(t: TestContext, settings: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'stratos-opencode-boundary-'));
  const resources = join(directory, 'resources');
  await mkdir(resources);
  const log = join(directory, 'requests.jsonl');
  const binary = join(directory, 'opencode.cjs');
  t.after(() => rm(directory, {recursive: true, force: true}));
  const catalog = {
    all: [
      {
        id: 'configured',
        source: 'config',
        models: {listed: {id: 'listed', providerID: 'configured'}},
      },
    ],
    connected: ['configured'],
    default: {configured: 'listed'},
  };
  await writeFile(
    binary,
    `#!/usr/bin/env node
const http = require('node:http'), fs = require('node:fs');
const settings = ${JSON.stringify({catalog, error: rejection, ...settings})};
const log = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(value)+'\\n');
log({type:'startup',pid:process.pid,config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),env:{
 configHome:process.env.XDG_CONFIG_HOME, dataHome:process.env.XDG_DATA_HOME,
 explicitConfig:process.env.OPENCODE_CONFIG, project:process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
 plugins:process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS, autoupdate:process.env.OPENCODE_DISABLE_AUTOUPDATE,
 pure:process.env.OPENCODE_PURE, configSearchHome:process.env.OPENCODE_TEST_HOME }});
if(settings.ignoreTerm) process.on('SIGTERM',()=>{});
let stream, messages=[], turn=0, aborts=0;
const send = (type,properties) => stream?.write('data: '+JSON.stringify({type,properties})+'\\n\\n');
const answer = (res,body,status=200) => {res.writeHead(status,{'content-type':'application/json'});res.end(body===undefined?'':JSON.stringify(body));};
const server=http.createServer(async(req,res)=>{
 try {
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=raw?JSON.parse(raw):undefined,path=new URL(req.url,'http://fixture').pathname;
 log({type:'request',method:req.method,path,body});
 if(path==='/config') {answer(res,settings.nativeConfig??JSON.parse(process.env.OPENCODE_CONFIG_CONTENT));return;}
 if(path==='/provider') {answer(res,settings.catalog,settings.providerStatus??200);return;}
 if(path==='/session'&&req.method==='POST') {answer(res,{id:'owned'});return;}
 if(path==='/event') {
   if(settings.streamStatus) {answer(res,{},settings.streamStatus);return;}
   stream=res;res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();return;
 }
 if(path==='/instance/dispose') {
   answer(res,true);
   setTimeout(()=>{
     if(settings.closeStreamBreak){stream?.end();return;}
     if(settings.closeProgress||settings.closeUnknownProgress) {
       send('message.part.updated',{sessionID:'owned',part:{id:'late',sessionID:'owned',
         messageID:settings.closeUnknownProgress?'unknown-message':'assistant1',type:'text',text:'late work'}});
     }
     send('server.instance.disposed',{directory:process.cwd()});stream?.end();
   },20);
   return;
 }
 if(path==='/session/owned/abort') {aborts++;setTimeout(()=>answer(res,true,settings.abortStatus??200),settings.abortDelay??0);return;}
 if(path==='/session/owned/message'&&req.method==='GET') {
   if(settings.reconcileStatus) {answer(res,{},settings.reconcileStatus);return;}
   answer(res,messages);return;
 }
 if(path==='/session/owned/message'&&req.method==='POST') {
   turn++;
   const user={id:body.messageID,sessionID:'owned',role:'user'};
   const userPart={id:'userpart'+turn,sessionID:'owned',messageID:user.id,type:'text',text:body.parts[0].text};
   const info={id:'assistant'+turn,sessionID:'owned',role:'assistant',parentID:user.id};
   const part={id:'part'+turn,sessionID:'owned',messageID:info.id,type:settings.partType??'text',text:'work'};
   messages.push({info:user,parts:[userPart]});
   send('message.updated',{sessionID:'owned',info:user});
   send('message.part.updated',{sessionID:'owned',part:userPart});
   send('message.part.delta',{sessionID:'owned',messageID:user.id,partID:userPart.id,field:'text',delta:'input, not progress'});
   if(settings.foreign) send('session.error',{sessionID:'not-owned',error:settings.error});
   if(settings.streamBreak) {stream.end();return;}
   if(settings.hang||settings.hangOnce&&turn===1) return;
   if(settings.hook) {
     const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
     const plugin=await import(config.plugin[0]);const hooks=await plugin.StratosHooks();
     try {await hooks['tool.execute.before']({callID:'call',tool:'bash'},{args:{command:'not run'}});}
     catch(error) {log({type:'hook-denied'});}
   }
   if(settings.backgroundModel) {
     const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),plugin=await import(config.plugin[0]);
     await (await plugin.StratosHooks())['chat.params']({agent:'title'},{});log({type:'background-model'});
   }
   if(settings.latePrior&&turn===1) {
     info.structured='first';messages.push({info,parts:[]});answer(res,{info,parts:[]});return;
   }
   if(settings.progress) {
     if(settings.deltaBeforeInfo) send('message.part.delta',{sessionID:'owned',messageID:info.id,partID:part.id,field:'text',delta:'work'});
     send('message.updated',{sessionID:'owned',info});
     send('message.part.updated',{sessionID:'owned',part});
   }
   if(settings.background) send('session.created',{sessionID:'child',info:{id:'child',parentID:'owned'}});
   if(settings.empty) {
     setTimeout(()=>send('session.error',{sessionID:'owned',error:settings.error}),settings.errorDelay??30);
     answer(res,undefined);return;
   }
   if(!settings.successAfter||turn<=settings.successAfter)info.error=settings.error;
   const parts=settings.progress||settings.finalProgress||!info.error?[part]:[];
   messages.push({info,parts});
   answer(res,{info,parts});return;
 }
 answer(res,{},404);
 }catch(error){log({type:'fixture-error',message:error.message});answer(res,{},500);}
});
server.listen(0,'127.0.0.1',()=> {
 if(!settings.silentStartup)console.log('opencode server listening on http://127.0.0.1:'+server.address().port);
});
`,
    {mode: 0o700},
  );
  const env = {
    TMPDIR: resources,
    XDG_DATA_HOME: join(directory, 'native-data'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      enabled_providers: ['configured'],
      provider: {
        configured: {
          npm: '@ai-sdk/openai',
          options: {apiKey: 'loopback-only', baseURL: 'http://127.0.0.1:1'},
          models: {listed: {name: 'Independent model'}},
        },
      },
      plugin: ['file:///untrusted-plugin.mjs'],
      mcp: {forbidden: {type: 'local', command: ['not-run']}},
    }),
  };
  const options = {workingDirectory: directory, binary, env};
  return {
    options,
    resources,
    directory,
    async records(): Promise<FixtureRecord[]> {
      try {
        return (await readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return [];
        }
        throw error;
      }
    },
  };
}

async function waitForRecord(
  f: Awaited<ReturnType<typeof fixture>>,
  matches: (row: FixtureRecord) => boolean,
) {
  const deadline = Date.now() + 5000;
  while (!(await f.records()).some(matches)) {
    assert.ok(
      Date.now() < deadline,
      'Native fixture did not reach the expected lifecycle boundary',
    );
    await delay(20);
  }
}

void test('OpenCode preflight uses the installed server provider API without inference, sessions or model injection', async t => {
  const f = await fixture(t);
  const result = await preflightOpenCode({
    ...f.options,
    provider: 'configured',
  });
  assert.ok(result.available);
  assert.deepEqual(result.catalogs, [
    {
      provider: 'configured',
      source: 'opencode/provider.list:config',
      modelIds: ['listed'],
      complete: true,
    },
  ]);
  const records = await f.records();
  const startup = records[0]!;
  assert.ok(startup.type === 'startup');
  assert.deepEqual(
    records.filter(row => row.type === 'request').map(row => row.path),
    ['/config', '/provider'],
  );
  assert.deepEqual(
    startup.config.provider,
    JSON.parse(f.options.env.OPENCODE_CONFIG_CONTENT).provider,
  );
  assert.equal(startup.config.model, undefined);
  assert.deepEqual(startup.config.plugin, []);
  assert.deepEqual(startup.config.mcp, {});
  assert.deepEqual(startup.config.permission, {'*': 'deny'});
  assert.equal(startup.config.autoupdate, false);
  assert.equal(startup.env.dataHome, f.options.env.XDG_DATA_HOME);
  assert.equal(startup.env.explicitConfig, '');
  assert.equal(startup.env.project, 'true');
  assert.equal(startup.env.plugins, 'true');
  assert.equal(startup.env.pure, 'true');
  assert.ok(startup.env.configSearchHome!.startsWith(f.resources));
  assert.deepEqual(await readdir(f.resources), []);
});

void test('OpenCode readiness skips missing binaries/auth, but propagates config, transport and malformed catalogs', async t => {
  const missing = await fixture(t);
  const missingResult = await preflightOpenCode({
    ...missing.options,
    binary: join(missing.directory, 'missing'),
  });
  assert.ok(
    !missingResult.available && missingResult.reason === 'harness-missing',
  );
  const auth = await fixture(t, {
    catalog: {
      all: [{id: 'configured', models: {}}],
      default: {},
      connected: [],
    },
  });
  const authResult = await preflightOpenCode({
    ...auth.options,
    provider: 'configured',
  });
  assert.ok(
    !authResult.available && authResult.reason === 'authentication-missing',
  );
  for (const settings of [
    {providerStatus: 401},
    {providerStatus: 404},
    {catalog: {all: []}},
    {nativeConfig: {plugin: ['managed']}},
    {nativeConfig: {mcp: {managed: {}}}},
  ]) {
    const f = await fixture(t, settings);
    await assert.rejects(preflightOpenCode(f.options));
    assert.deepEqual(await readdir(f.resources), []);
  }
  await assert.rejects(
    preflightOpenCode({...missing.options, provider: 'wrong-backend'}),
    /disabled/,
  );
  await assert.rejects(
    preflightOpenCode({
      ...missing.options,
      workingDirectory: join(missing.directory, 'absent'),
    }),
    /working directory/,
  );
  assert.deepEqual(await readdir(missing.resources), []);
});

void test('preflight and execution use identical provider configurations and final user text cannot pin selection', async t => {
  const f = await fixture(t);
  await preflightOpenCode(f.options);
  let progress = 0;
  const adapter = new OpenCodeAdapter({
    ...f.options,
    model: {providerID: 'configured', modelID: 'listed'},
    onProgress() {
      progress++;
    },
    onEvent() {},
    diagnostic() {},
  });
  t.after(() => adapter.close());
  await adapter.initialize();
  await assert.rejects(
    adapter.execute('Exact original user prompt'),
    ModelUnavailableError,
  );
  assert.equal(progress, 0);
  await adapter.close();
  const starts = (await f.records()).filter(row => row.type === 'startup');
  assert.deepEqual(starts[0]!.config.provider, starts[1]!.config.provider);
  assert.deepEqual(
    starts[0]!.config.enabled_providers,
    starts[1]!.config.enabled_providers,
  );
  assert.deepEqual(starts[1]!.config.mcp, {});
  assert.equal(starts[1]!.config.plugin!.length, 1);
  const request = (await f.records()).find(
    row => row.path === '/session/owned/message' && row.method === 'POST',
  );
  assert.match(
    request!.body!.messageID,
    /^msg_[a-f0-9]{26}$/,
    'Native IDs use a 48-bit timestamp plus 14 random characters',
  );
  assert.deepEqual(await readdir(f.resources), []);
});

void test('native terminal error classification excludes auth, unrelated 404, retryable 404 and generic failures', async t => {
  for (const error of [
    {...rejection, data: {...rejection.data, statusCode: 401}},
    {
      ...rejection,
      data: {...rejection.data, responseBody: '{"error":{"code":"not_found"}}'},
    },
    {...rejection, data: {...rejection.data, isRetryable: true}},
    {name: 'UnknownError', data: {message: 'model_not_found 404'}},
  ]) {
    const f = await fixture(t, {error});
    const adapter = new OpenCodeAdapter({
      ...f.options,
      model: {providerID: 'configured', modelID: 'listed'},
      onEvent() {},
      diagnostic() {},
    });
    t.after(() => adapter.close());
    await adapter.initialize();
    await assert.rejects(adapter.execute('test'), result => {
      assert.ok(
        result instanceof Error && !(result instanceof ModelUnavailableError),
      );
      assert.deepEqual(result.cause, error);
      return true;
    });

    await adapter.close();
  }
});

void test('native disposal accepts the canonical path of a symlinked working directory', async t => {
  const f = await fixture(t);
  const work = join(f.directory, 'work');
  const alias = join(f.directory, 'alias');
  await mkdir(work);
  await symlink(work, alias, 'dir');
  const adapter = new OpenCodeAdapter({
    ...f.options,
    workingDirectory: alias,
    model: {providerID: 'configured', modelID: 'listed'},
    onEvent() {},
    diagnostic() {},
  });
  t.after(() => adapter.close());
  await adapter.initialize();
  await assert.rejects(adapter.execute('test'), ModelUnavailableError);
  await adapter.close();
  assert.deepEqual(await readdir(f.resources), []);
});

void test('assistant stream/final parts and native background work synchronously report progress, including out-of-order metadata', async t => {
  for (const settings of [
    {progress: true},
    {progress: true, partType: 'reasoning'},
    {progress: true, partType: 'tool'},
    {progress: true, partType: 'file'},
    {progress: true, partType: 'patch'},
    {progress: true, partType: 'subtask'},
    {progress: true, deltaBeforeInfo: true},
    {finalProgress: true},
    {background: true},
    {backgroundModel: true},
  ]) {
    const f = await fixture(t, settings);
    let progress = 0;
    const adapter = new OpenCodeAdapter({
      ...f.options,
      model: {providerID: 'configured', modelID: 'listed'},
      onProgress() {
        progress++;
      },
      onEvent() {
        throw new Error('Soft consumer failure');
      },
      diagnostic() {},
    });
    t.after(() => adapter.close());
    await adapter.initialize();
    await assert.rejects(adapter.execute('test'), ModelUnavailableError);
    assert.ok(progress > 0, JSON.stringify(settings));
    await adapter.close();
  }
});

void test('tool hook progress precedes denial, and hook exceptions remain the original error after native abort', async t => {
  for (const throws of [false, true]) {
    const f = await fixture(t, {hook: true, abortDelay: 100});
    let progress = 0;
    let called = false;
    const failure = new Error('Original hook failure');
    const adapter = new OpenCodeAdapter({
      ...f.options,
      model: {providerID: 'configured', modelID: 'listed'},
      onProgress() {
        progress++;
      },
      onEvent() {},
      diagnostic() {},
      hooks: {
        beforeToolCall() {
          called = true;
          assert.ok(progress > 0);
          if (throws) {
            throw failure;
          }
          return {action: 'deny', reason: 'Not allowed'};
        },
      },
    });
    t.after(() => adapter.close());
    await adapter.initialize();
    await assert.rejects(
      adapter.execute('test'),
      throws ? error => error === failure : ModelUnavailableError,
    );
    assert.ok(called);
    if (throws) {
      assert.ok(
        (await f.records()).some(row => row.path === '/session/owned/abort'),
      );
    }
    await adapter.close();
  }
});

void test('empty HTTP responses await native session.error without unsafe prior-turn classification', async t => {
  for (const latePrior of [false, true]) {
    const f = await fixture(t, {
      empty: true,
      latePrior,
      errorDelay: 50,
      foreign: true,
    });
    const adapter = new OpenCodeAdapter({
      ...f.options,
      model: {providerID: 'configured', modelID: 'listed'},
      outputSchema: latePrior ? {} : undefined,
      onEvent() {},
      diagnostic() {},
    });
    t.after(() => adapter.close());
    await adapter.initialize();
    if (latePrior) {
      assert.equal(await adapter.execute('first'), 'first');
    }
    await assert.rejects(adapter.execute('test'), error => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof ModelUnavailableError, !latePrior);
      assert.deepEqual(error.cause, rejection);
      return true;
    });
    await adapter.close();
  }
});

void test('lifecycle stream or reconciliation failure cannot permit fallback', async t => {
  for (const settings of [
    {streamStatus: 503},
    {streamBreak: true},
    {reconcileStatus: 503},
  ]) {
    const f = await fixture(t, settings);
    const adapter = new OpenCodeAdapter({
      ...f.options,
      model: {providerID: 'configured', modelID: 'listed'},
      onEvent() {},
      diagnostic() {},
    });
    t.after(() => adapter.close().catch(() => {}));
    await assert.rejects(
      async () => {
        await adapter.initialize();
        await adapter.execute('test');
      },
      error => !(error instanceof ModelUnavailableError),
    );
    if (settings.streamBreak) {
      await assert.rejects(adapter.close(), /cleanup failed/);
    } else {
      await adapter.close();
    }
    assert.deepEqual(await readdir(f.resources), []);
  }
});

void test('close drains late native progress before resolving and fails closed on an incomplete lifecycle drain', async t => {
  for (const settings of [
    {closeProgress: true},
    {closeUnknownProgress: true},
    {closeStreamBreak: true},
  ]) {
    const f = await fixture(t, settings);
    let progress = 0;
    const adapter = new OpenCodeAdapter({
      ...f.options,
      model: {providerID: 'configured', modelID: 'listed'},
      onProgress() {
        progress++;
      },
      onEvent() {},
      diagnostic() {},
    });
    t.after(() => adapter.close().catch(() => {}));
    await adapter.initialize();
    await assert.rejects(adapter.execute('test'), ModelUnavailableError);
    assert.equal(progress, 0);
    if (settings.closeProgress) {
      await adapter.close();
      assert.ok(
        progress > 0,
        'Parent must observe late progress before deciding whether to advance',
      );
    } else {
      await assert.rejects(adapter.close(), /cleanup failed/);
    }
    assert.deepEqual(await readdir(f.resources), []);
  }
});

void test('caught failure and cancellation continue the same native conversation without prompt replay', async t => {
  for (const cancellation of [false, true]) {
    const f = await fixture(t, {
      hangOnce: cancellation,
      successAfter: 1,
      abortDelay: 50,
    });
    const adapter = new OpenCodeAdapter({
      ...f.options,
      model: {providerID: 'configured', modelID: 'listed'},
      onEvent() {},
      diagnostic() {},
    });
    t.after(() => adapter.close());
    await adapter.initialize();
    if (cancellation) {
      const rejected = assert.rejects(adapter.execute('first'), /cancelled/);
      await waitForRecord(
        f,
        row => row.path === '/session/owned/message' && row.method === 'POST',
      );
      adapter.cancel();
      await rejected;
    } else {
      await assert.rejects(adapter.execute('first'), ModelUnavailableError);
    }
    assert.equal(await adapter.execute('second'), 'work');
    const requests = (await f.records()).filter(row => row.type === 'request');
    assert.equal(
      requests.filter(row => row.path === '/session' && row.method === 'POST')
        .length,
      1,
    );
    assert.deepEqual(
      requests
        .filter(
          row => row.path === '/session/owned/message' && row.method === 'POST',
        )
        .map(row => row.body!.parts[0]!.text),
      ['first', 'second'],
    );
    await adapter.close();
  }
});

void test(
  'failed native cancellation closes the resource and permanently rejects continuation',
  {timeout: 15000},
  async t => {
    for (const hookFailure of [false, true]) {
      const f = await fixture(t, {
        hangOnce: !hookFailure,
        hook: hookFailure,
        abortStatus: 503,
      });
      const original = new Error('Original hook failure');
      const adapter = new OpenCodeAdapter({
        ...f.options,
        model: {providerID: 'configured', modelID: 'listed'},
        onEvent() {},
        diagnostic() {},
        ...(hookFailure
          ? {
              hooks: {
                beforeToolCall() {
                  throw original;
                },
              },
            }
          : {}),
      });
      t.after(() => adapter.close());
      await adapter.initialize();
      let failure: unknown;
      const rejected = assert.rejects(adapter.execute('first'), error => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /native cancellation failed/);
        if (hookFailure) {
          assert.equal(error.errors[0], original);
        } else {
          assert.match(error.errors[0].message, /cancelled/);
        }
        failure = error;
        return true;
      });
      if (!hookFailure) {
        await waitForRecord(
          f,
          row => row.path === '/session/owned/message' && row.method === 'POST',
        );
        adapter.cancel();
      }
      await rejected;
      await assert.rejects(
        adapter.execute('second'),
        error => error === failure,
      );
      const records = await f.records();
      assert.equal(
        records.filter(
          row => row.path === '/session/owned/message' && row.method === 'POST',
        ).length,
        1,
      );
      const pid = records.find(row => row.type === 'startup')!.pid;
      assert.throws(
        () => process.kill(pid, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
      );
      assert.deepEqual(await readdir(f.resources), []);
      await adapter.close();
    }
  },
);

void test('preflight cancellation closes an unresponsive owned startup without classifying it as missing auth', async t => {
  const f = await fixture(t, {
    silentStartup: true,
    ignoreTerm: process.platform !== 'win32',
  });
  const controller = new AbortController();
  const reason = new Error('Preflight cancelled by caller');
  const rejected = assert.rejects(
    preflightOpenCode(f.options, controller.signal),
    error => error === reason,
  );
  await waitForRecord(f, row => row.type === 'startup');
  controller.abort(reason);
  await rejected;
  assert.deepEqual(await readdir(f.resources), []);
});

void test(
  'preflight cancellation preserves an owned-server cleanup failure',
  {
    skip:
      process.platform === 'win32' && 'POSIX process-group failure injection',
  },
  async t => {
    const f = await fixture(t, {silentStartup: true});
    const controller = new AbortController();
    const reason = new Error('Preflight cancelled by caller');
    const stopFailure = new Error('Native stop denied');
    const rejected = assert.rejects(
      preflightOpenCode(f.options, controller.signal),
      error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [reason, stopFailure]);
        return true;
      },
    );
    await waitForRecord(f, row => row.type === 'startup');
    const pid: number = (await f.records()).find(
      row => row.type === 'startup',
    )!.pid;
    const kill = process.kill.bind(process);
    const mock = t.mock.method(
      process,
      'kill',
      (target: number, signal?: NodeJS.Signals | number) => {
        if (target === -pid && signal === 'SIGTERM') {
          throw stopFailure;
        }
        return kill(target, signal);
      },
    );
    try {
      controller.abort(reason);
      await rejected;
      assert.deepEqual(await readdir(f.resources), []);
    } finally {
      mock.mock.restore();
      kill(-pid, 'SIGKILL');
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            break;
          }
          // eslint-disable-next-line no-unsafe-finally -- Failure to confirm owned-process cleanup must fail this test.
          throw error;
        }
        assert.ok(
          Date.now() < deadline,
          'Owned failure-injection process did not exit',
        );
        await delay(20);
      }
    }
  },
);

void test(
  'cancellation interrupts startup and pending execution, awaits native abort, and closes only owned processes',
  {timeout: 15000},
  async t => {
    for (const startup of [true, false]) {
      const f = await fixture(t, {
        silentStartup: startup,
        hang: !startup,
        abortDelay: 100,
        ignoreTerm: process.platform !== 'win32',
      });
      const adapter = new OpenCodeAdapter({
        ...f.options,
        model: {providerID: 'configured', modelID: 'listed'},
        onEvent() {},
        diagnostic() {},
      });
      t.after(() => adapter.close());
      let active: Promise<unknown>;
      if (startup) {
        active = adapter.initialize();
      } else {
        await adapter.initialize();
        active = adapter.execute('test');
      }
      const rejected = assert.rejects(active, /cancelled/);
      await waitForRecord(f, row =>
        startup
          ? row.type === 'startup'
          : row.path === '/session/owned/message' && row.method === 'POST',
      );
      adapter.cancel();
      await rejected;
      await adapter.close();
      const records = await f.records();
      const pid = records.find(row => row.type === 'startup')?.pid;
      if (pid) {
        assert.throws(
          () => process.kill(pid, 0),
          (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
        );
      }
      if (!startup) {
        assert.ok(records.some(row => row.path === '/session/owned/abort'));
      }
      assert.deepEqual(await readdir(f.resources), []);
    }
  },
);

void test(
  'installed OpenCode discovers native catalogs, rejects a listed model, and preserves destination conversation',
  {
    skip:
      !process.env.STRATOS_TEST_OPENCODE_BINARY &&
      'Opt in with an installed OpenCode binary; provider responses are synthetic loopback fixtures',
    timeout: 90000,
  },
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'stratos-opencode-native-boundary-'),
    );
    const resources = join(directory, 'resources');
    const work = join(directory, 'work');
    await Promise.all([mkdir(resources), mkdir(work)]);
    await promisify(execFile)('git', ['init', '--quiet', work]);
    const ids = ['openai/gpt-6-sol', 'openai/gpt-6-astra'];
    const requests: Array<{model: string; text: string; path?: string}> = [];
    const failures: unknown[] = [];
    const provider = createServer((request, response) => {
      void (async () => {
        try {
          let text = '';
          for await (const chunk of request) {
            text += chunk;
          }
          const data = JSON.parse(text) as {model: string};
          requests.push({model: data.model, text, path: request.url});
          if (data.model === ids[0]) {
            response.writeHead(404, {'content-type': 'application/json'}).end(
              JSON.stringify({
                error: {
                  code: 'model_not_found',
                  type: 'invalid_request_error',
                  param: 'model',
                  message: 'Synthetic native boundary rejection',
                },
              }),
            );
            return;
          }
          assert.equal(data.model, ids[1]);
          const output = 'SYNTHETIC_LOOPBACK_RESULT';
          response.writeHead(200, {'content-type': 'text/event-stream'});
          const send = (event: Record<string, unknown>) =>
            response.write(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
          send({
            type: 'response.created',
            response: {
              id: `response-${requests.length}`,
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
              id: 'message',
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          });
          send({
            type: 'response.content_part.added',
            item_id: 'message',
            output_index: 0,
            content_index: 0,
            part: {type: 'output_text', text: '', annotations: []},
          });
          send({
            type: 'response.output_text.delta',
            item_id: 'message',
            output_index: 0,
            content_index: 0,
            delta: output,
          });
          send({
            type: 'response.output_text.done',
            item_id: 'message',
            output_index: 0,
            content_index: 0,
            text: output,
          });
          send({
            type: 'response.completed',
            response: {
              id: `response-${requests.length}`,
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
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', resolve);
    });
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    const env = {
      HOME: directory,
      TMPDIR: resources,
      XDG_DATA_HOME: join(directory, 'data'),
      XDG_CACHE_HOME: join(directory, 'cache'),
      XDG_STATE_HOME: join(directory, 'state'),
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        enabled_providers: ['openrouter'],
        share: 'disabled',
        agent: {title: {disable: true}, summary: {disable: true}},
        provider: {
          openrouter: {
            npm: '@ai-sdk/openai',
            whitelist: ids,
            options: {
              baseURL: `http://127.0.0.1:${address.port}/v1`,
              apiKey: 'synthetic-local-only',
            },
            models: Object.fromEntries(
              ids.map(id => [
                id,
                {name: id, limit: {context: 32768, output: 128}},
              ]),
            ),
          },
        },
      }),
    };
    const options = {
      workingDirectory: work,
      binary: process.env.STRATOS_TEST_OPENCODE_BINARY!,
      env,
    };
    const adapters: OpenCodeAdapter[] = [];
    t.after(async () => {
      for (const adapter of adapters) {
        await adapter.close();
      }
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        provider.close(error => (error ? reject(error) : resolve())),
      );
      await rm(directory, {recursive: true, force: true});
    });
    const readiness = await preflightOpenCode({
      ...options,
      provider: 'openrouter',
    });
    assert.ok(readiness.available);
    assert.deepEqual(
      readiness.catalogs
        .find(catalog => catalog.provider === 'openrouter')
        ?.modelIds.slice()
        .sort(),
      [...ids].sort(),
    );
    assert.equal(
      requests.length,
      0,
      'Discovery must not make inference requests',
    );
    assert.deepEqual(await readdir(resources), []);
    let progress = 0;
    const make = (modelID: string) => {
      const adapter = new OpenCodeAdapter({
        ...options,
        model: {providerID: 'openrouter', modelID},
        onProgress() {
          progress++;
        },
        onEvent() {},
        diagnostic() {},
      });
      adapters.push(adapter);
      return adapter;
    };
    const first = make(ids[0]!);
    await first.initialize();
    const prompt =
      'Remember LOCAL_NATIVE_MARKER. Reply briefly. Do not use tools.';
    const cancelFirst = setTimeout(() => first.cancel(), 30000);
    try {
      await assert.rejects(first.execute(prompt), error => {
        assert.ok(error instanceof ModelUnavailableError);
        assert.deepEqual(
          (error.cause as {data: {statusCode: number; isRetryable: boolean}})
            .data.statusCode,
          404,
        );
        assert.equal(
          (error.cause as {data: {isRetryable: boolean}}).data.isRetryable,
          false,
        );
        return true;
      });
    } finally {
      clearTimeout(cancelFirst);
      await first.close();
    }
    assert.equal(progress, 0, 'User text and pure dispatch are not progress');
    assert.deepEqual(
      await readdir(resources),
      [],
      'The rejected resource must be fully released before opening another',
    );
    const second = make(ids[1]!);
    await second.initialize();
    const cancelSecond = setTimeout(() => second.cancel(), 30000);
    try {
      assert.equal(
        ((await second.execute(prompt)) as string).trim(),
        'SYNTHETIC_LOOPBACK_RESULT',
      );
      assert.ok(progress > 0);
      assert.equal(
        ((await second.execute('Repeat the earlier marker.')) as string).trim(),
        'SYNTHETIC_LOOPBACK_RESULT',
      );
    } catch (error) {
      t.diagnostic(
        `Native requests: ${requests.length}; first boundaries: ${JSON.stringify(requests.slice(0, 5).map(({model, path}) => ({model, path})))}`,
      );
      t.diagnostic(
        `Fixture transport failures: ${failures.map(error => (error instanceof Error ? error.message : 'unknown')).join('; ')}`,
      );
      throw error;
    } finally {
      clearTimeout(cancelSecond);
      await second.close();
    }
    assert.deepEqual(
      requests.map(request => request.model),
      [ids[0], ids[1], ids[1]],
    );
    assert.ok(
      requests.every(request => request.text.includes(prompt)),
      'Both candidates and the native continuation retain the original user prompt',
    );
    assert.deepEqual(failures, []);
    assert.deepEqual(await readdir(resources), []);
    t.diagnostic(
      'Real installed OpenCode SDK/server; provider failures and successful output are synthetic, not remote inference.',
    );
  },
);
