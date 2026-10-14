---
title: Getting started
permalink: /getting-started/
---

# Getting started

This guide gets Stratos installed and explains where your workflows live.
You do not need a model account, an MCP server, or a local model to get started.
The first workflow uses ordinary TypeScript so you can learn the build-and-run
cycle before adding external services.

## Install Stratos

Use macOS or Linux with **Node.js 24 or newer**. The latest Node 24 LTS update
is the recommended baseline. Check your version, then install the scoped npm
package:

```sh
node --version
npm install --global @stratoscli/stratos
stratos --version
stratos run --help
```

`st` is a short alias for `stratos`; both accept the same commands. The
unscoped package named `stratos` is a different project.

The CLI prepares TypeScript builds and manages the matching Stratos SDK for
your workflows. You do not need a global TypeScript installation or a
workflow-specific `tsconfig.json`.

## Choose a workspace

Run commands from the directory where you want the work to happen. Stratos
looks for workflows in two places:

| Location | Use |
|---|---|
| `.stratos/workflows/` in the current directory | Workflows shared with this project |
| `~/.stratos/workflows/` in your home directory | Personal workflows available across projects |

For example, a workflow named `greet` can live at
`.stratos/workflows/greet/`. That directory contains its manifest
(`workflow.yaml`) and TypeScript entrypoint (`workflow.ts`).

```sh
stratos list
```

An empty list is normal before you create any workflows. Listing is read-only:
it does not build code, connect to tools, or run workflows. Discovery uses the
current directory, not the nearest Git root. Names must be unique within each
workflow root; use an explicit directory path if a name exists in both roots.

## Create your first workflow

Continue with [Author a workflow](authoring.md). It walks through creating the
two files, checking the input/output contract, and running a greeting example.
The basic cycle is:

```sh
stratos build greet
stratos describe greet
stratos run greet --input '{"name":"Ada"}' --json
```

Run these after creating the example. `build` reports configuration and type
errors before execution; `describe` shows usage instructions and the data the
workflow accepts and returns; `run` executes it. Use `schema` for schemas alone.
`describe`, `schema` and `run` can build automatically when
needed, but an explicit build is useful while authoring.

### Work with a coding agent

You can write the files yourself or ask a coding agent to do it. The bundled
authoring skill teaches agents to discover existing workflows, inspect their
contracts, build, correct errors, and check results.

Install it for the agent you use, for example:

```sh
stratos skill install --agent codex
stratos skill status --agent codex
```

Supported skill targets include Claude Code, Codex, Gemini CLI, Cursor, Copilot,
and OpenCode. Installing guidance for an agent is different from selecting an
execution harness inside a workflow. Reload your agent's skills if necessary,
then ask it to create a Stratos workflow for your task.

Installation is optional: `stratos --help` includes the bundled guidance.
See [skill management](reference/CLI.md#global-authoring-skill) for target directories,
updates, and removal.

## Add models and tools when you need them

A code-only workflow needs no provider credentials. Before adding an agent,
configure its native harness and model access. Stratos supports Claude Code,
Codex, and OpenCode; Ollama-backed agents require an installed compatible
local model and an explicit Codex or OpenCode harness.

Decision model calls use Jev credentials or a compatible Ollama decision model.
MCP tools require a server configuration and whatever authentication that
server expects; OAuth sign-in may open a local browser. These are separate
integration choices, not prerequisites for every workflow.

Before giving an agent tools, inspect its harness's built-in tool names without
starting a session or providing credentials:

```sh
stratos tools list
stratos tools list codex --json
```

The target is `claude-code`, `codex`, or `opencode`, not a model provider.
Use `allowedTools` and `disallowedTools` to filter built-in tools, and
`allowedMcps` to select workflow MCP servers. These are separate controls with
[harness-specific limits](primitives.md#choose-an-agents-tools), not a sandbox.

The [primitives guide](primitives.md) explains when to use each building block.
The [composition examples](composition.md) show how to combine them.

## Know the execution boundary

Stratos runs trusted code with the invoking process's permissions. It is
**not a sandbox**. Agents approve remaining tools by default, and tools can change files,
contact services, and incur charges. Inspect shared workflows and their
dependencies before building or running them.

Runs write local logs and events; optional traces can include prompts and tool
data. Keep that evidence private unless reviewed for sharing. Repeating a run
starts a new execution, not a durable resume, and can repeat completed side
effects. See [telemetry](reference/TELEMETRY.md) and
[runtime limitations](reference/RUNTIME.md#current-limitations).

Stratos is early-stage software licensed under AGPL-3.0-only. These docs follow
`main`, which may be newer than your installed release. To work on Stratos
itself rather than author a workflow, use the
[contributor guide](../CONTRIBUTING.md).
