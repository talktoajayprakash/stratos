<img src="assets/brand/stratos-icon.svg" alt="Stratos icon" width="96" height="96">

# Stratos

**A framework for agents to build, run, and improve TypeScript workflows.**

Stratos brings **agents, MCP tools, and decision models such as Jev and Clef**
together as first-class workflow primitives.

TypeScript controls the orchestration: run agents, call tools, ask decision models
for structured judgments, and use their answers to decide what happens next.
Ordinary code handles branching, loops, parallel execution, and combining results.

**Keep workflow logic independent of the harness and model.** Use Claude Code,
Codex, or OpenCode, with hosted models through providers such as OpenRouter or
local models served by Ollama. Specify a harness and model, or provide multiple
model options and let Stratos select a compatible combination available in your
environment.

Stratos is built for agents to author and use these workflows. An agent can
discover existing workflows, inspect their inputs and outputs, run them, or write
a new workflow for the task. Saved workflows can be reused and combined into
larger workflows.

Traces from previous runs give the authoring agent evidence to refine the
workflow: inspect what happened, revise the code or prompts, and run it again.
Each revision becomes a reusable workflow that can be evaluated and improved
further.

**Write a workflow once, check it into version control, and share it with your
team.** Each teammate can reuse the same workflow with their own setup to automate
recurring work.

**Early-stage software.** Stratos is licensed under **AGPL-3.0-only**.

## Why Stratos?

### Why long workflows become expensive

Skills help teams automate recurring work by giving agents reusable instructions.
But when a single agent manages the entire task, it must interpret the
instructions, choose tools, reason through their responses, and pass data between
calls. Even straightforward data transfer and processing can require another
model turn.

As workflows grow longer and involve more tools, instructions and intermediate
results accumulate in context, increasing cost and latency while making execution
harder to keep reliable.

### Scripts still need a consistent environment

Skills can offload some work to scripts, but those scripts still need an execution
environment. The agent or team has to arrange dependencies, work out how to run
them, and keep that setup consistent across machines. Sharing the instructions
and scripts alone does not make the automation portable.

### Move coordination into code

Stratos moves coordination into TypeScript and manages workflow builds and
dependencies. Code calls tools, passes data between steps, processes results, and
controls branching and execution order.

Agents handle cognitive tasks, each with its own context and a model suited to the
work. Independent agents can run in parallel, while decision models such as Jev
and Clef provide structured judgments wherever needed.

### Use the right model for each task

Teams can use agents with capable models for complex tasks, smaller or local
models for simpler tasks, decision models for structured judgments, and ordinary
code for predictable operations. Tool results flow directly through code, and each
agent receives only the context its task needs.

The workflow becomes a reusable program your team can check into version control,
run across compatible environments, and improve using traces from previous runs.
This reduces unnecessary model turns and makes long-running automation more
efficient and reliable.

## Install from npm

Use macOS or Linux with Node.js 24+ (latest Node 24 LTS recommended):

```sh
npm install --global @stratoscli/stratos
stratos --version
st --help
```

Both `stratos` and `st` expose the same commands.
The npm package also includes the TypeScript source and the inputs used by its
`build` script.

## Start from source

Clone the repository and build the CLI:

```sh
git clone https://github.com/talktoajayprakash/stratos.git
cd stratos
npm ci
npm run build
node dist/src/cli/main.js --help
```

The built CLI can be run with `node dist/src/cli/main.js`. To install the
checkout's CLI aliases locally:

```sh
npm link
stratos --version
st --help
```

`npm link` changes your local global npm links; it does not publish anything.

## Let an agent author a workflow

The bundled [workflow skill](skills/stratos-workflows/SKILL.md) teaches discovery,
authoring, build/fix/run and artifact inspection. Root `--help` includes that
same skill without requiring a global installation.

Install it for selected coding agents:

```sh
stratos skill install --agent codex,claude
stratos skill status
```

Supported targets are Claude Code, Codex, Gemini CLI, Cursor, Copilot and
OpenCode; `--all` explicitly selects all targets. These are skill-installation
targets, not a claim that every target is a workflow execution harness.
See [skill installation](docs/reference/CLI.md#global-authoring-skill) for repair/removal.

With the right context, any capable coding model should be able to write Stratos
workflows. Individual steps can use different models, including local models,
to suit their tasks. Stratos does not automatically choose a cheaper model or
translate reasoning-effort settings between incompatible providers.

A workflow lives under `.stratos/workflows/<name>/` or
`~/.stratos/workflows/<name>/`, with `workflow.yaml` and a TypeScript entrypoint.
The skill contains a complete runnable example.

```sh
stratos list
stratos build greet
stratos describe greet
stratos run greet --input '{"name":"Ada"}' --json
```

## What is available

| Capability | Current behavior |
|---|---|
| Typed workflows | Zod input/output contracts, TypeScript builds, nested workflows |
| Agents | Claude Code, Codex and OpenCode; fixed configuration and sequential conversation reuse |
| Agent tool selection | Built-in allow/deny lists, separate MCP selection, and `tools list` discovery; harness-specific limits apply |
| MCP clients | HTTP/stdio discovery, generated typed wrappers, agent allowlists and OAuth |
| Structured decisions | `decision` through Jev or compatible Ollama decision models |
| Local agents | Ollama-native model IDs with explicit Codex/OpenCode selection |
| Worktrees | Optional managed Git checkouts with dirty-state preservation |
| Observability | Local logs/events, retention and file/OTLP trace export |

Native harness authentication and provider access must be configured before
use. Integration support does not guarantee every model's task accuracy.
Malformed structured output fails validation rather than being silently
repaired.

## Examples

- [GitHub Actions security review](examples/gha-security-review/README.md):
  deterministic workflow scanning with one decision model confirmation per flagged
  file and no coding agent. Includes a sample repository; requires a Jev key
  and makes paid requests.

Inspect local Ollama readiness without installing or downloading anything:

```sh
stratos provider status ollama --json
```

Explicit builds validate declared Ollama models against the selected server.
Installation and model downloads remain user-approved actions.

## Execution and privacy boundaries

Workflow code executes with the invoking process's permissions; Stratos is
**not a sandbox**. Use trusted workflow code, dependencies and MCP servers.
Agents run noninteractively. `allowedTools` and `disallowedTools` filter mapped
built-in tools; `allowedMcps` selects workflow MCP servers separately. Remaining
tools are approved by default, and workflow hooks can deny or modify calls.
Inspect `stratos tools list <harness>` and the
[selection limits](docs/reference/RUNTIME.md#agent-built-in-tool-selection) before relying on
a restriction or running a shared workflow.

Logs, events and optional traces can contain prompts, model responses and tool
data. Keep artifacts private unless reviewed for sharing. Credential redaction
does not make arbitrary workflow content safe to publish.

There is no automatic whole-workflow retry or durable crash resume. Codex
cancellation stops the active request but may leave descendant/background work.
The inactivity watchdog and serving Stratos workflows as an MCP server are not
implemented. See the [runtime contract](docs/reference/RUNTIME.md) and
[deferred scope](docs/reference/SPEC.md#deferred-scope).

## Documentation

- [Documentation overview](docs/index.md), [getting started](docs/getting-started.md), and [author a workflow](docs/authoring.md)
- [Primitives](docs/primitives.md), [composition examples](docs/composition.md), and [MCP tools](docs/mcp.md)
- [Design philosophy and decisions](DESIGN_PHILOSOPHY.md)
- [CLI commands](docs/reference/CLI.md)
- [Workflow and agent runtime](docs/reference/RUNTIME.md)
- [Telemetry: logs, events, traces, and retention](docs/reference/TELEMETRY.md)
- [MCP and authoring contracts](docs/reference/SPEC.md)
- [Decision](docs/reference/DECISION.md)
- [Vision](VISION.md)
- [Contributor guide](CONTRIBUTING.md) and [coding-agent guidance](AGENTS.md)
- [Testing requirements](CONTRIBUTING.md#testing)

## Development

```sh
npm ci
npm run lint
npm test
```

`npm test` builds and runs Node's unit/local integration suite. Real provider
checks are opt-in and require approved credentials; ordinary CI does not make
paid requests. GitHub Actions checks Linux/macOS on Node 24, with a manual
Node 24/26 matrix.

`npm pack` builds a local installable archive without publishing. The versioned
model catalog lives in `data/models/`. Verify it against a Models.dev checkout
at the pinned source revision recorded in its `source.commit`:

```sh
npm run models:verify -- --repo /path/to/models.dev \
  --commit "$(node -p "require('./data/models/model-mapping.v1.json').source.commit")" \
  --output data/models/model-mapping.v1.json
```

Use `models:generate` with the same arguments to write a new snapshot. Review
mapping/test changes before updating the pinned revision.

The [Models catalog refresh](.github/workflows/models-refresh.yml) workflow runs
daily (or manually). It regenerates the snapshot from the latest Models.dev
revision and, when the mappings change, runs lint and tests and opens or updates
a pull request from the `automation/models-refresh` branch for review. It
requires the repository setting "Allow GitHub Actions to create and approve pull
requests".

## License

Copyright (c) 2026 Ajay Prakash.

Stratos is licensed under the [GNU Affero General Public License, version 3
only](LICENSE) (`AGPL-3.0-only`). Third-party components and data retain their
respective licenses, including the [Models.dev attribution](data/models/MODELS_DEV_LICENSE).
