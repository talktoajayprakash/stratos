#!/usr/bin/env node
import {Console} from 'node:console';
import {readFileSync} from 'node:fs';
import {rm, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {parseArgs} from 'node:util';

import {commandHelp} from './help.js';
import {mcpCommand} from './mcp.js';
import {ollamaStatus} from './provider.js';
import type {CommandResult} from './result.js';
import {skillCommand} from './skill.js';
import {toolsCommand} from './tools.js';
import {loadCatalog} from '../models/catalog.js';
import {PACKAGE_ROOT} from '../paths.js';
import {
  buildWorkflow,
  loadDefinition,
  executionSdk,
  isBuilt,
} from '../workflows/build.js';
import {discover, selectWorkflow, roots} from '../workflows/discovery.js';
import type {WorkflowOverrides} from '../workflows/runtime.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const help = `Stratos — code-authored workflows for agents and tools.

Usage: stratos <action> [workflow | --name workflow] [options]
       st      <action> [workflow | --name workflow] [options]
       stratos <resource> <action> [target] [options]
       st      <resource> <action> [target] [options]

  mcp         List MCP servers; login/logout (--name, --workflow).
  skill       Globally install/status/uninstall the authoring skill (--agent names | --all).
  provider    Inspect provider readiness: provider status ollama [--json].
  tools       List agent built-in tool names per harness: tools list [harness] [--json].
  list        Discover workflows and report build status.
  build       Refresh MCP wrappers and build workflows; supports manifest-only preparation.
  schema      Return workflow input/output JSON Schemas.
  describe    Return a workflow's usage manual and input/output JSON Schemas.
  run         Execute a workflow (--input JSON, --overrides JSON).
  clean       Remove generated artifacts for a workflow or project.
  --help      Show global help and the authoring skill, or scoped help after a command.
  --version   Show the installed version.
  --json      Return a structured result.

Agent workflows use createAgent() with native Claude Code, Codex, or OpenCode adapters.
OAuth login/refresh and selected agent MCPs are supported; remaining MVP services are still in progress.`;

let result: CommandResult;
let naturalJson = false;
try {
  loadCatalog();
  const {values, positionals} = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: {type: 'boolean'},
      version: {type: 'boolean'},
      json: {type: 'boolean'},
      name: {type: 'string'},
      workflow: {type: 'string'},
      input: {type: 'string'},
      overrides: {type: 'string'},
      agent: {type: 'string'},
      all: {type: 'boolean'},
    },
  });
  if (values.help && values.version) {
    throw new Error('Use either --help or --version, not both.');
  }
  const {version} = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  );
  const [action, positional] = positionals;
  if (action === 'setup') {
    throw new Error(
      'Use stratos provider status ollama [--json] for read-only readiness checks.',
    );
  }
  if (
    action !== 'skill' &&
    (values.agent !== undefined || values.all !== undefined)
  ) {
    throw new Error('--agent and --all are only valid for skill.');
  }
  if (
    !['mcp', 'provider', 'tools'].includes(action ?? '') &&
    (positionals.length > 2 || (positional && values.name))
  ) {
    throw new Error(
      'Specify one workflow target, either positional or --name.',
    );
  }
  if (
    action === 'provider' &&
    (values.name !== undefined ||
      values.workflow !== undefined ||
      values.input !== undefined ||
      values.overrides !== undefined)
  ) {
    throw new Error('Use stratos provider status ollama [--json].');
  }
  const target = positional ?? values.name;
  const cwd = process.cwd();
  if (values.version || values.help || !action) {
    if (!action && (target || values.input || values.overrides)) {
      throw new Error('Specify a command.');
    }
    const skillPath = join(PACKAGE_ROOT, 'skills/stratos-workflows/SKILL.md');
    result = {
      success: true,
      message: values.version
        ? version
        : values.help && action
          ? commandHelp(positionals)
          : `${help}\n\nWorkflow authoring skill: ${skillPath}\nResolve the skill's relative reference links from this file's directory.\n\n${readFileSync(skillPath, 'utf8')}`,
    };
  } else if (action === 'provider') {
    if (
      positional !== 'status' ||
      positionals[2] !== 'ollama' ||
      positionals.length !== 3
    ) {
      throw new Error('Use stratos provider status ollama [--json].');
    }
    result = await ollamaStatus();
  } else if (action === 'tools') {
    if (
      positionals.length > 3 ||
      values.name !== undefined ||
      values.workflow !== undefined ||
      values.input !== undefined ||
      values.overrides !== undefined
    ) {
      throw new Error(
        'Use stratos tools list [claude-code | codex | opencode].',
      );
    }
    result = await toolsCommand(positional, positionals[2]);
  } else if (action === 'skill') {
    if (
      positionals.length > 2 ||
      values.name !== undefined ||
      values.workflow !== undefined ||
      values.input !== undefined ||
      values.overrides !== undefined
    ) {
      throw new Error(
        'Use stratos skill install|status|uninstall [--agent names | --all].',
      );
    }
    result = await skillCommand(positional, values.agent, values.all ?? false);
  } else if (action === 'mcp') {
    if (
      positionals.length > 3 ||
      (positionals[2] && values.name) ||
      values.input ||
      values.overrides
    ) {
      throw new Error('Invalid MCP command arguments');
    }
    result = await mcpCommand(
      positional,
      positionals[2] ?? values.name,
      values.workflow,
      cwd,
    );
  } else if (action === 'list') {
    if (target || values.input || values.overrides) {
      throw new Error('list does not accept a target, input, or overrides');
    }
    result = await listWorkflows(cwd, json);
  } else if (['build', 'schema', 'describe', 'run', 'clean'].includes(action)) {
    if (action === 'describe' && values.workflow !== undefined) {
      throw new Error(
        'Use a positional workflow target or --name for describe',
      );
    }
    if (
      action !== 'run' &&
      (values.input !== undefined || values.overrides !== undefined)
    ) {
      throw new Error('--input and --overrides are only valid for run');
    }
    if (!target && ['run', 'schema', 'describe'].includes(action)) {
      throw new Error(`${action} requires a workflow name or directory path`);
    }
    // Keep workflow console output and build progress separate from JSON results.
    globalThis.console = new Console({
      stdout: process.stderr,
      stderr: process.stderr,
    });
    if (action === 'clean') {
      result = await cleanWorkflows(cwd, target);
    } else if (action === 'build' && !target) {
      result = await buildAllWorkflows(cwd);
    } else {
      ({result, naturalJson} = await workflowCommand(
        action,
        target!,
        cwd,
        values,
      ));
    }
  } else {
    throw new Error(`Unknown command ${action}`);
  }
} catch (error) {
  result = {
    success: false,
    message: 'Command failed.',
    errors: [
      {
        code: 'CLI_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

if (json) {
  process.stdout.write(JSON.stringify(result) + '\n');
} else if (naturalJson && result.success) {
  process.stdout.write(JSON.stringify(result.data, null, 2) + '\n');
} else {
  const text = [
    result.message,
    ...(result.errors ?? []).map(error => `${error.code}: ${error.message}`),
  ].join('\n');
  (result.success ? process.stdout : process.stderr).write(text + '\n');
}
process.exitCode = result.success ? 0 : 1;

async function listWorkflows(
  cwd: string,
  json: boolean,
): Promise<CommandResult> {
  const found = await discover(cwd);
  const entries = await Promise.all(
    found.workflows.map(async workflow => {
      const built = await isBuilt(workflow);
      return {
        name: workflow.name,
        shortDescription: workflow.shortDescription,
        path: workflow.path,
        status: built ? 'built' : 'not built',
        ...(!built
          ? {nextAction: `Run stratos build ${JSON.stringify(workflow.path)}`}
          : {}),
      };
    }),
  );
  return {
    success: !found.errors.length,
    message: json
      ? `Found ${entries.length} workflows.`
      : entries.length
        ? entries
            .map(
              w =>
                `${w.name} (${w.status}) — ${w.shortDescription}\n  ${w.path}${w.nextAction ? '\n  ' + w.nextAction : ''}`,
            )
            .join('\n')
        : 'No workflows found.',
    data: entries,
    ...(found.errors.length ? {errors: found.errors} : {}),
  };
}

async function cleanWorkflows(
  cwd: string,
  target: string | undefined,
): Promise<CommandResult> {
  const workflows = target
    ? [await selectWorkflow(cwd, target)]
    : (await discover(cwd, true)).workflows;
  if (!target) {
    const root = roots(cwd)[0]!;
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    for (const entry of entries.filter(
      name => name !== 'node_modules' && !name.startsWith('.'),
    )) {
      await rm(join(root, entry, 'dist'), {recursive: true, force: true});
      await rm(join(root, entry, 'generated'), {
        recursive: true,
        force: true,
      });
    }
    await rm(join(root, '.generated'), {recursive: true, force: true});
  } else {
    for (const workflow of workflows) {
      await rm(join(workflow.path, 'dist'), {recursive: true, force: true});
      await rm(join(workflow.path, 'generated'), {
        recursive: true,
        force: true,
      });
      await rm(join(workflow.root, '.generated', workflow.name + '.ts'), {
        force: true,
      });
    }
  }
  return {success: true, message: 'Generated artifacts cleaned.'};
}

async function buildAllWorkflows(cwd: string): Promise<CommandResult> {
  const found = await discover(cwd, true);
  const entries = [];
  for (const workflow of found.workflows) {
    try {
      const build = await buildWorkflow(workflow, {explicit: true});
      entries.push({name: workflow.name, success: true, ...build});
    } catch (error) {
      entries.push({name: workflow.name, success: false});
      found.errors.push({
        code: 'BUILD_ERROR',
        message: String(error),
        file: workflow.path,
      });
    }
  }
  return {
    success: !found.errors.length,
    message: `Built ${entries.filter(e => 'status' in e && e.status === 'built').length}; prepared MCP wrappers for ${entries.filter(e => 'status' in e && e.status === 'prepared').length}; failed ${entries.filter(e => !e.success).length} workflows.`,
    data: entries,
    ...(found.errors.length ? {errors: found.errors} : {}),
  };
}

async function workflowCommand(
  action: string,
  target: string,
  cwd: string,
  values: {input?: string; overrides?: string},
): Promise<{result: CommandResult; naturalJson: boolean}> {
  let result: CommandResult;
  let naturalJson = false;
  const workflow = await selectWorkflow(cwd, target);
  if (action === 'run' && !(await isBuilt(workflow))) {
    console.error('not built, running build first');
  }
  const build = await buildWorkflow(workflow, {
    explicit: action === 'build',
  });
  if (action === 'build') {
    result = {
      success: true,
      message:
        build.status === 'built'
          ? `Built ${workflow.name}.`
          : `Prepared MCP wrappers for ${workflow.name}; workflow entrypoint not present.`,
      data: build,
    };
  } else {
    const sdk = await executionSdk(workflow.root);
    const definition = await loadDefinition(workflow);
    let data;
    if (action === 'schema' || action === 'describe') {
      const schemas = sdk.inspectWorkflow(definition);
      data =
        action === 'describe'
          ? {
              name: workflow.name,
              version: workflow.version,
              shortDescription: workflow.shortDescription,
              longDescription: workflow.longDescription,
              ...schemas,
            }
          : schemas;
    } else {
      const overrides = values.overrides
        ? (JSON.parse(values.overrides) as WorkflowOverrides)
        : {};
      if (
        !overrides ||
        typeof overrides !== 'object' ||
        Array.isArray(overrides)
      ) {
        throw new Error('--overrides must be a JSON object');
      }
      data = await sdk.executeWorkflow(
        definition,
        values.input ? JSON.parse(values.input) : {},
        workflow.name,
        cwd,
        workflow,
        overrides,
      );
    }
    naturalJson = true;
    result = {
      success: true,
      message:
        action === 'schema'
          ? `Schema for ${workflow.name}.`
          : action === 'describe'
            ? `Description for ${workflow.name}.`
            : `Completed ${workflow.name}.`,
      data,
    };
  }
  return {result, naturalJson};
}
