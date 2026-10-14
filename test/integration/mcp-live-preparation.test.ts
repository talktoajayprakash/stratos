import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {PACKAGE_ROOT} from '../../src/paths.js';
import {waitForRetention} from '../helpers/home.js';

void test(
  'live GitHub MCP: manifest-first build, fresh explicit regeneration, typed execution and cached run',
  {
    skip:
      process.env.STRATOS_TEST_MCP_PREPARATION !== '1' &&
      'Opt in with STRATOS_TEST_MCP_PREPARATION=1 and STRATOS_TEST_GITHUB_TOKEN',
    timeout: 180_000,
  },
  async t => {
    const token = process.env.STRATOS_TEST_GITHUB_TOKEN;
    assert.ok(token, 'An authorized GitHub token is required');
    const cwd = await realpath(
      await mkdtemp(join(tmpdir(), 'stratos-mcp-live-prepare-')),
    );
    t.after(async () => {
      try {
        await waitForRetention();
      } finally {
        await rm(cwd, {recursive: true, force: true});
      }
    });
    const dir = join(cwd, '.stratos/workflows/github');
    await mkdir(dir, {recursive: true});
    await writeFile(
      join(dir, 'workflow.yaml'),
      `name: github
shortDescription: Read-only live MCP authoring verification
longDescription: Exercise this test fixture with schema-valid input.
version: '1'
mcp:
  servers:
    github:
      type: http
      url: https://api.githubcopilot.com/mcp/
      headers:
        Authorization: "Bearer {env:STRATOS_TEST_GITHUB_TOKEN}"
`,
    );
    const call = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [join(PACKAGE_ROOT, 'dist/src/cli/main.js'), ...args, '--json'],
        {cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024},
      );
    assert.equal(
      JSON.parse((await call('build', 'github')).stdout).data.status,
      'prepared',
    );
    const path = join(dir, 'generated/mcp/github.ts');
    const wrapper = await readFile(path, 'utf8');
    assert.ok(wrapper.includes('get_me'));
    assert.ok(!wrapper.includes(token));
    const before = (await stat(path)).mtimeMs;
    await call('build', 'github');
    assert.ok((await stat(path)).mtimeMs > before);
    await writeFile(
      join(dir, 'workflow.ts'),
      `import {workflow} from '@stratoscli/stratos';import {z} from 'zod';
import createGithub from './generated/mcp/github.js';
export default workflow({input:z.strictObject({}),output:z.strictObject({verified:z.boolean().describe('')}),
async run(){const github=await createGithub();const result=await github.get_me({});
return {verified:!result.isError && JSON.stringify(result).includes('login')};}});`,
    );
    await call('build', 'github');
    const ready = (await stat(path)).mtimeMs;
    const result = await call('run', 'github');
    assert.equal(JSON.parse(result.stdout).data.verified, true);
    assert.equal((await stat(path)).mtimeMs, ready);
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
    t.diagnostic(
      JSON.stringify({
        realRemoteMcp: true,
        auth: 'GitHub token',
        manifestOnly: true,
        freshExplicitBuild: true,
        tool: 'get_me',
        calls: 1,
        wrapperBytes: wrapper.length,
      }),
    );
  },
);
