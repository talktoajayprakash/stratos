import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {stringify} from 'yaml';
import {z} from 'zod';

import {PACKAGE_ROOT} from '../../src/paths.js';
import {testHome, waitForRetention} from '../helpers/home.js';

const exec = promisify(execFile);
const cli = join(PACKAGE_ROOT, 'dist/src/cli/main.js');
const resultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.unknown().optional(),
  errors: z.array(z.object({code: z.string(), message: z.string()})).optional(),
});
const listSchema = z.array(
  z.strictObject({
    name: z.string(),
    shortDescription: z.string(),
    path: z.string(),
    status: z.enum(['built', 'not built']),
    nextAction: z.string().optional(),
  }),
);
const descriptionSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  shortDescription: z.string(),
  longDescription: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
});

void test(
  'list progressively discloses descriptions, describe reuses schemas, and run needs no handshake',
  {timeout: 180_000},
  async t => {
    const cwd = await mkdtemp(join(testHome, 'workflow descriptions #'));
    t.after(async () => {
      try {
        await waitForRetention();
      } finally {
        await rm(cwd, {recursive: true, force: true});
      }
    });
    const root = join(cwd, '.stratos/workflows');
    const directory = join(root, 'greet');
    await mkdir(directory, {recursive: true});
    const manifest = {
      name: 'greet',
      version: '1',
      shortDescription: 'Greet a person without external calls.',
      longDescription:
        '## Usage\n\nSupply name. Returns message.\nDo not retry external side effects blindly.',
      privateMetadata: 'NOT_FOR_DISCOVERY',
    };
    const manifestPath = join(directory, 'workflow.yaml');
    await writeFile(manifestPath, stringify(manifest));
    const source = `import {workflow} from '@stratoscli/stratos';
import {z} from 'zod';
import {appendFileSync, writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(cwd, 'loaded'))}, 'loaded');
console.log('MODULE_LOG');
export default workflow({
  input: z.strictObject({name: z.string().min(1).describe('Person to greet')}),
  output: z.strictObject({message: z.string().describe('s'.repeat(12001))}),
  run({name}) {
    appendFileSync(${JSON.stringify(join(cwd, 'ran'))}, 'run\\n');
    console.log('RUN_LOG');
    return {message: 'Hello, ' + name + '!'};
  },
});`;
    await writeFile(join(directory, 'workflow.ts'), source);
    const invoke = (...args: string[]) =>
      exec(process.execPath, [cli, ...args], {
        cwd,
        signal: t.signal,
        timeout: 90_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    const call = async (...args: string[]) => {
      const response = await invoke(...args, '--json');
      const body = resultSchema.parse(JSON.parse(response.stdout));
      assert.equal(body.success, true, response.stdout);
      return {...response, body};
    };

    const initialFiles = await readdir(root, {recursive: true});
    const listed = await call('list');
    assert.equal(listed.body.message, 'Found 1 workflows.');
    assert.deepEqual(listSchema.parse(listed.body.data), [
      {
        name: manifest.name,
        shortDescription: manifest.shortDescription,
        path: directory,
        status: 'not built',
        nextAction: `Run stratos build ${JSON.stringify(directory)}`,
      },
    ]);
    assert.doesNotMatch(
      listed.stdout,
      /longDescription|inputSchema|outputSchema|NOT_FOR_DISCOVERY|## Usage/,
    );
    assert.deepEqual(await readdir(root, {recursive: true}), initialFiles);
    await assert.rejects(stat(join(cwd, 'loaded')), {code: 'ENOENT'});
    const textList = await invoke('list');
    assert.ok(textList.stdout.includes(manifest.shortDescription));
    assert.doesNotMatch(textList.stdout, /## Usage|NOT_FOR_DISCOVERY/);

    const described = await call('describe', 'greet');
    const detail = descriptionSchema.parse(described.body.data);
    assert.equal(detail.name, manifest.name);
    assert.equal(detail.version, manifest.version);
    assert.equal(detail.shortDescription, manifest.shortDescription);
    assert.equal(detail.longDescription, manifest.longDescription);
    assert.equal(
      z
        .object({
          properties: z.object({
            message: z.object({description: z.string()}),
          }),
        })
        .parse(detail.outputSchema).properties.message.description.length,
      12_001,
    );
    assert.match(described.stderr, /MODULE_LOG/);
    assert.doesNotMatch(
      described.stdout,
      /MODULE_LOG|RUN_LOG|NOT_FOR_DISCOVERY/,
    );
    await assert.rejects(stat(join(cwd, 'ran')), {code: 'ENOENT'});
    assert.equal(await readFile(join(cwd, 'loaded'), 'utf8'), 'loaded');
    const compiled = join(directory, 'dist/greet/workflow.js');
    const before = (await stat(compiled)).mtimeMs;
    const recordPath = join(directory, 'dist/.stratos-build.json');
    const beforeRecord = await readFile(recordPath, 'utf8');
    for (const args of [
      ['--name', 'greet'],
      [directory],
      ['./.stratos/workflows/greet'],
    ]) {
      assert.deepEqual((await call('describe', ...args)).body.data, detail);
      assert.equal((await stat(compiled)).mtimeMs, before);
      assert.equal(await readFile(recordPath, 'utf8'), beforeRecord);
    }
    assert.deepEqual(
      JSON.parse((await invoke('describe', 'greet')).stdout),
      detail,
    );
    const schemas = {
      inputSchema: detail.inputSchema,
      outputSchema: detail.outputSchema,
    };
    assert.deepEqual((await call('schema', 'greet')).body.data, schemas);
    assert.deepEqual(
      JSON.parse((await invoke('schema', 'greet')).stdout),
      schemas,
    );
    assert.equal(
      listSchema.parse((await call('list')).body.data)[0]!.status,
      'built',
    );
    await assert.rejects(stat(join(cwd, 'ran')), {code: 'ENOENT'});

    const revised = {
      ...manifest,
      longDescription: manifest.longDescription + '\nUpdated manual.',
    };
    await writeFile(manifestPath, stringify(revised));
    assert.equal(
      listSchema.parse((await call('list')).body.data)[0]!.status,
      'not built',
    );
    assert.equal(
      descriptionSchema.parse((await call('describe', 'greet')).body.data)
        .longDescription,
      revised.longDescription,
    );
    assert.notEqual(await readFile(recordPath, 'utf8'), beforeRecord);

    const direct = join(root, 'direct');
    await mkdir(direct);
    await writeFile(
      join(direct, 'workflow.yaml'),
      stringify({...manifest, name: 'direct'}),
    );
    await writeFile(join(direct, 'workflow.ts'), source);
    const ran = await call('run', 'direct', '--input', '{"name":"Ada"}');
    assert.deepEqual(ran.body.data, {message: 'Hello, Ada!'});
    assert.match(ran.stderr, /RUN_LOG/);
    assert.equal(await readFile(join(cwd, 'ran'), 'utf8'), 'run\n');

    await writeFile(
      join(directory, 'workflow.ts'),
      source + '\nexport const invalid: string = 42;\n',
    );
    await assert.rejects(call('describe', 'greet'), error => {
      const failure = z.object({stdout: z.string()}).parse(error);
      const body = resultSchema.parse(JSON.parse(failure.stdout));
      assert.equal(body.success, false);
      assert.equal(body.data, undefined);
      assert.match(body.errors?.[0]?.message ?? '', /not assignable/);
      return true;
    });
    assert.equal(await readFile(join(cwd, 'ran'), 'utf8'), 'run\n');
    await assert.rejects(stat(recordPath), {code: 'ENOENT'});
  },
);

void test(
  'all CLI access validates metadata; partial listings report errors and explicit paths resolve ambiguity',
  {timeout: 120_000},
  async t => {
    const cwd = await mkdtemp(join(testHome, 'description-errors-'));
    const global = join(testHome, '.stratos/workflows/description-ambiguous');
    t.after(() => rm(cwd, {recursive: true, force: true}));
    t.after(() => rm(global, {recursive: true, force: true}));
    const directory = join(cwd, '.stratos/workflows/description-ambiguous');
    for (const path of [directory, global]) {
      await mkdir(path, {recursive: true});
      await writeFile(
        join(path, 'workflow.yaml'),
        stringify({
          name: 'description-ambiguous',
          shortDescription: 'Choose this fixture.',
          longDescription: 'Supply valid input.',
          version: '1',
        }),
      );
    }
    const call = (...args: string[]) =>
      exec(process.execPath, [cli, ...args, '--json'], {
        cwd,
        signal: t.signal,
        timeout: 30_000,
      });
    const failure = async (args: string[], pattern: RegExp) => {
      await assert.rejects(call(...args), error => {
        const response = z.object({stdout: z.string()}).parse(error);
        const body = resultSchema.parse(JSON.parse(response.stdout));
        assert.equal(body.success, false);
        assert.match(body.errors?.[0]?.message ?? '', pattern);
        return true;
      });
    };
    await failure(['describe', 'description-ambiguous'], /Ambiguous workflow/);
    await failure(['describe', directory], /Workflow entrypoint is missing/);
    await failure(['describe', 'missing'], /not found/);
    await rm(global, {recursive: true});
    await writeFile(
      join(directory, 'workflow.yaml'),
      stringify({
        name: 'description-ambiguous',
        shortDescription: 'x'.repeat(401),
        longDescription: 'Supply valid input.',
        version: '1',
      }),
    );
    for (const action of ['list', 'build', 'describe', 'schema', 'run']) {
      await failure(
        action === 'list' ? [action] : [action, directory],
        /workflow.yaml: shortDescription: Contains 401 characters; maximum is 400/,
      );
    }
    const valid = join(cwd, '.stratos/workflows/valid');
    await mkdir(valid);
    await writeFile(
      join(valid, 'workflow.yaml'),
      'name: valid\nshortDescription: Select valid.\nlongDescription: Supply valid input.\nversion: "1"\n',
    );
    await assert.rejects(call('list'), error => {
      const response = z.object({stdout: z.string()}).parse(error);
      const body = resultSchema.parse(JSON.parse(response.stdout));
      assert.equal(body.success, false);
      assert.deepEqual(
        listSchema.parse(body.data).map(item => item.name),
        ['valid'],
      );
      assert.equal(body.errors?.[0]?.code, 'WORKFLOW_CONFIG_ERROR');
      return true;
    });
    await assert.rejects(stat(join(cwd, '.stratos/workflows/node_modules')), {
      code: 'ENOENT',
    });
  },
);
