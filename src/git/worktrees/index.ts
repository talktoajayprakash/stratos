import {execFile} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  lstat,
  realpath,
  readdir,
} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {promisify} from 'node:util';

import {z} from 'zod';

import {randomName} from './names.js';
import {withFileLock as withWorktreeLock} from '../../file-lock.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec('git', ['-C', cwd, ...args], {maxBuffer: 4 * 1024 * 1024})
  ).stdout.trim();
const exists = async (path: string) => {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw e;
  }
};
const registrySchema = z.strictObject({
  path: z.string(),
  identity: z.string(),
  preserve: z.boolean(),
  uncertain: z.boolean(),
  users: z.array(
    z.strictObject({id: z.string(), pid: z.number().int().positive()}),
  ),
});
type Registry = z.infer<typeof registrySchema>;
export interface WorktreeOptions {
  enabled: boolean;
  name?: string;
  cleanup?: boolean;
}

export {withWorktreeLock};

export async function acquireWorktree(
  directory: string,
  options: WorktreeOptions,
  warn: (message: string) => void,
  signal?: AbortSignal,
) {
  const repository = await realpath(
    await git(directory, 'rev-parse', '--show-toplevel'),
  );
  const common = await realpath(
    await git(
      repository,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ),
  );
  const managed = join(repository, '.stratos/worktrees');
  await mkdir(managed, {recursive: true});
  if ((await realpath(managed)) !== managed) {
    throw new Error('Managed worktree directory must not be a symlink');
  }
  const bookkeeping = join(common, 'stratos-worktrees');
  await mkdir(bookkeeping, {recursive: true});
  await reconcileWorktrees(repository, warn);
  const user = {id: randomUUID(), pid: process.pid};
  for (let attempt = 0; attempt < 65536; attempt++) {
    signal?.throwIfAborted();
    const name = options.name ?? randomName();
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      // eslint-disable-next-line no-control-regex -- Deliberately reject control characters in filesystem names.
      /[\\/\x00-\x20\x7f]/.test(name)
    ) {
      throw new Error('Invalid worktree name');
    }
    await git(repository, 'check-ref-format', `refs/heads/stratos/${name}`);
    const path = join(managed, name);
    const branch = `stratos/${name}`;
    const key = createHash('sha256').update(path).digest('hex');
    const stateFile = join(bookkeeping, `${key}.json`);
    const lock = join(bookkeeping, `${key}.lock`);
    const save = async (state: Registry) => {
      const temp = stateFile + '.' + randomUUID();
      await writeFile(temp, JSON.stringify(state), {mode: 0o600, flag: 'wx'});
      await rename(temp, stateFile);
    };
    const identity = async () => {
      if (
        (await realpath(path)) !== path ||
        (await realpath(await git(path, 'rev-parse', '--show-toplevel'))) !==
          path ||
        (await realpath(
          await git(
            path,
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
          ),
        )) !== common
      ) {
        throw new Error(
          'Existing path is not a worktree of the selected repository',
        );
      }
      const registration = await realpath(
        await git(path, 'rev-parse', '--absolute-git-dir'),
      );
      if (
        registration === common ||
        resolve(
          (await readFile(join(registration, 'gitdir'), 'utf8')).trim(),
        ) !== join(path, '.git')
      ) {
        throw new Error('Expected a registered linked Git worktree');
      }
      const info = await lstat(registration);
      return `${registration}:${info.dev}:${info.ino}:${info.birthtimeMs}`;
    };
    const load = async (id: string): Promise<Registry> => {
      let state: Registry;
      try {
        state = registrySchema.parse(
          JSON.parse(await readFile(stateFile, 'utf8')),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error('Invalid worktree bookkeeping; preserving checkout');
        }
        return {
          path,
          identity: id,
          preserve: false,
          uncertain: false,
          users: [],
        };
      }
      return state.identity === id
        ? state
        : {path, identity: id, preserve: false, uncertain: false, users: []};
    };
    const reconcile = (state: Registry) => {
      state.users = state.users.filter(entry => {
        try {
          process.kill(entry.pid, 0);
          return true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
            return true;
          }
          // A dead parent may have orphaned harness work. Retain uncertainty rather than deleting.
          state.uncertain = true;
          warn(
            'Stale worktree owner found; checkout preserved because orphaned agent activity is uncertain',
          );
          return false;
        }
      });
    };
    const result = await withWorktreeLock(
      lock,
      async () => {
        const present = await exists(path);
        const retained = await git(
          repository,
          'show-ref',
          '--verify',
          '--quiet',
          `refs/heads/${branch}`,
        ).then(
          () => true,
          () => false,
        );
        if (!options.name && (present || retained)) {
          return undefined;
        }
        if (present) {
          await identity();
        } else {
          if (retained) {
            await git(repository, 'worktree', 'add', '--', path, branch);
          } else {
            let base = 'HEAD';
            try {
              const ref = await git(
                repository,
                'symbolic-ref',
                'refs/remotes/origin/HEAD',
              );
              if (!ref.startsWith('refs/remotes/origin/')) {
                throw new Error();
              }
              await git(repository, 'rev-parse', '--verify', `${ref}^{commit}`);
              base = ref;
            } catch {
              warn(
                'Cached origin default-branch ref unavailable; creating worktree from local HEAD',
              );
            }
            await git(
              repository,
              'worktree',
              'add',
              '-b',
              branch,
              '--',
              path,
              base,
            );
          }
        }
        const id = await identity();
        const state = await load(id);
        reconcile(state);
        state.preserve ||= options.cleanup === false;
        state.users.push(user);
        await save(state);
        const currentBranch = await git(
          path,
          'symbolic-ref',
          '--short',
          '-q',
          'HEAD',
        ).catch(() => 'detached HEAD');
        return {id, currentBranch};
      },
      signal,
    );
    if (!result) {
      continue;
    }
    let released = false;
    return {
      path,
      name,
      repository,
      branch: result.currentBranch,
      async release(safe = true) {
        if (released) {
          return;
        }
        released = true;
        try {
          await withWorktreeLock(lock, async () => {
            if (!(await exists(path))) {
              return;
            }
            if ((await identity()) !== result.id) {
              warn('Worktree was replaced; cleanup skipped');
              return;
            }
            const state = await load(result.id);
            reconcile(state);
            state.users = state.users.filter(entry => entry.id !== user.id);
            state.uncertain ||= !safe;
            await save(state);
            if (state.preserve) {
              return;
            }
            if (state.users.length || state.uncertain) {
              warn(
                'Worktree cleanup skipped: active or uncertain agent ownership',
              );
              return;
            }
            if (
              await git(path, 'status', '--porcelain', '--untracked-files=all')
            ) {
              warn('Worktree cleanup skipped: uncommitted changes');
              return;
            }
            await git(repository, 'worktree', 'remove', '--', path);
          });
        } catch (e) {
          warn(
            `Worktree cleanup skipped: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      },
    };
  }
  throw new Error('Unable to find an unused worktree name');
}

/** Best-effort recovery at workflow startup; uncertain orphan ownership never authorizes deletion. */
export async function reconcileWorktrees(
  directory: string,
  warn: (message: string) => void,
): Promise<void> {
  let repository: string;
  let common: string;
  try {
    repository = await realpath(
      await git(directory, 'rev-parse', '--show-toplevel'),
    );
    common = await realpath(
      await git(
        repository,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ),
    );
  } catch {
    return;
  } // Non-Git workflows have nothing to reconcile.
  const bookkeeping = join(common, 'stratos-worktrees');
  let files: string[];
  try {
    files = await readdir(bookkeeping);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn('Unable to read worktree bookkeeping');
    }
    return;
  }
  for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
    try {
      await withWorktreeLock(
        join(bookkeeping, file.replace(/\.json$/, '.lock')),
        async () => {
          const stateFile = join(bookkeeping, file);
          const state = registrySchema.parse(
            JSON.parse(await readFile(stateFile, 'utf8')),
          );
          if (dirname(state.path) !== join(repository, '.stratos/worktrees')) {
            return;
          }
          let changed = false;
          state.users = state.users.filter(user => {
            try {
              process.kill(user.pid, 0);
              return true;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
                return true;
              }
              state.uncertain = true;
              changed = true;
              return false;
            }
          });
          if (changed) {
            const temp = stateFile + '.' + randomUUID();
            await writeFile(temp, JSON.stringify(state), {
              flag: 'wx',
              mode: 0o600,
            });
            await rename(temp, stateFile);
            warn(
              'Stale worktree owner found; checkout preserved because orphaned agent activity is uncertain',
            );
          }
          if (
            state.users.length ||
            state.preserve ||
            state.uncertain ||
            !(await exists(state.path))
          ) {
            return;
          }
          if (
            (await realpath(state.path)) !== state.path ||
            (await realpath(
              await git(state.path, 'rev-parse', '--show-toplevel'),
            )) !== state.path ||
            (await realpath(
              await git(
                state.path,
                'rev-parse',
                '--path-format=absolute',
                '--git-common-dir',
              ),
            )) !== common
          ) {
            return;
          }
          const registration = await realpath(
            await git(state.path, 'rev-parse', '--absolute-git-dir'),
          );
          const info = await lstat(registration);
          if (
            `${registration}:${info.dev}:${info.ino}:${info.birthtimeMs}` !==
              state.identity ||
            resolve(
              (await readFile(join(registration, 'gitdir'), 'utf8')).trim(),
            ) !== join(state.path, '.git')
          ) {
            return;
          }
          if (
            await git(
              state.path,
              'status',
              '--porcelain',
              '--untracked-files=all',
            )
          ) {
            warn('Worktree recovery cleanup skipped: uncommitted changes');
            return;
          }
          await git(repository, 'worktree', 'remove', '--', state.path);
        },
      );
    } catch {
      warn(
        'Worktree recovery skipped: bookkeeping or checkout could not be verified',
      );
    }
  }
}
