import assert from 'node:assert/strict';
import test from 'node:test';

import {blockedClaudeOutput} from '../../src/agents/claude/tool-output.js';

void test('Claude blocking uses native Bash output shape; MCP accepts unstructured feedback', () => {
  assert.deepEqual(blockedClaudeOutput('Bash', 'blocked'), {
    stdout: 'blocked',
    stderr: '',
    interrupted: false,
    isImage: false,
  });
  assert.equal(
    blockedClaudeOutput('mcp__github__get_me', 'blocked'),
    'blocked',
  );
});

void test('unmapped built-ins error instead of submitting a silently ignored replacement', () => {
  assert.throws(() => blockedClaudeOutput('Read', 'blocked'), /not yet mapped/);
});
