import {spawn} from 'node:child_process';
import {readdir, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {withFileLock} from '../file-lock.js';
import {
  artifactWarning,
  directory,
  readJson,
  retentionSchema,
  runName,
  runSchema,
  workspaceName,
  workspaceSchema,
  type Retention,
  type RunMetadata,
} from './artifact-storage.js';

export async function cleanRuns(
  root: string,
  limits: Retention,
): Promise<void> {
  retentionSchema.parse(limits);
  await directory(root);
  await withFileLock(join(root, '.lock'), async () => {
    const runs: Array<{
      path: string;
      workspace: string;
      metadata: RunMetadata;
    }> = [];
    for (const entry of await readdir(root, {withFileTypes: true})) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      const workspace = join(root, entry.name);
      try {
        await directory(workspace);
        const {path} = workspaceSchema.parse(
          await readJson(join(workspace, 'workspace.json')),
        );
        if (
          ![workspaceName(path), workspaceName(path, true)].includes(entry.name)
        ) {
          throw new Error('Workspace identity mismatch');
        }
        for (const child of await readdir(workspace, {withFileTypes: true})) {
          if (!child.isDirectory() || child.isSymbolicLink()) {
            continue;
          }
          const target = join(workspace, child.name);
          try {
            const metadata = runSchema.parse(
              await readJson(join(target, 'run.json')),
            );
            if (runName(metadata) !== child.name) {
              throw new Error('Run identity mismatch');
            }
            runs.push({path: target, workspace, metadata});
          } catch {
            artifactWarning('retention metadata verification');
          }
        }
      } catch {
        artifactWarning('retention workspace verification');
      }
    }
    runs.sort(
      (a, b) =>
        a.metadata.startedAt.localeCompare(b.metadata.startedAt) ||
        a.metadata.executionId.localeCompare(b.metadata.executionId),
    );
    const counts = new Map<string, number>();
    for (const run of runs) {
      counts.set(run.workspace, (counts.get(run.workspace) ?? 0) + 1);
    }
    let total = runs.length;
    const remove = async (run: (typeof runs)[number]) => {
      try {
        await directory(run.workspace);
        await directory(run.path);
        const current = runSchema.parse(
          await readJson(join(run.path, 'run.json')),
        );
        if (
          current.status === 'running' ||
          JSON.stringify(current) !== JSON.stringify(run.metadata)
        ) {
          throw new Error('Run changed');
        }
        await rm(run.path, {recursive: true});
        counts.set(run.workspace, counts.get(run.workspace)! - 1);
        total--;
        return true;
      } catch {
        artifactWarning('retention deletion');
        return false;
      }
    };
    const removed = new Set<string>();
    for (const run of runs) {
      if (
        run.metadata.status !== 'running' &&
        counts.get(run.workspace)! > limits.maxRunsPerWorkspace &&
        (await remove(run))
      ) {
        removed.add(run.path);
      }
    }
    for (const run of runs) {
      if (total <= limits.maxRunsTotal) {
        break;
      }
      if (run.metadata.status !== 'running' && !removed.has(run.path)) {
        await remove(run);
      }
    }
  });
}

export function launchRetention(root: string, limits: Retention): void {
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), root, JSON.stringify(limits)],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    child.on('error', () => artifactWarning('retention launch'));
    child.unref();
  } catch {
    artifactWarning('retention launch');
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (!process.argv[2] || !process.argv[3]) {
      throw new Error('Missing retention arguments');
    }
    await cleanRuns(
      process.argv[2],
      retentionSchema.parse(JSON.parse(process.argv[3])),
    );
  } catch {
    artifactWarning('retention cleanup');
    process.exitCode = 1;
  }
}
