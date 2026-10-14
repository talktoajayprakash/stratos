import assert from 'node:assert/strict';
import '../helpers/home.js';
import test from 'node:test';

import {z} from 'zod';

import {workflow, inspectWorkflow} from '../../src/workflows/definition.js';
import {
  createChildWorkflow,
  executeWorkflow,
  getContext,
} from '../../src/workflows/runtime.js';

const empty = z.strictObject({});
void test('schemas require described strict input fields, reject erased checks, and do not run code', () => {
  let ran = false;
  const definition = workflow({
    input: z.strictObject({count: z.number().default(2).describe('')}),
    output: empty,
    run() {
      ran = true;
      return {};
    },
  });
  const schemas = inspectWorkflow(definition);
  assert.equal(schemas.inputSchema.type, 'object');
  assert.equal(ran, false);
  for (const input of [
    z.object({name: z.string().describe('')}),
    z.strictObject({name: z.string()}),
    z.strictObject({nested: z.object({}).describe('')}),
    z.strictObject({overrides: z.string().describe('')}),
    z.strictObject({
      x: z
        .string()
        .refine(x => x.length > 1)
        .describe(''),
    }),
    z.strictObject({
      x: z
        .string()
        .transform(x => x.length)
        .describe(''),
    }),
  ]) {
    assert.throws(() =>
      inspectWorkflow(workflow({input, output: empty, run: () => ({})})),
    );
  }
});

void test('concurrent executions isolate context, apply defaults, reject unknown input and validate output', async () => {
  const ids = new Set<string>();
  const definition = workflow({
    input: z.strictObject({value: z.number().default(3).describe('')}),
    output: z.object({value: z.number().describe('')}),
    async run(input) {
      const context = getContext();
      ids.add(context.id);
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(getContext(), context);
      return input;
    },
  });
  const results = await Promise.all(
    Array.from({length: 12}, () =>
      executeWorkflow(definition, {}, 'test', '/tmp'),
    ),
  );
  assert.equal(ids.size, 12);
  assert.deepEqual(results[0], {value: 3});
  assert.throws(getContext);
  await assert.rejects(executeWorkflow(definition, {typo: 1}, 'test', '/tmp'));
  await assert.rejects(
    executeWorkflow(
      {...definition, run: () => ({value: 'wrong'})},
      {},
      'test',
      '/tmp',
    ),
  );
});

void test('closure rejects late work and attempts every cleanup on success and failure', async () => {
  let saved: ReturnType<typeof getContext> | undefined;
  let closed = 0;
  const original = new Error('execution failed');
  const definition = workflow({
    input: empty,
    output: empty,
    async run() {
      saved = getContext();
      saved.resources.add({
        async close() {
          closed++;
          throw new Error('cleanup failed');
        },
      });
      saved.resources.add({
        async close() {
          closed++;
        },
      });
      throw original;
    },
  });
  await assert.rejects(
    executeWorkflow(definition, {}, 'test', '/tmp'),
    error => error === original,
  );
  assert.equal(closed, 2);
  assert.equal(saved!.closing, true);
});

void test('child ownership rejects missing discovery context and closed parents before loading code', async () => {
  let child: ReturnType<typeof createChildWorkflow> | undefined;
  let owner: ReturnType<typeof getContext> | undefined;
  const definition = workflow({
    input: empty,
    output: empty,
    async run() {
      owner = getContext();
      child = createChildWorkflow('not-loaded');
      await assert.rejects(child.execute({}), /discovery-root context/);
      return {};
    },
  });
  await executeWorkflow(definition, {}, 'parent', '/tmp');
  await assert.rejects(child!.execute({}), /closed workflow/);
  await assert.rejects(
    executeWorkflow(
      definition,
      {},
      'late child',
      '/tmp',
      undefined,
      {},
      [],
      undefined,
      owner,
    ),
    /Parent workflow is closed/,
  );
});

void test('cycle detection precedes user code and root ownership releases worktrees only after resources', async () => {
  const order: string[] = [];
  const definition = workflow({
    input: empty,
    output: empty,
    run() {
      const owner = getContext();
      owner.resources.add({
        async close() {
          order.push('resource');
        },
      });
      owner.worktrees.releases.add(async safe => {
        order.push(`release:${safe}`);
      });
      return {};
    },
  });
  const metadata = {
    name: 'cycle',
    shortDescription: 'Test fixture',
    longDescription: 'Exercise this test fixture with schema-valid input.',
    version: '1',
    entrypoint: 'workflow.ts',
    path: '/synthetic/cycle',
    root: '/synthetic',
  };
  await assert.rejects(
    executeWorkflow(definition, {}, 'cycle', '/tmp', metadata, {}, [
      metadata.path,
    ]),
    /Workflow cycle/,
  );
  assert.deepEqual(order, []);
  await executeWorkflow(definition, {}, 'releases', '/tmp');
  assert.deepEqual(order, ['resource', 'release:true']);
});
