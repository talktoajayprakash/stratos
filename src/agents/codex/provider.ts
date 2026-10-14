import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

import type {CodexOptions} from '@openai/codex-sdk';
import {parse} from 'smol-toml';
import {z} from 'zod';

import {loadCatalog} from '../../models/catalog.js';
import {isMissingExecutable} from '../availability.js';
import {ollamaUrl} from '../ollama.js';

export type CodexEnvironmentOptions = {
  env?: Record<string, string>;
  apiKey?: string;
  provider?: string;
};

export function codexProviderId(provider = 'openai'): string {
  const {providers} = loadCatalog().providers.codex;
  if (!Object.hasOwn(providers, provider)) {
    throw new Error(`Unsupported Codex provider: ${provider}`);
  }
  return providers[provider]!;
}

export function codexEnvironment(
  options: CodexEnvironmentOptions,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (options.provider === 'azure' || options.provider === 'ollama') {
    // Explicit backends must never fall back to native OpenAI credentials.
    delete env.CODEX_API_KEY;
    delete env.OPENAI_API_KEY;
    return env;
  }
  const apiKey = options.apiKey ?? env.CODEX_API_KEY ?? env.OPENAI_API_KEY;
  if (apiKey !== undefined) {
    if (!apiKey.trim()) {
      throw new Error('Codex API key is empty');
    }
    env.CODEX_API_KEY = apiKey;
  }
  return env;
}

export function codexAuthPath(options: CodexEnvironmentOptions): string {
  return resolve(
    options.env?.CODEX_HOME ??
      process.env.CODEX_HOME ??
      join(homedir(), '.codex'),
    'auth.json',
  );
}

const azureSchema = z.strictObject({
  name: z.string().min(1).default('Azure Foundry'),
  base_url: z.url().refine(value => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }),
  env_key: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .refine(
      value =>
        ![
          'CODEX_API_KEY',
          'OPENAI_API_KEY',
          'STRATOS_HOOK_TOKEN',
          'CODEX_HOME',
          'HOME',
          'XDG_CONFIG_HOME',
          'XDG_DATA_HOME',
          'XDG_CACHE_HOME',
          'XDG_STATE_HOME',
        ].includes(value),
    ),
  env_key_instructions: z.string().optional(),
  wire_api: z.literal('responses').default('responses'),
  requires_openai_auth: z.literal(false).default(false),
  supports_websockets: z.literal(false).default(false),
  request_max_retries: z.number().int().nonnegative().optional(),
  stream_max_retries: z.number().int().nonnegative().optional(),
  stream_idle_timeout_ms: z.number().int().positive().optional(),
});

export type CodexProvider = {
  id: string;
  env: Record<string, string>;
  config: NonNullable<CodexOptions['config']>;
  hasApiKey: boolean;
};

/** Read only the selected native provider; never import ambient hooks, MCPs or project settings. */
export async function codexProvider(
  options: CodexEnvironmentOptions,
): Promise<CodexProvider> {
  const id = codexProviderId(options.provider);
  const env = codexEnvironment(options);
  if (options.provider === 'ollama') {
    return {
      id,
      env,
      hasApiKey: false,
      config: {
        model_provider: id,
        web_search: 'disabled',
        model_providers: {
          [id]: {
            name: 'Ollama',
            base_url: `${ollamaUrl(env)}/v1`,
            wire_api: 'responses',
            requires_openai_auth: false,
            supports_websockets: false,
          },
        },
      },
    };
  }
  if (id === 'openai') {
    return {
      id,
      env,
      config: {model_provider: id},
      hasApiKey: !!env.CODEX_API_KEY,
    };
  }
  let text: string;
  try {
    text = await readFile(
      join(dirname(codexAuthPath(options)), 'config.toml'),
      'utf8',
    );
  } catch (error) {
    if (isMissingExecutable(error)) {
      throw new Error(
        'Configure [model_providers.azure] in CODEX_HOME/config.toml before using Codex with Azure',
      );
    }
    throw error;
  }
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    // TOML diagnostics can include source lines containing credentials.
    throw new Error('Invalid Codex native configuration TOML');
  }
  const parsed = z
    .object({
      model_providers: z.object({[id]: azureSchema}),
    })
    .safeParse(value);
  if (!parsed.success) {
    throw new Error(
      'Invalid Codex Azure provider configuration: expected HTTPS base_url, env_key and Responses API settings',
    );
  }
  const provider = parsed.data.model_providers[id]!;
  const key = options.apiKey ?? env[provider.env_key];
  if (key !== undefined) {
    if (!key.trim()) {
      throw new Error('Codex Azure API key is empty');
    }
    env[provider.env_key] = key;
  }
  return {
    id,
    env,
    config: {
      model_provider: id,
      model_providers: {
        [id]: Object.fromEntries(
          Object.entries(provider).filter(([, value]) => value !== undefined),
        ),
      },
    },
    hasApiKey: key !== undefined,
  };
}
