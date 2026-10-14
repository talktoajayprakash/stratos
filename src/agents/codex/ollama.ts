import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {readOllamaModels} from '../ollama.js';

/** Native metadata prevents Codex's OpenAI fallback instructions for local models. */
export async function codexOllamaCatalog(
  home: string,
  id: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  const models = await readOllamaModels(env, signal);
  const model = models.find(model => model.id === id);
  if (!model) {
    throw new Error(`Ollama model is not installed or tool-capable: ${id}`);
  }
  const path = join(home, 'ollama-model.json');
  await writeFile(
    path,
    JSON.stringify({
      models: [
        {
          slug: id,
          display_name: id,
          context_window: model.context,
          shell_type: 'default',
          visibility: 'list',
          supported_in_api: true,
          priority: 0,
          base_instructions: '',
          input_modalities: model.capabilities.includes('vision')
            ? ['text', 'image']
            : ['text'],
          supported_reasoning_levels: [],
          default_reasoning_level: null,
          support_verbosity: false,
          supports_parallel_tool_calls: false,
          supports_reasoning_summaries: false,
          experimental_supported_tools: [],
          truncation_policy: {mode: 'bytes', limit: 10000},
        },
      ],
    }),
    {mode: 0o600},
  );
  return path;
}
