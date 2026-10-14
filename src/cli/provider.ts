import {constants} from 'node:fs';
import {access, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {delimiter, join} from 'node:path';

import {z} from 'zod';

import type {CommandResult} from './result.js';
import {
  OllamaConnectionError,
  ollamaUrl,
  readOllamaInventory,
  requestOllama,
} from '../agents/ollama.js';

export function ollamaInstallGuidance(platform: NodeJS.Platform) {
  switch (platform) {
    case 'darwin':
      return {
        installCommand: 'open https://ollama.com/download/mac',
        instructions:
          'Download the official macOS installer, mount it and drag Ollama to Applications. Open the app and allow its CLI link when prompted.',
        startCommand: 'open -a Ollama',
        documentation: 'https://docs.ollama.com/macos',
      };
    case 'linux':
      return {
        installCommand: 'curl -fsSL https://ollama.com/install.sh | sh',
        instructions:
          'Review and approve the official installer before running it; it can request elevated privileges. Check GPU/driver requirements in the documentation.',
        startCommand: 'ollama serve',
        documentation: 'https://docs.ollama.com/linux',
      };
    case 'win32':
      return {
        installCommand: 'Start-Process https://ollama.com/download/windows',
        instructions:
          'In PowerShell, open the official download and run OllamaSetup.exe. Reopen the terminal after installation to pick up PATH changes.',
        startCommand: 'ollama serve',
        documentation: 'https://docs.ollama.com/windows',
      };
    default:
      return {
        instructions:
          'No installation recipe is provided for this platform. Check official platform support or configure OLLAMA_HOST for a reachable server.',
        documentation: 'https://ollama.com/download',
      };
  }
}

export async function findOllamaInstallation(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  home = homedir(),
): Promise<string | undefined> {
  const binary = platform === 'win32' ? 'ollama.exe' : 'ollama';
  const directories = (env.PATH ?? '')
    .split(platform === 'win32' ? ';' : delimiter)
    .filter(Boolean);
  const candidates = directories.map(directory => join(directory, binary));
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Ollama.app/Contents/Resources/ollama',
      join(home, 'Applications/Ollama.app/Contents/Resources/ollama'),
    );
  } else if (platform === 'linux') {
    candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama');
  } else if (platform === 'win32' && env.LOCALAPPDATA) {
    candidates.push(join(env.LOCALAPPDATA, 'Programs/Ollama/ollama.exe'));
  }
  for (const candidate of new Set(candidates)) {
    try {
      if (!(await stat(candidate)).isFile()) {
        continue;
      }
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
    }
  }
  return undefined;
}

export async function ollamaStatus(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): Promise<CommandResult> {
  const endpoint = ollamaUrl(env);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(
    new URL(endpoint).hostname,
  );
  const guidance = ollamaInstallGuidance(platform);
  try {
    const signal = AbortSignal.timeout(15000);
    const {version} = z
      .object({version: z.string().min(1)})
      .parse(await requestOllama(endpoint, '/api/version', signal));
    const inventory = await readOllamaInventory(endpoint, signal);
    const models = inventory.map(model => ({
      id: model.id,
      capabilities: model.capabilities,
      local: !(model.remote_host || model.remote_model),
    }));
    return {
      success: true,
      message: `Ollama ${version} is reachable at ${endpoint}; ${models.length} installed model entries. No software or models were installed. Use the Ollama API to select a model, then run stratos build <workflow>. Check loaded context with ollama ps; agent harnesses need 64K or more for the tested configuration.`,
      data: {status: 'ready', endpoint, version, models},
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    if (!(error instanceof OllamaConnectionError) && !timedOut) {
      throw error;
    }
    const failure =
      error instanceof OllamaConnectionError ? error.cause : undefined;
    const reason = failure instanceof Error ? failure.cause : undefined;
    const unavailable =
      reason instanceof Error &&
      'code' in reason &&
      ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'].includes(
        String(reason.code),
      );
    // A timeout can also come from a live but slow/busy server; do not call it absent.
    const installation =
      local && unavailable
        ? await findOllamaInstallation(env, platform)
        : undefined;
    if (
      platform === 'darwin' &&
      installation &&
      !installation.includes('/Ollama.app/')
    ) {
      guidance.startCommand = 'ollama serve';
    }
    const status = timedOut
      ? 'timeout'
      : !unavailable
        ? 'connection-error'
        : !local
          ? 'remote-unreachable'
          : installation
            ? 'not-running'
            : 'not-found';
    const detail = timedOut
      ? 'Ollama did not complete its metadata checks within 15 seconds. Check the server and OLLAMA_HOST; a timeout does not prove Ollama is not installed.'
      : !unavailable
        ? 'Ollama metadata transport failed. Check OLLAMA_HOST, TLS certificates and proxy configuration; this does not prove Ollama is not installed.'
        : !local
          ? 'The selected remote Ollama server is unreachable. Check OLLAMA_HOST and network access; a local installation is not required for a remote server.'
          : installation
            ? `Ollama was found at ${installation}, but the selected server is unreachable. Check OLLAMA_HOST and start Ollama: ${guidance.startCommand ?? 'use the installation documentation'}.`
            : `Ollama is not reachable and no executable was found in PATH or standard installation locations. If installed elsewhere, fix PATH/OLLAMA_HOST. Otherwise ask the user to approve installation. ${guidance.installCommand ? `Install/setup command: ${guidance.installCommand}. ` : ''}${guidance.instructions}`;
    return {
      success: false,
      message: 'Ollama setup needs attention. No changes were made.',
      data: {
        status,
        endpoint,
        ...(installation ? {installation} : {}),
        ...(local && unavailable ? guidance : {}),
        retryCommand: 'stratos provider status ollama --json',
      },
      errors: [
        {
          code: 'OLLAMA_SETUP_REQUIRED',
          message: `${detail} After correcting it, rerun stratos provider status ollama --json.`,
        },
      ],
    };
  }
}
