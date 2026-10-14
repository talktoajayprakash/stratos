import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import test from 'node:test';

import {requestDecision} from '../../src/decision/transport.js';

for (const apiKey of ['fixture-secret', undefined]) {
  void test(`Decision transport (${apiKey ? 'authenticated' : 'local'}): bounds retries and preserves request shape`, async t => {
    let calls = 0;
    let status = 503;
    let raw = '{"answers":{}}';
    const server = createServer(async (req, res) => {
      calls++;
      assert.equal(
        req.headers.authorization,
        apiKey ? `Bearer ${apiKey}` : undefined,
      );
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      assert.deepEqual(JSON.parse(body), {state: 'fixture'});
      res.writeHead(status);
      res.end(raw);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const url = new URL(
      `http://127.0.0.1:${(server.address() as {port: number}).port}/v1/systemone`,
    );
    const call = () =>
      requestDecision(
        url,
        apiKey,
        {state: 'fixture'},
        new AbortController().signal,
        1000,
        1,
      );
    await assert.rejects(call(), /HTTP 503/);
    assert.equal(calls, 4);
    for (status of [400, 401, 404, 413]) {
      calls = 0;
      raw = 'fixture-secret';
      await assert.rejects(
        call(),
        error =>
          String(error).includes(`HTTP ${status}`) &&
          !String(error).includes('fixture-secret'),
      );
      assert.equal(calls, 1);
    }
    calls = 0;
    status = 200;
    raw = 'bad json';
    await assert.rejects(call(), /Invalid Decision JSON/);
    assert.equal(calls, 1);
    calls = 0;
    raw = '{"answers":{}}';
    assert.deepEqual(await call(), {answers: {}});
    assert.equal(calls, 1);
  });

  void test(`Decision transport (${apiKey ? 'authenticated' : 'local'}): aborts in-flight requests and retry waits`, async t => {
    let calls = 0;
    let respond = false;
    const server = createServer((_req, res) => {
      calls++;
      if (respond) {
        res.writeHead(429);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const url = new URL(
      `http://127.0.0.1:${(server.address() as {port: number}).port}/v1/systemone`,
    );
    const active = new AbortController();
    const request = requestDecision(url, apiKey, {}, active.signal, 1000, 1000);
    await once(server, 'request');
    active.abort(new Error('Workflow closed'));
    await assert.rejects(request, /Workflow closed/);
    assert.equal(calls, 1);
    respond = true;
    calls = 0;
    const waiting = new AbortController();
    const retry = requestDecision(url, apiKey, {}, waiting.signal, 1000, 1000);
    await once(server, 'request');
    await new Promise(resolve => setTimeout(resolve, 30));
    waiting.abort();
    await assert.rejects(retry);
    assert.equal(calls, 1);
  });

  void test(`Decision transport (${apiKey ? 'authenticated' : 'local'}): per-attempt timeout with at most four attempts`, async t => {
    let calls = 0;
    const server = createServer(() => {
      calls++;
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const url = new URL(
      `http://127.0.0.1:${(server.address() as {port: number}).port}/v1/systemone`,
    );
    await assert.rejects(
      requestDecision(url, apiKey, {}, new AbortController().signal, 50, 1),
      /timed out/,
    );
    assert.equal(calls, 4);
  });
}
