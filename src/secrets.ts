import type {Stats} from 'node:fs';
import {readFile, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';

/** Callers retain their file-type/owner policy and credential-safe diagnostics. */
export async function readSecretFile(
  name: string,
  root: string,
  validate?: (info: Stats) => void,
): Promise<string> {
  const path = name.startsWith('~/')
    ? resolve(homedir(), name.slice(2))
    : resolve(root, name);
  const info = await stat(path);
  if (info.mode & 0o077) {
    throw new Error('Secret file requires owner-only permissions');
  }
  validate?.(info);
  return (await readFile(path, 'utf8')).trim();
}

export async function interpolateSecretReferences(
  template: string,
  read: (kind: 'env' | 'file', name: string) => Promise<string>,
): Promise<string> {
  let value = '';
  let offset = 0;
  for (const match of template.matchAll(/\{(env|file):([^{}]+)\}/g)) {
    value += template.slice(offset, match.index);
    value += await read(match[1] === 'env' ? 'env' : 'file', match[2]!);
    offset = match.index + match[0].length;
  }
  return value + template.slice(offset);
}
