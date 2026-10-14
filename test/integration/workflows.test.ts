import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {PACKAGE_ROOT} from '../../src/paths.js';
import {workspaceName} from '../../src/telemetry/artifact-storage.js';
import {testHome, waitForRetention} from '../helpers/home.js';

const exec = promisify(execFile);
void test('CLI prepares authored workflows, runs generated children, reuses builds and rejects schema/type/cycle errors', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'stratos workflow #'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const root = join(cwd, '.stratos/workflows');
  await mkdir(root, {recursive: true});
  const call = async (...args: string[]) => {
    const result = await exec(
      process.execPath,
      [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), ...args, '--json'],
      {cwd},
    );
    return {...result, result: JSON.parse(result.stdout)};
  };
  const author = async (name: string, body: string) => {
    await mkdir(join(root, name), {recursive: true});
    await writeFile(
      join(root, name, 'workflow.yaml'),
      `name: ${name}\nshortDescription: Test ${name}\nlongDescription: Exercise this test fixture with schema-valid input.\nversion: "1"\n`,
    );
    await writeFile(join(root, name, 'workflow.ts'), body);
  };
  const child = `import { workflow } from '@stratoscli/stratos'; import { z } from 'zod'; import { getContext } from '@stratoscli/stratos/internal/runtime';
  export default workflow({ input: z.strictObject({ value: z.number().default(2).describe('') }),
    output: z.object({ value: z.number().describe('') }),
    run(input) { if (getContext().name !== 'child') throw new Error('Wrong child SDK/context'); console.log('SCRIPT_LOG'); return { value: input.value * 2 }; } });`;
  await author('child', child);
  await author(
    'parent',
    `import { workflow } from '@stratoscli/stratos'; import { z } from 'zod'; import { getContext } from '@stratoscli/stratos/internal/runtime';
    import createChild from '../.generated/child.js';
    export default workflow({ input: z.strictObject({}), output: z.object({ total: z.number().describe('') }),
      async run() { const child = createChild(); const results = await Promise.all([child.execute({ value: 3 }), child.execute({ value: 4 })]); if (getContext().name !== 'parent') throw new Error('Parent context not restored'); return { total: results[0].value + results[1].value }; } });`,
  );
  await author('broken', 'export const invalid: string = 42;');
  const list = await call('list');
  assert.ok(
    list.result.data.every(
      (entry: {status: string}) => entry.status === 'not built',
    ),
  );
  await assert.rejects(stat(join(root, 'node_modules')));
  const run = await call('run', 'parent');
  for (const directory of [root, join(root, 'parent'), join(root, 'child')]) {
    assert.equal(
      JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).type,
      'module',
    );
  }
  assert.deepEqual(run.result.data, {total: 14});
  assert.match(run.stderr, /not built, running build first/);
  assert.match(run.stderr, /SCRIPT_LOG/);
  await waitForRetention();
  const artifacts = join(
    testHome,
    '.stratos/runs',
    workspaceName(await realpath(cwd)),
  );
  const runs = (await readdir(artifacts, {withFileTypes: true})).filter(entry =>
    entry.isDirectory(),
  );
  assert.equal(runs.length, 1);
  const runDirectory = join(artifacts, runs[0]!.name);
  const log = await readFile(join(runDirectory, 'run.log'), 'utf8');
  assert.equal(log.trim().split('\n').length, 2);
  assert.ok(
    log
      .trim()
      .split('\n')
      .every(
        line =>
          line.includes('"workflowName":"child"') &&
          line.includes('"parentExecutionId":'),
      ),
  );
  assert.equal(await readFile(join(runDirectory, 'events.jsonl'), 'utf8'), '');
  assert.equal(
    JSON.parse(await readFile(join(runDirectory, 'run.json'), 'utf8')).status,
    'success',
  );
  const before = await stat(join(root, 'parent/dist/parent/workflow.js'));
  const reused = await call('run', '--name', 'parent');
  assert.doesNotMatch(reused.stderr, /not built/);
  assert.equal(
    (await stat(join(root, 'parent/dist/parent/workflow.js'))).mtimeMs,
    before.mtimeMs,
  );
  const schema = await call('schema', 'child');
  assert.equal(schema.result.data.inputSchema.properties.value.description, '');
  assert.doesNotMatch(schema.stderr, /SCRIPT_LOG/);
  await assert.rejects(call('run', 'child', '--input', '{"typo":1}'));
  await writeFile(
    join(root, 'child/workflow.ts'),
    child.replace('input.value * 2', 'input.value * 3'),
  );
  assert.equal(
    (await call('list')).result.data.find(
      (w: {name: string}) => w.name === 'parent',
    ).status,
    'not built',
  );
  assert.deepEqual((await call('run', 'parent')).result.data, {total: 21});
  await assert.rejects(call('build', 'broken'));
  await author('commonjs', child);
  await writeFile(
    join(root, 'commonjs/package.json'),
    '{"type":"commonjs","name":"preserve"}',
  );
  await assert.rejects(call('build', 'commonjs'), error =>
    String((error as {stdout?: string}).stdout).includes(
      'resolve this conflict',
    ),
  );
  assert.equal(
    JSON.parse(await readFile(join(root, 'commonjs/package.json'), 'utf8'))
      .type,
    'commonjs',
  );
  await author(
    'cycle',
    "import { workflow } from '@stratoscli/stratos'; import { z } from 'zod'; import self from '../.generated/cycle.js'; export default workflow({input:z.strictObject({}),output:z.object({}),run:()=>self().execute({})});",
  );
  await assert.rejects(call('build', 'cycle'), error =>
    String((error as {stdout?: string}).stdout).includes('Workflow cycle'),
  );
  await call('clean', 'child');
  assert.equal(
    (await call('list')).result.data.find(
      (w: {name: string}) => w.name === 'parent',
    ).status,
    'not built',
  );
  assert.match(
    await readFile(join(root, 'child/workflow.ts'), 'utf8'),
    /input.value/,
  );
  await rm(join(root, 'broken'), {recursive: true});
  assert.ok(
    !(await call('list')).result.data.some(
      (w: {name: string}) => w.name === 'broken',
    ),
  );
});
