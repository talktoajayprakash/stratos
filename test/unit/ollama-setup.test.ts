import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {z} from 'zod';

import {
  findOllamaInstallation,
  ollamaInstallGuidance,
  ollamaStatus,
} from '../../src/cli/provider.js';
import {ollamaFixture} from '../helpers/ollama.js';

const setupData = z.object({
  status: z.string(),
  startCommand: z.string().optional(),
  installCommand: z.string().optional(),
});

void test('setup recipes are explicit official OS-specific guidance, not automatic installation', () => {
  assert.equal(
    ollamaInstallGuidance('darwin').installCommand,
    'open https://ollama.com/download/mac',
  );
  assert.equal(ollamaInstallGuidance('darwin').startCommand, 'open -a Ollama');
  assert.equal(
    ollamaInstallGuidance('linux').installCommand,
    'curl -fsSL https://ollama.com/install.sh | sh',
  );
  assert.equal(
    ollamaInstallGuidance('win32').installCommand,
    'Start-Process https://ollama.com/download/windows',
  );
  assert.equal(ollamaInstallGuidance('freebsd').installCommand, undefined);
});

void test('installation checks inspect PATH without executing software and distinguish absent/nonexecutable entries', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'stratos-ollama-install-test-'),
  );
  t.after(() => rm(directory, {recursive: true, force: true}));
  assert.equal(
    await findOllamaInstallation({PATH: directory}, 'freebsd'),
    undefined,
  );
  await mkdir(join(directory, 'ollama'));
  assert.equal(
    await findOllamaInstallation({PATH: directory}, 'freebsd'),
    undefined,
  );
  await rm(join(directory, 'ollama'), {recursive: true});
  await writeFile(join(directory, 'ollama'), 'not an executable program', {
    mode: 0o700,
  });
  assert.equal(
    await findOllamaInstallation({PATH: directory}, 'freebsd'),
    join(directory, 'ollama'),
  );
  await writeFile(join(directory, 'ollama.exe'), 'not an executable program', {
    mode: 0o700,
  });
  assert.equal(
    await findOllamaInstallation({PATH: directory}, 'win32'),
    join(directory, 'ollama.exe'),
  );
  if (process.platform !== 'win32') {
    await chmod(join(directory, 'ollama'), 0o600);
    await assert.rejects(findOllamaInstallation({PATH: directory}, 'freebsd'), {
      code: 'EACCES',
    });
  }
});

void test('setup reads version/inventory, reports capability types and needs no local binary or key', async t => {
  const f = await ollamaFixture(t);
  const result = await ollamaStatus({
    PATH: '',
    OLLAMA_HOST: f.url,
    OPENAI_API_KEY: 'not-sent',
  });
  assert.equal(result.success, true);
  const data = result.data as {
    version: string;
    models: Array<{id: string; local: boolean}>;
  };
  assert.equal(data.version, '0.35.1');
  assert.equal(data.models.length, 5);
  assert.equal(data.models.find(m => m.id === 'cloud:latest')!.local, false);
  assert.equal(data.models.find(m => m.id === 'nimble:latest')!.local, true);
  assert.ok(
    f.requests.every(
      r =>
        !r.authorization &&
        ['/api/version', '/api/tags', '/api/show'].includes(r.path!),
    ),
  );
  f.state.status = 503;
  await assert.rejects(ollamaStatus({OLLAMA_HOST: f.url}), /HTTP 503/);
  f.state.status = 200;
  f.state.malformed = true;
  await assert.rejects(ollamaStatus({OLLAMA_HOST: f.url}));
});

void test('setup distinguishes missing, stopped, remote, TLS and timeout failures without installing anything', async t => {
  const directory = await mkdtemp(
    join(tmpdir(), 'stratos-ollama-setup-errors-'),
  );
  t.after(() => rm(directory, {recursive: true, force: true}));
  let cause: Error = new TypeError('fetch failed', {
    cause: Object.assign(new Error('refused'), {code: 'ECONNREFUSED'}),
  });
  t.mock.method(globalThis, 'fetch', () => Promise.reject(cause));
  const env = {PATH: directory, OLLAMA_HOST: 'http://127.0.0.1:11434'};
  const missing = await ollamaStatus(env, 'freebsd');
  assert.equal(missing.success, false);
  assert.equal(
    z.object({retryCommand: z.string()}).parse(missing.data).retryCommand,
    'stratos provider status ollama --json',
  );
  assert.equal(setupData.parse(missing.data).status, 'not-found');
  assert.match(
    missing.errors![0]!.message,
    /ask the user to approve installation/,
  );
  await writeFile(join(directory, 'ollama'), 'never execute me', {mode: 0o700});
  const stopped = await ollamaStatus(env, 'linux');
  assert.equal(setupData.parse(stopped.data).status, 'not-running');
  assert.equal(setupData.parse(stopped.data).startCommand, 'ollama serve');
  assert.match(stopped.errors![0]!.message, /start Ollama: ollama serve/);
  const remote = await ollamaStatus({
    ...env,
    OLLAMA_HOST: 'https://ollama.example.invalid',
  });
  assert.equal(setupData.parse(remote.data).status, 'remote-unreachable');
  assert.equal(setupData.parse(remote.data).installCommand, undefined);
  assert.match(
    remote.errors![0]!.message,
    /local installation is not required/,
  );
  cause = new TypeError('fetch failed', {
    cause: Object.assign(new Error('private TLS detail'), {
      code: 'CERT_HAS_EXPIRED',
    }),
  });
  const tls = await ollamaStatus(env);
  assert.equal(setupData.parse(tls.data).status, 'connection-error');
  assert.equal(setupData.parse(tls.data).installCommand, undefined);
  assert.match(tls.errors![0]!.message, /TLS/);
  assert.ok(!JSON.stringify(tls).includes('private TLS detail'));
  cause = new DOMException('deadline', 'TimeoutError');
  // Simulate the fetch deadline using the real signal reason.
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(cause));
  const timeout = await ollamaStatus(env);
  assert.equal(setupData.parse(timeout.data).status, 'timeout');
  assert.equal(setupData.parse(timeout.data).installCommand, undefined);
  await assert.rejects(
    ollamaStatus({OLLAMA_HOST: 'https://user:private-password@host'}),
    error =>
      error instanceof Error &&
      /without credentials/.test(error.message) &&
      !error.message.includes('private-password'),
  );
});
