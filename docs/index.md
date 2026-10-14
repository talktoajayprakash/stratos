---
title: What is Stratos?
permalink: /
---

# What is Stratos?

Stratos is an open-source platform for **agents to author, use, and manage
reusable workflows**. An agent can capture a procedure in TypeScript, run it
again, and compose it with other workflows instead of figuring out every step
from scratch each time. Any agent can reuse a workflow, just like a skill.

An agent is useful when a task needs reasoning or exploration. But not every
step needs a model to decide what happens next. Fetching known data, passing a
result to another task, or choosing a branch from a validated answer can be
ordinary code. Stratos lets you combine both approaches: **code coordinates the
work; models contribute where judgment is needed.**

Small workflows become building blocks for larger ones. One agent might create
a workflow that summarizes a document. Another can reuse it in a research
workflow, and a third can include it in a weekly-report workflow without
rewriting its implementation. The useful procedure lives in shared code, not
only in the conversation that produced it.

## What is a workflow?

A workflow is a program that **takes input, performs a task, and returns a
result**. Its input and output have explicit schemas, so callers know what to
provide and what to expect.

For example, an agent could create an issue-intake workflow that accepts a bug
report, classifies the issue, gathers relevant context through a tool, and asks
a coding agent to prepare an engineering brief when investigation is needed. The
workflow's code decides how those steps connect and what result to return.

Unlike a prompt describing a procedure, a workflow makes that procedure
executable. You can inspect it, test it with representative inputs, and run the
same coordination logic again. Model answers can still vary; putting the
surrounding steps in code does not make a model infallible.

In Stratos, a workflow lives in a directory with a `workflow.yaml` file for its
name and configuration, and a `workflow.ts` entrypoint for its schemas and
`run` function. It does not have to use an agent at all: a workflow can be
ordinary code, a single model decision, or a combination of many steps.

## How do agents author and share workflows?

Agents are not only steps that workflows invoke: they can be the authors and
callers of workflows too. Stratos provides CLI commands and an authoring skill
so a coding agent can work through the whole lifecycle:

1. **Discover and reuse.** Find available workflows, inspect their input and
   output contracts, and run one that already fits the task.
2. **Author and compose.** When the task needs something new, write a workflow
   or combine existing ones into a larger automation.
3. **Verify and maintain.** Build the workflow, correct errors, check its
   results, and use run evidence to revise the saved code.

Workflows are files rather than private agent state. Agents with access to the
same project's `.stratos/workflows/` directory can discover and reuse the same
workflows. The user-wide `~/.stratos/workflows/` directory makes workflows
available across projects to agents running as that user. Sharing a workflow
shares its code and contract, not the conversation that authored it.

People can inspect, edit, and run workflows too, but do not need to hand-author
each one. With the right context, any capable coding model should be able to
use Stratos. The [getting-started guide](getting-started.md#work-with-a-coding-agent)
explains how to give an agent the bundled authoring guidance.

## Why use Stratos?

### Reuse a task without repeating its instructions

Once a task is a workflow, another agent or workflow can reuse its
input and output contract rather than reproduce its internal steps. That makes
it possible to assemble larger automations from focused pieces that can be
understood and tested separately. TypeScript checks how those pieces fit
together, and Stratos validates their inputs and outputs at runtime.

### Keep predictable work in code

Use familiar functions, conditions, loops, and `Promise.all` to coordinate
work. If you already know which tool to call, code can call it directly through
a typed MCP client; MCP connects applications to external tools and data.
Use an agent when the next steps require reasoning or exploration. You do not
need to put the whole automation inside one long agent conversation or learn a
separate graph language.

### Use more than one kind of intelligence

Not every judgment needs a general-purpose LLM. Stratos's **Decision API**
integrates models such as Jev for focused decisions: choosing a category,
assigning a score, or estimating whether a condition holds. A workflow can use
one of these decisions to route a request, then invoke a coding agent only for
the branch that needs deeper reasoning.

This can reduce cost and latency compared with using a full agent conversation
for every decision. The benefit depends on the task and model; it is not a
performance guarantee. Stratos also supports local models through Ollama and
agents through Claude Code, Codex, and OpenCode. You choose the models and
configuration appropriate to each step.

### See what happened during a run

Stratos records local logs and agent events. Optional OpenTelemetry traces
connect a parent workflow with its child workflows, model requests, and tool
calls, helping you follow execution across the automation rather than inspect
isolated conversations. The [telemetry guide](reference/TELEMETRY.md) explains what is
collected and how to view it.

## How do workflows compose?

Calling a workflow from another workflow is called a **child workflow**
invocation. The caller is the parent. The child keeps its own implementation
and configuration; the parent passes input and receives its result.

Suppose an agent has created a workflow named `summarize` that accepts
`{text: string}` and returns `{summary: string}`. Another agent can build a
parent named `prepare-brief` that reuses it like this:

```typescript
import createSummarize from '../.generated/summarize.js';

// Inside the parent workflow's run function:
const summarize = createSummarize();
const result = await summarize.execute({text: input.notes});
```

Here, `input.notes` is a string declared in the parent's input schema.
`result.summary` is the child's typed output, ready for the parent's next step.
The parent does not need to know whether the summary came from an agent or
another workflow.

The import points to a **typed wrapper generated by Stratos**, not to the
child's source code. Keep both workflows in the same discovery root, for example
under `.stratos/workflows/`, and build the parent:

```sh
stratos build prepare-brief
```

Stratos prepares the child and generates the wrapper automatically. The
[complete child-workflow example](composition.md#child-workflows)
shows the surrounding parent definition using the greeting workflow from the
authoring guide.

Each `execute` call starts a fresh child run with its own validation and resource
cleanup. Its result goes back to the parent; errors reject the call and can be
handled with ordinary `try`/`catch`. The same child can also run independently
from the CLI. Reuse it in a loop, call independent children in parallel, or pass
one child's result to another to build up a larger task.

## Start building

Start with [Getting started](getting-started.md) to install Stratos on macOS or
Linux with Node.js 24 or newer and make its authoring guidance available to your
coding agent. Give the agent a task and ask it to find or create a workflow for
it. [Author a workflow](authoring.md) walks through the files and build-and-run
cycle using a small example that runs without model credentials or external
tools. The [primitives guide](primitives.md) explains how workflows add agents,
tools, and structured decisions.

Stratos is early-stage software. Workflow code runs with your process's
permissions: **it is not a sandbox**. Agents and tools can change files, call
external services, and incur charges. Review code, credentials, and permissions
before running a shared workflow, and treat logs and traces as potentially
sensitive.

See [current runtime limitations](reference/RUNTIME.md#current-limitations)
before adopting it for a task. These docs follow the repository's `main` branch,
which may include changes newer than the installed npm release.
