# Stratos design philosophy

Stratos turns reusable tasks into code that coordinates agents, tools, and
ordinary functions. Its design comes from a simple idea: let models do the work
that needs judgment, and let code handle the coordination we already understand.

This document gathers the decisions behind Stratos and explains their reasons
and trade-offs. It complements, rather than replaces, the detailed references.
The final section preserves agreed directions that are not implemented and
distinguishes them from questions that still need an answer.

| Topic | Start here |
|---|---|
| The basic idea and authoring experience | [Code and judgment](#put-coordination-in-code-and-judgment-in-models), [familiar tools](#use-familiar-tools-and-one-clear-contract) |
| Finding, preparing, and composing workflows | [Discovery and builds](#separate-discovery-preparation-and-execution), [composition](#compose-workflows-without-sharing-their-state) |
| Agents, models, and tools | [Conversations](#make-conversation-ownership-explicit), [harnesses](#share-behavior-without-hiding-native-differences), [MCP](#make-tool-access-explicit-and-typed) |
| Safety, credentials, and cleanup | [Errors](#make-failure-visible-and-recovery-deliberate), [authentication](#keep-authentication-out-of-workflow-logic), [worktrees](#preserve-work-before-cleaning-up-worktrees) |
| Understanding and improving runs | [Telemetry](#show-what-happened-without-inventing-evidence), [verification](#earn-confidence-with-real-evidence) |
| Decisions that are not yet features | [Recorded directions and open questions](#recorded-directions-and-open-questions) |

## Put coordination in code and judgment in models

A skill can teach an agent how to perform a task. A workflow captures the
repeatable parts as executable code: which step comes next, which inputs to
pass, when to branch, and how to combine results. The two work together rather
than replacing each other.

Ordinary TypeScript handles loops, conditions, parallel work, transformations,
and recovery. Agents and structured model calls provide judgment where it is
needed. This avoids asking a model to rediscover the same orchestration on every
run, and avoids adding a separate workflow language for things code already
expresses well.

The saved files are the reusable artifact. Running a workflow does not ask an
agent to regenerate its source. An authoring agent can inspect a run, change
the files, and try again; improvement happens through that visible edit-and-run
cycle, not through hidden changes to the workflow or shared conversation memory.

With the right context, any capable coding model should be able to write Stratos
workflows. Individual steps can use different models, including smaller local
models. Simpler APIs and useful diagnostics benefit everyone.

Lower cost, shorter runtime, and greater reliability are goals to measure, not
automatic consequences of using Stratos.

Details: [Vision](VISION.md).

## Use familiar tools and one clear contract

### TypeScript, Node.js, and npm

The CLI, runtime, SDK, and workflow code use TypeScript. This fits the native
agent SDK ecosystem and gives authors type-checker feedback before execution.
The reason is compatibility and useful error checking, not an assumption that
models inherently write better TypeScript than JavaScript.

Stratos compiles workflows and runs their JavaScript on Node.js. The supported
baseline is Node 24 on macOS and Linux, with npm handling dependencies. It is a
local, in-process runtime, not a sandbox or a persistent orchestration service.
Workflow code and dependencies have the invoking process's permissions.
Interactive MCP sign-in needs a browser; headless deployment is not a supported
target.

### Declare the contract once

A workflow directory contains `workflow.yaml` for its name, short and long descriptions, and
configuration, and a TypeScript entrypoint, normally `workflow.ts`. The module
exports `workflow({ input, output, run })`.

Zod, a schema library, describes the accepted data and checks values at runtime.
Its schemas also provide TypeScript types, and Stratos exports them as JSON
Schema. Authors do not maintain a second handwritten schema or rely on TypeScript
interfaces that disappear at runtime. Keeping one source of truth reduces
disagreement between what callers see and what execution accepts.

Inputs and successful outputs are objects; a workflow with no result returns
`{}`. Unknown input fields are rejected, including in nested input objects.
Defaults apply to omitted values, and `null` is accepted only when declared.
The top-level input name `overrides` is reserved for configuration.

Every field has a description, including nested fields. An empty description is
allowed when the name is already clear. This makes contracts useful to agents
and people without forcing meaningless prose onto self-explanatory fields.

Public schemas describe JSON-compatible values and representable constraints.
Transformations and custom business checks belong in `run`, where their behavior
is visible, rather than in a schema that cannot faithfully describe them to a
caller.

Reading schemas evaluates their declaring modules, but does not invoke `run`.
Workflow actions therefore belong inside functions, not in module-level code.
A build can check a contract without being a safe sandbox for arbitrary imports.

Details: [schema conventions](docs/reference/RUNTIME.md#schema-conventions) and
[workflow authoring](docs/reference/SPEC.md#invocation-runtime-and-agent-authoring).

## Separate discovery, preparation, and execution

Finding a workflow should not install packages, connect to tools, or execute
its code. Stratos discovers manifests in the current directory's
`.stratos/workflows/` and the user's `~/.stratos/workflows/`.

Names must be unique within each root. When a name appears in both roots, the
CLI reports the ambiguity and asks for an explicit directory path. It does not
silently pick one or wait for an interactive numbered selection. That keeps
automated callers from running a different workflow than intended.

`list` exposes names and short descriptions and checks build freshness.
`describe` loads the selected workflow's usage manual and schemas; `schema`
returns only schemas. Neither inspection command invokes `run`.
`describe`, `schema` and `run` prepare a
workflow when its build is absent or stale. Preparation failures stop the
operation; an old artifact is not a successful substitute for a failed build.
This keeps discovery inexpensive while allowing normal invocation to work
without a separate manual compilation step.

Build freshness uses SHA-256 hashes of authored files and paths, including
referenced workflows. Dependencies and compiler changes also invalidate affected
builds. Unchanged compiled code can be reused; changing an agent's model setting
does not by itself require recompiling its TypeScript.

A targeted build prepares the selected workflow and its dependencies, building
children before parents. A project-wide build reports failures while continuing
independent workflows. A broken unrelated workflow should not prevent useful
work elsewhere.

Explicit builds also refresh the available MCP tool schemas. They prepare all
declared MCPs, even before an entrypoint exists, so an author can read accurate
tool declarations before writing code. This is preparation, not a claim that a
manifest-only workflow has compiled. Normal `run`, `schema` and `describe` preparation uses
the direct-tool references needed by the workflow and reuses current builds.

That distinction balances two needs: up-to-date tool knowledge while authoring,
and avoiding unnecessary discovery work on every execution. Tool discovery does
not execute tools or guarantee that a future tool call will succeed.

Details: [discovery](docs/reference/RUNTIME.md#entrypoint-and-discovery),
[preparation order](docs/reference/RUNTIME.md#preparation-order), and
[MCP wrapper preparation](docs/reference/SPEC.md#mcp-wrapper-generation-and-storage).

## Let Stratos own the repetitive build setup

Authors supply workflow code and npm dependencies, not a custom compiler setup.
Stratos manages ESM package metadata and uses explicit TypeScript compiler flags:
strict checking, ES2022, NodeNext resolution, and no output on type errors.
An explicitly incompatible CommonJS package is an error, not something to
silently rewrite. This keeps the authoring surface small without hiding conflicts.

Each discovery root has one shared Stratos SDK whose version exactly matches
the CLI, including when moving to an older CLI. Preparation installs the matching
version when needed and invalidates affected builds. A root-local loading bridge
ensures workflow code and the runtime use the same SDK instance.

This is more than version tidiness: execution context uses Node's
`AsyncLocalStorage`, so two unrelated SDK instances could disagree about which
workflow owns a call. Workflows can have their own dependencies, but cannot
shadow the shared SDK with a closer copy.

Generated files are local build products. Child-workflow wrappers live under the
root's `.generated/`; MCP wrappers live under each workflow's `generated/mcp/`;
compiled files live under its `dist/`. Compilation mirrors source paths so
relative imports keep their meaning. JSON Schemas are produced in memory rather
than maintained as another set of checked-in files.

Stratos adds narrowly scoped ignore rules without replacing existing ones.
Already-tracked generated files are reported, not silently removed from Git.
`clean` deletes owned generated artifacts, invalidates dependent builds, and
preserves authored files, dependencies, and credentials. This makes regeneration
a routine operation rather than a risk to source or user data.

Details: [dependencies and build](docs/reference/RUNTIME.md#dependencies-and-build) and
[generated artifacts](docs/reference/RUNTIME.md#generated-artifacts-and-git-ignores).

## Make configuration predictable

Named agent and Decision configurations let people change execution settings
without rewriting workflow logic. Explicit call-site settings remain available
when code needs them.

Values resolve field by field, from highest to lowest priority:

1. Explicit settings in workflow code.
2. Overrides supplied for that workflow invocation.
3. Settings in `workflow.yaml`.
4. A documented default, where one exists.

Changing one field does not erase unrelated settings. Lists, such as preferred
models or allowed MCP servers, replace lower-priority lists instead of merging
them. Template variables merge by variable name within each prompt field; an
individual variable value replaces its previous value, even if it is an object.
These rules avoid surprising combinations and make partial overrides practical.

Prompts can be literal text, plain files, or Handlebars templates rendered by
Stratos. Missing variables fail before sending an incomplete prompt to a model.
File and template references resolve relative to the workflow directory.

An agent's system prompt is resolved for initialization and stays fixed.
`execute(prompt, variables?)` supplies the next user prompt; a prompt configuration
reference contributes only that prompt and its variables, not a new model,
system prompt, or tool selection. Prompt reuse is not hidden reconfiguration.

Details: [named configurations](docs/reference/RUNTIME.md#named-agent-configurations),
[prompt templates](docs/reference/RUNTIME.md#agent-prompt-templates), and
[Decision configuration](docs/reference/DECISION.md#credential-sources).

## Keep execution location and ownership separate

A workflow runs in the directory from which it was invoked, even when its source
was discovered elsewhere. Child workflows retain that same directory. Agent
`workingDirectory` settings resolve relative to it; selecting an agent directory
does not change the process-wide directory.

This separates "where the recipe is stored" from "where the work happens."
Workflow-relative prompt and secret-file references remain attached to the
recipe, while execution-relative paths refer to the caller's workspace.

Each workflow invocation gets a fresh async execution context containing its
configuration, identity, resource ownership, and trace context. SDK calls retrieve
that context internally rather than requiring an extra context argument throughout
the workflow. It follows awaited and parallel work without using a mutable global
"current workflow." Calling an execution primitive outside a workflow is an error;
pure question-building helpers do not need a run.

Details: [working directory](docs/reference/RUNTIME.md#execution-working-directory) and
[execution context](docs/reference/RUNTIME.md#execution-context).

## Compose workflows without sharing their state

Children are called through generated, typed wrappers within the same discovery
root. The wrapper starts a real workflow invocation, rather than merely importing
and calling another function. It provides configuration loading, validation,
identity, tracing, and cleanup.

A child uses its own configuration. Parent overrides do not leak into it; the
parent can explicitly bind `agents` or `decision` overrides when constructing
the child object. Each `execute(input)` starts a new invocation, including when
the same object is reused or called in parallel.

The object shapes look similar, but their ownership is deliberately different:

| Object | Creation | Repeated calls |
|---|---|---|
| Agent | Synchronous; native initialization waits until execution | Continue one conversation sequentially |
| Child workflow | Synchronous; binds the target and overrides | Start independent invocations; parallel calls are allowed |
| Direct MCP client | Awaited; returns after connection preparation | Reuse one ready client; concurrent tool calls are allowed |

Workflow references are explicit, not arbitrary names resolved from input.
Ancestor call cycles are rejected both during detected build dependencies and
at runtime. Repeated completed calls and parallel siblings are fine; recursively
invoking an active ancestor is not. This keeps composition inspectable and puts
a clear boundary around runaway workflow recursion without banning recursive
JavaScript helper functions.

An invalid required child blocks the parent's build, even if called conditionally,
because the parent needs its type contract. A runtime child failure is catchable;
handling it does not automatically fail the parent or other children.

Details: [nested execution](docs/reference/RUNTIME.md#nested-workflow-execution).

## Make conversation ownership explicit

One agent object represents one conversation belonging to one workflow
invocation. `createAgent(...)` establishes its settings and identity; the first
`execute(...)` initializes native resources. Later executions continue the same
conversation.

The harness, provider, model, effort, system prompt, tools, directory, worktree,
hooks, and output schema stay fixed. Different settings require another agent.
Keeping them fixed makes "continue this conversation" mean something precise,
rather than silently changing the conditions under which earlier answers arose.

Two simultaneous calls on the same object are an error, not a request to queue
prompts or create a replacement session. Only the overlapping call is rejected.
Independent work uses separate agents. A shared configuration name shares
settings, not memory.

There are no author-facing session IDs for joining another conversation, and
no conversation sharing across runs, parents, children, or siblings. Workflow
agents also do not reuse the calling coding agent's session. This keeps workflow
work from expanding or contaminating the caller's context.

Initialization failure can be followed by a later explicit attempt on the same
object. After an execution failure or cancellation, another explicit call attempts
to continue the initialized conversation. Neither case automatically replays the
failed prompt or silently replaces the session. Continuation can still fail.

Without an output schema, an agent returns text. With a Zod output schema, Stratos
uses native structured-output support and validates the result. It does not turn
arbitrary prose into a success-shaped object. Native schema restrictions still
matter; a common interface does not make all harness capabilities identical.

Details: [configured agents](docs/reference/RUNTIME.md#configured-agent-objects),
[sessions](docs/reference/RUNTIME.md#sessions), and [agent output](docs/reference/RUNTIME.md#agent-output).

## Share behavior without hiding native differences

A **harness** is the system that runs an agent's conversation and tool loop, such
as Claude Code, Codex, or OpenCode. A **model** produces its responses. A
**provider** serves the model. These are related choices, not interchangeable names.

The common runtime owns configuration, prompt rendering, admission limits,
validation, lifecycle, and telemetry. Adapters translate those decisions into
native SDK operations. Internally, they share initialization, execution,
cancellation, and cleanup methods, plus normalized observations.

This keeps workflow code portable without rebuilding every native agent loop.
For example, Claude retains a streaming query between prompts; Codex preserves
conversation identity across native SDK turns. Their common lifecycle does not
require identical process arrangements.

### Choose deliberately; fall back narrowly

An explicit harness constrains selection to that harness. Otherwise, ordered model
preferences are considered with their creator's harness first: Anthropic with
Claude Code and OpenAI with Codex. Only then does selection consider OpenCode in
model order; other model creators participate in that pass. The preference is
not proof of access or capability, and does not select a provider on the user's
behalf.

Readiness checks inspect installation, configured authentication, and independent
model catalogs without inference. A complete catalog can exclude a missing model;
absence from a partial catalog remains unknown. Invalid catalogs, policy failures,
and transport errors are errors, not empty lists that justify another choice.

Fallback handles missing harnesses, missing authentication, or unavailable models,
not rate limits or ordinary execution failures. A first native model rejection
can advance to another prepared candidate only when structured evidence identifies
model unavailability before any output, reasoning, attempted tool work, or
startup/background work, and after successful cleanup of the rejected resource.

Once a conversation is established, selection is fixed. Generic HTTP errors or
error-message guesses are not permission to switch models and replay work.
This preserves the author's choice and avoids duplicating side effects.

### Keep model identity separate from availability

For hosted models, Stratos ships a mapping from a pinned Models.dev revision,
using explicit `base_model` links rather than guessing from similar names,
punctuation, or dates. Provider configuration mappings live alongside it.
Updating Stratos updates this identity snapshot; it is separate from live
readiness checks.

When multiple native IDs are explicitly linked for a provider, the first listed
mapping gives repeatable selection. A missing mapping is an error. A catalog
identity does not prove account entitlement, deployment availability, identical
capabilities, or support for a particular reasoning-effort setting.

Details: [adapter boundary](docs/reference/RUNTIME.md#agent-and-harness-adapter-boundary),
[selection](docs/reference/RUNTIME.md#model-based-harness-preference), and
[model IDs](docs/reference/RUNTIME.md#canonical-model-ids).

## Keep local models local and user-controlled

Explicit `provider: ollama` uses installed Ollama names and tags, not guessed
hosted-model equivalents. Agent use requires an explicit Codex or OpenCode
harness and an installed local model advertising both completion and tool
capabilities. Decision-only models belong to the `decision` primitive, not the agent API.

Agents use `OLLAMA_HOST` or localhost. Decision first honors its explicit
`baseUrl`, then the same host/default. Invalid selected endpoints fail without
silently choosing another. Ollama uses no hosted credentials; OpenCode's auxiliary
model stays on the selected local model as well.

Stratos does not download missing models, fall back to a cloud provider, warm
models, or change server context and sampling settings. Provider status reads
metadata and gives setup guidance; installation and model downloads are explicit
user-approved actions. Explicit builds check declared local model capabilities
before the workflow's dependency and MCP preparation.

Hosted reasoning levels are not translated into local thinking settings:
Ollama agents use model defaults and reject explicit effort overrides.
Advertised context capacity is not proof of the server's actual loaded context.
These boundaries keep resource use, data location, and model choice visible.

Details: [Ollama agents](docs/reference/RUNTIME.md#ollama-native-agent-models) and
[provider status](docs/reference/CLI.md#ollama-provider-status).

## Make tool access explicit and typed

### Select tools from the workflow, not the surrounding machine

MCP, the Model Context Protocol, connects workflows and agents to external tools.
Servers are named in the workflow's `mcp.servers` map. Agent `allowedMcps` selects
from those definitions; an explicit list replaces configured selection, an empty
list enables none, and an unknown name is an error.

Workspace and user-level MCP settings are not inherited from the harness.
This avoids unintentionally enabling unrelated integrations and paying their
startup and context costs. Built-in harness tools are selected separately by
`allowedTools` and `disallowedTools`, using shared canonical names or
harness-specific names. Selection only removes tools; it does not enable
capabilities the harness leaves off. Neither selection is a sandbox: enabled
tools are approved by default, and some tools cannot be removed. The
[selection contract](docs/reference/RUNTIME.md#agent-built-in-tool-selection) records those
limits; `stratos tools list` reports the names supported by each harness.

### Make generated interfaces useful and honest

Direct workflow code imports generated server wrappers with readable, stable
paths. Stratos discovers all tools for each directly referenced server, allowing
dynamic tool-name use without a second usage list in configuration. Explicit
builds can prepare all declared servers before code is written.

Exported type names derive from exact tool names, with unambiguous character
escaping, rather than their position in a discovery result. Adding an unrelated
tool must not make an existing type name refer to something else.

Declared input and output schemas drive types and runtime validation from the
same discovery snapshot. A declared output describes `structuredContent`; the
rest of the MCP response remains available. When no output schema exists, Stratos
leaves the result generic instead of inferring a contract from sample text.
Schema changes are refreshed and checked with consumers during explicit builds,
not hidden behind stale successful wrappers.

### Give each connection an owner

A direct MCP factory is awaited so authentication and protocol preparation fail
at a clear point before tool use. Each object owns its client and transport,
reusing them for calls without automatically sharing clients across factories.
The runtime handles both modern handshake-free and legacy initialized protocol
behavior without changing workflow syntax.

Direct calls have a five-minute request timeout and no automatic retry.
Workflow cleanup cancels owned pending work and releases the client.
Agent tool calls follow a separate path: Stratos supplies selected configurations
and credentials, while the harness owns connections and execution. This uses
native tool handling instead of adding a forwarding layer to every agent call.

Details: [MCP connections](docs/reference/SPEC.md#mcp-connections-and-authentication) and
[generated wrappers](docs/reference/SPEC.md#mcp-wrapper-generation-and-storage).

## Keep authentication out of workflow logic

### Respect the native authentication boundary

Harnesses and providers own their login flows. Stratos uses supported configured
credentials or applicable native login; it does not copy subscription tokens into
its own store or bypass organization policies. Provider policy can limit what a
technically available login is allowed to do.

An explicit Codex Azure provider uses the selected native Azure configuration,
environment-key authentication, and the Responses API. It does not substitute
OpenAI keys or saved ChatGPT login when Azure setup fails. Isolation also excludes
unrelated native MCPs, hooks, and profiles. Selecting a provider is a meaningful
boundary, not a hint to find any working credential.

### Use standard OAuth and explicit secret references

Stratos manages MCP OAuth with the official SDK: server discovery, registration,
authorization-code flow with PKCE, and token exchange. It supplies browser launch,
a loopback callback, and persistence rather than inventing another authentication
protocol.

Registration prefers supplied client information, then a configured metadata
document when supported, then dynamic registration. Stratos does not host a
metadata document. The callback defaults to `127.0.0.1` on an available port;
fixed redirects are supported where registration requires them. Browser failure
or the five-minute timeout is a catchable error, and the listener is cleaned up.

Environment/file references keep secret values out of shared workflow definitions.
MCP credentials persist separately in `~/.stratos/credentials.json`, with `0700`
directory and `0600` file permissions. This is plaintext protected by filesystem
permissions, not a keyring or encryption boundary against other processes running
as the same user.

Credential identity uses the server URL, authorization server, and client ID,
not a workflow-local nickname. One account is stored per such identity. Short
file locks, coordinated refreshes, and atomic writes protect updates; browser
sign-in does not hold a file lock. Malformed stores fail visibly, network refresh
failures preserve existing credentials, and local logout is not a claim of
remote token revocation.

### Check authentication before business work

After input validation and before `run`, Stratos authenticates every OAuth MCP
declared by that invoked workflow, including a child when it starts. This is
deliberately broader than an agent's tool selection, but does not enable
unselected tools or open their native connections.

Known token lifetimes must exceed five minutes, including newly refreshed tokens.
Credentials are rechecked after all preflight sign-ins, and between agent requests.
This catches known authentication problems before business logic starts and
avoids beginning with a token already about to expire.

Unknown expiry is not guessed. A start-time margin cannot guarantee validity for
an arbitrarily long request. Credentials can refresh between requests; renewal
inside an active request is not implemented. No automatic tool replay is used
to disguise that limitation.

Details: [harness authentication](docs/reference/RUNTIME.md#harness-authentication),
[MCP authentication](docs/reference/SPEC.md#mcp-connections-and-authentication), and
[credential storage](docs/reference/SPEC.md#mcp-credential-storage).

## Keep structured decisions distinct from agent conversations

Decision is a model-independent decision API, not a small agent loop.
`decision(...)` makes a native structured request; `choice`, `score`, and `noul`
are pure question builders. They need neither individual generated wrappers nor
their own execution spans.

Multiple independent questions can share one state in a call. An array is a state
value, not an implicit batch. If a question depends on an earlier answer, code
makes a subsequent call. Question names identify answers, while instructions
and criteria describe the decision.

The submitted questions determine the response contract, so a second output
schema is unnecessary. Stratos validates answer names, types, options, and ranges
and preserves provider values. Choice retains its selection and probabilities;
Score can be a fractional weighted numeric level; Noul returns the probability
of a true answer, not an automatically chosen boolean.

Thresholds, normalization, ranking, branching, and follow-up actions stay in
workflow code. Confidence is not measured accuracy, and an interface-compatible
provider is not necessarily behaviorally interchangeable. Jev and Ollama decision
models have different input restrictions and confidence semantics. Stratos does
not rewrite inputs, truncate them, or emulate the decision API with chat prompts
to hide those differences.

Transient transport failures and HTTP 408, 429, and server errors allow up to
three retries after the first attempt, with a one-second delay and a 60-second
timeout per attempt. Malformed answers and contract errors fail immediately;
cancellation stops requests and retry waits. This is a bounded request policy,
not a general retry engine for workflows or tools with side effects.

Details: [Decision](docs/reference/DECISION.md).

## Make failure visible and recovery deliberate

Agents, child workflows, Decision, and direct MCP calls use ordinary exceptions
and rejected promises. An MCP tool error is an error, not successful domain data.
Authors can handle expected failures with `try`/`catch`; an unhandled failure
propagates and cancels the failed invocation's active descendants.

### Hooks control work; events describe it

Agents run noninteractively, with tool calls allowed by default. A before-tool
hook can allow, deny with feedback, or modify arguments. Denial lets the agent
try another approach; a thrown hook error fails the invocation. Silently ignoring
a broken control hook would remove the author's control while pretending it
still worked.

An after-tool hook can withhold a result and supply feedback, but cannot undo
the tool's side effects or promise removal from local artifacts. Arbitrary
successful-result replacement is not part of that contract. Lifecycle hooks
report start, completion, or failure; if error reporting itself throws, both
errors are retained rather than recursively calling the error hook.

Native event notifications are separate from awaited control responses. Merely
observing a tool event does not pause the harness. Codex uses an in-process MCP
hook bridge, and adapters supplement missing native failure observations where
available. Shared hooks do not imply identical native event coverage.

### Bound outstanding work without a global scheduler

Each top-level run and its children share agent limits: by default, 10 active
calls and 100 active-plus-queued calls. Waiting calls use the queue; exceeding
the outstanding limit raises a catchable error. Separate runs have separate
allowances.

This bounds agent admission within a run without a machine-wide daemon or
cross-process capacity pool. It does not bound all JavaScript memory or CPU use,
prove termination, or make overlapping calls to the same conversation valid.

### Cleanup follows ownership

Workflow contexts register resources before lazy initialization and attempt
cleanup on both success and failure. Closing a context prevents new work.
Cleanup attempts every owned resource even when one fails; errors are reported
without replacing the original execution error or failing an otherwise successful
result solely because cleanup failed.

`cancel()` signals synchronously; the pending execution reports when it stops.
Cancellation covers owned work, not unrelated sessions or external services.
There is no public early-disposal API; workflow completion owns resource disposal.
Native limits remain real: Codex abort stops its request but can leave descendant
or detached processes alive.

After a crash, stale run/worktree registrations are reconciled on later startup
or execution. There is no supervisor promising immediate process-tree cleanup.
Nor is there automatic whole-workflow retry or crash resume: repeating a workflow
is new work and may repeat side effects. Recovery must not pretend otherwise.

Details: [hooks](docs/reference/RUNTIME.md#agent-hooks),
[concurrency](docs/reference/RUNTIME.md#stratos-settings-and-agent-concurrency), and
[cleanup](docs/reference/RUNTIME.md#workflow-termination-and-cleanup).

## Preserve work before cleaning up worktrees

A Git worktree gives an agent a separate checkout without changing the workflow's
directory. It belongs to the agent configuration, not automatically to each
workflow. Multiple agents may deliberately share a named checkout without sharing
their conversations; authors coordinate their edits.

Unnamed worktrees receive a fresh adjective-noun name from two 256-word lists,
with collision checks against paths and branches. Named worktrees reuse existing
checkouts unchanged, or recreate them from a retained `stratos/<name>` branch.
That keeps names readable and makes committed progress recoverable.

New branches start from the locally cached `origin` default-branch reference,
without a fetch or a copy of uncommitted work. If that reference is unavailable,
Stratos uses local `HEAD` and warns. A conflicting directory that is not a valid
worktree is left untouched.

Managed checkouts live under the repository's `.stratos/worktrees/`. The harness
receives the actual worktree directory and a concise explanation that Stratos
owns its lifecycle. Native worktree isolation is not implicitly enabled.

Cleanup waits for the top-level run and its descendants, and skips a worktree
still used by another run. It removes only clean checkouts and retains their
branches. Staged, unstaged, or untracked changes preserve the checkout with a
diagnostic. Any `cleanup: false` request protects that checkout across later runs;
another request cannot silently revoke that protection.

Short, per-worktree OS locks coordinate bookkeeping, not agents' edits or network
work. Lock acquisition waits at most five seconds and never forcibly steals a
lock. If safe cleanup cannot be established, preserve the checkout. Stratos does
not automatically merge, reset, or discard work.

The governing trade-off is intentional: leaving something to clean up is better
than losing work or deleting a checkout another execution still needs.

Details: [worktrees](docs/reference/RUNTIME.md#agent-worktrees) and
[lock safeguards](docs/reference/RUNTIME.md#bookkeeping-lock-safeguards).

## Show what happened without inventing evidence

### Preserve the execution tree

Stratos normalizes native observations and creates OpenTelemetry spans, using
its GenAI conventions for AI operations where applicable. A span describes one
timed operation. One top-level run has one trace ID; each operation points to
its immediate parent. Children retain their own workflow execution IDs inside
that shared trace.

Agent model and tool calls are siblings under the agent span. Direct MCP calls
and Decision calls sit under their calling workflow. When the harness exposes
background-task, spawning-tool, or compaction ownership, those relationships
remain attached to the originating invocation, even across later prompts.

This tree helps explain where work happened instead of flattening every operation
into a list. A parent's success does not erase a caught child's failure, and
foreground completion does not prove background work finished. Intentional
cancellation is recorded separately from an operation error.

### Compose destinations as workflows compose

Trace export is explicit: file output or the OpenTelemetry Protocol (OTLP), using
HTTP JSON, HTTP Protobuf, or gRPC. Stratos exports directly through the
OpenTelemetry SDK; a separate collector service or per-run receiver is not
required.

A workflow exports its subtree to its own destination and inherited ancestor
destinations. A child can add a destination even if the parent has none.
Identical configurations are deduplicated. The same span identities are preserved
at each destination; a child-only destination can reference a parent it does not
contain.

This lets a reusable child retain its own observability without preventing the
parent from seeing the whole run. Failure at one destination does not stop another
export or fail workflow execution.

### Report observations, not guesses

Telemetry captures available prompts, responses, tool contents, configuration,
usage, and outcomes, while excluding credentials. It is best effort: collection,
parsing, and export failures produce diagnostics, not a workflow failure.
Control-hook failures remain different because they affect execution decisions.

Missing boundaries stay missing. Reconstructed Codex transcripts are labeled as
reconstruction, not exact provider requests or latency. A completion without a
start is an event, not an invented timed span. Unfinished observations close as
incomplete when ownership ends.

Preparation, native readiness, agent execution, and model work have different
timing boundaries. Nested durations are not added together as if independent.
Decision records structured state/questions and answers rather than inventing
chat messages. Unknown token usage, failed-attempt costs, and model accuracy are
not filled in from guesses.

Details: [trace hierarchy](docs/reference/TELEMETRY.md#trace-hierarchy-and-node-spans),
[routing](docs/reference/TELEMETRY.md#harness-telemetry-collection),
[startup timing](docs/reference/TELEMETRY.md#harness-preparation-and-startup-timing), and
[Decision measurements](docs/reference/TELEMETRY.md#content-and-measurement-mapping).

## Keep local evidence useful and bounded

Local logs and events exist even without trace export. Each top-level run has
`run.json`, `run.log`, and one combined `events.jsonl` for its agents and descendant
workflows. Identity fields distinguish interleaved work; serialized writes keep
individual JSONL records intact.

Artifacts live under `~/.stratos/runs/`, grouped by the invocation directory,
not a guessed repository root. Readable workspace names are checked against
stored absolute-path metadata, with hash suffixes for collisions or long names.
Run names include a portable UTC timestamp and execution ID. This keeps evidence
findable without mixing unrelated workspaces or concurrent runs.

Workflow code uses ordinary `console` methods. Stratos observes Node's native
console diagnostic channels rather than replacing console functions or requiring
a logging library. It does not promise capture of arbitrary stdout writes or
all subprocess streams, and it adds no custom log-level API.

Retention applies both a per-workspace and an overall limit: the latest 10 and
100 completed runs by default, configurable in user settings. A parent and all
its descendants are kept or removed together, while active runs are preserved.
A short-lived background cleanup process avoids delaying the result or requiring
a permanent daemon. External trace destinations and authored workflows are not
deleted by local retention.

Artifact failures are visible but do not fail the workflow. Logs and traces can
still contain sensitive business data: credential redaction is not permission
to publish every captured prompt or tool result.

Details: [local artifacts and retention](docs/reference/TELEMETRY.md#default-local-logs-and-agent-events).

## Make the CLI and guidance work for people and agents

`stratos` and `st` are equivalent. Workflow actions stay at the top level; other
resources use a resource/action/target shape. Positional workflow targets and
`--name` mean the same thing. Predictable spelling and explicit ambiguity errors
make commands easier to generate and automate.

Readable output is the default, with `--json` for a common result envelope.
JSON results and errors use standard output (stdout); logs and progress use the
separate diagnostic channel, standard error (stderr). Stable diagnostic codes
accompany readable messages and source locations when known. Warnings alone do
not fail a command, while actual failures use a nonzero exit status. Automation
should not have to guess whether a friendly-looking message hides an error.

The bundled authoring skill teaches discovery, writing, building, correction,
execution, and inspection. Root help includes that same skill rather than a
second copy that can drift. Command-specific help stays short and works without
discovery, authentication, or mutations. Detailed references are read on demand;
agents should inspect the tool declarations they need, not load every generated
schema into context.

Skill installation explicitly targets selected agents or all supported targets,
using user-level symlinks to the bundled files. There is no automatic install
hook, remote registry, or agent-settings rewrite. Ownership records allow repair
and removal of Stratos-managed links while preserving unrelated files and skills.
Installing guidance does not add an execution harness or prove that a native
agent has activated it.

The same restraint applies inside a run: add only context needed for correct
work, avoid repeating facts the harness already supplies, and keep workflow
conversations separate from their caller. Token conservation is a design concern,
not only a billing concern.

Details: [CLI](docs/reference/CLI.md), [authoring guidance](docs/reference/CLI.md#help-and-authoring-guidance),
and [skill installation](docs/reference/CLI.md#global-authoring-skill).

## Earn confidence with real evidence

Types and local fixtures catch important failures, but do not prove an external
integration works. Harness and MCP changes need authenticated checks of actual
tool effects, structured output, conversation continuation, and owned-resource
cleanup. Native policies and approved test credentials remain in force.

The live GPT test policy uses direct Azure for Codex and OpenCode; it is a
verification rule, not a production provider default. Ordinary contributor CI
runs local/offline checks without paid credentials. Authenticated continuous
integration remains a separate goal with trust, account, and spending decisions
still open.

Package verification installs the actual archive into an independent consumer,
rather than assuming imports work because the source checkout has dependencies.
The package intentionally includes TypeScript source and build inputs. Maintained
examples, regression tests, and attribution belong in the repository; one-off
probes, private logs, credentials, and machine-specific records do not.

Consistent linting and formatting reduce avoidable review noise. Behavioral tests
still matter: style compliance cannot establish correct cancellation, safe
cleanup, or honest output. Report failed, skipped, unverified, and successful
checks separately.

Design changes also need explicit review. A proposed improvement is not an
approved interface, and recording a decision does not implement it. Prefer a
small, complete solution to speculative extension points or infrastructure.

Details: [contributor guide](CONTRIBUTING.md) and
[testing requirements](CONTRIBUTING.md#testing).

## Recorded directions and open questions

Keeping a decision visible matters even when the runtime does not implement it.
These directions are not current feature guarantees or delivery commitments.

### Detect inactivity, not simply elapsed time

The recorded watchdog direction is to stop an executing agent after ten minutes
without meaningful activity, clean up its owned work, and return a catchable
timeout. Responsive agents should not be stopped merely because their total
execution is long, and queued calls should not consume an inactivity budget.

Output, tool activity, and real progress can count; a transport heartbeat or
the existence of a background process does not prove progress. Quiet background
work needs careful treatment so a legitimate long-running task is not mistaken
for a stalled one.

**Not implemented:** activity events do not currently enforce that timer.
Per-harness progress detection, quiet-task handling, bad-state detection, and
configuration still need decisions and verification. Preserving this direction
does not create a timeout setting or claim complete descendant cleanup.

### Renew credentials before a tool call, without replaying it

The recorded approach for expiry during an active agent request is an awaited
before-tool check: refresh the credential and update the harness's live MCP
connection before allowing the original call. Saving a new token to disk alone
does not update a running connection.

**Not implemented:** work was prioritized around workflow-start authentication
and between-request refresh. Safe in-flight updates still need native-harness
verification without replacing conversations or disrupting concurrent calls.
Revoked tokens and harnesses without a safe update mechanism remain open.
Post-failure tool replay is not an agreed workaround.

### Keep future possibilities separate from selected interfaces

| Area | Preserved direction or boundary |
|---|---|
| Warm-up and caching | Startup-latency improvements are worth investigating, but no warm-session pool or harness warm-up/cache API has been selected. Existing conversation reuse and build caching are separate. |
| Remote agents | The generic agent abstraction can extend beyond local execution; no remote transport or deployment contract is selected. |
| Calling-agent harness | Automatically matching the caller's harness remains a goal, not current selection behavior, and would not mean sharing the caller's conversation. |
| Workflows as MCP tools | The external-tool clients do not constitute a Stratos workflow MCP server. Its transport, lifecycle, discovery, and update behavior remain undecided. |
| Durability and memory | There is no automatic whole-run retry, crash resume, or persistent conversation memory. Adding them requires explicit side-effect and ownership semantics. |
| Separate metrics | Traces carry available usage and timing today. Metric definitions, dimensions, routing, and exporters have not been selected. |
| Additional APIs | Pi, agent-to-agent communication, direct model wrappers, public parallel helpers, and a no-code interface are not promised by the existing primitives. |
| Provider policy and authentication | Native login support is not provider approval. Subscription-policy applicability, multi-account MCP selection, and safe in-flight renewal are not settled by the common API. |
| Credentialed CI | Automated real-integration coverage remains the goal; trusted triggers, accounts, spending limits, and outage handling need explicit choices before enabling it. |

The detailed references retain the precise contracts:
[Runtime](docs/reference/RUNTIME.md), [MCP](docs/reference/SPEC.md),
[Telemetry](docs/reference/TELEMETRY.md), [CLI](docs/reference/CLI.md), and
[Decision](docs/reference/DECISION.md). This philosophy explains why those choices fit
together without turning unresolved questions into new requirements.
