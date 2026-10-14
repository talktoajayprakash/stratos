import {access, readFile} from 'node:fs/promises';
import {dirname, extname, join, resolve} from 'node:path';

import {parse} from '@babel/parser';

import type {WorkflowMetadata} from './discovery.js';

/** Follow authored local imports without evaluating modules or generated code. */
export async function referencedImports(
  workflow: WorkflowMetadata,
  generated: string,
  includeTypeOnly: boolean,
): Promise<string[]> {
  const visited = new Set<string>();
  const targets = new Set<string>();
  async function visit(file: string): Promise<void> {
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    const ast = parse(await readFile(file, 'utf8'), {
      sourceType: 'module',
      plugins: ['typescript'],
    });
    const imports: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') {
        return;
      }
      if (
        [
          'ImportDeclaration',
          'ExportNamedDeclaration',
          'ExportAllDeclaration',
        ].includes('type' in node ? String(node.type) : '') &&
        'source' in node &&
        node.source &&
        typeof node.source === 'object' &&
        'type' in node.source &&
        node.source.type === 'StringLiteral' &&
        'value' in node.source &&
        typeof node.source.value === 'string' &&
        (includeTypeOnly ||
          ((!('importKind' in node) || node.importKind !== 'type') &&
            (!('exportKind' in node) || node.exportKind !== 'type')))
      ) {
        imports.push(node.source.value);
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) {
          child.forEach(walk);
        } else if (child && typeof child === 'object') {
          walk(child);
        }
      }
    };
    walk(ast);
    for (const specifier of imports) {
      if (!specifier.startsWith('.')) {
        continue;
      }
      const target = resolve(dirname(file), specifier);
      if (dirname(target) === generated) {
        targets.add(target);
        continue;
      }
      const candidate = target.replace(/\.js$/, '.ts');
      if (
        !candidate.startsWith(workflow.path + '/') ||
        candidate.startsWith(join(workflow.path, 'generated') + '/') ||
        extname(candidate) !== '.ts'
      ) {
        continue;
      }
      try {
        await access(candidate);
      } catch {
        // Missing imports remain the compiler's responsibility.
        continue;
      }
      await visit(candidate);
    }
  }
  await visit(resolve(workflow.path, workflow.entrypoint));
  return [...targets];
}
