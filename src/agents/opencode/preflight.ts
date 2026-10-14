import {rm} from 'node:fs/promises';

import {z} from 'zod';

import {
  isMissingExecutable,
  snapshotCatalog,
  type HarnessReadiness,
  type ModelCatalog,
} from '../availability.js';
import {openCodeOllama} from './ollama.js';
import {
  openCodeConfiguration,
  openCodeDirectory,
  startOpenCodeServer,
  type OpenCodeServerOptions,
} from './process.js';

const nonempty = z
  .string()
  .min(1)
  .refine(
    value => value.trim() === value,
    'Native identifiers must not contain surrounding whitespace',
  );
const providerListSchema = z.object({
  all: z.array(
    z.looseObject({
      id: nonempty,
      source: z.enum(['env', 'config', 'custom', 'api']).optional(),
      models: z.record(
        nonempty,
        z.looseObject({id: nonempty, providerID: nonempty}),
      ),
    }),
  ),
  default: z.record(nonempty, nonempty),
  connected: z.array(nonempty),
});
const effectiveConfigSchema = z.looseObject({
  plugin: z.array(z.unknown()).optional(),
  plugin_origins: z.array(z.unknown()).optional(),
  mcp: z.record(z.string(), z.unknown()).optional(),
  enabled_providers: z.array(nonempty).optional(),
  disabled_providers: z.array(nonempty).optional(),
});

export function openCodeCatalogs(value: unknown): readonly ModelCatalog[] {
  const result = providerListSchema.safeParse(value);
  if (!result.success) {
    throw new Error('Invalid OpenCode provider catalog', {cause: result.error});
  }
  const data = result.data;
  const providers = new Map(data.all.map(provider => [provider.id, provider]));
  if (
    providers.size !== data.all.length ||
    new Set(data.connected).size !== data.connected.length
  ) {
    throw new Error('Duplicate OpenCode provider catalog entries');
  }
  return Object.freeze(
    data.connected.map(id => {
      const provider = providers.get(id);
      if (!provider?.source) {
        throw new Error(
          'Connected OpenCode provider is missing native catalog metadata',
        );
      }
      for (const [modelID, model] of Object.entries(provider.models)) {
        if (model.id !== modelID || model.providerID !== id) {
          throw new Error('Inconsistent OpenCode model catalog identity');
        }
      }
      return snapshotCatalog({
        provider: id,
        source: `opencode/provider.list:${provider.source}`,
        modelIds: Object.keys(provider.models),
        complete: true,
      });
    }),
  );
}

export async function preflightOpenCode(
  options: OpenCodeServerOptions & {provider?: string},
  signal?: AbortSignal,
): Promise<HarnessReadiness> {
  const nativeConfig = openCodeConfiguration(options);
  const combined = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(30000),
  ]);
  combined.throwIfAborted();
  const config =
    options.provider === 'ollama'
      ? await openCodeOllama(nativeConfig, options.env, combined)
      : nativeConfig;
  const directory = await openCodeDirectory(options);
  let server: Awaited<ReturnType<typeof startOpenCodeServer>> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    server = await startOpenCodeServer(
      options,
      directory,
      {
        ...config,
        plugin: [],
        mcp: {},
        permission: {'*': 'deny'},
        tools: {'*': false},
        instructions: [],
        lsp: false,
        formatter: false,
        snapshot: false,
        share: 'disabled',
      },
      combined,
      true,
    );
    const effective = effectiveConfigSchema.parse(
      (
        await server.client.config.get(
          {},
          {throwOnError: true, signal: combined},
        )
      ).data,
    );
    // Managed/remote settings retain native precedence. Pure mode prevents their
    // plugins executing; refuse configuration that cannot honor this isolation.
    if (
      effective.plugin?.length ||
      effective.plugin_origins?.length ||
      Object.keys(effective.mcp ?? {}).length
    ) {
      throw new Error(
        'OpenCode native configuration adds plugins or MCPs outside the isolated preflight',
      );
    }
    if (
      options.provider &&
      (effective.disabled_providers?.includes(options.provider) ||
        (effective.enabled_providers &&
          !effective.enabled_providers.includes(options.provider)))
    ) {
      throw new Error(
        `OpenCode provider "${options.provider}" is disabled by native configuration`,
      );
    }
    const response = await server.client.provider.list(
      {},
      {throwOnError: true, signal: combined},
    );
    const catalogs = openCodeCatalogs(response.data);
    if (
      options.provider &&
      !catalogs.some(catalog => catalog.provider === options.provider)
    ) {
      const known = providerListSchema
        .parse(response.data)
        .all.some(provider => provider.id === options.provider);
      if (!known) {
        throw new Error(
          `OpenCode provider "${options.provider}" is not configured or known to the native server`,
        );
      }
    }
    if (
      !catalogs.length ||
      (options.provider &&
        !catalogs.some(catalog => catalog.provider === options.provider))
    ) {
      return {
        available: false,
        reason: 'authentication-missing',
        error: new Error(
          'OpenCode has no connected authentication source for the configured provider',
        ),
      };
    }
    // Native "connected" means configured credentials, not remotely validated credentials or entitlement.
    return {available: true, catalogs};
  } catch (error) {
    if (!combined.aborted && isMissingExecutable(error)) {
      return {available: false, reason: 'harness-missing', error};
    }
    failed = true;
    failure =
      combined.aborted && !(error instanceof AggregateError)
        ? combined.reason
        : error;
    throw failure;
  } finally {
    const errors: unknown[] = [];
    try {
      await server?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await rm(directory, {recursive: true, force: true});
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      // eslint-disable-next-line no-unsafe-finally -- Preserve the probe failure and block fallback after incomplete cleanup.
      throw new AggregateError(
        failed ? [failure, ...errors] : errors,
        'OpenCode preflight cleanup failed',
      );
    }
    if (!failed) {
      combined.throwIfAborted();
    }
  }
}
