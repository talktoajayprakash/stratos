---
title: Primitives
permalink: /primitives/
---

# Primitives

Stratos provides a few building blocks that compose through ordinary TypeScript.
Their inputs and outputs are typed, failures are catchable, and the workflow
owns the resources they create. Use the smallest building block that fits the
task rather than asking an agent to handle every step.

| Primitive | Detailed documentation |
|---|---|
| Workflows and children | [Contracts and composition](reference/RUNTIME.md#nested-workflow-execution) |
| Agents | [Configuration, conversations, and lifecycle](reference/RUNTIME.md#configured-agent-objects) |
| MCP tools | [Setup and typed calls](mcp.md) |
| Decision | [Questions, schemas, providers, and retries](reference/DECISION.md) |

Logs, events, trace export, and measurements for every primitive are covered
in [Telemetry](reference/TELEMETRY.md).

## API at a glance

The similar-looking factories have different lifecycles. Create execution
objects inside a workflow's `run` function and await their work before returning.

| API | Result | Reuse |
|---|---|---|
| `workflow({input, output, run})` | A workflow definition, default-exported by its entrypoint | Run through the CLI or a generated child wrapper |
| `createAgent(options)` | An agent; `execute(prompt, variables?)` returns text or schema-typed output | One conversation; sequential calls only |
| Generated child factory `createChild({overrides}?)` | A child reference; `execute(input)` returns the child's output | A fresh invocation per call; parallel calls allowed |
| Generated MCP factory `await createServer()` | A ready client with typed tool methods | Reuse its connection; concurrent calls allowed |
| `decision({state, questions, ...settings})` | A promise of typed answers and usage | Each call is a separate decision request |
| `choice`, `score`, `noul` | Typed question objects | Pure builders, with no network call or execution context |

Named agent and Decision settings live in `workflow.yaml`. Explicit settings
in code take precedence over invocation overrides, which take precedence over
the named YAML settings. Unspecified fields retain their lower-priority values;
arrays replace rather than append. See
[configuration precedence](reference/RUNTIME.md#named-agent-configurations) and
[Decision settings](reference/DECISION.md#credential-sources).

## Workflows and child workflows

A workflow is a reusable function with a Zod input/output contract and a
`workflow.yaml` manifest. The TypeScript module default-exports
`workflow({input, output, run})`; `run` holds the actual work.

Use strict object inputs and describe every input/output field. Stratos derives
TypeScript types and JSON Schema from the same declarations, validates values,
and compiles the workflow before running it. Keep actions inside `run`, because
preparation evaluates modules to read their schemas.

A parent can call smaller workflows through generated, typed wrappers:

```typescript
import createGreet from '../.generated/greet.js';

// Inside the parent workflow's run function:
const greet = createGreet();
const result = await greet.execute({name: 'Ada', loud: true});
```

This uses the greeting workflow from the
[complete first-workflow example](authoring.md).
Build the parent to prepare the child and its wrapper; do not write generated
files yourself.

Each call starts an independent child invocation with its own configuration,
validation, and cleanup. Children must be in the same discovery root. Parent
configuration does not leak into a child; bind overrides explicitly when needed.
Parallel calls are allowed, while calling an active ancestor is rejected.

Read the [complete child example](composition.md#child-workflows)
and [composition contract](reference/RUNTIME.md#nested-workflow-execution).

## Agents

Use an agent when a task needs a conversation, reasoning, or a sequence of tool
actions. Stratos integrates Claude Code, Codex, and OpenCode through a common
`createAgent` interface.

```typescript
import {createAgent} from '@stratoscli/stratos';

// Inside run, using a named agent configuration in workflow.yaml:
const reviewer = createAgent({configId: 'reviewer'});
const review = await reviewer.execute('Review the changes in this workspace.');
const summary = await reviewer.execute('Summarize the main findings.');
```

The example requires a `reviewer` entry in the manifest and working native
harness/provider authentication. See the
[complete configured agent example](composition.md#agents)
before running it; reviewing a workspace can involve real tool calls.

Creation is synchronous and native initialization happens on first execution.
Reusing one object continues its conversation sequentially. Separate objects
have separate conversations and can run in parallel. An agent's model, harness,
system prompt, tools, and other settings remain fixed; only its user prompt
and variables change between requests.

Without an output schema, `execute` returns text. Supply `outputSchema` with a
Zod schema to request and validate structured output. Stratos does not repair
arbitrary prose into an apparently successful result.

Workflow cleanup releases owned resources. Cancellation is a signal, not proof
that all work has stopped; see the [native lifecycle limits](reference/RUNTIME.md#public-lifecycle-controls).

### Choose an agent's tools

An agent's harness supplies built-in tools such as shell execution and file
editing. These are separate from the external tools provided by MCP servers.
First inspect the names supported by the harness you intend to use:

```sh
stratos tools list
stratos tools list opencode
stratos tools list codex --json
```

These commands read Stratos's tool catalog without starting a harness or
requiring credentials. The target is the **harness**, not the model provider.
Use the returned names exactly: some are shared names such as `shell`, while
others are harness-specific, such as Claude Code's `NotebookEdit`.
The [CLI reference](reference/CLI.md#agent-built-in-tool-names) explains the output.

Use `allowedTools` when you want to keep a small set of built-in tools. For
example, this named configuration retains OpenCode's file-reading and search
tools while removing its other mapped built-in tools:

```yaml
agents:
  reviewer:
    harness: opencode
    model: [openai/gpt-6-astra]
    allowedTools: [read, glob, grep]
    allowedMcps: []
```

Add the entry under `agents` in your workflow's manifest and use it with
`createAgent({configId: 'reviewer'})`. The model is an example; configure
working harness/provider access before execution.

Use `disallowedTools` instead when you want to keep the defaults except for
selected tools, for example `disallowedTools: [shell, web_search]`. If both
lists are present, denial wins: a name in both lists is removed.

| Setting | Effect |
|---|---|
| Both built-in lists omitted | Keep the harness's default built-in tools |
| `allowedTools: [...]` | Remove mapped, removable tools not in the list |
| `allowedTools: []` | Remove every mapped, removable built-in tool, not necessarily every tool |
| `disallowedTools: [...]` | Remove the listed tools; `[]` removes none through this list |
| `allowedMcps: [...]` | Select workflow-defined MCP servers independently; `[]` selects none |

The same fields work in `createAgent` and invocation overrides. Explicit code
settings win over overrides, which win over YAML. Each list replaces the
lower-priority value of that field rather than appending; overriding
`allowedTools` does not clear an inherited `disallowedTools`. Selection stays
fixed for that agent object.

**Tool selection only removes tools; it does not grant new capabilities or
provide a sandbox.** A listed tool that the harness leaves off stays off.
Unknown names fail validation, while a known name absent from the selected
harness has no effect.

Pay attention to the catalog's always-on tools and the harness-specific limits.
Codex's `edit` and `write` cannot be removed with these lists. OpenCode must keep
or exclude `edit` and `write` together. On Claude Code, excluding `shell`
does not exclude the separate `Monitor` tool, which can also run commands.
Tools outside Stratos's mappings are not filtered, and structured-output
delivery remains available.

Remaining tools are approved by default. Use
[control hooks](reference/RUNTIME.md#agent-hooks) when you need to inspect arguments,
deny a particular call, or modify its inputs. Read the
[full selection contract and harness mappings](reference/RUNTIME.md#agent-built-in-tool-selection)
before relying on a restriction.

## MCP tools

Use direct MCP clients when code knows which tool to call and does not need a
model to select it. Put server configuration in `workflow.yaml`, then run
`stratos build <workflow>` to discover tools and generate typed wrappers.
Explicit builds can prepare these wrappers before the entrypoint exists.

```typescript
import createCatalog from './generated/mcp/catalog.js';

// Inside run, after discovery of a tool with this contract:
const catalog = await createCatalog();
const response = await catalog.lookup({key: 'example'});
```

`catalog` and `lookup` are illustrative: use the actual configured server and
discovered tool signature, not assumed endpoints or methods. Follow the
[MCP tool guide](mcp.md) for setup,
authentication, generated types, and a complete workflow.

The awaited factory returns a ready client owned by the workflow. Tool calls
reuse that connection and may run concurrently. Results retain the MCP envelope;
a declared output schema types and validates `response.structuredContent`.
Without a declared schema, validate unknown data before using it.

Tool errors and transport failures throw. Requests have a five-minute timeout
and are not automatically retried, since replaying a tool can repeat side
effects. Agents use their harness's MCP connections instead of these direct
clients.

## Decision

Use `decision` for structured decisions rather than a full agent conversation.
Jev and compatible local Ollama decision models expose the native
`/v1/systemone` API. Focused decisions can reduce cost and latency while letting code retain
control of the larger automation.

| Helper | Question | Answer |
|---|---|---|
| `choice` | Which option fits? | Selected option, probabilities, and confidence |
| `score` | Where does this fall on ordered levels? | Numeric score, which can be fractional |
| `noul` | How likely is this condition to be true? | Probability in `[0, 1]`, not a boolean |

The helpers only build questions. `decision` makes the request:

```typescript
import {choice, decision} from '@stratoscli/stratos';

// Inside run, using a named Decision configuration:
const result = await decision({
  configId: 'classifier',
  state: 'I need help with an invoice.',
  questions: {
    category: choice('What kind of request is this?', {
      billing: 'Payments, invoices, or refunds',
      technical: 'Broken functionality or setup',
    }),
  },
});
const category = result.answers.category.choice;
```

Configure `decision.classifier` with the intended provider, model, and
credential reference before running this code. The
[complete Decision example](composition.md#decision)
includes the manifest and workflow contract.

Several independent questions can share state in one request. If a later
question depends on an earlier answer, make another call. Workflow code owns
thresholds and routing; Stratos preserves validated provider answers rather
than recalculating them. Compatible response shapes do not promise identical
accuracy or confidence calibration across models.

Read the [Decision reference](reference/DECISION.md) for provider requirements,
input/output schemas, and retries, and
[Telemetry](reference/TELEMETRY.md#decision-measurements) for its measurements.

## Ordinary code

Use functions, loops, conditions, `Promise.all`, and `try`/`catch` to connect the
primitives. No additional graph language or public parallel helper is needed.
For example, a workflow can classify a request with Decision, select a child
workflow, call a tool, and invoke an agent only for the part requiring reasoning.

Await owned work before returning. Catch expected failures where the workflow
can genuinely recover; do not hide failures behind empty successful values.
An unhandled error fails the invocation and triggers cleanup. Whole-workflow
retry and crash resume are not automatic, so starting again can repeat completed
side effects.

See [error and cleanup contracts](reference/RUNTIME.md#primitive-error-contract) and
[the design philosophy](../DESIGN_PHILOSOPHY.md).
