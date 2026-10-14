import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, rename, rm, writeFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';

import {z} from 'zod';

export const workspaceSchema = z.strictObject({
  path: z.string().refine(isAbsolute),
});
export const runSchema = z
  .strictObject({
    version: z.literal(1),
    executionId: z.uuid(),
    workflowName: z.string(),
    startedAt: z.iso.datetime(),
    status: z.enum(['running', 'success', 'error']),
    completedAt: z.iso.datetime().optional(),
  })
  .refine(run =>
    run.status === 'running'
      ? run.completedAt === undefined
      : run.completedAt !== undefined,
  );
export type RunMetadata = z.infer<typeof runSchema>;
export const retentionSchema = z.object({
  maxRunsPerWorkspace: z.number().int().nonnegative().safe().default(10),
  maxRunsTotal: z.number().int().nonnegative().safe().default(100),
});
export type Retention = z.infer<typeof retentionSchema>;

export function artifactWarning(operation: string): void {
  // Do not include paths, captured payloads, or native errors in soft diagnostics.
  try {
    process.stderr.write(
      `Stratos run artifacts: ${operation} failed; workflow execution continues\n`,
    );
  } catch {
    // An unavailable diagnostic stream must not fail the workflow.
  }
}

export async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Expected an artifact directory');
  }
}

export async function readJson(path: string): Promise<unknown> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile()) {
      throw new Error('Expected artifact metadata');
    }
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}

export async function saveJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, {force: true});
  }
}

function prefix(value: string, bytes: number): string {
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character) > bytes) {
      break;
    }
    result += character;
  }
  return result;
}

export function workspaceName(path: string, hashed = false): string {
  const readable = path.replaceAll('/', '-');
  if (!hashed && Buffer.byteLength(readable) <= 255) {
    return readable;
  }
  const suffix =
    '-' + createHash('sha256').update(path).digest('hex').slice(0, 12);
  return prefix(readable, 255 - suffix.length) + suffix;
}

export function runName(
  run: Pick<RunMetadata, 'startedAt' | 'workflowName' | 'executionId'>,
): string {
  const time = run.startedAt.replaceAll(':', '-');
  const name = run.workflowName.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `${time}-${name.slice(0, 255 - time.length - run.executionId.length - 2)}-${run.executionId}`;
}

/** Called under the run-root lock, including metadata creation and verification. */
export async function workspaceDirectory(
  root: string,
  path: string,
): Promise<string> {
  for (const name of new Set([
    workspaceName(path),
    workspaceName(path, true),
  ])) {
    const target = join(root, name);
    try {
      await mkdir(target, {mode: 0o700});
      await saveJson(join(target, 'workspace.json'), {path});
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    await directory(target);
    if (
      workspaceSchema.parse(await readJson(join(target, 'workspace.json')))
        .path === path
    ) {
      return target;
    }
  }
  throw new Error('Workspace identity collision');
}
