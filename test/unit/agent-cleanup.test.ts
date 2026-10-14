import assert from 'node:assert/strict';
import {test} from 'node:test';

import {closeAgentAdapters} from '../../src/agents/cleanup.js';

void test('cleanup attempts every close and waits for outstanding closure despite failures', async () => {
  const errors = [
    new Error('synchronous close failure'),
    new Error('async close failure'),
  ];
  const reported: unknown[] = [];
  const started: number[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  let finished = false;
  const cleanup = closeAgentAdapters(
    new Set([
      {
        close() {
          started.push(1);
          throw errors[0];
        },
      },
      {
        async close() {
          started.push(2);
          throw errors[1];
        },
      },
      {
        close() {
          started.push(3);
          return pending;
        },
      },
    ]),
    error => reported.push(error),
  ).then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(finished, false);
  release();
  await cleanup;
  assert.deepEqual(reported, errors);
});

void test('cleanup preserves success and the original execution failure, even if logging fails', async () => {
  const cleanupError = new Error('close failed');
  const originalError = new Error('execution failed');
  let reports = 0;
  async function execute(fail: boolean) {
    try {
      if (fail) {
        throw originalError;
      }
      return 'success';
    } finally {
      await closeAgentAdapters(
        [
          {
            async close() {
              throw cleanupError;
            },
          },
          {
            async close() {
              throw cleanupError;
            },
          },
        ],
        error => {
          assert.equal(error, cleanupError);
          reports++;
          throw new Error('logging failed');
        },
      );
    }
  }
  assert.equal(await execute(false), 'success');
  await assert.rejects(execute(true), error => error === originalError);
  assert.equal(reports, 4);
});
