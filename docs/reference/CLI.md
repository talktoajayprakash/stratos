# CLI reference

Use the CLI to discover, build, inspect, and run saved workflows, and to manage
their supporting integrations. This page is a command reference; follow
[Author a workflow](../authoring.md) for a complete first run.

## Command overview

Both `stratos` and `st` accept these commands. A workflow target is a unique
discovered name or an explicit directory path.

| Command | Purpose | Important behavior |
|---|---|---|
| `list` | List project and user workflows | Read-only; reports build freshness |
| `build [workflow]` | Validate and prepare code and integrations | No target builds the current project; explicit builds refresh MCP schemas |
| `schema <workflow>` | Inspect input/output JSON Schemas | Builds when needed, without invoking `run` |
| `describe <workflow>` | Read usage manual and input/output JSON Schemas | Uses schema preparation; no workflow `run` |
| `run <workflow>` | Execute with JSON input | Builds when needed; can perform real actions |
| `clean [workflow]` | Remove generated artifacts | Preserves authored files, dependencies, and credentials |
| `mcp list` | List configured servers, qualified by workflow | Does not connect or authenticate |
| `mcp login <server>` | Authenticate an OAuth server | May open a browser; use `--workflow` to disambiguate |
| `mcp logout <server>` | Remove local credentials | Does not imply remote token revocation |
| `skill install` / `skill uninstall` | Manage authoring guidance | Requires `--agent` or `--all`; modifies only owned links |
| `skill status` | Inspect skill installation | Read-only; defaults to all supported targets |
| `provider status ollama` | Check the selected Ollama server | Metadata only; no installation, downloads, or inference |
| `tools list [harness]` | List accepted built-in tool names and always-on tools | Static catalog; no harness startup or credentials |

### Options

| Option | Applies to | Meaning |
|---|---|---|
| `--name <target>` | Workflow commands, MCP login/logout | Alternative to the positional target, not an additional target |
| `--input '<JSON>'` | `run` | Workflow input object; omitted input defaults to `{}` |
| `--overrides '<JSON>'` | `run` | Named `agents` and `decision` settings, separate from domain input |
| `--workflow <name-or-path>` | MCP commands | Select the owning workflow's server definitions |
| `--agent <names>` | Skill commands | Comma-separated installation targets |
| `--all` | Skill commands | Explicitly select every supported target |
| `--json` | Commands and help | Emit the common structured result on stdout |
| `--help` | Root, command, or resource group | Show guidance without executing the operation |
| `--version` | Root | Show the installed package version |

Input is a JSON string, not a filename. To use a local file, let the shell read
it: `stratos run greet --input "$(cat input.json)" --json`.
Configuration overrides merge field by field; they are not workflow input
fields. For example, to change only a named agent's effort:

```sh
stratos run review-pr --input '{"repo":"org/repo"}' \
  --overrides '{"agents":{"validator":{"effort":"low"}}}' --json
```

This assumes an existing `review-pr` workflow with that input and named agent.
Use `describe` to read the manual and contract before invoking an unfamiliar
workflow. Overrides do not change an already-running conversation.

## Command names

The CLI is invoked as `stratos` or its short alias `st`. Both names expose the same commands, arguments, options, and behavior.

```text
stratos <action> [workflow] [options]
stratos <resource> <action> [target] [options]
```

Workflows are the default resource: `list`, `build`, `describe`, `schema`, `run` and `clean`
stay at the top level. Other operations use a resource group: `mcp`, `skill`,
`provider` or `tools`, followed by the action and then any target. `st` accepts the
same forms. `list` discovers entries, `status` inspects without changing them,
and `install`/`setup` denote changes, not diagnostics.

Select workflow and MCP login/logout targets with a positional name or
`--name`; the forms are equivalent. `--workflow` disambiguates MCP
configurations, and `--agent` selects skill installation targets.
Provider and harness names are positional: `stratos provider status ollama`,
`stratos tools list codex`.
Resource commands use this order; alternate verb-first spellings are not supported.

Examples of equivalent target selection:

```sh
stratos schema review-pr
stratos schema --name review-pr
stratos describe review-pr
stratos describe --name review-pr
stratos build review-pr
stratos build --name review-pr
stratos run review-pr --input '{"repo":"org/repo"}'
stratos run --name review-pr --input '{"repo":"org/repo"}'
stratos mcp login github --workflow review-pr
stratos mcp login --name github --workflow review-pr
stratos mcp logout github --workflow review-pr
stratos mcp logout --name github --workflow review-pr
```

Workflow invocation overrides are supplied with `--overrides '<JSON>'`, using
the `agents` and `decision` maps.

```sh
stratos skill status
stratos provider status ollama --json
stratos tools list codex --json
```

## Help and authoring guidance

`stratos --help` and `st --help` return the command summary followed by the
complete bundled `skills/stratos-workflows/SKILL.md`. Bare invocation returns
the same help. Guidance is read from the running package, so it matches that
installation without requiring a global skill installation.

Help includes the absolute skill-file path so agents can resolve its relative
reference links. References remain on demand rather than expanding
their contents into help. `--help --json` puts the same text in the common
envelope's `message`; `--version` remains version-only. Missing or unreadable
skill content fails global help explicitly instead of returning incomplete guidance.

After a command or resource group, `--help` returns only its syntax, description
and applicable options, not the complete authoring skill:

```sh
stratos build --help
stratos mcp --help
stratos mcp login --help
stratos skill install --help
stratos provider status ollama --help
stratos tools list --help
```

Command help works without required targets/options, workflow discovery,
provider requests, authentication or mutations. It does not require reading
the bundled skill. `--json` wraps the scoped text in the same common envelope.
Unknown commands/subcommands still fail instead of displaying successful global
help. Bare `stratos` and root `--help` retain the full authoring guidance.

## Workflow target resolution

A workflow can be selected by a unique name or an explicit workflow directory
path, relative or absolute. If the name matches both project and user roots,
the CLI reports the matching paths rather than choosing one or prompting.
Retry with an explicit path. These rules apply to `describe`, `schema`, `build`, `run`,
`clean`, and MCP commands' `--workflow` selector. They do not change the
same-root restriction for child workflows.

## Ollama provider status

```sh
stratos provider status ollama
stratos provider status ollama --json
```

Both aliases support this read-only command; no workflow target is needed.
Only Ollama status is implemented in the `provider` command group.
It checks `OLLAMA_HOST` (default `http://127.0.0.1:11434`) through
`/api/version`, `/api/tags` and `/api/show`, with a 15-second metadata deadline.
A reachable server is sufficient even if no local executable is installed.
Success reports the version and installed native IDs/capabilities, distinguishing
cloud-backed entries; it does not certify a particular task or harness.

When a local connection is unavailable, the command inspects PATH and standard
installation locations. It distinguishes missing installation from
installed-but-unreachable, with
OS-specific commands and official instructions: macOS installer/app launch,
Linux installer/`ollama serve`, or Windows installer/`ollama serve`.
The authoring agent asks for approval before running installation, starting a
service or pulling a chosen model. The command **does not install software,
start servers, change settings, download models or perform inference**.
The macOS/Windows install command opens the official download page; the user
must complete that installer. A remote connection failure does not request
local installation; timeout/TLS/HTTP/invalid-metadata errors must not be
presented as proof Ollama is absent.

Use the common result envelope and exit codes. Readiness failures include
`OLLAMA_SETUP_REQUIRED`, corrective guidance and
`retryCommand: "stratos provider status ollama --json"`. Other configuration/HTTP/metadata
errors use the standard CLI error path. Status does not enumerate the entire
downloadable library: see the bundled skill's
[Ollama authoring guidance](../../skills/stratos-workflows/references/composition.md#ollama-authoring-setup-and-discovery).

## Agent built-in tool names

Before configuring an agent's `allowedTools` or `disallowedTools`, ask the CLI
which names its harness accepts:

```sh
stratos tools list
stratos tools list claude-code
stratos tools list opencode
stratos tools list codex --json
```

Omit the target to list all three harnesses, or pass exactly one of
`claude-code`, `codex`, or `opencode`. **The target is a harness, not a model
provider** such as Azure or Ollama: the harness supplies the agent's built-in
tools. No workflow target is needed.

Names shared across harnesses use Stratos names such as `shell` and `read`.
Harness-specific tools retain their own names, such as Claude Code's
`NotebookEdit`. Use the exact, case-sensitive names the command returns, not
guessed native aliases: `shell` is accepted, but `Bash` is not.

Text output groups names by harness under `tools` and, when applicable,
`always on (cannot be removed)`. With `--json`, the common result envelope's
`data` is an array even when selecting one harness:

| Field | Type | Meaning |
|---|---|---|
| `harness` | String | The selected harness ID |
| `tools` | String array | Names whose mapped native tools or capabilities Stratos can remove |
| `alwaysOn` | String array | Names unaffected by either allow/deny list; Codex reports `edit` and `write` |

Each `tools` array combines shared and harness-specific names. Names for
capabilities absent from that harness are omitted. Always-on names need not
be included in `allowedTools`, and adding them to `disallowedTools` has no effect.

The catalog comes from the **installed Stratos version's adapter mappings**.
It does not query the installed SDK or enumerate the tools active in a live
session, including tools outside Stratos's mappings. Listing a name does not
enable that tool. The command starts no harness, makes no model request, and
needs no credentials. It does not list MCP tools; use the
[MCP discovery guide](../mcp.md#discover-tools-and-generate-types) for those.

### Apply a tool selection

Set the lists on a named agent in `workflow.yaml`, pass them to `createAgent`,
or supply invocation overrides. For an existing `review-pr` workflow using
`configId: "validator"` and accepting a `repo` input:

```sh
stratos run review-pr --input '{"repo":"org/repo"}' \
  --overrides '{"agents":{"validator":{"disallowedTools":["shell","web_search"]}}}' --json
```

This replaces that agent's configured `disallowedTools` list, not the whole
agent configuration. Its `allowedTools` and other unspecified fields remain
in effect; explicit settings in `createAgent` have higher priority than the
override. The command runs a real workflow and may incur charges.

Tool selection only removes mapped tools; it is not a sandbox or a guarantee
that the agent cannot perform a particular action through another tool. See
[the tool-selection walkthrough](../primitives.md#choose-an-agents-tools) and
[agent built-in tool selection](RUNTIME.md#agent-built-in-tool-selection).

## Global authoring skill

```sh
stratos skill install --agent codex,claude,gemini,cursor
stratos skill install --all
stratos skill status
stratos skill status --agent codex --json
stratos skill uninstall --agent cursor
stratos skill uninstall --all
```

These commands manage only the bundled `stratos-workflows` skill. Installation
is global to the current user, across projects, not system-wide. There is no
project scope, registry, download, automatic update or npm post-install hook.
Install/uninstall require either `--agent` (comma-separated names) or `--all`;
they never guess which agents are installed. `status` defaults to all supported
targets and does not write files. `claude-code` aliases `claude`; repeated targets
are deduplicated. Both executable aliases and the common JSON/exit contract apply.

| Target | Default skills directory | Environment override |
|---|---|---|
| `claude` | `~/.claude/skills` | `$CLAUDE_CONFIG_DIR/skills` |
| `codex` | `~/.agents/skills` | None; `CODEX_HOME` does not relocate this shared root |
| `gemini` | `~/.gemini/skills` | `$GEMINI_CLI_HOME/.gemini/skills` |
| `cursor` | `~/.cursor/skills` | None |
| `copilot` | `~/.copilot/skills` | `$COPILOT_HOME/skills` |
| `opencode` | `~/.config/opencode/skills` | `$OPENCODE_CONFIG_DIR/skills`, otherwise `$XDG_CONFIG_HOME/opencode/skills` |

Overrides must be absolute directory paths. Resolve and validate selected
targets and the complete bundled skill before installation writes. The
destination is `<skills-directory>/stratos-workflows`, a directory symlink to
`<running-package>/skills/stratos-workflows`. Preserve its relative references;
do not paste the skill into `AGENTS.md`, `CLAUDE.md` or agent settings. The
installer does not enable Gemini/Cursor/Copilot as workflow execution harnesses.

### Installation ownership and recovery

The internal ownership record is `~/.stratos/skill-installations.json`. Serialize
mutations under a local file lock and atomically update the record. Record
canonical parent paths and expected symlink targets, including an interrupted
package-location change, so another Stratos invocation can repair owned links.
Do not treat a matching filename alone as proof of ownership.

Reinstall leaves an already-correct link untouched. An independently created
correct link is reported as unmanaged, not adopted. Only recorded links still
pointing to a recorded target may be updated or removed. Conflicting real files,
directories and foreign links (including dangling ones) remain untouched and
produce `SKILL_CONFLICT`; other per-target failures produce `SKILL_ERROR`.
Corrupt/unsafe records fail without replacement. Multi-target operations report
all attempted outcomes and exit 1 if any operation fails, rather than concealing
partial success. Uninstall never deletes source skill files or harness directories.

### Skill results

`data` contains `skill`, `source`, and `installations`. Each installation reports
`agent`, resolved `path`, `status`, `managed`, and `target` when a symlink was
observed/created. Status inspection reports `installed`, `not-installed`,
`outdated`, `broken` or `conflict`; mutation outcomes additionally include
`unchanged`, `updated`, `removed` and `error`. A successful status inspection is
not a claim that all targets are installed or that a native agent loaded them.

After a package upgrade or move, rerun installation for the desired targets.
An upgrade at a stable package path is visible through existing links; removing
the package leaves dangling links until repaired or uninstalled. Uninstall the
skill before removing the CLI if no replacement CLI will remain available.

Some harnesses also discover shared/compatibility directories, so target
selection controls write destinations, not exclusive visibility. Reload skills
or restart the native agent if necessary. Local installation does not propagate
to remote/cloud sessions and does not override native skill permissions or policy.
Skill discovery is not proof that a native agent has activated the skill or
can complete an authenticated workflow.

## Workflow discovery and schemas

The CLI lists discovered workflows and retrieves their resolved input and
output JSON Schemas. Stratos loads the workflow definition and converts its Zod
schemas without invoking `run`; module-level code is evaluated during loading.

```sh
stratos list
stratos describe --name <name>
stratos run --name <name> --input '{"key":"value"}'
```

`list` returns discovered workflow names and short descriptions, `describe`
returns a usage manual and schemas, `schema` returns only input/output JSON
Schemas, and `run` executes with the supplied JSON input. All commands also
work with `st`. Output behavior is defined below.

`schema` automatically performs a full build when a current successful build is unavailable. It returns schemas only after build success, reuses a current build when available, and surfaces build errors without invoking the workflow's `run` function. Build progress belongs on stderr; schema JSON remains on stdout.

When `run` encounters a workflow without a current successful build, it logs `not built, running build first` to stderr and automatically builds before execution. The user does not need to run `stratos build` separately. Execution starts only after a successful build; a build failure stops the command without invoking the workflow.

Before the workflow body starts, including with a cached build, authenticate its
declared OAuth MCP servers. Reuse fresh credentials, refresh near-expiry tokens
or request browser sign-in. Known token expiries must leave more than five
minutes; authentication failure or insufficient lifetime fails the run before
business logic executes. Tokens without expiry metadata retain existing
behavior, with no verified lifetime guarantee. This check does not discover
tools or start native agents/MCP processes; `describe`, `schema` and `list` do not run it.
Child workflows perform the same check when invoked. Mid-request renewal is
not implemented; see [authentication](./SPEC.md#mcp-connections-and-authentication).

`list` reflects the current discovery directories, including new workflows and
excluding deleted ones even if generated artifacts remain. Its JSON entries
contain `name`, `shortDescription`, `path`, `status` (`built` or `not built`), and
`nextAction` when a build is needed. Listing compares current workflow and
referenced-workflow SHA-256 hashes with the last successful build. New or
changed workflows are marked `not built` with build guidance. Listing
validates manifest metadata, but does not validate workflow code, install
dependencies, compile, or regenerate wrappers.

Discovery reads names and descriptions from `workflow.yaml` without preparing workflows; only the short description is exposed in the list. Schema retrieval prepares required dependencies, builds, schemas, and workflow/referenced wrappers, recording workflow hashes. Execution reuses valid preparation or performs it when missing/stale. Workflow changes trigger refresh of affected artifacts; details and refresh behavior are tracked in [RUNTIME.md](./RUNTIME.md#code-derived-workflow-schemas).

<a id="progressive-discovery-approved-not-yet-implemented"></a>

### Progressive discovery

The [description split](SPEC.md#workflow-descriptions) supports the following
agent flow after creating the greeting example:

```sh
stratos list --json
stratos describe greet --json
stratos run greet --input '{"name":"Ada"}' --json
```

| Command | Response |
|---|---|
| `list` | Entries contain `name`, `shortDescription`, and existing `path`, `status`, and conditional `nextAction` fields. No `longDescription` or schemas. |
| `describe <workflow>` | `name`, `version`, `shortDescription`, `longDescription`, `inputSchema`, and `outputSchema` together in the result data. |
| `schema <workflow>` | Existing `inputSchema` and `outputSchema` data, unchanged; no manual added. |
| `run <workflow>` | Existing execution behavior and result. |

`describe` stays top-level and supports unique names, directory paths,
`--name <target>`, and the `st` alias, using existing target-resolution rules.
Without `--json`, `describe` prints its data as JSON, like `schema`.
Its `--json` form uses the common structured result envelope; logs and build
progress stay on stderr. In JSON mode, `list` uses a brief count in `message`
instead of repeating the catalog already in `data`. Ordinary CLI list output
remains a readable listing, using the short description.

`describe` reuses schema preparation: it can install dependencies, prepare MCP
wrappers, compile, and evaluate workflow modules when required. It returns the
manual and schemas only after successful preparation and inspection, without
invoking any workflow's `run`. It is not a side-effect-free metadata read.
`list` remains free of build/module execution. See
[runtime enforcement](RUNTIME.md#workflow-description-enforcement).

The authoring skill teaches agents to select from `list` and fetch `describe`
when the current manual/schema is not already available before execution.
`run` does not require proof of a preceding `describe` call: ordinary scripts
and callers with the contract already in context remain valid. This flow is
guidance, not an authorization or safety gate; enforce critical constraints
in code. See the [migration and authoring guidance](SPEC.md#workflow-description-migration-and-authoring)
for the breaking manifest and list-output changes.

## Managed SDK version

The SDK used for execution must exactly match the running CLI version. Before `build`, `describe`, `schema`, or `run` reuses prepared artifacts, Stratos checks the selected root's SDK and uses npm to install the exact matching version if missing or different. An SDK change invalidates the root's builds; installation failure stops preparation. This synchronization is automatic and lazy per root, including when an older CLI is used. Updating a globally installed CLI does not immediately update every workflow root. `list` performs no SDK installation.

## Cleaning generated artifacts

```sh
stratos clean
stratos clean review-pr
stratos clean --name review-pr
```

`clean` without a target removes Stratos-generated artifacts for all workflows in the current project root, including leftovers belonging to deleted workflows. Targeted cleanup removes the selected workflow's generated artifacts. Both forms support `st` and the standard target-resolution rules.

Remove generated workflow/MCP wrappers, compiled `dist/` output, and build-status records. Preserve authored files, installed dependencies (including the shared Stratos SDK), and credentials. Targeted cleanup invalidates dependent builds so compiled copies of a removed wrapper cannot remain usable as current artifacts. The next `build`, `describe`, `run`, or `schema` regenerates required artifacts. Project-wide cleanup does not include the user discovery root automatically.

## Output formatting

Use readable text by default for listings and command reports, with `--json` available for structured output. Do not require agents to consume JSON for simple listings. Schema documents and workflow results retain their natural JSON representation in default output; with `--json`, they appear inside the common response envelope's `data` field.

```sh
stratos list
stratos list --json
stratos build review-pr --json
stratos mcp list --json
```

Structured output must remain parseable. In JSON mode, structured results and errors go to stdout; logs and progress go to stderr. Text mode renders diagnostics readably. Ordinary output does not require stack traces or internal runtime details.

### Diagnostics and exit codes

- Success exits with code `0`.
- Warnings without errors also exit with code `0`.
- Failure exits with code `1`.

Diagnostics have a stable `code` and a readable `message`, including correction guidance where possible. Optional `file` and `line` fields identify a known source location. There is no `column` field.

### Common command result

All commands use one result model, rendered by a shared formatter as readable text or JSON:

```ts
type Diagnostic = {
  code: string;
  message: string;
  file?: string;
  line?: number;
};

type CommandResult<T = unknown> = {
  success: boolean;
  message: string;
  data?: T;
  errors?: Diagnostic[];
  warnings?: Diagnostic[];
};
```

`success` and `message` are required. Other fields are optional and omitted when unnecessary; commands need not expose granular internal steps. A simple report can be:

```json
{
  "success": true,
  "message": "Generated artifacts cleaned."
}
```

Commands add structured `data` where useful. Listings can supply workflow entries, project-wide builds can supply per-workflow results, `schema --json` places the input/output schemas in `data`, and `run --json` places the workflow's output in `data`. The envelope does not change workflow or SDK return values. Commands that need to convey actual data must still do so; the minimal message-only form is suitable for simple reports.

Failures use the same envelope. For example, `stratos run --json` without
a workflow target returns:

```json
{
  "success": false,
  "message": "Command failed.",
  "errors": [
    {
      "code": "CLI_ERROR",
      "message": "run requires a workflow name or directory path"
    }
  ]
}
```

Warnings alone do not make `success` false. For project-wide builds, any failed build makes the overall command unsuccessful. Exit codes remain `0` for success and `1` for failure. In JSON mode emit the common result on stdout and keep logs/progress on stderr.

## Workflow authoring build

`build` performs validation and preparation; any failure fails the build.

Build a selected workflow and its required dependencies, or omit the target to build every workflow in the current project's discovery root:

```sh
stratos build review-pr
stratos build --name review-pr
stratos build
```

A project-wide build continues processing independent workflows after a failure and reports all results. Exit `1` if any build fails, otherwise `0`. A failed required dependency prevents its dependents from building successfully. The no-target form is project-root scoped; it does not include user-level workflows automatically. All forms also work with `st`.

Run a build after creating or changing a workflow. Checks cover the workflow
definition and configuration, TypeScript types, Zod/JSON Schema contract, and
the [supported safety checks](RUNTIME.md#workflow-safety-and-resource-validation).
Building does not invoke the workflow's `run` function and does not prove that
arbitrary code will terminate or behave correctly.

The build command installs required dependencies, generates required workflow and referenced/MCP wrappers, and type-builds as needed so dependency and preparation failures are included in its diagnostics. It uses the existing hash-based freshness and artifact-reuse rules. Building does not execute workflow business logic.

**Ollama authoring checks:** Every explicit build validates all native model IDs
declared with `provider: ollama` in named `agents` and `decision` YAML settings,
including each member of an ordered agent model list. This runs before that
workflow's dependency/MCP preparation and before reusing a cached build.
Required child builds perform the same check. The selected server must list
the model as local, with `completion` + `tools` capabilities for agents or
`decision` for the decision primitive. Agent context/output metadata must also be valid.
Missing models or an unavailable server fail the build with
`stratos provider status ollama --json` guidance. Model checks never pull/load a model
or execute a workflow body; successful checks are metadata evidence only.

Agent checks use `OLLAMA_HOST` or `http://127.0.0.1:11434`. Decision uses
explicit `baseUrl` > `OLLAMA_HOST` > the same localhost default, matching runtime
and preserving any explicit URL path prefix. Invalid selected endpoints fail
without fallback. To diagnose a Decision server with provider status, select
that server's origin in `OLLAMA_HOST`; status itself
accepts origins, not path prefixes. Dynamic creation-time settings and invocation
overrides cannot be certified from YAML; declare provider/model defaults in
YAML for authoring checks. A declared Ollama provider without a model still
checks server metadata, but does not guess the model supplied later.
`list` and implicit builds for `describe`/`schema`/`run` do not
perform this YAML-only network validation. Existing runtime checks still apply
to effective settings, so a YAML default does not block an invocation override.
This intentionally makes explicit authoring builds stricter than runtime
ordered-candidate selection: **every declared candidate must be installed**.

**MCP authoring flow:** An explicit
`stratos build <workflow>` prepares wrappers for all MCP servers declared in
that workflow's `workflow.yaml`, even without imports or an entrypoint file.
No separate MCP preparation command is needed. It reuses valid credentials,
refreshes them under the existing OAuth policy, or requests browser sign-in
when required for an OAuth-configured server. Authentication or discovery
failure fails preparation; existing sign-in timeouts and manual-credential
requirements remain unchanged. A sign-in prompt is written to stderr before
opening the browser, keeping JSON results parseable.

Build lists the tools available to the authenticated user and generates
`generated/mcp/<server>.ts` without calling tools. With no entrypoint yet, it
reports successful MCP preparation, not a compiled or runnable workflow; it
must not record a successful workflow build. The author then uses the stubs
in workflow code and builds again to compile/check it. `run`, `describe` and `schema`
still require the workflow definition.

The build result's `data` contains `status: "prepared" | "built"` and `wrappers`
(the generated MCP source paths). Project-wide results include these fields for
each successful workflow; preparation-only entries are counted separately from
compiled workflows.

**MCP freshness:** Every explicit build
rediscovers tools and regenerates stubs for the configured MCPs, even when
authored files and existing build hashes are unchanged. A cached build must
not bypass this step. Authentication or discovery failure fails the build,
rather than reporting success using stale stubs. When workflow code exists,
changed stubs must be reflected in its compilation/type checking before
build success. This verifies current discovery access and schema compatibility,
not tool execution permissions or future server availability.

Build-time refresh is distinct from still-unimplemented active-request renewal;
see [MCP authentication](./SPEC.md#mcp-connections-and-authentication).

Detected direct workflow recursion and indirect workflow call cycles are
errors, not warnings. Static inspection is not a general proof of safety or
termination; runtime cycle checks and agent limits also apply.

## MCP configurations and connections

```text
stratos mcp list
st mcp list
```

Lists all MCPs found in workflows discovered under `./.stratos/workflows/` and `~/.stratos/workflows/`, reading their definitions from `workflow.yaml`. Connection ownership is described in [SPEC.md](./SPEC.md#mcp-connections-and-authentication).

List entries are qualified by workflow name, for example:

```text
github (review-pr)
github (release)
slack (release)
```

In JSON mode, `data` is an array of entries with `name`, `workflow`, `path` and
`type`. Bare `stratos mcp` fails with command guidance; use `stratos mcp --help`
for help. Numbered or interactive selection is not supported.

### MCP authentication

```text
stratos mcp login --name <server-name>
st mcp login --name <server-name>

stratos mcp login --name github
stratos mcp login --name github --workflow review-pr
```

Authenticates with the named MCP server found in the discovered workflow definitions and stores the resulting credentials for subsequent use. Workflow execution must also detect missing required MCP credentials and launch interactive authentication.

For manually supplied OAuth client secrets, the first discovered authorization
server is trusted automatically and remembered for that MCP URL and client ID.
No extra URL or confirmation is required. The binding is retained even if the
sign-in fails. If a later discovery advertises a different server, authentication
stops before reusing credentials. After verifying an intentional change, run
`stratos mcp logout --name <server-name>` followed by
`stratos mcp login --name <server-name>` to trust the new server. Use the same
`--workflow` selector for both commands when needed.

### MCP logout

```text
stratos mcp logout --name <server-name>
st mcp logout --name <server-name>

stratos mcp logout --name github
stratos mcp logout --name github --workflow review-pr
```

Removes the locally stored credentials for the named MCP server. Remote token revocation is a separate operation where supported, as described in [SPEC.md](./SPEC.md#mcp-credential-storage).

Use `--workflow <workflow-name>` to select the workflow whose MCP configuration should be used for login or logout. The shorter form is allowed when the server name resolves unambiguously. If ambiguous, report the matching workflow-qualified entries and require an explicit selector; do not choose silently. If the workflow name itself is ambiguous across discovery roots, list matching workflow directory paths and require an explicit path, without interactive selection.

## Workflow console logs

Workflow scripts use native Node.js `console` output, captured to a `.log`
file separately from agent events. There is no `--log-level` flag or custom
level filtering. See [run artifacts and retention](TELEMETRY.md#default-local-logs-and-agent-events).
