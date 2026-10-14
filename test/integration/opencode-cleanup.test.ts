import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {OpenCodeAdapter} from '../../src/agents/opencode/adapter.js';

void test(
  'OpenCode shutdown stops a launcher and its native server child',
  {timeout: 15000, skip: process.platform === 'win32'},
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'stratos-opencode-cleanup-'),
    );
    const pidFile = join(directory, 'server.pid');
    let pid: number | undefined;
    t.after(async () => {
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
        }
      }
      await rm(directory, {recursive: true, force: true});
    });
    const server = `const http = require('node:http');
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    let events;
    const server = http.createServer((req,res) => {
      if(req.url.startsWith('/event')) { events=res;res.writeHead(200, {'content-type':'text/event-stream'}); res.flushHeaders(); return; }
      if(req.url.startsWith('/instance/dispose')) {
        events.write('data: '+JSON.stringify({type:'server.instance.disposed',properties:{directory:process.cwd()}})+'\\n\\n');
        events.end();
      }
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify(req.url.startsWith('/session') && !req.url.includes('/abort') ? { id:'fixture-session' } : true));
    });
    server.listen(0,'127.0.0.1',()=>console.log('opencode server listening on http://127.0.0.1:'+server.address().port));`;
    const launcher = join(directory, 'opencode.cjs');
    await writeFile(
      launcher,
      `#!/usr/bin/env node\nrequire('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(server)}],{stdio:'inherit'});\n`,
      {mode: 0o700},
    );
    const adapter = new OpenCodeAdapter({
      workingDirectory: directory,
      binary: launcher,
      model: {providerID: 'fixture', modelID: 'fixture'},
      onEvent() {},
      diagnostic() {},
    });
    await adapter.initialize();
    pid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(pid > 0);
    process.kill(pid, 0);
    await adapter.close();
    assert.throws(
      () => process.kill(pid!, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
    );
    pid = undefined;
  },
);
