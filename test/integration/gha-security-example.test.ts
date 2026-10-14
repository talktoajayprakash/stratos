import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {once} from 'node:events';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {parse} from 'yaml';
import {z} from 'zod';

import {PACKAGE_ROOT} from '../../src/paths.js';
import {testHome, waitForRetention} from '../helpers/home.js';

const exec = promisify(execFile);
const finding = z.strictObject({
  file: z.string(),
  line: z.number(),
  class: z.string(),
  severity: z.string(),
  explanation: z.string().min(1),
});
const envelope = z.object({
  success: z.boolean(),
  data: z.object({findings: z.array(finding)}).optional(),
});
const seeded = [
  ['01-pwn-request.yml', 18, 'pwn_request', 'critical'],
  ['02-expression-injection.yml', 16, 'expression_injection', 'high'],
  ['03-issue-comment-command.yml', 13, 'unauthorized_command', 'high'],
  ['04-workflow-run-artifact.yml', 30, 'artifact_poisoning', 'high'],
  ['05-unpinned-third-party.yml', 18, 'supply_chain', 'high'],
  ['06-self-hosted-pr.yml', 12, 'self_hosted_runner', 'critical'],
].map(([file, line, klass, severity]) => ({
  file: `.github/workflows/${file}`,
  line,
  class: klass,
  severity,
}));

void test(
  'published GitHub Actions review exposes descriptions, scans locally and filters Decision answers',
  {timeout: 180000},
  async t => {
    const source = join(PACKAGE_ROOT, 'examples/gha-security-review');
    const configuration = z
      .object({
        name: z.literal('gha-security-review'),
        version: z.string(),
        shortDescription: z.string().min(1),
        longDescription: z.string().min(1),
        description: z.never().optional(),
        decision: z.object({
          triage: z.object({
            model: z.literal('jev-1.13.0'),
            apiKey: z.literal('{env:JEV_API_KEY}'),
          }),
        }),
      })
      .parse(parse(await readFile(join(source, 'workflow.yaml'), 'utf8')));
    const cwd = await realpath(
      await mkdtemp(join(tmpdir(), 'stratos-gha-example-')),
    );
    t.after(async () => {
      try {
        await waitForRetention();
      } finally {
        await rm(cwd, {recursive: true, force: true});
      }
    });
    const authored = [
      'workflow.ts',
      'workflow.yaml',
      'package.json',
      'package-lock.json',
      'sample-repo',
    ].map(name => join(source, name));
    const copyOptions = {
      recursive: true,
      filter: (path: string) =>
        path === source ||
        authored.some(name => path === name || path.startsWith(`${name}/`)),
    };
    await cp(source, join(cwd, 'gha-security-review'), copyOptions);
    const call = (...args: string[]) =>
      exec(
        process.execPath,
        [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), ...args, '--json'],
        {
          cwd,
          env: {...process.env, HOME: testHome, JEV_API_KEY: 'fixture-only'},
          signal: t.signal,
          timeout: 120000,
        },
      );
    assert.equal(
      JSON.parse((await call('build', './gha-security-review')).stdout).success,
      true,
    );
    const schemas = z
      .strictObject({
        inputSchema: z.record(z.string(), z.unknown()),
        outputSchema: z.record(z.string(), z.unknown()),
      })
      .parse(
        JSON.parse((await call('schema', './gha-security-review')).stdout).data,
      );
    const expectedDescription = {
      name: configuration.name,
      version: configuration.version,
      shortDescription: configuration.shortDescription,
      longDescription: configuration.longDescription,
      ...schemas,
    };
    assert.deepEqual(
      JSON.parse((await call('describe', './gha-security-review')).stdout).data,
      expectedDescription,
    );
    assert.deepEqual(schemas.inputSchema.required, ['repoDir']);
    assert.deepEqual(Object.keys(schemas.outputSchema.properties ?? {}), [
      'findings',
    ]);
    assert.deepEqual(
      JSON.parse((await call('list')).stdout).data,
      [],
      'Examples outside discovery roots are selected by path',
    );
    await assert.rejects(stat(join(cwd, 'traces')), {code: 'ENOENT'});

    let unauthorized = false;
    let scores: Record<string, number> = {};
    const requested: string[] = [];
    const fixtureErrors: unknown[] = [];
    const server = createServer((req, res) => {
      void (async () => {
        assert.equal(req.url, '/v1/systemone');
        assert.equal(req.headers.authorization, 'Bearer fixture-only');
        let body = '';
        for await (const chunk of req) {
          body += chunk;
        }
        const request = z
          .object({
            model: z.string(),
            state: z.object({workflow_file: z.string(), content: z.string()}),
            questions: z.record(
              z.string(),
              z.object({type: z.literal('noul')}),
            ),
          })
          .parse(JSON.parse(body));
        assert.equal(request.model, configuration.decision.triage.model);
        requested.push(request.state.workflow_file);
        if (unauthorized) {
          res.writeHead(401).end('Fixture authentication failure');
          return;
        }
        const noul = scores[request.state.workflow_file] ?? 0.9;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            model: 'fixture-only',
            usage: {input_tokens: 1, output_tokens: 1},
            answers: Object.fromEntries(
              Object.keys(request.questions).map(id => [
                id,
                {type: 'noul', noul},
              ]),
            ),
          }),
        );
      })().catch(error => {
        fixtureErrors.push(error);
        res.writeHead(500).end('Fixture assertion failed');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const overrides = JSON.stringify({
      decision: {triage: {baseUrl: `http://127.0.0.1:${address.port}`}},
    });
    const run = async (input: object, target = './gha-security-review') => {
      try {
        const result = await call(
          'run',
          target,
          '--input',
          JSON.stringify(input),
          '--overrides',
          overrides,
        );
        return {code: 0, ...envelope.parse(JSON.parse(result.stdout))};
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 1 ||
          !('stdout' in error) ||
          typeof error.stdout !== 'string'
        ) {
          throw error;
        }
        return {code: 1, ...envelope.parse(JSON.parse(error.stdout))};
      }
    };
    const input = {repoDir: 'gha-security-review/sample-repo'};
    const summary = (result: Awaited<ReturnType<typeof run>>) =>
      result.data!.findings.map(({explanation: _, ...rest}) => rest);

    const all = await run(input);
    assert.equal(all.code, 0);
    assert.deepEqual(summary(all), seeded);
    assert.deepEqual(
      [...requested].sort(),
      seeded.map(s => s.file),
      'Only scanner candidates reach Decision; safe decoys do not',
    );

    scores = {
      [seeded[4]!.file]: 0.2,
      [seeded[5]!.file]: 0.199999,
    };
    const filtered = await run(input);
    assert.equal(filtered.code, 0);
    assert.deepEqual(summary(filtered), seeded.slice(0, 5));

    unauthorized = true;
    const failed = await run(input);
    assert.equal(failed.code, 1);
    assert.equal(failed.success, false);

    const before = requested.length;
    const invalid = await run({repoDir: ''});
    assert.equal(invalid.code, 1);
    assert.equal(requested.length, before, 'Input errors must not call Jev');

    const root = join(cwd, '.stratos/workflows');
    await mkdir(root, {recursive: true});
    const discovered = join(root, configuration.name);
    await cp(source, discovered, copyOptions);
    const listed = JSON.parse((await call('list')).stdout);
    assert.deepEqual(listed.data, [
      {
        name: configuration.name,
        shortDescription: configuration.shortDescription,
        path: discovered,
        status: 'not built',
        nextAction: `Run stratos build ${JSON.stringify(discovered)}`,
      },
    ]);
    assert.equal(listed.message, 'Found 1 workflows.');
    assert.doesNotMatch(
      JSON.stringify(listed),
      /longDescription|inputSchema|outputSchema/,
    );
    await assert.rejects(stat(join(root, 'node_modules')), {code: 'ENOENT'});
    assert.deepEqual(
      JSON.parse((await call('describe', configuration.name)).stdout).data,
      expectedDescription,
    );
    assert.equal(
      requested.length,
      before,
      'Discovery and inspection do not call Decision',
    );
    unauthorized = false;
    scores = {};
    const byName = await run(
      {repoDir: join(discovered, 'sample-repo')},
      configuration.name,
    );
    assert.equal(byName.code, 0);
    assert.deepEqual(summary(byName), seeded);
    assert.deepEqual(
      requested.slice(before).sort(),
      seeded.map(item => item.file),
    );
    assert.deepEqual(fixtureErrors, []);
  },
);
