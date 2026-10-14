# Compose implemented primitives

Read only the relevant section. Each TypeScript example is a complete entrypoint.
Create a manifest with `name`, `shortDescription`, `longDescription` and string
`version` following SKILL.md; merge any
additional YAML shown below into it. Do not execute paid or mutating examples
without suitable authorization and configuration.

## Agents

Use the user's requested model/harness or an existing working configuration;
don't infer availability from a model name. Native harness authentication must
already work. The following model is illustrative, not a mandatory default:

```yaml
agents:
  summarizer:
    harness: codex
    model: [openai/gpt-6-astra]
    allowedMcps: []
    systemPrompt: Summarize the supplied text briefly without using tools.
```

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

`createAgent` is synchronous; initialization happens lazily. Reuse the same object
for sequential follow-up prompts to retain its conversation. Don't overlap
`execute` calls on one object; use separate objects for independent parallel
work. Creation/configuration stays fixed; only prompts vary. Await work before
returning. Workflow cleanup closes owned resources automatically.

`harness` can be `claude-code`, `codex` or `opencode`. `model` is an ordered list
of canonical IDs. Omit `harness` only when automatic selection is intended.
Exception: explicit `provider: ollama` uses installed native IDs such as
`gemma4:26b`, not Models.dev IDs. Select `codex` or `opencode` explicitly;
Stratos does not download missing models. Agents use `OLLAMA_HOST` or
`http://127.0.0.1:11434`, without a key. Configure/check the model's loaded
context in Ollama (64K+ for these harnesses). Decision-only Nimble/Clef belong
in `decision`, not `createAgent`.
Leave `effort` unset for Ollama: explicit overrides are not supported.
`allowedMcps` selects names from the workflow's `mcp.servers`.
`allowedTools`/`disallowedTools` remove built-in tools by name. Some names are
canonical, shared across harnesses (`shell`, `read`); others are one harness's
own tool names (`NotebookEdit`). Always run
`stratos tools list <claude-code|codex|opencode>` for the exact names to use in
config. Always-on tools stay on; omit them. Another harness's name is
ignored. The lists never turn on a tool. A tool in both lists is removed.
OpenCode removes `edit` and `write` only together.
Enabled tools are approved by default; use approved `beforeToolCall` hooks for
finer restrictions.

Explicit creation settings override invocation overrides, which override YAML:
`--overrides '{"agents":{"summarizer":{"effort":"low"}}}'`.
For typed agent output, set `outputSchema` to a Zod schema in `createAgent`;
`execute` then returns its validated output rather than text.
OpenCode uses a native `StructuredOutput` tool to deliver this result: a
deny-all collection hook must still allow that tool. Local model/harness
compatibility does not guarantee semantic correctness or reliable tool use.

Prompts may be strings, `{file: 'prompts/task.md'}` or
`{template: 'prompts/task.hbs'}` with variables as the second `execute` argument.
These files resolve relative to the workflow directory. `{configId: 'task'}`
selects configured execution prompt fields, not a new agent configuration.
`workingDirectory` instead resolves relative to the invocation directory.

`agent.cancel()` synchronously signals cancellation; await the pending execute
to observe completion. A later explicit execute attempts continuation, not an
automatic replay. Codex descendant/background work can survive cancellation;
don't promise full process isolation. Optional `worktree: {enabled: true}` uses
a managed Git checkout, but is not a security sandbox.

### Ollama authoring setup and discovery

Before authoring with Ollama, run `stratos provider status ollama --json`. This checks the
selected server without installing, starting services or downloading models.
On failure, explain the diagnostic and ask approval before executing its
OS-specific install/start instructions. Recheck afterward. Don't install locally
to fix an intentionally remote `OLLAMA_HOST`; don't start a second server when
the existing one is reachable.

Use the selected server's `GET /api/tags` for installed native IDs/digests and
`POST /api/show` with `{"model":"<native-id>"}` for capabilities and context
metadata. Use Ollama's official
[search/library](https://ollama.com/search) and each model's **Tags** page for
downloadable candidates. Local `/api/tags` is not the public catalog;
`https://ollama.com/api/tags` lists cloud models, not all downloadable models.
There is no documented exhaustive downloadable-library API. Custom/imported
models can extend the library; don't invent Models.dev-to-Ollama mappings.

Discuss task suitability and device memory/download size before choosing a tag.
Ask before `ollama pull <native-id>` or `POST /api/pull` with a JSON model body;
then check installed metadata again. Ordinary agents need local `completion`
and `tools` capabilities and explicit Codex/OpenCode; Decision needs `decision`.
Check loaded context separately (`ollama ps`); advertised capacity is not the
active allocation. Use the native ID in named YAML settings, omit agent
`effort`, and build. Every declared model candidate must be installed for an
explicit build; runtime-only creation fields/overrides are not build-checked.
Finally run a representative task: metadata compatibility does not establish
answer quality. A receiving device must repeat readiness checks/build and any
necessary approved setup for its own server.

## Child workflows

Use a child in the same discovery root; discover it and read `stratos describe
<child-name> --json` for its manual and schemas first.
Import its generated factory from `../.generated/<child-name>.js`, not its source
entrypoint. Build the parent to prepare the child and wrapper automatically.
Don't handwrite generated files or introduce recursive workflow calls.

For a parent calling the `greet` example from SKILL.md:

```typescript
import {workflow} from '@stratoscli/stratos';
import {z} from 'zod';
import createGreet from '../.generated/greet.js';

export default workflow({
  input: z.strictObject({
    name: z.string().describe('Person to greet'),
  }),
  output: z.strictObject({
    message: z.string().describe('The child greeting'),
  }),
  async run(input) {
    const greet = createGreet();
    return await greet.execute({name: input.name, loud: true});
  },
});
```

Child creation is synchronous. Each `.execute(input)` creates a fresh child run
and returns its typed output directly, not a CLI result envelope. Child objects
also accept `createGreet({overrides: {agents: {...}}})` for named child agents.
Use ordinary loops, conditions, `Promise.all` and `try/catch` for composition.
Propagate failures unless the user requested a specific recovery behavior.

## Decision

Use Decision when the task needs typed decisions, with the user's configured
Jev or local Ollama decision model. Jev requires a credential reference; don't
print or embed the key.

```yaml
decision:
  classifier:
    model: jev-1.13.0
    apiKey: "{env:JEV_API_KEY}"
```

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

`choice` gives a choice, probabilities and confidence; `score` takes 2-10 ordered
levels; `noul` returns a value in `[0, 1]`, not a boolean. Workflow code owns
thresholds/calculations. Settings precedence is call > invocation
`decision[configId]` > YAML. Provider values are validated, not recalculated.

To swap the configuration above to local Nimble without changing TypeScript:
`--overrides '{"decision":{"classifier":{"provider":"ollama","model":"nimble"}}}'`.
Use `clef` instead to swap models. Ollama must be running with the model already
pulled (0.35+ for Nimble, 0.35.1+ for Clef). Build and runtime use explicit
`baseUrl` > `OLLAMA_HOST` > `http://127.0.0.1:11434`; override any explicit old
`baseUrl` too. Only explicit URLs accept path prefixes. No Jev key is
resolved or sent. Use required nonempty instructions, nonblank question/option
names, at most 64 questions, 2-26 Choice options with text/null descriptions,
2-10 text Score levels and text-only Noul descriptions when supplied. Omit
unused Noul criteria. Text/JSON requests must fit 64 KiB and the loaded context.
No chat-model emulation, images, input coercion or calibrated confidence is
implied; reevaluate routing thresholds rather than assuming model equivalence.
