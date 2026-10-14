import {randomUUID} from 'node:crypto';
import {mkdir, writeFile, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {compile} from 'json-schema-to-typescript';

import {connectMcp, discoverTools} from './client.js';
import type {WorkflowMetadata} from '../workflows/discovery.js';
import {referencedImports} from '../workflows/imports.js';

/** Follow authored local imports without evaluating workflow modules. */
export async function referencedMcps(
  workflow: WorkflowMetadata,
): Promise<string[]> {
  const generated = join(workflow.path, 'generated/mcp');
  const paths = await referencedImports(workflow, generated, false);
  return [
    ...new Set(
      paths.map(path =>
        path
          .slice(generated.length + 1)
          .replace(/\.js$/, '')
          .replace(/\.ts$/, ''),
      ),
    ),
  ];
}

function toolTypeName(name: string): string {
  return `Tool_${name.replace(
    /[^a-zA-Z0-9_]/gu,
    character => `$${character.codePointAt(0)!.toString(16).toUpperCase()}$`,
  )}`;
}

export async function generateMcpWrappers(
  workflow: WorkflowMetadata,
  names: string[],
  timeout: number,
): Promise<void> {
  for (const name of names) {
    if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
      throw new Error(
        `MCP server name cannot be used as a wrapper filename: ${JSON.stringify(name)}`,
      );
    }
  }
  for (const name of names) {
    const abort = new AbortController();
    const connection = await connectMcp(workflow, name, abort.signal, timeout);
    try {
      const tools = await discoverTools(connection);
      const pieces = [
        '// Generated from MCP tool schemas. Do not edit.',
        'import { createWorkflowMcp, type McpToolResult } from "@stratoscli/stratos/internal/runtime";',
      ];
      const seen = new Set<string>();
      for (const tool of tools) {
        if (tool.name === 'then') {
          throw new Error(
            'MCP tool name then conflicts with async client creation',
          );
        }
        if (seen.has(tool.name)) {
          throw new Error(`Duplicate MCP tool name: ${tool.name}`);
        }
        seen.add(tool.name);
        const typeName = toolTypeName(tool.name);
        // The schema compiler normalizes names; keep exact names outside it.
        pieces.push(`declare namespace ${typeName}Schema {`);
        for (const [kind, schema] of [
          ['Input', tool.inputSchema],
          ['Output', tool.outputSchema],
        ] as const) {
          if (schema === undefined) {
            continue;
          }
          pieces.push(
            `export namespace ${kind}Schema {`,
            // Adding a title makes the compiler treat {} as an object schema.
            Object.keys(schema).length === 0
              ? `export type ${kind} = unknown;`
              : await compile(
                  {...schema, title: kind} as Parameters<typeof compile>[0],
                  kind,
                  {
                    bannerComment: '',
                    $refOptions: {resolve: {file: false, http: false}},
                  },
                ),
            '}',
          );
        }
        pieces.push(
          '}',
          `export type ${typeName}Input = ${typeName}Schema.InputSchema.Input;`,
        );
        if (tool.outputSchema !== undefined) {
          pieces.push(
            `export type ${typeName}Output = ${typeName}Schema.OutputSchema.Output;`,
          );
        }
      }
      pieces.push(
        `export default async function createServer() { const client = await createWorkflowMcp(${JSON.stringify(name)}, ${timeout}); return {`,
      );
      for (const tool of tools) {
        const typeName = toolTypeName(tool.name);
        const hasOutput = tool.outputSchema !== undefined;
        const result = hasOutput
          ? `McpToolResult & { structuredContent: ${typeName}Output }`
          : 'McpToolResult';
        const definition = hasOutput
          ? `, ${JSON.stringify({
              name: tool.name,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
            })}`
          : '';
        pieces.push(
          `/** ${(tool.description ?? tool.name).replaceAll('*/', '* /')} */\n[${JSON.stringify(tool.name)}]: (args: ${typeName}Input): Promise<${result}> => client.callTool${hasOutput ? `<${typeName}Output>` : ''}(${JSON.stringify(tool.name)}, {...args}${definition}),`,
        );
      }
      pieces.push('}; }');
      await mkdir(join(workflow.path, 'generated/mcp'), {recursive: true});
      const file = join(workflow.path, 'generated/mcp', `${name}.ts`);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, pieces.join('\n'), {flag: 'wx'});
        await rename(temporary, file);
      } finally {
        await rm(temporary, {force: true});
      }
    } finally {
      await connection.close();
    }
  }
}
