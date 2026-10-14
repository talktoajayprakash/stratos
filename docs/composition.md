---
title: Composition examples
permalink: /guides/composition/
---

# Composition examples

Composition means connecting small tasks through their inputs and outputs.
You use ordinary TypeScript to decide what runs next; Stratos supplies the
validation, configuration, and resource lifecycle around each primitive.

Start with the child-workflow example below. It extends the greeting workflow
from [Author a workflow](authoring.md) without requiring credentials. The
agent and Decision examples are separate workflows and require provider
setup before execution.

## Child workflows

Keep the existing `greet` workflow and create a sibling directory,
`.stratos/workflows/greet-team/`. Create its `workflow.yaml`:

```yaml
name: greet-team
shortDescription: Greet a list of people in uppercase by reusing the greet workflow.
longDescription: |
  Requires the greet workflow in the same discovery root. Supply names to
  receive uppercase messages in input order. An empty list returns no messages.
  No credentials or external calls are needed.
version: "1"
```

Create `.stratos/workflows/greet-team/workflow.ts`:

```typescript
import {workflow} from '@stratoscli/stratos';
import {z} from 'zod';
import createGreet from '../.generated/greet.js';

export default workflow({
  input: z.strictObject({
    names: z.array(z.string().min(1)).describe('People to greet'),
  }),
  output: z.strictObject({
    messages: z.array(z.string()).describe('Greetings in input order'),
  }),
  async run(input) {
    const greet = createGreet();
    const results = await Promise.all(
      input.names.map(name => greet.execute({name, loud: true})),
    );
    return {messages: results.map(result => result.message)};
  },
});
```

From the workspace directory, build and run the parent:

```sh
stratos build greet-team
stratos list --json
stratos describe greet-team --json
stratos run greet-team --input '{"names":["Ada","Grace"]}' --json
```

The result's `data` is:

```json
{"messages":["HELLO, ADA!","HELLO, GRACE!"]}
```

The import refers to a generated wrapper, not `greet/workflow.ts`. Building
the parent builds the required child and generates the wrapper before checking
the parent's types. Both workflows must be in the same discovery root; do not
write the `.generated/` files yourself.

`createGreet()` binds the child reference without running it. Each `execute`
starts a fresh child invocation and returns its output directly, without the
CLI envelope. `Promise.all` allows independent calls to run concurrently and
preserves the input order in its result array. An empty `names` array returns
an empty `messages` array without starting a child.

The child uses its own configuration, not its parent's agent settings. You
can bind named child-agent or Decision overrides when creating the object;
see the [wrapper contract](reference/RUNTIME.md#generated-workflow-wrappers).
Repeated and parallel calls are supported, but invoking an active ancestor
workflow is an error.

## Agents

Use an agent when a step needs language reasoning or a conversation. This
example accepts text and returns a summary. Create a `summarize` directory
under the same workflow root and add this `workflow.yaml`:

```yaml
name: summarize
shortDescription: Summarize supplied text using an agent; use when the source text is already available.
longDescription: |
  Supply text and receive a model-generated summary. Configure native Codex
  authentication and an available model before execution; requests may cost
  money. The prompt requests no tools, but tool restrictions do not guarantee
  read-only execution. Repeated runs make new requests; wording may differ.
version: "1"
agents:
  summarizer:
    harness: codex
    model: [openai/gpt-6-astra]
    allowedMcps: []
    allowedTools: []
    systemPrompt: Summarize the supplied text briefly without using tools.
```

The model is an example, not a universal default. Configure an available
model/provider and working native Codex authentication, or select another
supported harness before running it. `allowedMcps: []` disables workflow MCPs;
`allowedTools: []` removes every mapped, removable built-in tool.
**This is not a tool-free or read-only guarantee:** Codex's `edit` and `write`
remain available through `apply_patch`, and unmapped tools are unaffected.
The system prompt requests no tool use but does not enforce it. Inspect
`stratos tools list codex` and read
[tool selection and its limits](primitives.md#choose-an-agents-tools)
before executing.

Create `workflow.ts`:

```typescript
import {createAgent, workflow} from '@stratoscli/stratos';
import {z} from 'zod';

export default workflow({
  input: z.strictObject({
    text: z.string().describe('Text to summarize'),
  }),
  output: z.strictObject({
    summary: z.string().describe('Short summary'),
  }),
  async run(input) {
    const summarizer = createAgent({configId: 'summarizer'});
    const summary = await summarizer.execute(input.text);
    return {summary};
  },
});
```

After configuring access, build and run it:

```sh
stratos build summarize
stratos list --json
stratos describe summarize --json
stratos run summarize --input '{"text":"The release adds CSV export. PDF export is still being investigated."}' --json
```

The output contains a model-generated `summary`; wording is not deterministic
and the request may incur charges. Creation is synchronous, but the first
execution initializes the harness. A later `execute` on the same object
continues that conversation. Unlike a child-workflow object, one agent object
cannot accept overlapping calls: use separate agents for parallel work.

This workflow also meets the `{text}` to `{summary}` contract used in the
[Overview's composition example](index.md#how-do-workflows-compose).
The parent need not know which harness produced the summary.
For typed agent answers, prompt templates, restrictions, or local models,
use the [agent reference](reference/RUNTIME.md#configured-agent-objects).

## Decision

Use a structured decision when you need a category or score rather than a
conversation. Create `.stratos/workflows/classify-request/` with this manifest:

```yaml
name: classify-request
shortDescription: Classify a request as billing or technical using a structured model decision.
longDescription: |
  Requires JEV_API_KEY. Supply request text and receive a billing or technical
  category. Each run sends the text to Jev and may incur charges; only send
  authorized data. Model decisions may vary and provider failures propagate.
version: "1"
decision:
  classifier:
    model: jev-1.13.0
    apiKey: "{env:JEV_API_KEY}"
```

Create `workflow.ts`:

```typescript
import {choice, decision, workflow} from '@stratoscli/stratos';
import {z} from 'zod';

export default workflow({
  input: z.strictObject({
    text: z.string().describe('Request to classify'),
  }),
  output: z.strictObject({
    category: z.enum(['billing', 'technical']).describe('Selected category'),
  }),
  async run(input) {
    const result = await decision({
      configId: 'classifier',
      state: input.text,
      questions: {
        category: choice('What kind of request?', {
          billing: 'Payments or refunds',
          technical: 'Broken functionality',
        }),
      },
    });
    return {category: result.answers.category.choice};
  },
});
```

Provide `JEV_API_KEY` privately through the environment before execution.
Then:

```sh
stratos build classify-request
stratos list --json
stratos describe classify-request --json
stratos run classify-request --input '{"text":"I need help with a refund."}' --json
```

The intended category is `billing`, but this is a model decision, not a
guaranteed answer. `choice` constructs the question; `decision` makes the
request. Code can use the selected category to choose a child workflow or
decide whether to invoke an agent.

You can select a compatible installed Ollama decision model through
configuration instead. The [Decision reference](reference/DECISION.md) explains
provider setup, other question types, probability semantics, and portability
limits. Changing providers does not guarantee equivalent decisions.

## Handle results and failures deliberately

All three examples return domain data from `run`. Agents, children, Decision,
and direct MCP tools throw or reject on failure; they do not return a successful
placeholder result. Catch a failure only where your workflow has a defined
recovery behavior. Otherwise let it propagate so the run reports failure and
cleans up owned resources.

Await work before returning. A handled child error does not fail its parent;
an unhandled parent error cancels active descendants. Cleanup does not undo
completed side effects, and a rerun is not an automatic resume.

For an end-to-end workflow that combines deterministic code with Decision
decisions, read
[GitHub Actions security review](../examples/gha-security-review/README.md).
For direct tool calls without an agent, continue with [MCP tools](mcp.md).
