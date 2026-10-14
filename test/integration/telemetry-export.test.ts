import assert from 'node:assert/strict';
import '../helpers/home.js';
import {once} from 'node:events';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {
  Server,
  ServerCredentials,
  type ServerUnaryCall,
  type sendUnaryData,
} from '@grpc/grpc-js';
import {ROOT_CONTEXT} from '@opentelemetry/api';
import {z} from 'zod';

import {workflow} from '../../src/index.js';
import {RunTelemetry} from '../../src/telemetry/export.js';
import type {WorkflowMetadata} from '../../src/workflows/discovery.js';
import {executeWorkflow, getContext} from '../../src/workflows/runtime.js';
import {traceSpans as spans} from '../helpers/otlp.js';
const metadata = (cwd: string, name: string, path?: string) =>
  ({
    name,
    shortDescription: 'Trace fixture',
    longDescription: 'Manual text that must not appear in workflow attributes.',
    version: '1',
    path: cwd,
    root: cwd,
    ...(path ? {otel: {traces: {exporter: {type: 'file', path}}}} : {}),
  }) as WorkflowMetadata;
const empty = z.strictObject({});
const definition = (run: () => Promise<{}>) =>
  workflow({input: empty, output: empty, run});
async function files(directory: string) {
  const entries = await readdir(directory);
  return (
    await Promise.all(
      entries.map(async file =>
        (await readFile(join(directory, file), 'utf8'))
          .trim()
          .split('\n')
          .flatMap(line => spans(JSON.parse(line))),
      ),
    )
  ).flat();
}

void test('file routing preserves nested parentage, deduplicates inherited destinations, and isolates caught failures', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'stratos-traces-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  await executeWorkflow(
    definition(async () => {
      const parent = getContext();
      await executeWorkflow(
        definition(async () => ({})),
        {},
        'same',
        cwd,
        metadata(cwd, 'same', 'parent'),
        {},
        [],
        parent.agentPool,
        parent,
      );
      await assert.rejects(
        executeWorkflow(
          definition(async () => {
            throw new Error('child failure');
          }),
          {},
          'different',
          cwd,
          metadata(cwd, 'different', 'child'),
          {},
          [],
          parent.agentPool,
          parent,
        ),
      );
      return {};
    }),
    {},
    'parent',
    cwd,
    metadata(cwd, 'parent', 'parent'),
  );
  const all = await files(join(cwd, 'parent'));
  const child = await files(join(cwd, 'child'));
  assert.equal(all.length, 3);
  assert.equal(child.length, 1);
  assert.equal((await readdir(join(cwd, 'parent'))).length, 1);
  const parent = all.find(s => s.name === 'workflow parent')!;
  for (const item of all) {
    assert.equal(
      item.attributes.find(a => a.key === 'stratos.workflow.description')?.value
        .stringValue,
      'Trace fixture',
    );
    assert.doesNotMatch(JSON.stringify(item), /Manual text|longDescription/);
  }
  for (const item of all.filter(s => s !== parent)) {
    assert.equal(item.parentSpanId, parent.spanId);
    assert.equal(item.traceId, parent.traceId);
  }
  assert.equal(parent.status.code, 1);
  assert.equal(child[0]!.status.code, 2);
  assert.equal(
    child[0]!.spanId,
    all.find(s => s.name === 'workflow different')!.spanId,
  );
});

void test('child-only destinations and concurrent top-level runs retain independent trace context', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'stratos-child-traces-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  await Promise.all(
    ['one', 'two'].map(name =>
      executeWorkflow(
        definition(async () => {
          const parent = getContext();
          await executeWorkflow(
            definition(async () => ({})),
            {},
            name + '-child',
            cwd,
            metadata(cwd, name, name),
            {},
            [],
            parent.agentPool,
            parent,
          );
          return {};
        }),
        {},
        name,
        cwd,
      ),
    ),
  );
  const a = await files(join(cwd, 'one'));
  const b = await files(join(cwd, 'two'));
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.ok(a[0]!.parentSpanId);
  assert.notEqual(a[0]!.traceId, b[0]!.traceId);
});

for (const protocol of ['http/json', 'http/protobuf', 'grpc']) {
  void test(`exports actual ${protocol} payloads with configured authentication`, async t => {
    const received: Array<{body: Buffer; auth: unknown; type?: string}> = [];
    let endpoint: string;
    if (protocol === 'grpc') {
      const server = new Server();
      server.addService(
        {
          export: {
            path: '/opentelemetry.proto.collector.trace.v1.TraceService/Export',
            requestStream: false,
            responseStream: false,
            requestSerialize: (v: Buffer) => v,
            requestDeserialize: (v: Buffer) => v,
            responseSerialize: () => Buffer.alloc(0),
            responseDeserialize: (v: Buffer) => v,
          },
        },
        {
          export(
            call: ServerUnaryCall<Buffer, {}>,
            callback: sendUnaryData<{}>,
          ) {
            received.push({
              body: call.request,
              auth: call.metadata.get('authorization')[0],
            });
            callback(null, {});
          },
        },
      );
      const port = await new Promise<number>((resolve, reject) =>
        server.bindAsync(
          '127.0.0.1:0',
          ServerCredentials.createInsecure(),
          (error, port) => (error ? reject(error) : resolve(port)),
        ),
      );
      endpoint = `http://127.0.0.1:${port}`;
      t.after(() => server.forceShutdown());
    } else {
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        received.push({
          body: Buffer.concat(chunks),
          auth: req.headers.authorization,
          type: req.headers['content-type'],
        });
        res.setHeader(
          'content-type',
          protocol === 'http/json'
            ? 'application/json'
            : 'application/x-protobuf',
        );
        res.end(protocol === 'http/json' ? '{}' : Buffer.alloc(0));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      endpoint = `http://127.0.0.1:${(server.address() as {port: number}).port}/v1/traces`;
    }
    process.env.STRATOS_EXPORT_TEST = 'private-fixture-token';
    t.after(() => {
      delete process.env.STRATOS_EXPORT_TEST;
    });
    const telemetry = new RunTelemetry();
    const ctx = await telemetry.context(
      ROOT_CONTEXT,
      {
        type: 'otlp',
        endpoint,
        protocol,
        headers: {Authorization: 'Bearer {env:STRATOS_EXPORT_TEST}'},
      },
      process.cwd(),
      process.cwd(),
      'test',
      'id',
    );
    telemetry.tracer
      .startSpan(
        'actual-export',
        {
          attributes: {
            content: 'hello private-fixture-token',
            data: JSON.stringify({apiKey: 'other-secret', answer: 42}),
          },
        },
        ctx,
      )
      .end();
    await telemetry.close();
    assert.equal(received.length, 1);
    assert.equal(received[0]!.auth, 'Bearer private-fixture-token');
    assert.ok(received[0]!.body.includes(Buffer.from('actual-export')));
    assert.ok(
      !received[0]!.body.includes(Buffer.from('private-fixture-token')),
    );
    assert.ok(!received[0]!.body.includes(Buffer.from('other-secret')));
    if (protocol === 'http/json') {
      assert.equal(
        spans(JSON.parse(received[0]!.body.toString()))[0]!.name,
        'actual-export',
      );
    } else {
      assert.equal(
        received[0]!.body[0],
        10,
        'OTLP resourceSpans protobuf field',
      );
    }
  });
}

void test('invalid configuration and unavailable destinations remain soft and do not expose secrets', async t => {
  const messages: unknown[][] = [];
  const original = console.error;
  console.error = (...args) => {
    messages.push(args);
  };
  t.after(() => {
    console.error = original;
  });
  const telemetry = new RunTelemetry();
  const ctx = await telemetry.context(
    ROOT_CONTEXT,
    {
      type: 'otlp',
      endpoint: 'http://127.0.0.1:1/v1/traces',
      protocol: 'http/json',
    },
    '.',
    '.',
    'test',
    'id',
  );
  telemetry.tracer.startSpan('failed-export', {}, ctx).end();
  await telemetry.context(
    ctx,
    {
      type: 'otlp',
      endpoint: 'https://example.invalid',
      protocol: 'http/json',
      headers: {Authorization: '{env:STRATOS_NEVER_DEFINED_TEST}'},
    },
    '.',
    '.',
    'test',
    'id',
  );
  await telemetry.close();
  assert.ok(messages.length >= 2);
  assert.ok(
    messages.every(m => String(m).includes('workflow execution continues')),
  );
});

void test('non-authentication headers preserve content and IDs while credential headers and references are redacted', async t => {
  const received: Buffer[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers['x-ingestion-version'], '4');
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    received.push(Buffer.concat(chunks));
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const previous = process.env.STRATOS_HEADER_REFERENCE;
  process.env.STRATOS_HEADER_REFERENCE = 'referenced-fixture-secret';
  t.after(() => {
    if (previous === undefined) {
      delete process.env.STRATOS_HEADER_REFERENCE;
    } else {
      process.env.STRATOS_HEADER_REFERENCE = previous;
    }
  });
  const telemetry = new RunTelemetry();
  const endpoint = `http://127.0.0.1:${(server.address() as {port: number}).port}/v1/traces`;
  const ctx = await telemetry.context(
    ROOT_CONTEXT,
    {
      type: 'otlp',
      endpoint,
      protocol: 'http/json',
      headers: {
        'x-ingestion-version': '4',
        'X-Token': 'literal-fixture-token',
        'x-custom': '{env:STRATOS_HEADER_REFERENCE}',
      },
    },
    process.cwd(),
    process.cwd(),
    'test',
    'id',
  );
  telemetry.tracer
    .startSpan(
      'header-redaction',
      {
        attributes: {
          'stratos.workflow.execution.id': 'workflow-4242',
          output: JSON.stringify({answer: 4, text: 'The answer is 4'}),
          content: 'literal-fixture-token referenced-fixture-secret',
        },
      },
      ctx,
    )
    .end();
  await telemetry.close();
  assert.equal(received.length, 1);
  const payload = received[0]!.toString('utf8');
  const attributes = Object.fromEntries(
    spans(JSON.parse(payload))[0]!.attributes.map(item => [
      item.key,
      item.value.stringValue,
    ]),
  );
  assert.equal(attributes['stratos.workflow.execution.id'], 'workflow-4242');
  assert.deepEqual(JSON.parse(attributes.output!), {
    answer: 4,
    text: 'The answer is 4',
  });
  assert.equal(attributes.content, '[redacted] [redacted]');
  assert.ok(!payload.includes('literal-fixture-token'));
  assert.ok(!payload.includes('referenced-fixture-secret'));
});
