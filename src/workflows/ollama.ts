import {z} from 'zod';

import type {WorkflowMetadata} from './discovery.js';
import {agentSettings} from '../agents/config.js';
import {
  ollamaAgentModels,
  ollamaUrl,
  readOllamaInventory,
} from '../agents/ollama.js';
import {ollamaModelId} from '../models/ollama.js';

const configurations = z.record(z.string(), z.record(z.string(), z.unknown()));

/** Validate declared authoring defaults; never execute workflow code to discover settings. */
export async function validateWorkflowOllama(
  workflow: WorkflowMetadata,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const agents = configurations.parse(workflow.agents ?? {});
  const decisions = configurations.parse(workflow.decision ?? {});
  const requests: Array<{
    config: string;
    ids: string[];
    endpoint: string;
    agent: boolean;
  }> = [];
  for (const [name, value] of Object.entries(agents)) {
    if (value.provider !== 'ollama') {
      continue;
    }
    const settings = agentSettings.partial().parse(value);
    if (settings.effort !== undefined) {
      throw new Error(
        `agents.${name}: Ollama does not support effort overrides; leave effort unset.`,
      );
    }
    if (settings.harness && !['codex', 'opencode'].includes(settings.harness)) {
      throw new Error(`agents.${name}: Ollama requires codex or opencode.`);
    }
    requests.push({
      config: `agents.${name}`,
      ids: settings.model?.map(ollamaModelId) ?? [],
      endpoint: ollamaUrl(env),
      agent: true,
    });
  }
  for (const [name, value] of Object.entries(decisions)) {
    if (value.provider !== 'ollama') {
      continue;
    }
    const settings = z
      .object({
        model: z.string().min(1).optional(),
        baseUrl: z.string().optional(),
      })
      .parse(value);
    requests.push({
      config: `decision.${name}`,
      ids: settings.model === undefined ? [] : [ollamaModelId(settings.model)],
      endpoint: settings.baseUrl ?? ollamaUrl(env),
      agent: false,
    });
  }
  for (const endpoint of new Set(requests.map(request => request.endpoint))) {
    const relevant = requests.filter(request => request.endpoint === endpoint);
    const inventory = await readOllamaInventory(endpoint);
    const errors: string[] = [];
    for (const request of relevant) {
      for (const id of request.ids) {
        const model = inventory.find(model => model.id === id);
        const prefix = `${workflow.name}: ${request.config} model ${JSON.stringify(id)}`;
        if (!model) {
          // JSON is API data, not a generated shell command containing untrusted model text.
          errors.push(
            `${prefix} is not installed on ${endpoint}. Run stratos provider status ollama --json; after user approval, pull this exact ID with Ollama's POST /api/pull body ${JSON.stringify({model: id})}, then rebuild.`,
          );
        } else if (model.remote_host || model.remote_model) {
          errors.push(
            `${prefix} is cloud-backed, not an installed local model.`,
          );
        } else if (
          request.agent
            ? !model.capabilities.includes('completion') ||
              !model.capabilities.includes('tools')
            : !model.capabilities.includes('decision')
        ) {
          errors.push(
            `${prefix} lacks required ${request.agent ? 'completion and tools' : 'decision'} capabilities.`,
          );
        }
      }
    }
    if (errors.length) {
      throw new Error(errors.join('\n'));
    }
    if (relevant.some(request => request.agent)) {
      // Validate the same context/output metadata consumed by native harnesses.
      ollamaAgentModels(inventory);
    }
  }
}
