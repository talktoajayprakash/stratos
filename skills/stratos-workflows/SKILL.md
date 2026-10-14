---
name: stratos-workflows
description: Create, edit, build, run, and debug TypeScript workflows in the open-source Stratos workflow engine. Use for workflow.yaml, workflow.ts, generated MCP clients, child workflows, and workflows using Claude Code, Codex, OpenCode, or Decision. Not the unrelated Stratos desktop app.
---

# Stratos workflows

Use the existing CLI and SDK, not a new orchestration layer. Implement only the
user's requested behavior; preserve unrelated workflows, credentials and data.

## Discover first

Run commands from the user's intended workspace. Discovery checks its
`.stratos/workflows/` and `~/.stratos/workflows/`, not the nearest Git root.

```sh
node --version
stratos --version
stratos list --json
```

Use Node.js 24 or newer. `st` is an alias for `stratos`. If the executable is
missing, use the user's installed CLI path or the repository's built
`node /absolute/path/to/stratos/dist/src/cli/main.js`; do not install an unrelated
registry package named `stratos`.
If a shell selects an older Node, use the workspace's supported runtime and
verify its version before building; login shells can change PATH.
Workflow actions stay top-level (`build`, `run`); other commands follow
resource then action (`mcp login`, `skill status`, `provider status`,
`tools list`).
Use `<command> --help` for concise scoped syntax; root `--help` includes this skill.

Inspect an existing workflow's manifest and source before editing. Names must
be unique within a discovery root; use an explicit directory path when a name
is ambiguous across roots. Check for a suitable existing workflow before
creating another. `list` does not build, connect MCPs or run workflow code.
Select by name and short description, then fetch `stratos describe <workflow>
--json` before execution when the current manual/schema is not already in
context. It returns both descriptions and input/output schemas in `data`.
Use `schema` when only the input/output contract is needed. `run` does not
require a preceding discovery call.

For a new workflow, create `.stratos/workflows/<name>/workflow.yaml` and
`workflow.ts`. Keep a short task-specific name. Read additional references only
when needed:

- [MCP tools](references/mcp.md): configuration, manifest-first generation,
  targeted type lookup and typed results.
- [Agents, children and Decision](references/composition.md): supported
  composition patterns. Read just the relevant section.

For `provider: ollama`, first run `stratos provider status ollama --json` and read the
[Ollama setup/discovery section](references/composition.md#ollama-authoring-setup-and-discovery).
The authoring agent owns the setup conversation: ask before Ollama installation,
service changes or model downloads. Provider status/build never perform those actions.

## Minimal executable workflow

For example, `.stratos/workflows/greet/workflow.yaml`:

```yaml
name: greet
shortDescription: Greet a person, optionally in uppercase.
longDescription: |
  Supply a nonempty name. Set loud to true for an uppercase greeting.
  Returns message; no credentials or external calls are needed.
  Example input: {"name":"Ada"} returns {"message":"Hello, Ada!"}.
version: "1"
```

`.stratos/workflows/greet/workflow.ts`:

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

Both manifest descriptions are required and nonblank. `shortDescription` is a
single paragraph describing what the workflow does and when to choose it:
target 150-300 characters, maximum 400. Use YAML `>-` to fold source lines.
`longDescription` is a Markdown manual: target 300-800 words when warranted,
maximum 12,000 characters excluding schemas. Limits count Unicode code points,
including whitespace; shorter text is fine. Explain relevant prerequisites,
input conventions, output meaning, side effects, failures and retry gotchas.
Add an example only when useful; do not repeat every schema field.
Legacy manifest `description` is rejected: replace it with both fields and
write the manual rather than copying or truncating the old text.
This does not change this skill's frontmatter or Zod field descriptions.

Both public schemas must describe objects. Reject unknown input fields using
`z.strictObject`, including nested input objects. Describe every input/output
property with `.describe(...)`, including nested properties. Use JSON-compatible
schemas; put transformations, custom refinements and business checks in `run`.
The input name `overrides` is reserved.

Keep side effects and creation of agents, MCP clients and child objects inside
`run`: build/schema/describe commands load modules to inspect their definitions. Use
`.js` extensions in relative TypeScript imports. Do not author a `tsconfig.json`,
edit generated files, or install a workflow-local copy of `stratos`. Build manages
the shared SDK and ESM setup. Declare additional npm dependencies in the
workflow's `package.json` only when required.

## Build, fix, run

```sh
stratos build greet --json
stratos list --json
stratos describe greet --json
stratos run greet --input '{"name":"Ada"}' --json
stratos run greet --input '{"name":"Ada","loud":true}' --json
```

The example results in `data` are `{"message":"Hello, Ada!"}` and
`{"message":"HELLO, ADA!"}`. Include representative input and expected output for
the workflow you author, and verify the user's actual requirement.

JSON commands return `{success, message, data?, errors?, warnings?}`; workflow
output is in `data`. Failures exit 1 and expose `errors`. Logs/progress use stderr.
Fix the reported source/configuration problem and rebuild; don't hide failures
with casts, dummy successful results or disabled schema checks.

`describe`, `schema` and `run` build automatically if needed. Inspection can
install dependencies, prepare MCP wrappers and evaluate modules; it does not
invoke `run` and is not a sandbox. An explicit `build` also
rediscovers every declared MCP, even with unchanged source. A manifest-only
`status: "prepared"` means wrappers exist, not that the workflow is runnable.
Rebuild after MCP configuration or catalog changes.
Explicit builds also recheck every declared Ollama YAML model against the
selected server, even with a cached build. Fix missing models/configuration
using the setup guidance; don't claim runtime-only settings were build-checked.

Build checks are not execution evidence. Run with safe representative inputs,
check results and relevant failure cases, then revise. Execution is **not
sandboxed**; agents and tools can have real side effects. Do not use production
mutations as smoke tests or rerun a failed workflow blindly: runs are fresh and
can repeat earlier side effects.

## Debug and hand off

- Start with CLI `errors` and stderr. For a type mismatch, inspect the named
  source/type only. For authentication failure, follow the configured server or
  harness login flow; never read or print token files into model context.
- Logs live under `~/.stratos/runs/<workspace>/<run>/`. Match `workspace.json`'s
  `path` to the invocation directory and inspect the selected run's `run.json`
  and a bounded tail of `run.log`. `events.jsonl` combines parent/child agent
  events; it can be empty for code-only runs. Search by execution/session ID
  instead of reading all run history.
- Optional traces require `otel.traces.exporter` in YAML; they are separate from
  `events.jsonl`. A simple local configuration is
  `otel: {traces: {exporter: {type: file, path: .stratos/telemetry}}}`.
  That relative export path uses the invocation directory.
- Use `stratos clean <workflow>` only when generated artifacts need removal,
  then rebuild. It preserves authored files, dependencies and credentials.
- Share authored manifests, sources, prompts and dependency manifests/lockfiles.
  Do not commit `generated/`, `.generated/`, `dist/`, `node_modules/`, run
  artifacts, credentials or private MCP schemas. Keep generated ignore rules.
- Report saved paths, how to invoke, actual results and any blockers. Missing
  auth, skipped calls or a successful build alone are not a successful live run.

Do not invent commands such as `stratos check`, `stratos init`,
or a workflow-serving MCP command. They are not implemented in this version.
