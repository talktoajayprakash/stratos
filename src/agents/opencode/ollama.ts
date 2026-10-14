import type {Config} from '@opencode-ai/sdk/v2';

import {ollamaUrl, readOllamaModels} from '../ollama.js';

export async function openCodeOllama(
  config: Config,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<Config> {
  if (
    config.disabled_providers?.includes('ollama') ||
    (config.enabled_providers && !config.enabled_providers.includes('ollama'))
  ) {
    throw new Error(
      'OpenCode provider "ollama" is disabled by native configuration',
    );
  }
  if (config.provider?.ollama) {
    throw new Error(
      'Stratos manages the Ollama provider; configure its origin with OLLAMA_HOST',
    );
  }
  const models = await readOllamaModels(env, signal);
  return {
    ...config,
    enabled_providers: ['ollama'],
    provider: {
      ollama: {
        name: 'Ollama',
        npm: '@ai-sdk/openai-compatible',
        // An explicit empty key prevents native saved credentials being inherited.
        options: {baseURL: `${ollamaUrl(env)}/v1`, apiKey: ''},
        models: Object.fromEntries(
          models.map(model => [
            model.id,
            {
              name: model.id,
              tool_call: true,
              reasoning: model.capabilities.includes('thinking'),
              limit: {context: model.context, output: model.output},
            },
          ]),
        ),
      },
    },
  };
}
