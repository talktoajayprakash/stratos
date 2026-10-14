import {
  execFile,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';

import {claudeProviderEnvironment, loadCatalog} from '../../models/catalog.js';
import {providerModelIds} from '../../models/mapping.js';
import {
  isMissingExecutable,
  snapshotCatalog,
  type HarnessReadiness,
} from '../availability.js';

type ClaudePreflightOptions = {
  cwd: string;
  provider?: string;
  env?: Record<string, string | undefined>;
  pathToClaudeCodeExecutable?: string;
};

const exec = promisify(execFile);
const runCommand = async (
  executable: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
) => {
  const script = /\.(js|mjs|tsx|ts|jsx)$/.test(executable);
  if (script) {
    await stat(executable);
  }
  const {stdout} = await exec(
    script ? process.execPath : executable,
    script ? [executable, ...args] : args,
    options,
  );
  return {stdout};
};
type Dependencies = {
  run?: typeof runCommand;
  executable?: () => string;
  catalog?: typeof loadCatalog;
};

/** Resolve relative to the SDK itself, with the same Linux libc preference as its query factory. */
export function claudeExecutable(): string {
  const require = createRequire(
    createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'),
  );
  const platform = process.platform;
  const arch = process.arch;
  const report = platform === 'linux' ? process.report.getReport() : undefined;
  const header = report && 'header' in report ? report.header : undefined;
  const musl =
    header !== null &&
    typeof header === 'object' &&
    !('glibcVersionRuntime' in header);
  const suffixes =
    platform === 'linux'
      ? musl
        ? [`linux-${arch}-musl`, `linux-${arch}`]
        : [`linux-${arch}`, `linux-${arch}-musl`]
      : platform === 'android'
        ? [`linux-${arch}-android`]
        : [`${platform}-${arch}`];
  let missing: unknown;
  for (const suffix of suffixes) {
    try {
      return require.resolve(
        `@anthropic-ai/claude-agent-sdk-${suffix}/claude${platform === 'win32' ? '.exe' : ''}`,
      );
    } catch (error) {
      if (!isMissingExecutable(error)) {
        throw error;
      }
      missing = error;
    }
  }
  throw missing;
}

const nativeProviders: Readonly<Record<string, string>> = {
  firstParty: 'anthropic',
  bedrock: 'amazon-bedrock',
  vertex: 'google-vertex-anthropic',
};

export async function preflightClaude(
  options: ClaudePreflightOptions,
  signal?: AbortSignal,
  dependencies: Dependencies = {},
): Promise<HarnessReadiness> {
  signal?.throwIfAborted();
  // ENOENT here is a bad working directory, not a missing harness.
  if (!(await stat(options.cwd)).isDirectory()) {
    throw new Error('Claude working directory is not a directory');
  }
  const env = claudeProviderEnvironment(options.provider, {
    ...process.env,
    ...options.env,
  });
  const backends = loadCatalog().providers.claude;
  const enabledFlags = backends.backendFlags.filter(flag =>
    /^(1|true|yes|on)$/i.test(env[flag] ?? ''),
  );
  const configuredProviders = Object.entries(backends.providers).filter(
    ([, configuration]) =>
      enabledFlags.some(flag => configuration.env[flag] === '1'),
  );
  if (
    enabledFlags.length > 1 ||
    (enabledFlags.length > 0 && configuredProviders.length !== 1)
  ) {
    throw new Error(
      'Unsupported or conflicting Claude API backend configuration',
    );
  }
  const configuredProvider = options.provider ?? configuredProviders[0]?.[0];
  const run = dependencies.run ?? runCommand;
  const settings = {
    cwd: options.cwd,
    env,
    signal,
    timeout: 10_000,
    maxBuffer: 16_384,
    windowsHide: true,
    encoding: 'utf8' as const,
  };
  let executable: string;
  try {
    executable =
      options.pathToClaudeCodeExecutable ??
      (dependencies.executable ?? claudeExecutable)();
    await run(executable, ['--version'], settings);
  } catch (error) {
    signal?.throwIfAborted();
    if (isMissingExecutable(error)) {
      return {available: false, reason: 'harness-missing', error};
    }
    throw error;
  }
  signal?.throwIfAborted();
  let stdout: string;
  let statusError: Error | undefined;
  try {
    // Match the adapter's settingSources: []; managed policy remains enabled.
    ({stdout} = await run(
      executable,
      ['--setting-sources', '', 'auth', 'status'],
      settings,
    ));
  } catch (error) {
    signal?.throwIfAborted();
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 1 ||
      !('stdout' in error) ||
      typeof error.stdout !== 'string' ||
      !error.stdout
    ) {
      throw error;
    }
    stdout = error.stdout;
    statusError = error;
  }
  signal?.throwIfAborted();
  const status: unknown = JSON.parse(stdout);
  if (
    !status ||
    typeof status !== 'object' ||
    !('loggedIn' in status) ||
    typeof status.loggedIn !== 'boolean'
  ) {
    throw new Error('Invalid Claude authentication status', {
      cause: statusError,
    });
  }
  const nativeProvider =
    'apiProvider' in status ? status.apiProvider : undefined;
  if (
    nativeProvider !== undefined &&
    (typeof nativeProvider !== 'string' ||
      !Object.hasOwn(nativeProviders, nativeProvider))
  ) {
    throw new Error(
      'Claude authentication status reports an unsupported API backend',
    );
  }
  const provider =
    typeof nativeProvider === 'string'
      ? nativeProviders[nativeProvider]!
      : (configuredProvider ?? 'anthropic');
  if (configuredProvider !== undefined && provider !== configuredProvider) {
    throw new Error(
      `Claude authentication status does not match configured provider ${configuredProvider}`,
    );
  }
  if (
    provider !== 'anthropic' &&
    (nativeProvider === undefined || !status.loggedIn)
  ) {
    throw new Error(
      `Claude auth status cannot establish authentication for external provider ${provider}`,
      {cause: statusError},
    );
  }
  if (!status.loggedIn) {
    return {
      available: false,
      reason: 'authentication-missing',
      error:
        statusError ??
        new Error('Claude reports no configured authentication source'),
    };
  }
  if (statusError) {
    throw statusError;
  }
  const mapping = (dependencies.catalog ?? loadCatalog)().models;
  const modelIds = Object.keys(mapping.models)
    .filter(canonical => canonical.split('/')[0] === 'anthropic')
    .flatMap(canonical => [...providerModelIds(mapping, canonical, provider)]);
  return {
    available: true,
    catalogs: Object.freeze([
      snapshotCatalog({
        provider,
        source: 'packaged-provider-mapping',
        modelIds,
        complete: false,
      }),
    ]),
  };
}
