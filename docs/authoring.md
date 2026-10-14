---
title: Author a workflow
permalink: /authoring/
---

# Author a workflow

Build a small greeting workflow to learn the complete authoring cycle:
declare its contract, write its behavior, build it, and inspect the result.
This example makes no model requests and uses no external tools.

Complete [Getting started](getting-started.md) first. Run the commands below
from your chosen workspace, not from inside the workflow directory.

## Create the workflow files

Check existing names with `stratos list`. If `greet` is already present, use
another name consistently rather than overwrite it. For a new `greet` workflow:

```sh
mkdir -p .stratos/workflows/greet
```

Create `.stratos/workflows/greet/workflow.yaml`:

```yaml
name: greet
shortDescription: Greet a person, optionally in uppercase.
longDescription: |
  Supply a nonempty name. Set loud to true for an uppercase greeting.
  Returns message; no credentials or external calls are needed.
  Example input: {"name":"Ada"} returns {"message":"Hello, Ada!"}.
version: "1"
```

The manifest provides the discoverable name, two descriptions, and a string version.
Agent, tool, and telemetry configuration can be added here later. The default
entrypoint is `workflow.ts`; the manifest's optional `entrypoint` field selects
another file inside the same directory.

Both descriptions must be nonblank. Keep `shortDescription` to one paragraph:
target 150-300 characters, with a hard limit of 400 Unicode code points.
Use `longDescription` for Markdown usage instructions and relevant prerequisites,
input conventions, side effects, and retry gotchas. Its hard limit is 12,000
Unicode code points, excluding schemas; 300-800 words is a target only when
needed. Simple workflows need less. Spaces and line breaks count toward limits.
Use YAML `>-` to fold a short description's source lines.

**Breaking migration:** the old manifest `description` field is rejected.
Replace it with both fields and write the manual; there is no automatic split
or truncation. This does not change Zod's field descriptions. See the
[description contract](reference/SPEC.md#workflow-descriptions).

Create `.stratos/workflows/greet/workflow.ts`:

```typescript
import {workflow} from '@stratoscli/stratos';
import {z} from 'zod';

export default workflow({
  input: z.strictObject({
    name: z.string().min(1).describe('Person to greet'),
    loud: z.boolean().default(false).describe('Use uppercase'),
  }),
  output: z.strictObject({
    message: z.string().describe('The greeting'),
  }),
  run(input) {
    const message = `Hello, ${input.name}!`;
    console.info('Greeting prepared');
    return {message: input.loud ? message.toUpperCase() : message};
  },
});
```

`workflow(...)` connects three things. `input` describes accepted values;
`output` describes a successful result; `run` performs the work. Zod supplies
runtime validation and TypeScript inference from the same declarations, so
`input.name` is already typed as a string. Stratos also exposes these
declarations as JSON Schema for callers.

Here, `name` must be nonempty and an omitted `loud` becomes `false`.
`z.strictObject` rejects unknown fields rather than silently ignoring typos.
Both public schemas describe objects, and every field has a description.
See the [schema rules](reference/RUNTIME.md#schema-conventions) for nested objects,
defaults, and JSON-compatible constraints.

Keep actions inside `run`. Preparation loads the module to inspect its
definition, so model requests, tool calls, and other side effects must not run
at module scope. `run` can be synchronous, as above, or `async` when it awaits
agents, tools, or child workflows.

## Build and inspect the contract

```sh
stratos build greet
stratos list --json
stratos describe greet --json
```

The build prepares dependencies, checks types and schemas, and compiles the
workflow. Stratos supplies the compiler settings and shared SDK; do not create
a `tsconfig.json` or install a second workflow-local Stratos SDK. Declare other
npm dependencies in the workflow's `package.json` when needed.

`describe` puts the workflow name, version, both descriptions, `inputSchema`,
and `outputSchema` inside its JSON result's `data` field. Use
`stratos schema greet --json` for schemas alone. Agents select from `list`,
then fetch `describe` when the current manual/schema is not already available.
Neither inspection command invokes `run`, but preparation can install
dependencies, connect to MCP servers and evaluate modules. A successful build
establishes that the contract and code pass these checks, not that an arbitrary
workflow's behavior is correct.

## Run and check the result

```sh
stratos run greet --input '{"name":"Ada"}' --json
stratos run greet --input '{"name":"Ada","loud":true}' --json
```

The first command returns `{"message":"Hello, Ada!"}` in `data`; the second
returns `{"message":"HELLO, ADA!"}`. The `Greeting prepared` log goes to stderr
and the local run log, leaving JSON stdout available for scripts.

All JSON commands use the same envelope: `success`, `message`, and optional
`data`, `errors`, and `warnings`. Success exits with code `0`; a failed
validation or execution exits with code `1`. Without `--json`, `run` prints
the workflow's output directly. See [CLI output](reference/CLI.md#output-formatting)
for the full format.

Check a failure too. This input deliberately misspells the option and should
be rejected before `run` executes:

```sh
stratos run greet --input '{"name":"Ada","lodu":true}' --json
```

Correct the caller's input rather than relax the contract to hide the error.
After changing workflow code, build and rerun representative cases.
`describe`, `schema` and `run` also rebuild automatically when required artifacts are stale.

## Inspect a run

Each top-level run writes `run.json`, `run.log`, and `events.jsonl` under
`~/.stratos/runs/`, grouped by the invocation directory. This example emits
a console log but no agent events, so an empty `events.jsonl` is expected.
Trace export is optional and configured separately.

Use [Telemetry](reference/TELEMETRY.md#default-local-logs-and-agent-events) to find
the matching workspace and run, configure traces, or adjust retention.
Build failures are reported by the CLI; they are not successful workflow runs.

## Reuse and share the workflow

Another workflow can call `greet` through a generated, typed wrapper rather
than copying its implementation. Continue with
[Compose workflows](composition.md#child-workflows) to greet several people
from a parent workflow.

Commit the authored manifest, TypeScript, prompts, and any dependency
manifests/lockfiles. Generated wrappers, compiled `dist/` files, and installed
dependencies are local build products. Stratos adds scoped ignore rules for
them; do not commit run artifacts or credentials.

To regenerate artifacts, use `stratos clean greet`, then build again. Cleanup
preserves the authored files, dependencies, and credentials, and invalidates
dependent builds. It is not a command for deleting the workflow.
