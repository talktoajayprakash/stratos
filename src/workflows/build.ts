import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  access,
  readdir,
} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import ts from '@typescript/native';
import type {JSONSchema} from 'zod/v4/core';

import {
  readWorkflow,
  workflowHash,
  type WorkflowMetadata,
} from './discovery.js';
import {ensureEsmPackage} from './esm.js';
import {referencedImports} from './imports.js';
import {validateWorkflowOllama} from './ollama.js';
import type * as runtime from './runtime.js';
import {mcpConfiguration} from '../agents/mcp-config.js';
import {referencedMcps, generateMcpWrappers} from '../mcp/generate.js';
import {PACKAGE_ROOT} from '../paths.js';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(
  await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
) as {version: string};
const flags = [
  '--target',
  'ES2022',
  '--module',
  'NodeNext',
  '--moduleResolution',
  'NodeNext',
  '--strict',
  '--noEmitOnError',
  '--types',
  'node',
];
const signature = JSON.stringify([manifest.version, ts.version, flags]);
interface BuildRecord {
  id: string;
  hash: string;
  signature: string;
  children: Record<string, string>;
  files: string[];
  mcpWrappers?: string[];
  mcpHash: string;
}

export interface BuildResult {
  status: 'built' | 'prepared';
  wrappers: string[];
}

async function wrapperHash(workflow: WorkflowMetadata, names: string[]) {
  const hash = createHash('sha256');
  for (const name of [...names].sort()) {
    hash.update(
      JSON.stringify([
        name,
        await readFile(
          join(workflow.path, 'generated/mcp', `${name}.ts`),
          'utf8',
        ),
      ]),
    );
  }
  return hash.digest('hex');
}

const recordPath = (workflow: WorkflowMetadata) =>
  join(workflow.path, 'dist/.stratos-build.json');

async function buildHash(workflow: WorkflowMetadata) {
  return createHash('sha256')
    .update(await readFile(recordPath(workflow)))
    .digest('hex');
}

async function command(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', code =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${command} failed (${code}):\n${stdout}${stderr}`)),
    );
  });
}
const npm = (args: string[], cwd: string) => command('npm', args, cwd);

export const compiledEntry = (workflow: WorkflowMetadata) =>
  join(
    workflow.path,
    'dist',
    relative(workflow.root, resolve(workflow.path, workflow.entrypoint)),
  ).replace(/\.[cm]?tsx?$/, '.js');

export async function loadDefinition(workflow: WorkflowMetadata) {
  return (
    await import(
      pathToFileURL(compiledEntry(workflow)).href +
        '?v=' +
        (await workflowHash(workflow.path))
    )
  ).default;
}

export async function isBuilt(
  workflow: WorkflowMetadata,
  ancestors = new Set<string>(),
): Promise<boolean> {
  if (ancestors.has(workflow.path)) {
    return false;
  }
  try {
    const record: BuildRecord = JSON.parse(
      await readFile(recordPath(workflow), 'utf8'),
    );
    if (
      !record.id ||
      record.signature !== signature ||
      record.hash !== (await workflowHash(workflow.path)) ||
      record.mcpHash !== (await wrapperHash(workflow, record.mcpWrappers ?? []))
    ) {
      return false;
    }
    for (const file of record.files) {
      await access(join(workflow.path, 'dist', file));
    }
    await access(join(workflow.root, '.generated', `${workflow.name}.ts`));
    for (const name of record.mcpWrappers ?? []) {
      await access(join(workflow.path, 'generated/mcp', name + '.ts'));
    }
    const installed = JSON.parse(
      await readFile(
        join(workflow.root, 'node_modules/@stratoscli/stratos/package.json'),
        'utf8',
      ),
    );
    if (installed.version !== manifest.version) {
      return false;
    }
    for (const directory of [workflow.root, workflow.path]) {
      if (
        JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
          .type !== 'module'
      ) {
        return false;
      }
    }
    for (const [child, hash] of Object.entries(record.children)) {
      const metadata = await readWorkflow(join(workflow.root, child));
      if (
        (await buildHash(metadata)) !== hash ||
        !(await isBuilt(metadata, new Set([...ancestors, workflow.path])))
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function ignore(directory: string, lines: string[]): Promise<void> {
  const file = join(directory, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const missing = lines.filter(line => !existing.split(/\r?\n/).includes(line));
  if (missing.length) {
    await writeFile(
      file,
      existing +
        (existing && !existing.endsWith('\n') ? '\n' : '') +
        missing.join('\n') +
        '\n',
    );
  }
}

async function setupSdk(root: string): Promise<void> {
  await mkdir(root, {recursive: true});
  await ensureEsmPackage(root);
  await ignore(root, ['/.generated/', '/node_modules/']);
  let installed;
  try {
    installed = JSON.parse(
      await readFile(
        join(root, 'node_modules/@stratoscli/stratos/package.json'),
        'utf8',
      ),
    ).version;
  } catch {
    /* install missing SDK */
  }
  if (installed !== manifest.version) {
    // Install the running distribution through npm to preserve CLI/SDK identity.
    const temporary = await mkdtemp(join(tmpdir(), 'stratos-sdk-'));
    try {
      const [packed] = JSON.parse(
        await npm(
          [
            'pack',
            '--ignore-scripts',
            '--json',
            '--pack-destination',
            temporary,
          ],
          PACKAGE_ROOT,
        ),
      );
      await npm(
        [
          'install',
          '--prefix',
          root,
          '--no-save',
          '--package-lock=false',
          '--no-audit',
          '--no-fund',
          join(temporary, packed.filename),
        ],
        root,
      );
    } finally {
      await rm(temporary, {recursive: true, force: true});
    }
  }
  await mkdir(join(root, '.generated'), {recursive: true});
  await writeFile(
    join(root, '.generated/execution-sdk.mjs'),
    'export * from "@stratoscli/stratos/internal/runtime";\n',
  );
}

export async function executionSdk(root: string): Promise<typeof runtime> {
  return import(pathToFileURL(join(root, '.generated/execution-sdk.mjs')).href);
}

/** Resolve only explicit imports of generated wrappers, including imports through helpers. */
async function childrenOf(
  workflow: WorkflowMetadata,
): Promise<WorkflowMetadata[]> {
  const generated = join(workflow.root, '.generated');
  const paths = await referencedImports(workflow, generated, true);
  const names = new Set(
    paths.map(path =>
      path.slice(generated.length + 1).replace(/\.[cm]?[jt]s$/, ''),
    ),
  );
  if (!names.size) {
    return [];
  }
  // Resolve names within this exact root, including explicit roots outside the standard locations.
  const available: WorkflowMetadata[] = [];
  for (const entry of await readdir(workflow.root, {withFileTypes: true})) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith('.') ||
      entry.name === 'node_modules'
    ) {
      continue;
    }
    try {
      available.push(await readWorkflow(join(workflow.root, entry.name)));
    } catch {
      /* only required children fail preparation */
    }
  }
  return [...names].map(name => {
    const matches = available.filter(w => w.name === name);
    if (matches.length !== 1) {
      throw new Error(
        `Required child ${name} is missing, invalid, or duplicated in ${workflow.root}`,
      );
    }
    return matches[0]!;
  });
}

function schemaType(
  schema: JSONSchema._JSONSchema | JSONSchema._JSONSchema[],
): string {
  if (typeof schema === 'boolean' || Array.isArray(schema)) {
    return 'unknown';
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  if (schema.enum) {
    return schema.enum
      .map((value: unknown) => JSON.stringify(value))
      .join(' | ');
  }
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    return variants.map(schemaType).join(' | ');
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map(type => schemaType({...schema, type})).join(' | ');
  }
  if (schema.type === 'object') {
    return (
      '{ ' +
      Object.entries(schema.properties ?? {})
        .map(
          ([key, value]) =>
            `${JSON.stringify(key)}${schema.required?.includes(key) ? '' : '?'}: ${schemaType(value)};`,
        )
        .join(' ') +
      ' }'
    );
  }
  if (schema.type === 'array') {
    return `Array<${schemaType(schema.items ?? {})}>`;
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    return 'number';
  }
  if (
    schema.type === 'string' ||
    schema.type === 'boolean' ||
    schema.type === 'null'
  ) {
    return schema.type;
  }
  return 'unknown';
}

export async function buildWorkflow(
  workflow: WorkflowMetadata,
  options: {explicit?: boolean} = {},
  ancestors: string[] = [],
): Promise<BuildResult> {
  if (ancestors.includes(workflow.path)) {
    throw new Error(
      `Workflow cycle: ${[...ancestors, workflow.path].join(' -> ')}`,
    );
  }
  try {
    return await prepareWorkflow(workflow, options, ancestors);
  } catch (error) {
    // A failed refresh must not leave a previous successful build reusable.
    await rm(recordPath(workflow), {force: true});
    throw error;
  }
}

async function prepareWorkflow(
  workflow: WorkflowMetadata,
  options: {explicit?: boolean},
  ancestors: string[],
): Promise<BuildResult> {
  if (options.explicit) {
    await validateWorkflowOllama(workflow);
  }
  if (!options.explicit && (await isBuilt(workflow))) {
    return {status: 'built', wrappers: []};
  }
  let hasEntrypoint = true;
  try {
    await access(resolve(workflow.path, workflow.entrypoint));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    hasEntrypoint = false;
  }
  if (!hasEntrypoint && (!options.explicit || ancestors.length)) {
    throw new Error(
      `Workflow entrypoint is missing: ${workflow.entrypoint} (${workflow.name})`,
    );
  }
  const mcpWrappers = options.explicit
    ? Object.keys(mcpConfiguration.parse(workflow.mcp ?? {servers: {}}).servers)
    : await referencedMcps(workflow);
  const pkg = await ensureEsmPackage(workflow.path);
  await setupSdk(workflow.root);
  await ignore(workflow.path, ['/dist/', '/generated/', '/node_modules/']);
  if (pkg) {
    if (
      ['dependencies', 'devDependencies', 'optionalDependencies'].some(key => {
        const dependencies = pkg[key];
        return (
          dependencies &&
          typeof dependencies === 'object' &&
          '@stratoscli/stratos' in dependencies &&
          dependencies['@stratoscli/stratos']
        );
      })
    ) {
      throw new Error(
        'Workflow must use the shared Stratos SDK; remove its local @stratoscli/stratos dependency',
      );
    }
    await npm(['install', '--no-audit', '--no-fund'], workflow.path);
  }
  try {
    await access(join(workflow.path, 'node_modules/@stratoscli/stratos'));
    throw new Error('Workflow has a shadow Stratos SDK in its node_modules');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await generateMcpWrappers(workflow, mcpWrappers, 300_000);
  const wrappers = mcpWrappers.map(name =>
    join(workflow.path, 'generated/mcp', `${name}.ts`),
  );
  if (!hasEntrypoint) {
    await rm(recordPath(workflow), {force: true});
    return {status: 'prepared', wrappers};
  }
  const children = await childrenOf(workflow);
  for (const child of children) {
    await buildWorkflow(child, options, [...ancestors, workflow.path]);
  }
  if (await isBuilt(workflow)) {
    return {status: 'built', wrappers};
  }
  await rm(join(workflow.path, 'dist'), {recursive: true, force: true});
  // NodeNext determines authored .ts module kind from package.json. The emitted tree is always ESM.
  const compilerFlags = [...flags, '--moduleDetection', 'force'];
  const result = await command(
    process.execPath,
    [
      join(
        dirname(require.resolve('@typescript/native/package.json')),
        'bin/tsc',
      ),
      resolve(workflow.path, workflow.entrypoint),
      ...compilerFlags,
      '--rootDir',
      workflow.root,
      '--outDir',
      join(workflow.path, 'dist'),
      '--listEmittedFiles',
    ],
    workflow.path,
  );
  const files = result
    .split(/\r?\n/)
    .filter(line => line.startsWith('TSFILE: '))
    .map(line => relative(join(workflow.path, 'dist'), line.slice(8).trim()));
  const sdk = await executionSdk(workflow.root);
  const definition = await loadDefinition(workflow);
  const schemas = sdk.inspectWorkflow(definition);
  if (
    workflow.name.includes('/') ||
    workflow.name.includes('\\') ||
    workflow.name === '.' ||
    workflow.name === '..'
  ) {
    throw new Error('Workflow name cannot contain path separators');
  }
  const wrapper = `import { createChildWorkflow } from "@stratoscli/stratos/internal/runtime";\nimport type { WorkflowOverrides } from "@stratoscli/stratos/internal/runtime";\nexport default function createChild(options: { overrides?: WorkflowOverrides } = {}) {\n return createChildWorkflow<${schemaType(schemas.inputSchema)}, ${schemaType(schemas.outputSchema)}>(${JSON.stringify(relative(workflow.root, workflow.path))}, options);\n}\n`;
  await writeFile(
    join(workflow.root, '.generated', workflow.name + '.ts'),
    wrapper,
  );
  const record: BuildRecord = {
    id: randomUUID(),
    hash: await workflowHash(workflow.path),
    signature,
    files,
    mcpWrappers,
    mcpHash: await wrapperHash(workflow, mcpWrappers),
    children: Object.fromEntries(
      await Promise.all(
        children.map(async child => [
          relative(workflow.root, child.path),
          await buildHash(child),
        ]),
      ),
    ),
  };
  await writeFile(recordPath(workflow), JSON.stringify(record));
  return {status: 'built', wrappers};
}
