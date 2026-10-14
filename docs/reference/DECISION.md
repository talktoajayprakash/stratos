# Decision API

The `decision` primitive makes structured decisions without starting an agent conversation.
Provide shared context and named questions; receive typed answers with the
provider's probabilities, scores, and available usage. Workflow code decides
what to do with those answers.

This is the API reference. Start with the
[complete classification workflow](../composition.md#decision) for a
runnable definition and manifest. The sections below cover configuration,
request and response schemas, provider differences, and error behavior.

## Execution and question helpers

`decision` is the model-independent name for a structured decision primitive. Supported providers are Jev and local Ollama decision models, tested with Nimble and Clef. Both use the native `/v1/systemone` API; there is no chat-prompt emulation. Compatible answer shapes do not establish identical capabilities, accuracy or confidence semantics.

```ts
import { decision, choice, score, noul } from "@stratoscli/stratos";
```

Only `decision(...)` makes an API call. `choice(...)`, `score(...)`, and `noul(...)` are reusable, pure SDK helpers that construct typed question objects. They do not require generated wrapper files for individual questions. Plain question objects remain valid inputs.

The call follows the existing primitive contract: typed input/output, runtime validation, an execution-context-associated span, and catchable errors. Question builders are not separate execution primitives.

| Builder | Arguments | Answer |
|---|---|---|
| `choice(instructions, options)` | Instructions and an option-name/description map | Selected option, option probabilities, and confidence |
| `score(instructions, levels)` | Instructions and an ordered array of at least two level descriptions | Fractional score, level probabilities, legend, and confidence |
| `noul(instructions?, criteria?)` | Optional instructions and true/false descriptions; provider restrictions apply | Probability of true, from 0 to 1 |

The helpers validate their question shapes. `noul` does not return a boolean,
and confidence does not measure whether a particular answer is correct.

### SDK call

Call `decision(options)` inside a workflow's `run` function. Its exported
`DecisionOptions<Q>` combines the following fields, and its promise resolves
to `DecisionResult<Q>`, inferred from the questions.

| Field | Requirement | Meaning |
|---|---|---|
| `state` | Required | Shared text, object, or array to evaluate |
| `questions` | Required nonempty map | Names mapped to Choice, Score, or Noul questions |
| `configId` | Optional | Existing named entry under `decision` in `workflow.yaml` |
| `model` | Required after configuration resolution | Provider's model ID |
| `provider` | Defaults to `jev` | `jev` or `ollama` |
| `apiKey` | Required for Jev | Environment/file reference, not a literal secret |
| `baseUrl` | Optional | HTTP(S) API base, without the `/v1/systemone` suffix |

Supply settings in code or select named configuration as described next.
Question helpers are pure and may be used outside execution; the API call
requires an active workflow context.

## Credential sources

Decision credentials use the same [environment/file references as telemetry headers](TELEMETRY.md#telemetry-authentication-references): `{env:VARIABLE}` resolves an environment variable and `{file:path}` reads a secret file. Secret files must be readable only by their owner (for example `0400` for owner-read-only, or `0600` when owner writes are also needed); exclude group and other-user access. Keep credentials out of checked-in workflow files, logs, events, traces, and errors.

Named Decision settings live under `decision` in `workflow.yaml`. Jev
requires `model` and `apiKey`, with `apiKey` holding a reference rather than
the secret itself:

```yaml
decision:
  classifier:
    model: jev-1.13.0
    apiKey: "{env:JEV_API_KEY}"
```

Alternatively, `apiKey: "{file:~/.stratos/secrets/jev-key}"` reads an owner-protected file. Decision configuration also accepts `provider` and `baseUrl`. When omitted, `provider` defaults to `jev`. Unsupported providers fail explicitly.

| Provider | Default baseUrl | Credentials |
|---|---|---|
| `jev` | `https://api.typesafe.ai` | Required env/file API-key reference; sent as Bearer authentication. |
| `ollama` | `OLLAMA_HOST`, otherwise `http://127.0.0.1:11434` | No key or Authorization header. Inherited Jev references are not resolved or forwarded. |

An explicit `baseUrl` overrides the provider default. Stratos appends
`/v1/systemone`; configure a base URL, not that full endpoint. URLs must use
HTTP(S), without embedded credentials, query parameters or fragments.

For Ollama, build checks and runtime both use **explicit `baseUrl` >
`OLLAMA_HOST` > `http://127.0.0.1:11434`**. Resolve explicit fields with the
normal call-site > invocation > YAML precedence first. An explicit `baseUrl`
can include a path prefix; `OLLAMA_HOST` must be an HTTP(S) origin without
credentials, path, query or fragment. Host-only values such as `localhost:11435`
use HTTP, with port 11434 when omitted. Invalid selected endpoints fail instead
of falling back. Explicit URLs bypass `OLLAMA_HOST`; Jev never reads it.

Code selects this configuration with
`decision({ configId: "classifier", state, questions })`. Invocation overrides
use `--overrides '{"decision":{"classifier":{...}}}'`. Settings resolve field
by field with call site > workflow invocation override > YAML configuration >
defaults. Unspecified fields retain their lower-priority values. The question
examples below use this named `classifier` configuration.

Missing or rejected Jev credentials raise a catchable error. Handled errors
permit workflow recovery; unhandled errors fail the workflow under the normal
cleanup rules. References do not provide credential refresh. Telemetry's
soft-error policy does not turn failed model calls into successful calls.

### Local Ollama and configuration-only swaps

Run Ollama locally and pull a compatible decision model before invoking Stratos:
`ollama pull nimble` or `ollama pull clef`. The endpoint requires Ollama 0.35+;
Clef requires 0.35.1+. Ordinary chat models are not substitutes, and the endpoint
does not support Ollama cloud or MLX/Safetensors models. Stratos neither starts
the service nor downloads models.

```yaml
decision:
  classifier:
    provider: ollama
    model: nimble
```

Change only `model` to `clef` to use Clef. To switch an existing named Jev
configuration without editing TypeScript or supplying a Jev key, run the
classification example from the [composition guide](../composition.md#decision):

```sh
stratos run classify-request --input '{"text":"I need help with a refund."}' \
  --overrides '{"decision":{"classifier":{"provider":"ollama","model":"nimble"}}}' \
  --json
```

Because merging is field by field, an explicitly configured `baseUrl` persists
when changing providers. Override it too if it points at the old service.
Call-site settings still win over invocation/YAML. An inherited `apiKey`
reference remains syntactically validated but is unused by Ollama; switching
back to Jev restores credential resolution.

An explicit `stratos build` checks declared `decision` Ollama model IDs against
the configured `baseUrl`, then `OLLAMA_HOST`, then the localhost default,
preserving an explicit URL's path prefix. The installed entry must be local and
advertise `decision`; it need not advertise the ordinary-agent
`completion`/`tools` capabilities. This reads
metadata only; it does not call `/v1/systemone`. Dynamic call-site/override
settings retain runtime validation. Ordinary agents and
`stratos provider status ollama` use the same `OLLAMA_HOST`/localhost fallback.

## Request retries

Transient failures allow three retries after the initial attempt, for four
attempts maximum, with a fixed one-second delay. HTTP 408, 429, 5xx and
transport failures may retry; malformed JSON and response-contract errors do
not. Each attempt has a 60-second timeout, not a shared 60-second budget.
Exhausted failures raise a catchable error. Workflow cancellation aborts
in-flight requests and pending retries and is never retried. These settings
are not configurable.

## Input schema

The following types describe the request data after SDK settings have been
resolved. This is the provider payload, not a second argument to `decision`;
the workflow-facing options also include the configuration fields above.

```ts
type JsonValue =
  | string | number | boolean | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type Content = string | JsonValue[] | { [key: string]: JsonValue };
type Description = Content | null;

type Question =
  | {
      type: "choice";
      instructions?: Description;
      criteria: Record<string, Description>;
    }
  | {
      type: "score";
      instructions?: Description;
      criteria: readonly [Content, Content, ...Content[]];
    }
  | {
      type: "noul";
      instructions?: Description;
      criteria?: {
        true?: Description;
        false?: Description;
      } | null;
    };

type DecisionInput<Q extends Record<string, Question>> = {
  model: string;
  state: Content;
  questions: Q;
};
```

`state` is required and cannot be null or a bare number/boolean. Nested JSON values may contain numbers, booleans, and nulls. An array is one shared state, not an implicit batch of requests. Jev evaluates text/JSON; images, audio, and video are not supported by this integration.

`questions` must be nonempty. Each question's map key identifies its answer; it is not an instruction to the model. Independent questions of different types can be included in one call. If a later question needs an earlier answer, workflow code constructs a subsequent call.

| Question | Criteria | Validation |
|---|---|---|
| Choice | Map of option names to descriptions | At least one option; Jev allows at most 255. Descriptions may be text, objects, arrays, or null. |
| Score | Ordered array of level descriptions | Stratos requires at least two levels; Jev allows at most 10. A level is text, an object, or an array, never null. |
| Noul | Optional descriptions of true and false | Either description may be omitted or null; the criteria object itself may be omitted or null. |

For Jev, instructions may be omitted or null on all three question types.
Choice's 255-option and Score's 10-level maxima are Jev-specific limits, not
guarantees about other models. Stratos requires at least two Score levels.

### Ollama portability limits

The SDK retains the existing input schema above. Ollama imposes additional
native restrictions; valid Jev inputs are not necessarily portable:

| Field | Ollama requirement |
|---|---|
| State/instructions | Nonblank text, object or array. Instructions are required for every question, not omitted/null. |
| Questions | 1-64 questions with nonblank names. |
| Choice | 2-26 options with nonblank names; descriptions are text or null, not objects/arrays. |
| Score | Text levels only. Stratos still permits 2-10 levels, even though Ollama permits up to 26. |
| Noul | Omit criteria or use text descriptions for `true`/`false`; avoid Jev's nullable/structured variants. |
| Request | Text/JSON only in Stratos, at most 64 KiB for Ollama and within the model's loaded context. |

Use this common subset for configuration-only provider swaps. Stratos sends
validated input unchanged and exposes catchable native HTTP failures; it does
not invent instructions, stringify structured criteria or truncate input.
Ollama's optional image and `keep_alive` request fields are not exposed.
Missing models return HTTP 404; unsupported models/input/context return 400;
oversized requests return 413. These errors are not retried. Raw provider error
bodies are omitted, as for Jev.

## Output schema and inference

```ts
type ChoiceAnswer<K extends string> = {
  type: "choice";
  choice: K;
  probabilities: Record<K, number>;
  confidence: number;
};

type ScoreAnswer = {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  legend: Record<string, Content>;
  confidence: number;
};

type NoulAnswer = {
  type: "noul";
  noul: number;
};
```

The response envelope contains `model`, `answers`, and `usage: { input_tokens: number; output_tokens: number }`, with integer token counts. `model` identifies the model that answered, which may differ from a requested alias.

Ollama reports input tokens evaluated for scoring, potentially counting shared
context again across questions. Output tokens count internal scoring work, not
the length of the response JSON; **zero is valid**, as observed with Clef.
Ollama confidence measures distribution concentration (`1 - H(p) / ln(N)`),
not calibrated correctness. Do not assume a threshold tuned on Jev has the same
behavior on Nimble or Clef. Model loading is included in client invocation
latency and the existing 60-second per-attempt timeout; it is not independently
timed by this integration.

`answers` preserves each input question's name and infers its answer kind. Choice preserves the literal option-name union in `choice` and the corresponding probability keys. Fixed Score rubrics provide their level indices for typed access. Dynamically generated question names remain a string-keyed map with the applicable inferred answer type.

Malformed responses—including missing answers, wrong types, or invalid ranges—raise a catchable validation error immediately, without retrying. This is distinct from the retry policy for transient request failures.

No separate `outputSchema` argument is needed. Response validation is tied to the submitted questions: answer names and types, Choice option names, Score level keys, and numeric ranges. Validate structure, answer keys/types, option names, and documented numeric ranges. Return provider values unchanged: do not check probability sums, normalize probabilities, or recalculate scores. Workflow authors own those calculations.

- Choice selects one option and retains probabilities for all options. Probability-key ordering need not match the input's object ordering.
- Score uses zero-based level indices. With N levels, `score` is a number from 0 to N−1, computed as the probability-weighted average of those indices; it may be fractional. `legend` preserves the supplied descriptions, including objects and arrays. JSON level keys are strings.
- Noul returns P(true), a number from 0 to 1, without a separate confidence field. It is not automatically converted to a boolean.
- Choice and Score retain both probability distributions and confidence in the 0–1 range. Confidence is distinct from the selected option's probability and is not a guarantee of correctness. Distributions sum approximately to 1.

Workflow code owns thresholds, score normalization, aggregation, branching, and subsequent agent or MCP calls. No additional execution primitives are required for routing, filtering, ranking, or verification.

## Workflow examples

These snippets run inside a workflow's `run` function. Inputs, tool results, and handler functions are illustrative local variables/functions, not new Stratos APIs. Thresholds are example workflow policy, not SDK defaults. Each example uses the imports shown above.

### Choice: route a request

```ts
const { answers } = await decision({
  configId: "classifier",
  state: input.message,
  questions: {
    category: choice("What does the user need?", {
      billing: "Payments, charges, invoices, or refunds",
      technical: "Bugs, crashes, or broken functionality",
      other: "Anything else",
    }),
  },
});

answers.category.choice;               // "billing" | "technical" | "other"
answers.category.probabilities.billing; // number
answers.category.confidence;           // number

switch (answers.category.choice) {
  case "billing": return handleBilling(input);
  case "technical": return handleTechnicalIssue(input);
  case "other": return handleOtherRequest(input);
}
```

Handlers are ordinary workflow functions and can invoke MCP tools or agents.

### Noul: check evidence before continuing

```ts
const { answers } = await decision({
  configId: "classifier",
  state: { task: input.task, evidence: toolResults },
  questions: {
    sufficient: noul(
      "Does the evidence contain reproduction steps for the reported bug?"
    ),
  },
});

if (answers.sufficient.noul >= 0.9) {
  return investigateBug(toolResults);
}
return gatherMoreEvidence(input);
```

### Score: assess severity

```ts
const { answers } = await decision({
  configId: "classifier",
  state: input.bugReport,
  questions: {
    severity: score("How severe is the reported issue?", [
      "Cosmetic issue; functionality works",
      "Broken functionality with a workaround",
      "Blocked functionality without a workaround",
    ]),
  },
});

answers.severity.probabilities["2"]; // probability of the blocking level
answers.severity.legend["2"];        // that level's description
return {
  severity: answers.severity.score,   // fractional number from 0 to 2
  needsReview: answers.severity.confidence < 0.7,
};
```

### Mixed questions: one call, multiple decisions

```ts
const { answers, usage } = await decision({
  configId: "classifier",
  state: { report: input.bugReport, investigation: toolResults },
  questions: {
    area: choice("Which area is affected?", {
      frontend: "Browser interface or rendering",
      backend: "Server processing or APIs",
      unknown: "The evidence does not identify the area",
    }),
    severity: score("How severe is the issue?", [
      "Cosmetic issue",
      "Broken functionality with a workaround",
      "Blocked functionality without a workaround",
    ]),
    reproducible: noul(
      "Does the investigation provide concrete reproduction steps?"
    ),
  },
});

if (answers.reproducible.noul < 0.8) {
  return gatherMoreEvidence(input);
}
return investigateArea({
  area: answers.area.choice,
  severity: answers.severity.score,
});
```

### Dynamic questions: filter tool results

```ts
if (searchResults.length === 0) {
  return { results: [] };
}

// Each item.id is unique within these results.
const questions = Object.fromEntries(
  searchResults.map((item) => [
    item.id,
    noul({
      question: "Does this candidate help answer the user's request?",
      request: input.request,
      candidate: item,
    }),
  ])
);

const { answers } = await decision({
  configId: "classifier",
  state: { request: input.request },
  questions,
});

return {
  results: searchResults.filter((item) => answers[item.id].noul >= 0.8),
};
```

Each candidate receives an independent yes/no probability, allowing multiple candidates or none to qualify. Dynamic IDs cannot be individually autocompleted, but their answer kind remains typed. The empty-input branch avoids an invalid empty question map.

## OpenTelemetry instrumentation

<a id="content-and-measurement-mapping"></a>

Each call records structured inputs and answers, available usage, and outcome.
See [Telemetry](TELEMETRY.md) for exporter setup, Langfuse, logs, and trace
hierarchy. [Decision measurements](TELEMETRY.md#decision-measurements)
explains the latency boundaries, token mapping, and confidence limitations.

## Provider compatibility and limitations

Stratos uses native Node fetch against Jev or Ollama. Provider input
restrictions differ; use the portability limits above rather than assuming
that another SDK's types describe Stratos's accepted inputs. Errors are
catchable and omit raw provider error bodies. `model` remains required after
configuration merging; `apiKey` is required only for Jev.

Nimble and Clef support configuration-only workflow swaps on Ollama 0.35.1.
They may disagree on classification, confidence and routing even with valid
response shapes. Stratos does not hide those differences through input
conversion, threshold changes or fallback providers.

References: [API](https://docs.typesafe.ai/api), [OpenAPI](https://api.typesafe.ai/openapi.json), [Score semantics](https://docs.typesafe.ai/primitives/score), [SDK types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts).

Ollama references: [native API](https://docs.ollama.com/api/systemone),
[decision guide](https://docs.ollama.com/capabilities/decision),
[Nimble](https://ollama.com/library/nimble), [Clef](https://ollama.com/library/clef).
