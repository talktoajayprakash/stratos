# Vision

Stratos aims to make workflow automation faster, more cost-efficient, and more
reliable by composing reusable workflows, agents, decision models, and tools
in code.

## Why Stratos

Skills are useful for teaching agents how to perform tasks. But asking a
general-purpose model to reason through every step on every run adds cost and
uncertainty to work that could be expressed in code. The model's judgment is
more useful where the task genuinely needs it.

Stratos captures that orchestration as executable workflows, combining LLMs,
coding agents, structured decisions, tool calls, and ordinary code logic.
Lower cost, faster execution, and greater reliability are goals to validate,
not claims of results already achieved.

Stratos must be conservative with token usage, adding only the context needed for correct execution and avoiding redundant instructions or unnecessary context growth.

## Composability: build large workflows from small ones

Agents can compose a large workflow from smaller, reusable workflows instead
of starting from scratch each time. Each workflow has a clear input and output
contract and can serve as a building block in a larger automation.

Code connects those building blocks: passing results between steps, choosing
which workflow to invoke, and running independent work in parallel. This lets
agents reuse established workflows and assemble more capable automations while
keeping individual pieces focused, understandable, and independently testable.

See [workflow composition](docs/reference/RUNTIME.md#nested-workflow-execution) for the current
execution contract.

## Decision: capable automation beyond LLMs

Not every decision needs a general-purpose LLM or a full agent conversation.
Stratos integrates decision models such as Jev through a structured decision
API for tasks such as classification, scoring, and evaluating conditions.

For focused decisions, these models can reduce cost and latency compared with
using a general-purpose LLM or agent loop for every step. Workflows can combine
their efficient decisions with LLM reasoning, agent actions, tools, and code
to create capable automations, choosing the right kind of model for each task.

For example, a workflow can use Jev to classify a request, route it to a
specialized child workflow, and invoke a coding agent only when the task needs
one. The decision model supplies the answer; workflow code controls what happens next.

See the [Decision API](docs/reference/DECISION.md) for supported providers and decision
types.

## Workflows authored and improved by agents

Coding agents can author the workflows themselves. Stratos gives them tools
to discover existing workflows, inspect their contracts, write new ones, run
them, and use execution evidence to improve the saved code.

The authoring format, configuration, and primitives should be straightforward
for coding models to understand and generate.

With the right context, any capable coding model should be able to write Stratos
workflows. Each workflow can use different models, including smaller local
models, to suit its tasks.

A coding agent can run a workflow, inspect its results, revise its code and
configuration, and repeat. Stratos supplies reusable execution and observation
tools, not an automatic self-improvement loop or cross-run conversation memory.

## Core primitives and generic abstractions

Stratos defines core primitives for composing workflows, running agents through
coding harnesses, making structured decisions, and calling tools alongside
ordinary code logic.

The system must remain agnostic to any specific harness or model. Shared
contracts across the CLI, SDK, runtime, configuration and telemetry allow
workflows to use different harnesses, models and MCP clients without tying
their orchestration to one implementation.

## Requirements

### Platforms

Stratos targets macOS and Linux with Node.js 24 or newer. Headless deployment
is not a supported target; interactive MCP sign-in requires a local browser.
MCP credential storage is defined in [SPEC.md](docs/reference/SPEC.md#mcp-credential-storage).

### CLI access and agent guidance

An easily installed CLI should make the workflow lifecycle accessible to both
people and agents. Discovery, schema inspection, build diagnostics, execution,
and run evidence support an explicit author-and-improve cycle.

The bundled, installable skill teaches agents what Stratos is, how workflows
fit together, and how to use the CLI.

Authors check existing names before creating or renaming a workflow. Stratos
rejects duplicates within a discovery root instead of choosing one silently.

Build setup belongs to Stratos, keeping the authored files focused on the task.
Stratos owns compiler settings and supplies `tsc` flags; workflows do not need
an authored `tsconfig.json`.

After creating or changing a workflow, authors run
`stratos build --name <workflow-name>` and use its diagnostics to correct issues.
They then verify the behavior, not merely the build.

### Environment and runtime management

The CLI must make it easy to set up the environment and manage all aspects of the runtime. This includes setting up authentication for MCP integrations, harnesses, and model providers.

### Standard workflow format and discovery

Workflows must follow a standard, well-defined format so that agents can easily author and run them. Each workflow is a directory containing `workflow.yaml` metadata and its entrypoint module.

The CLI must discover workflows in standard locations, similar to skills:

- `./.stratos/workflows/` — workflows available in the current directory.
- `~/.stratos/workflows/` — workflows available to the user across directories.

These locations provide both local and user-wide discovery through the CLI.

## Vision and implementation

This document records product goals, not performance guarantees or a release
roadmap. [README.md](README.md) lists current capabilities and limitations.
[SPEC.md](docs/reference/SPEC.md) and [RUNTIME.md](docs/reference/RUNTIME.md) describe the public contracts;
[DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) explains their decisions and rationale;
[CONTRIBUTING.md](CONTRIBUTING.md#testing) describes verification requirements.
