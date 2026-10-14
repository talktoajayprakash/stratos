import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

import {stringify} from 'smol-toml';

import {
  isMissingExecutable,
  snapshotCatalog,
  type HarnessReadiness,
} from '../availability.js';
import {readCodexCatalog} from './catalog.js';
import {ollamaCatalog, readOllamaModels} from '../ollama.js';
import {
  codexAuthPath,
  codexProvider,
  type CodexEnvironmentOptions,
} from './provider.js';

export {codexAuthPath, codexEnvironment} from './provider.js';
export type CodexPreflightOptions = CodexEnvironmentOptions & {
  workingDirectory: string;
  provider?: string;
  binary?: string;
};

export function codexBinary(): string {
  if (
    !['darwin', 'linux'].includes(process.platform) ||
    !['arm64', 'x64'].includes(process.arch)
  ) {
    throw new Error('Unsupported Codex platform');
  }
  const require = createRequire(import.meta.url);
  const codexRequire = createRequire(
    require.resolve('@openai/codex/package.json'),
  );
  const root = dirname(
    codexRequire.resolve(
      `@openai/codex-${process.platform}-${process.arch}/package.json`,
    ),
  );
  const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  return join(root, 'vendor', target, 'bin', 'codex');
}

async function savedAuthentication(
  path: string,
): Promise<'missing' | 'api-key' | 'chatgpt'> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingExecutable(error)) {
      return 'missing';
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid Codex authentication JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Codex authentication file');
  }
  if (
    'OPENAI_API_KEY' in value &&
    value.OPENAI_API_KEY !== null &&
    value.OPENAI_API_KEY !== undefined
  ) {
    if (
      typeof value.OPENAI_API_KEY !== 'string' ||
      !value.OPENAI_API_KEY.trim()
    ) {
      throw new Error('Invalid saved Codex API key');
    }
    return 'api-key';
  }
  if (
    'tokens' in value &&
    typeof value.tokens === 'object' &&
    value.tokens !== null &&
    'access_token' in value.tokens &&
    typeof value.tokens.access_token === 'string' &&
    value.tokens.access_token.trim() &&
    'id_token' in value.tokens &&
    typeof value.tokens.id_token === 'string' &&
    value.tokens.id_token.trim() &&
    'refresh_token' in value.tokens &&
    typeof value.tokens.refresh_token === 'string' &&
    value.tokens.refresh_token.trim()
  ) {
    return 'chatgpt';
  }
  throw new Error(
    'Codex authentication file contains no usable saved credentials',
  );
}

type NativeStatus = {code: number; stdout: string; stderr: string};
function nativeStatus(
  binary: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  signal?: AbortSignal,
): Promise<NativeStatus> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        env,
        cwd,
        signal,
        timeout: 15_000,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        if (!error) {
          resolve({code: 0, stdout, stderr});
          return;
        }
        if (typeof error.code === 'number' && !error.killed) {
          resolve({code: error.code, stdout, stderr});
          return;
        }
        // Native login diagnostics can contain key fragments. Never retain those in errors.
        reject(
          Object.assign(
            new Error('Codex preflight command failed', {
              cause: {
                code: error.code,
                signal: error.signal,
                killed: error.killed,
              },
            }),
            {code: error.code},
          ),
        );
      },
    );
  });
}

function notLoggedIn(status: NativeStatus): boolean {
  const lines = `${status.stdout}\n${status.stderr}`
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('WARNING:'));
  return (
    status.code === 1 && lines.length === 1 && lines[0] === 'Not logged in'
  );
}

/** Checks native presence and metadata, not remote credential validity or entitlement. */
export async function preflightCodex(
  options: CodexPreflightOptions,
  signal?: AbortSignal,
): Promise<HarnessReadiness> {
  signal?.throwIfAborted();
  const provider = await codexProvider(options);
  const env = provider.env;
  let binary: string;
  try {
    binary = options.binary ?? codexBinary();
  } catch (error) {
    if (isMissingExecutable(error)) {
      return {available: false, reason: 'harness-missing', error};
    }
    throw error;
  }
  const home = await mkdtemp(join(tmpdir(), 'stratos-codex-preflight-'));
  let failed = false;
  let failure: unknown;
  try {
    Object.assign(env, {
      CODEX_HOME: home,
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CACHE_HOME: join(home, 'cache'),
      XDG_STATE_HOME: join(home, 'state'),
    });
    let version: NativeStatus;
    try {
      version = await nativeStatus(binary, ['--version'], env, home, signal);
    } catch (error) {
      if (isMissingExecutable(error)) {
        return {available: false, reason: 'harness-missing', error};
      }
      throw error;
    }
    if (version.code !== 0) {
      throw new Error('Codex version check failed', {
        cause: {code: version.code},
      });
    }
    await writeFile(join(home, 'config.toml'), stringify(provider.config), {
      mode: 0o600,
    });
    if (options.provider === 'ollama') {
      return {
        available: true,
        catalogs: [ollamaCatalog(await readOllamaModels(env, signal))],
      };
    }
    if (provider.id === 'azure') {
      if (!provider.hasApiKey) {
        return {
          available: false,
          reason: 'authentication-missing',
          error: new Error(
            'Codex Azure authentication is not configured: set the provider env_key',
          ),
        };
      }
      const catalog = await readCodexCatalog({
        binary,
        env,
        cwd: home,
        signal,
        provider: provider.id,
      });
      return {available: true, catalogs: [catalog]};
    }
    const authentication = env.CODEX_API_KEY
      ? 'api-key'
      : await savedAuthentication(codexAuthPath(options));
    if (authentication !== 'missing' && !env.CODEX_API_KEY) {
      await symlink(codexAuthPath(options), join(home, 'auth.json'));
    }
    const status = await nativeStatus(
      binary,
      ['-c', 'cli_auth_credentials_store="file"', 'login', 'status'],
      env,
      home,
      signal,
    );
    if (authentication === 'missing' && notLoggedIn(status)) {
      return {
        available: false,
        reason: 'authentication-missing',
        error: new Error('Codex authentication is not configured'),
      };
    }
    // login status does not read CODEX_API_KEY; exec does. Its known absence is not a rejected key.
    if (status.code !== 0 && !(env.CODEX_API_KEY && notLoggedIn(status))) {
      throw new Error('Codex authentication status check failed', {
        cause: {code: status.code},
      });
    }
    if (authentication === 'missing') {
      throw new Error('Codex reported an unrecognized authentication source');
    }
    const catalog = await readCodexCatalog({binary, env, cwd: home, signal});
    // API-key discovery exposes native metadata, not an exhaustive API account model list.
    return {
      available: true,
      catalogs: [
        authentication === 'api-key'
          ? snapshotCatalog({...catalog, complete: false})
          : catalog,
      ],
    };
  } catch (error) {
    failed = true;
    failure =
      signal?.aborted && !(error instanceof AggregateError)
        ? signal.reason
        : error;
    throw failure;
  } finally {
    try {
      await rm(home, {recursive: true, force: true});
    } catch (error) {
      if (failed) {
        // eslint-disable-next-line no-unsafe-finally -- Preserve both failures; incomplete cleanup must block fallback.
        throw new AggregateError(
          [failure, error],
          'Codex preflight and cleanup failed',
        );
      }
      // eslint-disable-next-line no-unsafe-finally -- A successful probe is unusable when its cleanup fails.
      throw error;
    }
    if (!failed) {
      signal?.throwIfAborted();
    }
  }
}
