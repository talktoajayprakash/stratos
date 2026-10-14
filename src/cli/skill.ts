import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';

import {z} from 'zod';

import type {CommandResult, Diagnostic} from './result.js';
import {withFileLock} from '../file-lock.js';
import {PACKAGE_ROOT} from '../paths.js';

const SKILL = 'stratos-workflows';
const agents = ['claude', 'codex', 'gemini', 'cursor', 'copilot', 'opencode'];
const absolutePath = z.string().refine(isAbsolute);
const recordSchema = z
  .object({
    version: z.literal(1),
    // Two targets record an interrupted move from one package location to another.
    links: z.record(absolutePath, z.array(absolutePath).min(1).max(2)),
  })
  .strict();
type InstallRecord = z.infer<typeof recordSchema>;

interface Installation {
  agent: string;
  path: string;
  status:
    | 'not-installed'
    | 'installed'
    | 'outdated'
    | 'broken'
    | 'conflict'
    | 'unchanged'
    | 'updated'
    | 'removed'
    | 'error';
  managed: boolean;
  target?: string;
}

function configDirectory(
  name: string,
  fallback: string,
  env: NodeJS.ProcessEnv,
): string {
  const value = env[name];
  if (value === undefined) {
    return fallback;
  }
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute directory path.`);
  }
  return value;
}

export function skillDirectories(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Record<string, () => string> {
  return {
    claude: () =>
      join(
        configDirectory('CLAUDE_CONFIG_DIR', join(home, '.claude'), env),
        'skills',
      ),
    codex: () => join(home, '.agents/skills'),
    gemini: () =>
      join(configDirectory('GEMINI_CLI_HOME', home, env), '.gemini/skills'),
    cursor: () => join(home, '.cursor/skills'),
    copilot: () =>
      join(
        configDirectory('COPILOT_HOME', join(home, '.copilot'), env),
        'skills',
      ),
    opencode: () =>
      join(
        env.OPENCODE_CONFIG_DIR !== undefined
          ? configDirectory('OPENCODE_CONFIG_DIR', '', env)
          : join(
              configDirectory('XDG_CONFIG_HOME', join(home, '.config'), env),
              'opencode',
            ),
        'skills',
      ),
  };
}

async function statEntry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function loadRecord(path: string): Promise<InstallRecord> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {version: 1, links: {}};
    }
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`Installation record is not a regular file: ${path}`);
    }
    return recordSchema.parse(JSON.parse(await handle.readFile('utf8')));
  } finally {
    await handle.close();
  }
}

async function saveRecord(path: string, record: InstallRecord) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(record) + '\n');
    await handle.close();
    await rename(temporary, path);
  } finally {
    await handle.close();
    if (await statEntry(temporary)) {
      await unlink(temporary);
    }
  }
}

async function inspect(
  agent: string,
  path: string,
  source: string,
  record: InstallRecord,
): Promise<Installation> {
  const entry = await statEntry(path);
  if (!entry) {
    return {agent, path, status: 'not-installed', managed: false};
  }
  if (!entry.isSymbolicLink()) {
    return {agent, path, status: 'conflict', managed: false};
  }
  const target = resolve(dirname(path), await readlink(path));
  const managed = record.links[path]?.includes(target) ?? false;
  const exists = await statEntry(target);
  const status =
    target === source && exists
      ? 'installed'
      : !managed
        ? 'conflict'
        : exists
          ? 'outdated'
          : 'broken';
  return {agent, path, status, managed, target};
}

async function removeLink(installation: Installation) {
  const entry = await statEntry(installation.path);
  if (
    !entry?.isSymbolicLink() ||
    resolve(dirname(installation.path), await readlink(installation.path)) !==
      installation.target
  ) {
    throw new Error(`Skill link changed; left untouched: ${installation.path}`);
  }
  await unlink(installation.path);
}

export async function skillCommand(
  action: string | undefined,
  agentOption: string | undefined,
  all: boolean,
): Promise<CommandResult> {
  if (!action || !['install', 'status', 'uninstall'].includes(action)) {
    throw new Error('Use stratos skill install|status|uninstall.');
  }
  if (agentOption !== undefined && all) {
    throw new Error('Use either --agent or --all, not both.');
  }
  if (action !== 'status' && agentOption === undefined && !all) {
    throw new Error(
      'Select --agent <names> or --all. Skill installation is global.',
    );
  }
  const selected =
    agentOption === undefined
      ? agents
      : [
          ...new Set(
            agentOption.split(',').map(name => {
              const trimmed = name.trim();
              return trimmed === 'claude-code' ? 'claude' : trimmed;
            }),
          ),
        ];
  for (const agent of selected) {
    if (!agents.includes(agent)) {
      throw new Error(
        `Unknown skill target ${JSON.stringify(agent)}. Choose ${agents.join(', ')}.`,
      );
    }
  }
  const directories = skillDirectories();
  const targets = selected.map(agent => ({
    agent,
    path: join(directories[agent]!(), SKILL),
  }));
  let source = join(PACKAGE_ROOT, 'skills', SKILL);
  if (action === 'install') {
    source = await realpath(source);
    for (const file of [
      'SKILL.md',
      'references/mcp.md',
      'references/composition.md',
    ]) {
      await readFile(join(source, file), 'utf8');
    }
  }
  const recordFile = join(homedir(), '.stratos/skill-installations.json');
  const perform = async (): Promise<CommandResult> => {
    const record = await loadRecord(recordFile);
    const installations: Installation[] = [];
    const errors: Diagnostic[] = [];
    for (const target of targets) {
      let installation: Installation = {
        ...target,
        status: 'error',
        managed: false,
      };
      try {
        // Canonical parents keep ownership stable when a harness directory is a symlink.
        let parent = dirname(target.path);
        if (action === 'install') {
          await mkdir(parent, {recursive: true});
        }
        if (await statEntry(parent)) {
          parent = await realpath(parent);
        }
        installation = await inspect(
          target.agent,
          join(parent, SKILL),
          source,
          record,
        );
        const {path} = installation;
        if (
          action !== 'status' &&
          (installation.status === 'conflict' ||
            (action === 'uninstall' &&
              installation.target &&
              !installation.managed))
        ) {
          installation.status = 'conflict';
          errors.push({
            code: 'SKILL_CONFLICT',
            message: `Unmanaged skill entry left untouched: ${path}. Move it manually before retrying.`,
            file: path,
          });
        } else if (
          action === 'install' &&
          installation.status === 'installed'
        ) {
          installation.status = 'unchanged';
        } else if (action === 'install') {
          const updating = installation.managed;
          const previousTargets = record.links[path];
          if (updating) {
            // Persist both valid targets before unlinking, so a crash remains repairable.
            record.links[path] = [installation.target!, source];
            await saveRecord(recordFile, record);
            await removeLink(installation);
          }
          await symlink(source, path, 'dir');
          record.links[path] = [source];
          try {
            await saveRecord(recordFile, record);
          } catch (error) {
            if (!updating) {
              await removeLink({...installation, target: source});
              if (previousTargets) {
                record.links[path] = previousTargets;
              } else {
                delete record.links[path];
              }
            }
            throw error;
          }
          installation = {
            ...installation,
            target: source,
            managed: true,
            status: updating ? 'updated' : 'installed',
          };
        } else if (action === 'uninstall') {
          if (installation.managed) {
            await removeLink(installation);
            installation = {...installation, status: 'removed', managed: false};
          }
          if (record.links[path]) {
            delete record.links[path];
            await saveRecord(recordFile, record);
          }
        }
      } catch (error) {
        installation.status = 'error';
        errors.push({
          code: 'SKILL_ERROR',
          message: error instanceof Error ? error.message : String(error),
          file: installation.path,
        });
      }
      installations.push(installation);
    }
    return {
      success: errors.length === 0,
      message: installations
        .map(
          entry =>
            `${entry.agent}: ${entry.status}${entry.target && !entry.managed && entry.status !== 'removed' ? ' (unmanaged)' : ''}\n  ${entry.path}`,
        )
        .join('\n'),
      data: {skill: SKILL, source, installations},
      ...(errors.length ? {errors} : {}),
    };
  };
  if (action === 'status') {
    return perform();
  }
  await mkdir(dirname(recordFile), {recursive: true, mode: 0o700});
  return withFileLock(
    join(dirname(recordFile), '.skill-installations.lock'),
    perform,
  );
}
