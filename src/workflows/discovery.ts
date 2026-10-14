import {createHash} from 'node:crypto';
import {readFile, readdir, realpath, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve, dirname, relative, isAbsolute} from 'node:path';

import {parse} from 'yaml';
import {z} from 'zod';

const description = (maximum: number) =>
  z.string().superRefine((value, ctx) => {
    if (!value.trim()) {
      ctx.addIssue({code: 'custom', message: 'Must not be blank'});
    }
    const length = [...value].length;
    if (length > maximum) {
      ctx.addIssue({
        code: 'custom',
        message: `Contains ${length} characters; maximum is ${maximum} Unicode code points`,
      });
    }
  });

const metadata = z
  .object({
    name: z.string().min(1),
    shortDescription: description(400).refine(
      value => !/[\r\n\u0085\u2028\u2029]/u.test(value.trim()),
      'Must be a single paragraph without internal line breaks; use a YAML folded string',
    ),
    longDescription: description(12_000),
    description: z
      .never({
        error:
          'description was removed; replace it with shortDescription and an author-written longDescription',
      })
      .optional(),
    version: z.string(),
    entrypoint: z.string().default('workflow.ts'),
  })
  .passthrough();
export type WorkflowMetadata = z.infer<typeof metadata> & {
  path: string;
  root: string;
};
export interface Discovery {
  workflows: WorkflowMetadata[];
  errors: Array<{code: string; message: string; file: string}>;
}

export const roots = (cwd: string) => [
  ...new Set([
    resolve(cwd, '.stratos/workflows'),
    join(homedir(), '.stratos/workflows'),
  ]),
];

export async function readWorkflow(path: string): Promise<WorkflowMetadata> {
  path = await realpath(path);
  const file = join(path, 'workflow.yaml');
  const result = metadata.safeParse(parse(await readFile(file, 'utf8')));
  if (!result.success) {
    throw new Error(
      `${file}: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }
  const config = result.data;
  const entry = relative(path, resolve(path, config.entrypoint));
  if (entry.startsWith('..') || isAbsolute(entry)) {
    throw new Error('Entrypoint must be inside the workflow directory');
  }
  return {...config, path, root: dirname(path)};
}

export async function discover(
  cwd: string,
  projectOnly = false,
): Promise<Discovery> {
  const result: Discovery = {workflows: [], errors: []};
  for (const root of projectOnly ? roots(cwd).slice(0, 1) : roots(cwd)) {
    let entries;
    try {
      entries = await readdir(root, {withFileTypes: true});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    const names = new Map<string, string>();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        entry.name === 'node_modules'
      ) {
        continue;
      }
      const path = join(root, entry.name);
      try {
        await stat(join(path, 'workflow.yaml'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      try {
        const workflow = await readWorkflow(path);
        const previous = names.get(workflow.name);
        if (previous) {
          result.workflows = result.workflows.filter(
            w => w.root !== workflow.root || w.name !== workflow.name,
          );
          throw new Error(
            `Duplicate workflow name ${workflow.name}: ${previous} and ${path}`,
          );
        }
        names.set(workflow.name, path);
        result.workflows.push(workflow);
      } catch (error) {
        result.errors.push({
          code: 'WORKFLOW_CONFIG_ERROR',
          message: String(error),
          file: join(path, 'workflow.yaml'),
        });
      }
    }
  }
  return result;
}

export async function selectWorkflow(
  cwd: string,
  target: string,
): Promise<WorkflowMetadata> {
  if (target.includes('/') || isAbsolute(target) || target === '.') {
    return readWorkflow(resolve(cwd, target));
  }
  const found = await discover(cwd);
  const matches = found.workflows.filter(workflow => workflow.name === target);
  const duplicate = found.errors.find(error =>
    error.message.includes(`Duplicate workflow name ${target}:`),
  );
  if (duplicate) {
    throw new Error(duplicate.message);
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? `Ambiguous workflow ${target}. Specify a directory path:\n${matches.map(w => w.path).join('\n')}`
        : `Workflow ${target} not found${found.errors.length ? '\n' + found.errors.map(e => e.message).join('\n') : ''}`,
    );
  }
  return matches[0]!;
}

export async function workflowHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, {withFileTypes: true})).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (
        ['dist', 'generated', '.generated', 'node_modules', '.git'].includes(
          entry.name,
        )
      ) {
        continue;
      }
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
      } else if (entry.isFile()) {
        const bytes = await readFile(file);
        hash.update(JSON.stringify([relative(path, file), bytes.length]));
        hash.update(bytes);
      }
    }
  };
  await walk(path);
  return hash.digest('hex');
}
