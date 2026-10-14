import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Stratos owns ESM setup, while preserving the author's package configuration. */
export async function ensureEsmPackage(
  directory: string,
): Promise<Record<string, unknown>> {
  const file = join(directory, 'package.json');
  let pkg: Record<string, unknown> = {private: true};
  try {
    pkg = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  if (pkg.type !== undefined && pkg.type !== 'module') {
    throw new Error(
      `${file} declares type ${JSON.stringify(pkg.type)}. Stratos workflows require "type": "module"; resolve this conflict before building.`,
    );
  }
  if (pkg.type !== 'module') {
    pkg.type = 'module';
    await writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
  }
  return pkg;
}
