# Workflow and agent runtime

This reference explains what happens when Stratos runs your code: how builds
are prepared, configuration is resolved, conversations are owned, and resources
are cleaned up. Use it when you need the precise behavior behind the
[primitives](../primitives.md). For a guided first run, start with
[Author a workflow](../authoring.md).

For the reasons and trade-offs behind these contracts, see
[Design philosophy](../../DESIGN_PHILOSOPHY.md).

## Runtime model

A workflow exports `workflow({input, output, run})`. The CLI or a generated
child wrapper prepares the build, validates input, establishes a fresh
execution context, performs workflow-start MCP authentication, calls `run`,
validates its output, and closes owned resources. Build and schema commands
load the definition without calling `run`; actions belong inside that function.

An agent object owns one conversation. A child-workflow object instead starts
a new invocation on each call. Both use the current workflow context, so
their resources and errors remain attached to the right invocation.
The [specification](SPEC.md#signature-and-schema-rules) defines the public
workflow contract; this page defines its execution behavior.

| Question | Reference |
|---|---|
| Where do files and agent edits go? | [Working directory](#execution-working-directory), [worktrees](#agent-worktrees) |
| When does Stratos install or compile anything? | [Discovery](#entrypoint-and-discovery), [builds](#dependencies-and-build) |
| How does a parent call a child? | [Nested execution](#nested-workflow-execution), [generated wrappers](#generated-workflow-wrappers) |
| How do I configure and reuse an agent? | [Agent objects](#configured-agent-objects), [configuration](#named-agent-configurations), [prompts](#agent-prompt-templates) |
| Which model, harness, and credentials are used? | [Harness selection](#harness-selection), [authentication](#harness-authentication), [model IDs](#explicit-model-selection) |
| How do I control tools and validate answers? | [Built-in tool selection](#agent-built-in-tool-selection), [MCP selection](#agent-mcp-selection), [hooks](#agent-hooks), [agent output](#agent-output) |
| What happens on failure or cancellation? | [Lifecycle controls](#public-lifecycle-controls), [errors](#primitive-error-contract), [cleanup](#workflow-termination-and-cleanup) |

These are execution contracts, not a promise of a sandbox, durable resume,
or uniform native-harness capabilities. Unimplemented behavior is called out
explicitly, including the [inactivity watchdog](#agent-inactivity-watchdog).

## Execution working directory

A workflow executes with the invoking process's current working directory. For direct terminal invocation, this is the terminal's current directory. Discovering or loading a workflow from another directory must not change its execution working directory to the workflow's directory.

Child workflow invocations retain the original invocation working directory as well. Nested execution does not switch to the child's source directory.

### Agent working directory

Agents accept `workingDirectory` in their YAML configuration and at the call site. Workflow code may supply a dynamically computed value, including one from workflow input. Apply the existing field precedence: call site > invocation override > YAML configuration.

Resolve relative paths against the workflow execution’s working directory (the original invoking directory), not the workflow source directory. If no effective setting is supplied, the agent uses that invocation directory. Selecting an agent directory does not change the workflow process’s working directory.

```yaml
agents:
  implementer:
    workingDirectory: packages/backend
```

```ts
const implementer = createAgent({
  configId: "implementer",
  workingDirectory: input.targetDirectory,
});
await implementer.execute("Implement the fix.");
```

When worktrees are enabled, the resolved `workingDirectory` identifies the repository from which Stratos creates the worktree. The created worktree path becomes the effective directory for all operations of that agent object, including the directory passed to the harness. The working directory and worktree remain fixed across `execute()` calls on that object. A different directory/worktree requires a separately configured agent object.

### Agent worktrees

Set `worktree: { enabled: true, name?: string, cleanup?: boolean }` in agent YAML configuration or at object creation. Managed checkouts live under `<repository>/.stratos/worktrees/<name>/`; new branches use `stratos/<name>`. Workflows keep their invocation directory, while agents use the checkout as their effective working directory.

Omitting `name` creates a fresh adjective-noun name from two 256-word lists, retrying on checkout or branch collisions. An explicit name reuses an existing worktree unchanged, including its current branch, commits, and uncommitted changes. If the checkout is absent but `stratos/<name>` exists, Stratos recreates it from that branch. A conflicting path that is not a valid worktree of the selected repository raises a catchable error and is left untouched.

Fresh branches start from the locally cached `origin` default-branch ref without fetching or copying uncommitted changes. If that ref is unavailable, Stratos uses local `HEAD` and reports a warning.

Multiple agents may share a named worktree concurrently without sharing their conversations. Authors coordinate concurrent file edits. Cleanup waits until the top-level execution and its descendants finish. With `cleanup: true` (the default), Stratos removes only a clean checkout and retains its branch. Staged, unstaged, or untracked changes preserve the checkout and produce a soft diagnostic.

Any `cleanup: false` request persistently protects the checkout, including across later runs; subsequent `cleanup: true` requests do not clear that protection. Explicit removal and recreation starts a new checkout lifecycle. Across separate runs, cleanup skips worktrees still in use; the last finishing run may clean up subject to the same preservation checks. Stratos does not automatically merge, reset, or discard changes.

### Worktree context supplied to the harness

Stratos passes the effective worktree path as the harness's execution directory and identifies it through the supported system/developer instruction mechanism. Stratos retains responsibility for creation and cleanup; this does not enable a harness's native worktree isolation mode.

Keep the added context minimal: worktree identity/location, source repository, branch at initialization, and Stratos's lifecycle ownership, only to the extent needed beyond the harness's existing context. Avoid duplicating directory/branch facts already communicated accurately or needlessly repeating the context on successive requests. Follow the [minimal-context principle](./SPEC.md#design-principle-minimal-context-and-conservative-token-usage).

Native configuration references:

- **Claude Code:** use SDK `cwd` and `systemPrompt` (or the preset's `append`). See [manual worktrees](https://code.claude.com/docs/en/worktrees) and [system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts).
- **Codex:** the App Server supports thread `cwd`; configuration supports `developer_instructions`. For Ollama, Stratos uses native `instructions` so the configured prompt reaches the Responses API as system instructions. See [App Server](https://learn.chatgpt.com/docs/app-server) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
- **OpenCode:** use `directory` and the prompt API's `system` field. Its environment prompt already includes the working directory and workspace root. See the inspected v1.4.3 [SDK types](https://github.com/anomalyco/opencode/blob/v1.4.3/packages/sdk/js/src/gen/types.gen.ts) and [environment prompt](https://github.com/anomalyco/opencode/blob/v1.4.3/packages/opencode/src/session/system.ts).

### Best-effort shutdown and crash reconciliation

Normal workflow cleanup attempts to close owned harness sessions. Later startup/run reconciliation handles stale run/worktree registrations after a runtime process dies. There is no supervisor process guaranteeing immediate termination of descendants after a crash.

Brief cross-process `fs-ext`/`flock` locks coordinate worktree bookkeeping and cleanup without serializing agent execution. If active use cannot be established safely, Stratos preserves the worktree and reports a soft error.

### Bookkeeping lock safeguards

Use one bookkeeping lock per worktree, so unrelated worktrees do not contend for the same lock.

- Never hold multiple bookkeeping locks simultaneously or reacquire a lock already held by the same operation.
- Release locks in `finally`, including when the protected operation throws.
- Do not hold bookkeeping locks while waiting for agents or network requests.
- Limit lock-acquisition waiting to five seconds. If acquisition exceeds that limit, report the issue. For cleanup, preserve the worktree and skip deletion. Never forcibly steal the lock.

The five-second limit applies to waiting to acquire a lock, not agent execution or how long a lock may be held. Expiry does not release another process’s lock. These safeguards do not require a supervisor.

## Entrypoint and discovery

The entrypoint file defaults to `workflow.ts` in the workflow directory. Authors can override the file with `entrypoint` in `workflow.yaml`, for example `entrypoint: review.ts`. This selects the module; Stratos reads its default-exported workflow definition and invokes its `run` function.

Discovery reads workflow metadata from `workflow.yaml` and exposes names and
short descriptions. It must not install dependencies, compile code, load
entrypoint modules, generate schemas/wrappers, or connect to MCP servers merely
to list workflows.

`list` reflects the workflow directories currently present in the discovery roots, regardless of stale generated wrappers. SHA-256 freshness checks compare authored files and referenced workflow hashes with the last successful build. New or changed workflows are marked `not built`, with guidance to run `stratos build <workflow>`. Listing hashes files but does not install, compile, generate wrappers, or invoke workflow code. Successful build hashes are recorded in `<workflow>/dist/.stratos-build.json`; a missing record means `not built`, and failed builds do not mark the workflow built. The record is generated locally and excluded from Git with `dist/`.

Workflow access has three stages:

1. **Get name and short description:** read `workflow.yaml`; listing additionally checks SHA-256 freshness to report built/not-built status, without build or wrapper preparation.
2. **Get manual and schemas:** `describe` automatically performs a full build if the requested workflow lacks a current successful build. This includes validation, required dependencies, wrapper generation, and compilation. Return the manual and schemas only after a successful build; surface build failures instead. Reuse a current successful build when available, load its definition, and convert the Zod input/output schemas in memory. `schema` uses the same preparation but returns only schemas. Successful builds update the build-status record. This stage does not invoke any workflow's `run` function. Preparation follows the dependency order defined below.
3. **Run workflow:** if the workflow has no current successful build (including missing or stale build status), log `not built, running build first` and automatically perform the build, including required preparation and building. Execute only if building succeeds; a build failure surfaces to the caller without invoking the workflow. A successful build updates the build-status record. Otherwise reuse valid built preparation, validate arguments, and execute `run` under the runtime lifecycle. The build message is progress output and goes to stderr so JSON stdout remains clean.

Preparation is lazy at explicit building, schema retrieval, or execution, not discovery. Changes to workflows require refreshing affected schemas/wrappers and builds; a change to a referenced workflow must also invalidate artifacts that depend on it. Use SHA-256 for workflow content hashes. During listing and before building, schema retrieval, or execution, read and hash authored workflow files, including TypeScript, `workflow.yaml`, `package.json`, and `package-lock.json`; exclude generated files and `node_modules`. Include referenced workflows' hashes in freshness checks. Account for file paths as well as contents so additions, deletions, and renames invalidate affected artifacts. Listing uses these freshness checks only to report status; artifact preparation remains lazy.

<a id="workflow-description-enforcement-approved-not-yet-implemented"></a>

### Workflow-description enforcement

The [description contract](SPEC.md#workflow-descriptions) uses
`shortDescription` and `longDescription`, exposed through
[progressive discovery](CLI.md#progressive-discovery).

Enforce the required strings, nonblank content, single-paragraph short format,
and Unicode-code-point limits in the shared manifest validator in
`src/workflows/discovery.ts`. Discovery, build, `describe`, `schema`, and
execution must use the same validation, including explicit-path selection.
These are metadata checks, not compilation or workflow-body validation.
Report the manifest path, field, actual length, and maximum for length errors.
Preserve existing discovery error reporting; never silently omit invalid
metadata, truncate descriptions, or synthesize replacements.

Construct list and describe responses from explicit fields rather than
serializing the complete manifest. Listing may read the manual as part of YAML
parsing but must not expose it or schemas in the catalog response. Preserve
existing freshness checks and the prohibition on preparing workflows to list
them.

`describe` must reuse `schema`'s dependency/build/module-loading lifecycle,
freshness checks, and error handling rather than introduce a second preparation
path. It must not invoke `run`; preparation can still install dependencies or
contact MCP servers. Do not require state proving that a caller fetched
descriptions before execution. Description content is guidance, not enforcement
of runtime safety or input constraints.

## Dependencies and build

The minimum supported Node.js major version is **24 (LTS)** on macOS and Linux.
Use the latest available `24.x` update as the baseline for the CLI, SDK, and
workflow execution. Workflows still require TypeScript compilation; running
on Node does not bypass type checking.

`stratos build <workflow>` (or `stratos build --name <workflow>`) builds the selected workflow and its required dependencies. `stratos build` without a target builds all workflows in the current project's discovery root. Both forms are also available through `st`.

A project-wide build continues processing independent workflows when another workflow fails. Report all build results and exit with failure if any build fails. A failed required dependency still prevents a dependent workflow from building successfully; unrelated workflows remain isolated. This does not prescribe parallel build scheduling.

Each workflow declares its npm dependencies in `package.json` alongside its TypeScript files, with `package-lock.json` recording resolved versions.

Stratos manages one shared Stratos SDK installation per discovery root, under `<workflows-root>/node_modules/@stratoscli/stratos/`. Workflows and generated wrappers use that shared SDK; individual workflows may retain their own dependencies and libraries, but must not install a closer copy that shadows it. The CLI must execute workflows through this same SDK instance, rather than establish context through a separate bundled copy. Runtime context setup and SDK primitives must access the same `AsyncLocalStorage` instance while preserving distinct contexts for each invocation. Production loading uses a root-local ESM bridge importing the shared root-installed SDK; version matching is defined below.

The shared SDK version must exactly match the running CLI version (for example,
CLI `1.2.0` uses SDK `1.2.0`). Before `build`, `describe`, `schema`, or `run` reuses artifacts,
Stratos checks the root's SDK. A missing or different version is installed
through npm and invalidates that root's builds, including when an older CLI
is used. Installation failures stop preparation. Matching installations are
reused; authors do not manage this dependency manually. Synchronization is
lazy per root, not a background update of all roots. `list` remains read-only.

When a workflow is prepared for building, schema retrieval, or execution, Stratos automatically installs required dependencies and builds it as needed. Dependency installation or build failures must stop execution and propagate the error to the caller.

Stratos must reuse an existing, up-to-date build and skip rebuilding it, subject to the explicit-build MCP freshness check below. Dependency setup and building are associated with the workflow directory; workflow execution retains the invoking process's working directory.

Stratos uses the TypeScript compiler (`tsc`) to check types and compile workflow code to JavaScript, then executes the generated JavaScript with Node.js. Type-checking errors must stop the build and be returned to the caller before workflow execution.

During preparation, Stratos manages `"type": "module"` in both the shared workflow root and individual workflow `package.json` files. Create missing package metadata and preserve existing fields/dependencies. An explicitly configured CommonJS package is a build error; do not silently overwrite its module type.

Stratos owns compiler configuration and passes settings explicitly as flags to the `tsc` command instead of using a workflow `tsconfig.json`. Workflow authors do not need to generate or check in a TypeScript configuration file. The compiler baseline is ES2022 with NodeNext modules/module resolution, strict checking, and no emit on errors.

Stratos rebuilds when workflow TypeScript source files, `package.json`, `package-lock.json`, Stratos-managed compiler settings, or the TypeScript compiler version changes, or when generated JavaScript is missing. Otherwise, it reuses the existing build. Changes only to agent settings in `workflow.yaml`, such as model or reasoning effort, do not require rebuilding.

### Preparation order

Explicit authoring builds support the
[manifest-first MCP preparation flow](./SPEC.md#mcp-wrapper-generation-and-storage):
prepare all MCPs declared in the selected workflow's manifest, including those
not yet imported. When the entrypoint is absent, successful MCP preparation
does not mark the workflow built or produce a child-workflow wrapper.
Compilation and schema validation still require the definition; `run` and
`schema` and `describe` cannot inspect a manifest-only workflow.

Every explicit build rediscovers tools and regenerates MCP wrappers, even when
the authored-file hashes are unchanged. Cached workflow build status cannot
bypass this check. Authentication/discovery failures fail the build; changed
wrappers invalidate affected compiled artifacts and require checking their
consumers against the new types. This does not execute MCP tools or guarantee
their future runtime availability.

Preparation reuses current artifacts and builds required child workflows before their parents:

1. Read metadata and inspect imports to identify required child workflows without executing workflow code. Reject detected workflow cycles; runtime cycle rejection remains required for calls not resolved statically.
2. Install required dependencies, including the shared Stratos SDK.
3. Prepare directly used MCP wrappers needed for compilation; explicit authoring builds additionally prepare declared MCPs regardless of imports.
4. Recursively build required child workflows first.
5. Load each compiled child definition and read/validate its input/output Zod schemas without calling `run`.
6. Generate the child's typed workflow wrapper from its schemas before compiling the parent.
7. Compile the parent, load its definition, validate its schemas, and generate its own callable wrapper.
8. Record successful build hashes only after required preparation succeeds.

Steps 5–6 are part of completing each child's recursive build, not a second execution of that build. Loading a definition evaluates its module; the workflow's `run` function is never invoked during preparation. JSON Schema conversion remains in memory.

`stratos build <workflow>` prepares only the target and required dependencies. `stratos build` prepares the current project root, processing children before parents and continuing independent workflows after failures. An unrelated invalid workflow must not block a targeted build. Discovery alone does not prepare wrappers. This order applies equally when `describe`, `schema` or `run` automatically builds a workflow.

### Explicit cleanup

`stratos clean` removes generated workflow/MCP wrappers, compiled output, and build-status records across the current project root, including leftovers for deleted workflows. `stratos clean <workflow>` (or `--name`) limits removal to that workflow and invalidates dependent builds. Preserve authored files, installed dependencies/shared SDK, and credentials. Subsequent preparation regenerates required artifacts. See [CLI cleanup](./CLI.md#cleaning-generated-artifacts).

### Generated artifacts and Git ignores

Compiled workflow JavaScript goes in the workflow's `dist/` directory.
Generated TypeScript wrapper sources remain separate: root-level `.generated/`
for workflow wrappers and workflow-local `generated/mcp/` for MCP wrappers.
The build mirrors source paths relative to the discovery root into each
workflow's own `dist/`, using the discovery root as `rootDir` and
`<workflow>/dist` as `outDir`. Compilation includes the entrypoint and its
imported source closure. Child implementations are built independently and
invoked through the runtime-managed wrapper.

For example:

```text
workflows/
├── node_modules/@stratoscli/stratos/
├── .generated/summarize.ts
├── review-pr/
│   ├── workflow.ts
│   ├── node_modules/
│   └── dist/
│       ├── review-pr/workflow.js
│       └── .generated/summarize.js
└── summarize/
    ├── workflow.ts
    ├── node_modules/
    └── dist/summarize/workflow.js
```

The parent source and compiled entrypoint both import
`../.generated/summarize.js`. Workflow-local MCP wrappers are mirrored under
the workflow's portion of the output tree as well. This preserves relative
imports and workflow-local dependency resolution; the shared SDK remains
available from the discovery root. Compilation uses ES2022/NodeNext with
strict checking and no emit on errors; a root-local ESM bridge loads the SDK.

During setup/preparation, Stratos adds explicit `.gitignore` rules for the relevant root-level `.generated/` and `node_modules/` directories and each workflow's `generated/`, `dist/`, and `node_modules/` directories. Rules must be scoped to the managed workflow locations so unrelated project directories are not ignored. Preserve existing ignore entries and avoid duplicating rules.

Directory naming alone does not exclude files from Git. If generated artifacts are already tracked, report this to the caller rather than silently modifying the Git index; adding ignore rules does not untrack committed files.

## Nested workflow execution

A workflow can invoke another workflow and use its result to compose larger workflows from smaller ones. Stratos manages the child invocation as a nested workflow execution, including preparation, loading the child's workflow configuration, and applying its input/output contract. A direct import and function call alone does not provide this runtime-managed behavior.

Workflow composition is limited to the same discovery root. Project workflows
can reference other workflows in that project root, and user-level workflows
can reference others in the user root. Cross-root references are rejected;
nested resolution never falls back to another root.

Workflow names declared in `workflow.yaml` must be unique within a discovery root. Stratos must reject duplicate names in the same root and identify the conflicting workflow directories in the error. Identical names in different roots do not violate this rule.

Each child workflow uses its own `workflow.yaml` configuration, including its agent and MCP settings. Parent configuration and parent invocation overrides do not automatically carry over. The parent can explicitly supply overrides when invoking the child; overrides merge field by field, with unspecified fields retaining the child's configured values.

Parent and child workflows share one Node.js process. Primitives and generated wrappers access their execution context internally as defined below. Child errors are catchable; parent failure cancels active descendants.

### Configured child-workflow objects

Authors create a configured child-workflow object through its generated typed wrapper, then invoke `execute(input)` repeatedly. Creation binds the workflow reference and override defaults; it does not start a child execution. The object can be passed to helpers. Each `execute(...)` starts a fresh runtime-managed child invocation with its own execution ID, context, session scope, inputs, and cleanup. Reusing the configured object must not carry agent conversations between invocations. Parallel executions on the same configured object are allowed as independent child invocations, subject to existing execution limits and cycle checks.

The configured object has no session resources that authors must close. Each child execution owns and cleans up its agents. Same-root resolution and explicit generated typed references are required; arbitrary workflow-name lookup is unsupported. Bind overrides at construction; `execute(input)` has no per-execution override argument.

### Execution context

Every workflow invocation gets a fresh execution context, including repeated or parallel invocations of the same workflow. The context contains that invocation's overrides and its configuration resolved from its own `workflow.yaml`, and associates calls with its session scope and lifecycle state. YAML configuration is parsed and validated into runtime objects; it is not applied as global Node.js configuration or environment variables.

Stratos establishes the context using Node.js `AsyncLocalStorage` before invoking `run(input)`. Agent calls, Decision calls, generated MCP wrappers, and generated child-workflow wrappers retrieve it internally. Workflow authors create configured agent objects, call `decision(...)`, and use generated wrappers directly, without a context argument. Calling these primitives outside an active workflow execution raises an error. The pure `choice`, `score`, and `noul` helpers build question objects without executing a primitive; see [DECISION.md](./DECISION.md).

Awaited and parallel operations within an invocation retain its context. A child wrapper initiates a fresh child context using the child's configuration and explicitly bound overrides, without inheriting parent configuration or overrides. Parent, child, and sibling contexts remain distinct while sharing the top-level agent concurrency allowance. No mutable global current-execution variable is used.

### Generated workflow wrappers

A root-wide `stratos build` generates typed wrappers for all valid workflows in the current project root. A targeted build, including automatic builds for schema retrieval or execution, prepares only the requested workflow and its required dependencies. Discovery lists workflows immediately; wrappers become available when built. Each discovery root owns a `.generated/` directory: `./.stratos/workflows/.generated/` for project workflows and `~/.stratos/workflows/.generated/` for user workflows.

```text
.stratos/workflows/
├── .generated/             # Generated locally; excluded from Git and discovery
│   ├── review-pr.ts
│   └── release.ts
├── review-pr/
│   ├── workflow.yaml
│   └── workflow.ts
└── release/
    ├── workflow.yaml
    └── workflow.ts
```

Workflows in the same root reference wrappers through stable relative imports, for example `../.generated/review-pr.js`. Each wrapper default-exports a factory accepting optional `{ overrides }`, with `agents` and `decision` named override maps. Values merge field by field with the child's configuration. The object's `execute(input)` accepts the child's typed input and returns a Promise of its typed output through the nested-execution runtime; failures reject and are catchable. Omitted overrides retain the child's settings. The top-level workflow input name `overrides` remains reserved.

```typescript
import createReviewPr from "../.generated/review-pr.js";

const reviewPr = createReviewPr({
  overrides: {
    agents: {
      validator: { effort: "max" },
    },
  },
});

const first = await reviewPr.execute({
  repository: "org/repo",
  pullNumber: 42,
});

// A fresh child execution, with the same configured override defaults.
const second = await reviewPr.execute({
  repository: "org/repo",
  pullNumber: 43,
});
```

Generated files are excluded from Git and recreated locally for each teammate. Workflow discovery must exclude `.generated/`. Generating a child-workflow wrapper from its loaded definition does not itself execute the workflow or connect to its MCP servers. The full preparation process may first need directly used MCP wrappers, as required by the preparation order above; this is separate from child-wrapper emission. These shared workflow wrappers are separate from workflow-local MCP wrappers under `generated/mcp/`.

### Code-derived workflow schemas

Each workflow defines input and output Zod schemas in TypeScript. Stratos converts these declarations to JSON Schema using Zod's native conversion; authors do not maintain separate handwritten JSON Schema contracts. Function and wrapper types are inferred from the Zod schemas. Use `stratos list` for discovery and `stratos schema <workflow>` to retrieve the contract.

Conversion reads runtime Zod schema objects without invoking `run`. Obtaining these objects evaluates their declaring modules, so keep workflow actions out of module-level code. Each entrypoint default-exports `workflow({ input, output, run })`. Public `name`, `shortDescription` and `longDescription` belong in `workflow.yaml`. JSON Schemas are generated in memory, while wrappers, compiled JavaScript, and freshness hashes are persisted.

Discovery reads metadata and checks freshness without preparing artifacts. Schema retrieval prepares required wrappers and records workflow hashes as described above. Explicit builds can also prepare MCP wrappers before the entrypoint exists.

Stratos must refresh a workflow's generated schemas and wrappers when its source code changes. Content hashes track workflow changes, including referenced workflows. SHA-256 is the chosen hash algorithm. The coverage and check timing are defined above. Compiler settings/version also invalidate builds as specified under dependencies and build. During explicit builds and automatic build/preparation for `run`, `describe` or `schema`, remove stale Stratos-generated workflow wrappers for deleted or renamed workflows. References to missing workflows must produce actionable build errors rather than reuse outdated wrappers. Previously compiled wrapper copies must not make an affected build appear current. Listing reflects the current workflow directories without modifying generated files. Cleanup is limited to Stratos-generated artifacts, not authored files.

Preparation follows the [dependency order above](#preparation-order).
Compilation follows the [mirrored layout](#generated-artifacts-and-git-ignores).

### Schema conventions

- Input and output schemas must describe objects. A workflow with no output data declares an empty output object and returns `{}`. Top-level `overrides` is reserved and cannot be an input field.
- Every declared input/output field, including nested fields, must have a description exposed in JSON Schema. An empty string is valid when the field name is self-explanatory (for example, `count`, `startIndex`, or `endIndex`); checks must not reject a description merely because it is empty.
- Public contracts support JSON-compatible strings, numbers, booleans, null, arrays, and nested objects, with optional fields, defaults, enums, and constraints that can be faithfully represented in JSON Schema.
- Transformations and custom refinements that cannot be faithfully represented in JSON Schema must not appear in public schemas. Business checks and transformations belong inside `run`.
- Unknown input fields must be rejected rather than silently stripped. Authors can express this with strict Zod objects, including nested input objects. Defaults apply to omitted fields; null is accepted only where explicitly declared.

## Invalid workflows and execution errors

An invalid workflow does not block unrelated workflows. A missing or invalid required child wrapper does block parent preparation, even if its call is conditional: the parent must compile against the child's contract.

At execution, child errors reject their promises. A caught child error does not fail the parent or unrelated siblings; the failed child still cleans up its resources. Unhandled errors propagate upward. A top-level failure cancels and cleans up its active descendants. A valid wrapper establishes the callable contract, not a guarantee that child execution succeeds.

## Configured agent objects

Workflow authors create a configured agent object once and invoke `execute(...)` on it repeatedly. The object retains its configuration defaults, template-variable defaults, and logical conversation/session identity. Repeated sequential executions on the same object continue the conversation; creating another object establishes an independent logical session. The object may be passed to helpers within its owning workflow execution. Workflow scope, parent/child isolation, rejection of concurrent use of the same session, and automatic cleanup when the owning workflow finishes remain required.

`createAgent({...})` synchronously establishes configuration and logical identity without initializing harness resources. The first `execute(...)` initializes the harness; later calls reuse that conversation. Only the user prompt and its variables vary between requests. There is no public `start()`, `sessionId`, early `close()`, or warm-up API. Public `cancel()` signals cancellation synchronously; resource cleanup is automatic when the owning workflow finishes.

### Public lifecycle controls

Cancellation scope includes all work owned by that agent session: the active request, background shell/tool tasks, and background subagents and their work, including tasks launched by earlier completed prompts. This also applies when only background work remains active. It does not cancel other agent sessions or terminate externally owned/shared services. Native interrupt alone is insufficient where background work survives; the adapter must also request termination of those owned tasks. The conversation remains available for a later explicit execution under the existing continuation rules.

Cancelling an active request rejects its pending `execute()` promise with a catchable cancellation error. `cancel()` is synchronous and signal-only; await the pending execution to observe completion. Returning from `cancel()` is not evidence that execution has stopped.

A later explicit `execute()` on an initialized object attempts to continue the same conversation with the new prompt and fixed configuration, without replaying the cancelled request. Continuation failures remain catchable. This cannot reopen a context closed by workflow completion, failure, or cancellation. Resource disposal is automatic; no public `close()` or `dispose()` is exposed.

<a id="codex-sdk-cancellation--accepted-mvp-limitation"></a>

### Codex cancellation limits

The Codex SDK integration uses per-execution `AbortController` / `AbortSignal`
cancellation. It stops the active request and rejects its promise, but shell
commands, subagent-owned processes, or detached/background work may survive.
This is a Codex-specific exception to all-owned-work cancellation, not a
relaxation of other harness contracts. Stratos still attempts automatic cleanup.
It does not add custom native SIGINT delivery or guarantee descendant
termination. Cancellation remains catchable, and later explicit calls attempt
same-conversation continuation.

### Initialization failure and retry

A failed initialization does not permanently invalidate the configured agent
object. The current `execute()` rejects with a catchable initialization error.
If the workflow handles it and calls `execute()` again on the same object,
Stratos attempts initialization again using its fixed configuration. A new
agent object is not required solely because initialization failed.

This is a new attempt on a later explicit execution call, not an automatic retry loop inside the failed call. After initialization succeeds, subsequent executions reuse that session. Failed attempts remain subject to the existing partial-resource cleanup requirements. Context closure still prevents new execution or initialization attempts.

### Continue after execution failure

When execution fails after initialization, `execute()` rejects with a
catchable error. A later explicit call on that object attempts to continue
the same conversation with the new user prompt and fixed configuration.
An execution failure alone does not permanently invalidate the object.

This does not automatically replay the failed request or silently replace the conversation. Continuation is an attempt, not a guarantee that a damaged or unavailable native session will recover; a failure to continue remains catchable.

The existing error propagation, resource cleanup, and context-closure rules still apply. This decision does not reopen closed agents. Overlapping execution is handled separately under the concurrent-use rule below.

<a id="fixed-agent-configuration-for-mvp"></a>

### Fixed agent configuration

Configure the agent object once. Resolve its settings for initialization from explicit object-creation settings > workflow invocation overrides > `workflow.yaml`, preserving unspecified lower-priority fields. Harness, model, effort, system prompt, MCP and built-in tool selection, working directory/worktree, hooks, and optional output schema remain fixed for that object. `execute()` adds the next user prompt to the same conversation; it does not reconfigure the agent. Use a new object when different configuration is required.

System-prompt files and templates resolve during initialization and remain
fixed. User prompts are prepared before each request, from a literal string,
plain file, template with variables, or configuration reference. An execution's
configuration reference supplies only `prompt` and `templateVariables.prompt`;
it does not reconfigure the system prompt, harness, model, effort, MCPs, or
output schema. See the [execute signature](#agent-execute-signature).

This restriction concerns author-controlled configuration. MCP credentials are rechecked between requests; renewal during an active request is not implemented.

### Agent creation API

The factory is `createAgent({...})`. Its argument holds settings directly: optional `configId`, harness, provider, model, effort, prompts and template-variable defaults, allowed MCPs, allowed/disallowed built-in tools, working directory, worktree settings, hooks, and optional output schema. Named configuration is a convenience; explicit creation fields remain supported.

`configId` selects the full named agent configuration, including `systemPrompt`, `allowedMcps`, `allowedTools` and `disallowedTools`. Resolve field by field using explicit creation fields > workflow invocation overrides > YAML, retaining unspecified fields from lower-priority sources. Creation is synchronous; resolve settings and initialize the harness lazily on first execute as specified above.

For example, these fields can be part of the selected configuration in `workflow.yaml`:

```yaml
agents:
  reviewer:
    systemPrompt:
      file: "prompts/reviewer.md"
    allowedMcps:
      - github
```

```typescript
const reviewer = createAgent({ configId: "reviewer" });

// Explicit creation fields override their configured values.
const focusedReviewer = createAgent({
  configId: "reviewer",
  systemPrompt: { file: "prompts/focused-reviewer.md" },
  allowedMcps: ["github"],
});
```

The example shows the selected fields, not all required harness/model configuration. Creation reads the full agent configuration; a configuration reference passed to execute supplies only the user prompt and its variables.

### Agent execute signature

The public interface is:

```typescript
type PromptSource =
  | string
  | { file: string }
  | { template: string }
  | { configId: string };

interface Agent<TOutput = string> {
  execute(
    prompt: PromptSource,
    templateVariables?: Record<string, unknown>
  ): Promise<TOutput>;
  cancel(): void;
}
```

`TOutput` defaults to string or is inferred from the agent's configured `outputSchema`. The first argument supplies the prompt source. The optional second argument is a dictionary of user-prompt variables directly, not a full agent configuration or a field-grouped variables object. A configuration reference reads only `prompt` and `templateVariables.prompt` from the selected configuration; all other agent settings stay fixed. Plain file and template paths remain relative to the workflow root.

```typescript
// Literal prompt.
await reviewer.execute("Review these changes.");

// Plain file.
await reviewer.execute({ file: "prompts/review.md" });

// Template with variables supplied in code.
await reviewer.execute(
  { template: "prompts/review.hbs" },
  { language: "TypeScript", code: sourceCode }
);

// Prompt and its configured variables.
await reviewer.execute({ configId: "review" });

// Configured prompt with variables supplied in code.
await reviewer.execute(
  { configId: "review" },
  { language: "TypeScript", code: sourceCode }
);
```

## Agent and harness adapter boundary

The common Stratos Agent/runtime owns execution rules; each harness adapter translates requests into native SDK operations. Workflow authors use the common Agent API.

| Responsibility | Common Stratos Agent/runtime | Harness adapter |
|---|---|---|
| Configuration | Resolve fixed object settings using field-by-field precedence | Translate resolved settings into native SDK options |
| Prompts | Load/render the fixed system prompt for initialization and prepare each user prompt | Submit the resulting prompts |
| Conversation | Enforce workflow/session scope, sequential use, and fixed configuration | Create and continue the native conversation |
| Concurrency | Enforce running/outstanding limits and queue admission | Execute requests when admitted |
| MCPs | Select workflow-defined servers and obtain valid credentials | Configure the harness to use those servers through its own MCP connections |
| Structured output | Convert Zod to JSON Schema and validate the returned value | Use native structured-output support and extract its result |
| Events | Consume common events for hooks, activity tracking, logs, and traces | Translate native events into the common event format |
| Cancellation | Signal cancellation of owned work | Translate cancellation to supported native operations; see the Codex limitation above |
| Cleanup | Decide when cleanup is required and coordinate it | Release native sessions, connections, and owned processes |

The common Agent can use existing runtime facilities for configuration, credentials, concurrency, and telemetry; this split does not require all responsibilities to reside in one class.

The workflow context owns the Agent's lifetime. The Agent represents its logical conversation and retains the handle needed to use it. The adapter manages the corresponding native resources. When workflow cleanup closes an agent, the adapter releases resources it owns. Closing one session must preserve resources still serving other sessions. Stratos must not terminate an externally owned service merely because an agent finishes. This ownership contract does not select process-sharing, pooling, or warm-up mechanisms.

Adapters receive one `onEvent` callback at construction. Observations include
`message.delta`, `tool.started`/`tool.completed`,
`model.started`/`model.completed`, `compaction.started`/`compaction.completed`,
and `background.started`/`background.activity`/`background.completed`.
Events carry timestamps, available details, and native or adapter-correlated
operation IDs. Reconstruction is explicitly marked. Observed delivery order
is preserved within an adapter, not across agents. Activity observations do
not enforce an inactivity timeout.

The callback is bound to its owning Agent execution context. Observation failures are logged softly and do not fail the agent. Events do not control the harness loop; control hooks remain separate and hook exceptions remain fatal. Common Agent code records invocation start/end around execute. Native coverage varies by harness; unavailable boundaries are not invented.

Tracing consumers retain an explicit parent context from the owning workflow span. Workflow, child-workflow, agent, model and tool spans share a trace ID and use the immediate parent's span ID. Owning workflow execution ID and name are attributes. Model/tool spans are siblings under their Agent span. HTTP callbacks use the bound context, not whichever ambient context happens to be active when the callback arrives. Harness-provided trace context is not required.

For integration contributors, the internal adapter contract is:

```ts
interface AgentAdapter<TOutput = string> {
  initialize(): Promise<void>;
  execute(prompt: string): Promise<TOutput>;
  cancel(): void;
  close(): Promise<void>;
}
```

The common Agent initializes lazily before execution; repeated execute calls use the existing conversation. The prompt received by the adapter is already rendered by the common layer. Cancellation signals without waiting, following the existing contract. Close releases owned resources during runtime cleanup and is not exposed to workflow authors. The TypeScript interface exists in `src/agents/adapter.ts`; adapters live under `src/agents/{claude,codex,opencode}/adapter.ts`, with shared lifecycle in `src/agents/session.ts`. This interface does not authorize resource-sharing or pooling.

Adding another harness requires its native lifecycle, configuration/result translation and event mapping, verified against the shared adapter contract tests. Configuration precedence, templates, admission limits and workflow cleanup rules stay in the common runtime.

## Harness selection

Stratos uses TypeScript for its CLI, runtime, SDK, and workflow functions to maximize compatibility with Claude Code, Codex, Pi, and OpenCode harness SDKs.

Workflow code also uses TypeScript: explicit types and compiler feedback help
authors catch integration mistakes before execution. This does not assume
models inherently write better TypeScript than JavaScript.

The implemented harnesses are Claude Code, Codex, and OpenCode. Pi is deferred.

The agent abstraction must allow the harness to be selected dynamically. Workflows should remain portable across these harnesses without rewriting their logic. Automatically using the calling agent's harness is a deferred goal, not a current runtime requirement.

The harness, model, and reasoning effort can be overridden at invocation time.
Detecting the calling agent's harness is deferred. When no harness is explicit,
selection follows the model-based preferences below. Canonical model-name
translation is described under [model IDs](#canonical-model-ids).

Using the calling agent's harness does **not** mean using its session. Workflow agents must never reuse the parent/calling agent's session, to avoid bloating the parent's context.

### Model-based harness preference

`harness` is a single optional identifier on an agent configuration, not a list. Omit it to select a harness for the requested canonical model. An explicit effective value constrains that agent to the specified harness.

Use the model creator identified by the canonical ID to establish the preference order:

| Canonical model creator | Preferred harness | Fallback harness |
| --- | --- | --- |
| Anthropic (`anthropic/…`) | Claude Code | OpenCode |
| OpenAI (`openai/…`) | Codex | OpenCode |
| Other creators, including open-source models such as Gemma | OpenCode | No additional harness specified |

This is the user's explicit selection policy, not a guarantee that a harness supports every model from that creator. A candidate still needs compatible configuration, model mapping/access, and support for the agent's required capabilities. The creator is distinct from the serving backend: an Anthropic model served through OpenRouter still has Anthropic's harness preference. Backend selection and authentication remain with the harness and its adapter.

For an ordered model list without a required harness, selection uses two passes. First consider all models in declared order with their first-party harness: Anthropic with Claude Code and OpenAI with Codex. Only if no first-party combination is usable, consider all models through OpenCode in declared order. Other creators participate in the OpenCode pass. For `[GPT, Claude]`, the candidate order is GPT/Codex, Claude/Claude Code, GPT/OpenCode, Claude/OpenCode.

An invocation override can set `agents[configId].harness` even when the named configuration omits `harness`. After applying the existing field-by-field precedence, an effective explicit harness bypasses automatic harness preferences for that agent: consider its configured models in order using only that harness. If none can be used through the required harness, surface a catchable error rather than selecting another harness. Omitted model and other configuration fields retain their existing values. See [named agent configurations](#named-agent-configurations).

Fallback to the next candidate is allowed only for an unavailable model, a missing harness, or missing authentication. Other failures propagate without trying another candidate; rate limits and ordinary execution errors do not trigger fallback. `model` is an ordered list of preferred canonical model IDs, including when only one model is requested. With an explicit harness, try the list in order through that harness only. A supplied list replaces the lower-priority list under the existing field-by-field configuration precedence.

Selection has two phases inside the existing lazy initialization/execution lifecycle. Initialization checks each distinct harness once for installation, configured authentication, and an independent model catalog, without inference or selecting a candidate model for catalog discovery. It builds an immutable ordered list of provisionally eligible harness/model/provider combinations. Catalog compatibility uses the same exact first declared provider mapping that execution uses; do not infer aliases, strip dates, or extend a catalog with the requested model. Absence from a complete list excludes the pair. Absence from a partial list remains explicitly unknown and eligible. Missing mappings and incompatible harness families are excluded. Malformed catalogs, policy failures, and discovery transport errors propagate; they are not empty successful catalogs. Configured authentication and catalog membership do not establish remote credential validity or account entitlement.

Candidate conversations open lazily at execution. A native, structured, model-specific rejection can advance to the next initialized candidate only before the conversation produces output/reasoning, attempts tool work (including denied tools), or performs startup/background work. The rejected resource must close successfully before another is opened, and the unchanged original prompt is sent onward. Successful execution, a non-availability execution failure, or cancellation also pins the conversation. Later explicit calls attempt continuation on that same resource; they never automatically replay a failed prompt or change the harness/model. Initialization/startup failures do not start an automatic execution retry. Cleanup failure during selection preserves both errors and prevents advancement; normal final workflow cleanup retains its existing soft-error policy.

HTTP status, error prose, or a generic invalid-request error alone never proves model unavailability. When native metadata cannot safely classify a rejection, surface the error rather than guessing. This narrow first-attempt exception does not authorize switching an established conversation or relaxing fixed configuration. `src/agents/selection.ts` implements discovery and first-execution selection; harness-specific preflight, progress and error translation live with their adapters.

Example configuration:

```yaml
agents:
  validator:
    harness: codex
    model:
      - openai/preferred-model
      - openai/fallback-model
```

The IDs above illustrate the format, not model availability. TypeScript creation uses the same list shape: `createAgent({ harness: "codex", model: ["openai/preferred-model", "openai/fallback-model"] })`. Without an explicit harness, the existing two-pass preference order applies.

### Claude persistent session execution

The Claude adapter uses persistent streaming input, keeping its query process and input channel alive between sequential prompts. It initializes lazily and releases owned resources during workflow cleanup. This does not provide a warm-up API, pool, or cross-workflow conversation reuse.

### Deferred session warm-up and caching

Session warm-up, caching, and pooling are not implemented, and no public API
for them is defined. They are separate from the supported conversation reuse
through sequential executions on one configured agent object.

## Harness authentication

Harness authentication uses the user's configured API credentials or existing local login managed by the harness/provider. Stratos does not run a separate harness login flow or manage those login credentials.

For Claude Code, the intended behavior supports both API-key authentication and native subscription authentication. If the user has authenticated through the Claude Code binary, Stratos should allow the harness to use that existing login without requiring an API key. Stratos must not extract or copy the harness's subscription tokens into its own credential store.

If the selected harness has neither usable API credentials nor an applicable local login, invocation raises an authentication error identifying the harness. Configure credentials through that harness's supported mechanism. Stratos does not define a universal cross-harness precedence between API keys and native login.

The applicability of Anthropic's subscription policy to this Agent SDK integration remains unresolved. This records the intended product behavior, not confirmation of provider approval. See the [SDK guidance](https://code.claude.com/docs/en/agent-sdk/overview#get-started) and [authentication policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

This is separate from MCP authentication, which Stratos manages as described in [SPEC.md](./SPEC.md#mcp-connections-and-authentication). Ignoring inherited MCP settings does not mean ignoring the harness's local login.

### Codex Azure provider

An explicit `harness: 'codex'`, `provider: 'azure'` uses only the native
`[model_providers.azure]` table from `$CODEX_HOME/config.toml` (default
`~/.codex/config.toml`). Stratos validates and copies that provider into isolated
native configuration for discovery and execution, without importing ambient
MCPs, hooks, or profiles. The selected provider is fixed for the agent's
conversation. No new public agent option or automatic provider switch is added.

Azure uses environment-key authentication and the Responses API. Missing or
invalid configuration/credentials fail explicitly; OpenAI keys and saved
ChatGPT logins do not substitute for Azure credentials. The ordinary OpenAI
provider and its native authentication behavior remain unchanged. The packaged
canonical-to-native mapping still controls deployment names; native Codex
catalog metadata does not prove an Azure deployment exists or is authorized.

The [native provider validation](../../src/agents/codex/provider.ts) defines the
supported table fields. See [testing requirements](../../CONTRIBUTING.md#testing)
for provider and credential constraints.

## Named agent configurations

Each agent usage can reference a configuration identifier, such as `validator`. All agent usages referencing that identifier use the configuration supplied for it when the workflow executes.

### Configuration fields

These fields can be supplied directly to `createAgent` or resolved from named
configuration and invocation overrides. Callbacks and Zod schema objects are
TypeScript values, so supply them in code.

| Field | Shape and behavior |
|---|---|
| `configId` | Optional named entry under `agents` in the workflow manifest |
| `model` | Nonempty ordered array; required after settings are resolved |
| `harness` | Optional `claude-code`, `codex`, or `opencode`; omission uses model-based selection except with Ollama |
| `provider` | Serving backend supported by the selected harness; not an automatic credential fallback |
| `effort` | Reasoning setting supported by that model/harness; omit for Ollama |
| `systemPrompt` | Fixed string, `{file}`, or `{template}` source |
| `prompt` | User-prompt source available through an execute configuration reference |
| `templateVariables` | Defaults grouped under `systemPrompt` and `prompt` |
| `allowedMcps` | Workflow server names; `[]` enables none, not a ban on native tools |
| `allowedTools` | Built-in tool-name array; remove unlisted mapped, removable tools; `[]` removes all removable tools in the mappings |
| `disallowedTools` | Built-in tool-name array; remove listed tools even if also allowed; `[]` adds no removals |
| `workingDirectory` | Absolute path or a path relative to the invocation directory |
| `worktree` | `{enabled, name?, cleanup?}` for a managed Git checkout |
| `hooks` | Fixed TypeScript control/lifecycle callbacks |
| `outputSchema` | Zod schema; execution returns its validated, inferred output instead of text |

### Override precedence

Invocation overrides apply field by field for each configuration identifier. Each supplied harness, model, or reasoning effort value takes precedence over its value in `workflow.yaml`; unspecified fields retain their configured values. A partial override does not replace the entire configuration. For example, overriding only `validator`'s effort preserves its configured harness and model.

An override may also supply a field absent from the named configuration. For example, this invocation override object requires OpenCode for agents using `configId: "validator"`, unless an explicit object-creation setting takes precedence:

```json
{
  "agents": {
    "validator": {
      "harness": "opencode"
    }
  }
}
```

The override leaves the configured model or model list, prompts, MCP selection, and other omitted fields intact. When this is the effective harness setting, automatic first-party/OpenCode selection is bypassed. This uses the existing precedence of object-creation settings > invocation overrides > YAML configuration; automatic harness selection applies only when no effective harness is specified. It does not change the settings of an already initialized agent object. The example specifies the override payload, not a new CLI flag.

Configuration identity and session identity are separate. Sharing a `configId` does not imply sharing a conversation. Explicit creation settings override invocation overrides and YAML field by field; `execute()` accepts user-prompt input only.

```typescript
const validator = createAgent({
  configId: "validator",
  harness: "codex",
  model: ["openai/gpt-5.4"],
  effort: "low",
});
await validator.execute("Review these changes.");
```

The selected harness/provider must support the requested model and effort.

### Noninteractive tool permissions

Agents run noninteractively. Approve tool calls by default; do not prompt a terminal user for tool approval. A supplied Stratos `beforeToolCall` hook can allow, deny with feedback, or modify arguments under the existing hook contract. No hook or no decision means allow. Explicit hook denials must still prevent execution, and unexpected hook exceptions must still fail the invocation. Default approval does not override those controls.

Codex automatically trusts only Stratos-generated hooks in an isolated Codex configuration; do not trust ambient project/user hooks through this mechanism. Native noninteractive approval and Stratos callback wiring are implemented in all three initial adapters.

## Agent output

Agent configuration accepts an optional `outputSchema` containing a Zod schema, fixed for the object's lifetime. Without it, `execute(...)` resolves to text. With it, execution resolves directly to the typed value inferred from that schema. Stratos converts the schema to JSON Schema for the selected harness's native structured-output API and validates the returned value with Zod.

```typescript
const ReviewSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.string()),
});

const reviewer = createAgent({
  configId: "validator",
  outputSchema: ReviewSchema,
});
const review = await reviewer.execute("Review these changes.");

// review.approved is boolean; review.issues is string[].
```

Stratos uses native structured-output support, without a free-form text-cleanup fallback. Structured-output failures are catchable errors. Workflow-level Zod input/output contracts are separate.

With Claude Code, Stratos permits the native `StructuredOutput` delivery call when an `outputSchema` is configured. It does not pass that internal call to author `beforeToolCall` or `afterToolCall` hooks. Other tool calls continue through those hooks, and the structured result is still validated against the Zod schema.

Native schema restrictions still apply; the common API does not make all harnesses accept identical JSON Schema features.

## Agent hooks

Agent configuration supports a fixed `hooks` object containing TypeScript callbacks, including async callbacks. Tool hooks control native execution rather than only observing SDK events. Thrown exceptions and rejected promises follow the error contract below.

| Hook | Purpose |
|---|---|
| `onStart()` | An agent invocation begins; no arguments. |
| `onComplete()` | The invocation completes successfully; no arguments. |
| `onError(error)` | The invocation fails; receives detailed error information. |
| `beforeToolCall` | Inspect a pending tool call before execution. |
| `afterToolCall` | Inspect a completed tool call and optionally withhold its result with feedback. |

Invocation completion is distinct from ending a reusable session. Lifecycle events also feed timing and activity observations, but no inactivity watchdog is implemented.

Native compaction and task observations now feed the existing event artifacts and
trace consumers. Available task/tool/compaction parent references retain their
owning invocation across later prompts; foreground return is not task completion.
Missing native boundaries remain observation gaps, and owner cleanup records
unobserved completion as incomplete. This observation wiring does not implement
the watchdog. See [telemetry semantics](./TELEMETRY.md#harness-telemetry-collection)
for reconstruction and timing limits.

`beforeToolCall` can allow a call, deny it with feedback, or modify its arguments. No hook or no decision means allow. Denial prevents tool execution but lets the agent try another approach; it does not itself fail the invocation. A thrown or rejected hook error instead fails the invocation and is catchable around `execute()`. An unhandled error follows normal workflow failure and cleanup rules.

Shared return type exported by Stratos:

```ts
type BeforeToolCallResult =
  | void
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "modify"; arguments: Record<string, unknown> };
```

A before-tool callback returns `BeforeToolCallResult | Promise<BeforeToolCallResult>`. Each harness adapter translates the shared decision into its native hook response.

The after-tool return type is:

```ts
type AfterToolCallResult =
  | void
  | { action: "block"; reason: string };
```

An after-tool callback returns `AfterToolCallResult | Promise<AfterToolCallResult>`. No hook or no decision preserves the result. Explicit blocking withholds the original result from the model and supplies the reason so the agent can continue; it does not undo the completed tool's side effects or itself fail the agent invocation. Unexpected callback exceptions still fail the invocation. This is not a promise to redact local artifacts or native metadata. Arbitrary successful-result replacement is not included in this return type.

Harness mapping: OpenCode mutates the after-tool result, Codex uses native blocking feedback, and Claude uses output replacement with feedback (Claude's native block alone leaves the original visible). Codex code-mode blocking rejects the nested tool promise with the feedback reason, rather than returning a successful replacement.



Tool hooks receive tool-call details, including tool-failure details when a call fails. Failure details must be available through the after-call observation; a before-call hook cannot receive a failure that has not occurred yet. `onError(error)` receives detailed agent-invocation error information rather than an argument-free notification. No invocation metadata or result arguments are required for `onStart()` or `onComplete()`.

Tool events expose `toolCallId`, `toolName`, and `input`; after-call events additionally expose `output` or `error`. If `onError` throws or rejects, the agent call rejects with an `AggregateError` containing both errors, without recursively invoking `onError`. Native error details preserve available `message`, `stack`, `cause`, and `code`. `onError` accepts `unknown`, since workflow callbacks can throw arbitrary values. Shared hook names do not imply identical native coverage.

The harness owns its agent loop. Native control-hook responses and asynchronous event notifications have different sequencing guarantees; an observation callback alone does not pause native execution. See [Claude Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks), [Codex hooks](https://learn.chatgpt.com/docs/hooks), and [OpenCode plugins](https://opencode.ai/docs/plugins/).

**Codex hook connection:** Use native `mcp_tool` hook handlers connected to an MCP server hosted inside the Stratos Node process. That server invokes the workflow's hook callbacks, preserving the common author-facing lambda interface. No per-hook command helper is required. Retain SDK-event supplementation for tool failures not delivered by native post hooks. Callback-error propagation, cancellation, call-ID correlation, hook trust and server lifecycle need regression coverage. Native fail-open behavior is not accepted as Stratos hook-error behavior.

## Direct MCP client lifecycle

Direct workflow MCP clients are created through an explicitly awaited factory: resolve the workflow-local server configuration and authentication, set up the transport, detect a mutually supported protocol version, and complete the preparation required by that version before returning the object. Support modern and legacy server behavior: modern `2026-07-28` requests need no initialization handshake or HTTP protocol session; legacy servers still use `initialize`. Each created object owns its client and transport resources, rather than necessarily a protocol session or dedicated HTTP socket; its generated tool methods reuse that ready client. Separate factory calls do not automatically share a client, even for the same server configuration. This is distinct from synchronous configured-agent creation and lazy agent initialization. Detection caching policy remains unspecified.

Stratos associates the direct client with its owning workflow execution context for automatic cleanup, including partially initialized resources. Initialization errors are catchable. Tool methods may be called concurrently on a ready client. Requests time out after five minutes and are not automatically retried; cleanup cancels owned pending work. See [MCP connections](./SPEC.md#mcp-connections-and-authentication). Agent MCP connections are managed by the harness, using configuration and credentials supplied by Stratos.

## Agent MCP selection

Agent creation may supply `allowedMcps` as an array referencing keys in that workflow's `mcp.servers` map. The selection is fixed for the configured object.

```typescript
const validator = createAgent({
  configId: "validator",
  allowedMcps: ["github", "slack"],
});
await validator.execute("Review this pull request.");
```

- Omitted: use the MCP selection resolved from the agent configuration.
- Provided array at object creation: replace the configured selection for this agent object; do not merge the lists.
- Empty array (`[]`): enable no MCP servers.
- Unknown server name: raise a catchable configuration error.

Stratos resolves selected server configurations and credentials and supplies them to the harness SDK. The harness manages its own MCP connections and tool calls. Workspace/user MCP settings are excluded. The selected servers remain fixed across executions; refreshed credentials are supplied between requests, not during an active request.

The shared workflow runtime also authenticates all OAuth MCPs declared by an
invoked workflow before its `run` body, using the existing five-minute margin.
This does not enable unselected MCPs in agents or start their connections.
It applies separately at child invocation and fails before business logic if
authentication or the known-expiry margin is insufficient. Mid-request renewal
is not implemented. See the [authentication contract](./SPEC.md#mcp-connections-and-authentication)
for unknown-expiry and long-running-workflow limits.

## Agent built-in tool selection

`allowedTools` and `disallowedTools` filter the agent harness's built-in tools,
independently of `allowedMcps`. A tool that at least two harnesses provide has
a canonical name; a tool only one harness provides uses that harness's own
name. Names are case-sensitive.

Find the exact names for the harness, not the model provider:

```sh
stratos tools list
stratos tools list claude-code
stratos tools list codex --json
stratos tools list opencode
```

The command reads static mappings from the installed Stratos version without
starting a harness or requiring credentials. It lists removable names together
and always-on names separately; it is not an inventory of a live session.
See [CLI output and usage](CLI.md#agent-built-in-tool-names).

### Configure the selection

The lists may be set in `workflow.yaml`, invocation overrides, or `createAgent`.
The YAML below shows tool-selection fields to add to agents that already have
their model and other settings:

```yaml
agents:
  reviewer:
    harness: opencode
    allowedTools: [read, glob, grep]
  writer:
    disallowedTools: [shell, web_search, NotebookEdit]
```

Explicit creation fields take precedence over invocation overrides, which take
precedence over YAML. Each higher-priority list replaces only the same field:
overriding `allowedTools` preserves an inherited `disallowedTools`, and vice
versa. Selection remains fixed for the configured object.

For example, code can narrow an existing named agent's allowed tools:

```typescript
const reviewer = createAgent({
  configId: "reviewer",
  allowedTools: ["read", "grep"],
});
```

### Selection rules and limits

- Omitted: keep the harness's default built-in tools.
- `allowedTools`: remove every canonical and harness-specific tool of the agent's harness that is not listed. An empty array removes every removable tool.
- `disallowedTools`: remove the listed tools. When both are set, a tool in both lists is removed.
- Selection only removes tools. Listing a tool never turns on one the harness leaves off, and built-in tools without a name below are not affected.
- Unknown name: configuration error.
- A name the agent's harness does not have, including another harness's own name, is ignored.
- Always-on tools are implicit: `allowedTools` need not list them, and listing them in either list has no effect. Codex always provides `apply_patch`, so Codex `edit` and `write` stay on. `stratos tools list` shows each harness's always-on tools.
- OpenCode's `edit` permission governs both `edit` and `write`, so OpenCode agents must keep or exclude them together; otherwise initialization raises a catchable error.
- MCP tools are selected only by `allowedMcps`. MCP support tools (Claude Code `ToolSearch`, `WaitForMcpServers`, `RefreshMcpTools` and MCP resource tools; Codex `tool_search` and MCP resource tools) follow the configured MCP servers. The native `StructuredOutput` tool for `outputSchema` remains.
- Enabled tools are still approved by default; use `beforeToolCall` hooks for argument-level restrictions.

These are tool-name filters, not an action-level permission boundary or a
sandbox. Another enabled tool may perform the same action. In particular,
Claude Code's `Monitor` is separate from `shell` and can run commands; removing
`shell` alone does not remove it. Codex `allowedTools: []` still leaves
`apply_patch` available. Use a `beforeToolCall` hook to deny an `apply_patch`
call when required, and review remaining capabilities rather than assuming
an empty list creates a tool-free session.

### Harness mappings

| Canonical | Claude Code tools | Codex configuration | OpenCode permission |
|---|---|---|---|
| `shell` | `Bash`, `PowerShell` | `features.shell_tool` | `bash` |
| `read` | `Read` | — | `read` |
| `edit` | `Edit` | `apply_patch` (always on) | `edit` |
| `write` | `Write` | `apply_patch` (always on) | `edit` |
| `glob` | `Glob` | — | `glob` |
| `grep` | `Grep` | — | `grep` |
| `lsp` | `LSP` | — | `lsp` |
| `web_fetch` | `WebFetch` | — | `webfetch` |
| `web_search` | `WebSearch` | `web_search = "disabled"`, `features.standalone_web_search` | `websearch` |
| `subagent` | `Agent`, `SendMessage`, `ListAgents` | `features.multi_agent`, `features.multi_agent_v2` | `task` |
| `todo` | `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, `TodoWrite` | `tools.update_plan.enabled` | `todowrite` |
| `plan_mode` | `EnterPlanMode`, `ExitPlanMode` | — | `plan_exit` |
| `ask_user` | `AskUserQuestion` | `tools.experimental_request_user_input.enabled` | `question` |
| `skill` | `Skill` | `cloud.skills.enabled` | `skill` |
| `notify_user` | `PushNotification`, `SendUserFile` | `features.send_message_to_user_async` | — |

Harness-specific names:

- Claude Code (tool names): `NotebookEdit`, `Monitor`, `TaskStop`, `Workflow`, `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `RemoteTrigger`, `EnterWorktree`, `ExitWorktree`, `ReportFindings`, `Artifact`, `SendFeedback`, `ShareOnboardingGuide`. Undocumented Claude Code tools such as `DesignSync`, and `EndConversation`, which Claude Code does not let sessions remove, are not selectable.
- Codex (feature names; each sets `features.<name>`): `view_image`, `goals`, `memories`, `sleep_tool`, `tool_suggest`, `image_generation`, `request_permissions_tool`, `current_time_reminder`, `token_budget` (also history notes), `deferred_executor`, `code_mode`, `agent_message_board`.
- OpenCode (permission names): `codesearch`.

Claude Code receives removed tools through `disallowedTools`; when `Bash` is removed, Claude Code adds `Glob` and `Grep` unless they are also removed. Codex configuration keys are set to `false`. Codex model metadata can add `clock` and `request_user_input_async` regardless of configuration. OpenCode permissions are set to `deny` in both server and session rules. Each harness's names are defined in its adapter (`claudeTools`, `codexTools`, `openCodeTools`); the canonical list is in `src/agents/tools.ts`. `stratos tools list [harness] [--json]` prints these names per harness from the same mappings.

## Agent prompt templates

Each `execute(prompt, templateVariables?)` supplies one user message.
A messages array or caller-supplied conversation history is not supported.
Sequential executions on the same object continue its harness-managed
conversation; authors do not supply a session identifier.

`prompt` and `systemPrompt` support literal strings, plain files, and Handlebars templates. Both may be configured in `workflow.yaml` or at object creation, with creation settings taking precedence over invocation overrides and YAML. The system prompt is fixed; only the user prompt varies between executions.

```typescript
const validator = createAgent({
  configId: "validator",
  systemPrompt: "Review for correctness and explain any defects.",
});
await validator.execute(`Review this code:\n${input.code}`);
```

An execute request may supply a string prompt or a template with variables directly, or obtain either form from configuration. Configuration used to supply that request contributes only `prompt` and `templateVariables.prompt`. Other configuration fields, including the system prompt and its variables, are ignored for that request. This is distinct from using configuration to create the agent, where the full agent settings apply. Reference configuration with `{ configId: string }` as the first argument; pass any user-prompt variables as the optional second argument.

The resolved `systemPrompt` remains fixed across executions on an agent object. A different system prompt requires a new agent object.

Stratos renders text templates in Node.js using Handlebars, before sending them to the harness.

Both `systemPrompt` and `prompt` accept the following forms (shown for `systemPrompt`):

```yaml
# Literal text
systemPrompt: "Review for correctness."

# Alternatively, a plain file read as-is
systemPrompt:
  file: prompts/validator.md

# Alternatively, a Handlebars template to render
systemPrompt:
  template: prompts/validator.hbs
```

These are alternative forms, not repeated keys in one configuration. File paths resolve relative to the workflow root, not the invocation working directory. Handlebars template files conventionally use `.hbs`. The explicit `file` or `template` key selects plain loading or rendering.

Template variables are grouped by field within an agent configuration, rather than addressed through JSON Pointer or JSONPath:

```json
{
  "templateVariables": {
    "systemPrompt": {
      "language": "TypeScript",
      "focusAreas": ["correctness", "performance"]
    }
  }
}
```

The runtime applies the field's variables dictionary to its template text. Use `templateVariables.systemPrompt` and `templateVariables.prompt` for their respective variable dictionaries. Missing template variables must raise a catchable error before invoking the harness; they must not silently render as empty text. For example, `{{language}}` without a supplied `language` value is an error. Resolve the system prompt and its variables for initialization and retain the result. Prepare the user prompt before each execution, without reconfiguring the system prompt or other agent settings. The optional second argument to execute is the user-prompt variable dictionary directly; do not wrap it in a `prompt` or `templateVariables` key. Any additional template-enabled configuration fields remain undecided.

Agent creation may supply `templateVariables` to override configured defaults. Merge by variable name within each template field, in ascending priority: `workflow.yaml`, then workflow invocation overrides, then object-creation arguments. Unspecified variables retain their lower-priority values. Each supplied variable value replaces the previous value as a whole, including object and array values; do not deep-merge inside a variable. These defaults do not provide a per-execution agent-configuration override API.

For example, configured `systemPrompt` variables `{ language: "TypeScript", focus: "correctness" }` combined with call-site `templateVariables: { systemPrompt: { focus: "performance" } }` resolve to `{ language: "TypeScript", focus: "performance" }` with the call-site `focus` value taking precedence even if a workflow invocation override also sets `focus`.

## Explicit model selection

Specify models in `workflow.yaml`, invocation overrides, or agent creation
settings. Explicit creation settings take precedence over invocation overrides,
which take precedence over YAML. The resolved model stays fixed for that
object's conversation, subject to the initial selection rules above.

### Canonical model IDs

Use Models.dev canonical IDs from its `models/` source paths, except for the
explicit Ollama provider described below. Stratos configuration names the
canonical model and may constrain the harness; otherwise model-based harness
preferences apply. The adapter translates that model to the request ID for the
harness's effective, configured backend. Stratos does not choose between native
access and OpenRouter. Backend inspection and native request translation belong
inside the adapter.

Generate a versioned mapping from a pinned Models.dev Git revision and ship it with Stratos releases. Users update Stratos to receive newer mappings; runtime catalog fetching is not part of this approach. Only explicit, valid `base_model` links are accepted. Exact filename/path coincidences, namespace substitutions, punctuation changes, and display-name matches must not create mappings.

Keep provider-to-harness configuration mappings in the same shared location as the generated canonical model mappings (`data/models/`), and load these mappings when Stratos starts. Adapters consume the shared mappings rather than keeping separate provider tables. This includes Claude Code provider-to-backend flags, such as `amazon-bedrock` to `CLAUDE_CODE_USE_BEDROCK=1`. Models.dev supplies catalog identities; harness-specific flags are maintained by Stratos, not inferred from Models.dev. The packaged provider table and cached catalog loader are implemented in `data/models/provider-mapping.v1.json` and `src/models/catalog.ts`. CLI startup loads both tables, and the Claude adapter consumes the provider flags. Live Bedrock/Vertex authentication is not yet verified.

All explicitly linked provider IDs, including variants, are preserved in the
mapping. When several native IDs are mapped for the selected provider, the
first in the bundled snapshot is used for repeatability. Missing mappings
produce a catchable error rather than a guessed ID. This establishes catalog
identity, not provider selection, account access, or identical capabilities.

The TypeScript generator lives in `scripts/models/`; runtime lookups and harness
candidate ordering live in `src/models/`. Catalog mapping is not proof of model
availability or account access.

If the selected harness does not support the specified model or reasoning effort, the runtime must throw an error.

### Ollama-native agent models

With **explicit `provider: ollama`**, `model` contains native installed Ollama
names, such as `gemma4:26b`, `qwen3.5:9b` or a user-created tag. An omitted tag
means `:latest`, as in Ollama. Do not translate a Models.dev canonical ID,
infer a weight identity, or try another provider when the name is missing.
Without this explicit provider, existing canonical-ID rules are unchanged.

Select `harness: codex` or `harness: opencode` explicitly. This implementation
does not choose a new automatic harness preference for provider-native names;
omitting the harness, or selecting Claude Code, errors. Ordered model lists
and invocation overrides retain existing semantics within the selected harness.
The provider, model and harness stay fixed for an initialized conversation.

Agents use `OLLAMA_HOST` (an HTTP(S) origin without credentials, path, query or
fragment), defaulting to `http://127.0.0.1:11434`. No model key is required.
Readiness uses the server's independent `/api/tags` and `/api/show` metadata,
without inference. Only installed local models advertising both `completion`
and `tools` are eligible; remote/cloud entries and decision-only Nimble/Clef
are not ordinary agents. Inventory, configuration and transport errors propagate.
Missing models do not trigger downloads, model creation or cloud fallback.

Decision uses the same `OLLAMA_HOST`/localhost fallback for Ollama, after any
explicit `baseUrl` (call > invocation > YAML). Build checks and runtime agree;
explicit URL path prefixes remain supported. Invalid selected endpoints fail
without fallback, and Jev ignores `OLLAMA_HOST`.

For authoring, `stratos provider status ollama --json` diagnoses the selected server and
reports OS-specific install/start instructions without executing them. The
authoring agent owns approval and setup conversation. Explicit `stratos build`
rechecks every declared Ollama YAML model, including cached and child builds,
before that workflow's dependency/MCP preparation. All declared candidate IDs
must be installed and advertise the appropriate capabilities. See
[CLI status and build scope](CLI.md#ollama-provider-status): implicit builds and
dynamic/override settings are not validated against YAML defaults.

Codex uses a private keyless Responses provider and native model metadata;
OpenCode uses an isolated OpenAI-compatible provider populated from that same
installed inventory. OpenAI keys/saved Codex logins are not local-model
authentication. OpenCode pins its auxiliary model to the selected local model.
Its Ollama provider settings are Stratos-managed; a competing
`OPENCODE_CONFIG_CONTENT.provider.ollama` table errors rather than being
silently ignored. Use `OLLAMA_HOST` for the origin.
Existing control hooks, MCP allowlists, schema validation, cancellation,
conversation ownership, cleanup and telemetry remain in force. Invalid native
structured output is an error, not an invitation to parse arbitrary prose.

Leave `effort` unset for Ollama agents. This initial integration uses model
defaults and rejects explicit effort overrides before discovery; it does not
invent a mapping between hosted reasoning levels and local model thinking.

Stratos does not change server context, load/warm models, sampling parameters
or installed files. Harness metadata uses an explicit model `num_ctx` when
present, otherwise its advertised architecture limit; the latter is **not**
proof of the server's loaded context. Configure at least 64K for these harnesses
and check `ollama ps`. Record the installed digest, quantization and actual
loaded context for evaluations.

For OpenCode, an omitted `num_predict` (Ollama's default of `-1`) or an explicit
`num_predict: -1` maps to model metadata `limit.output: 0`. OpenCode 1.4.3 resolves
zero to its default output budget of 32,000 tokens, unless its native
`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` setting overrides that default. This is
a finite harness budget, not unlimited generation. Positive model `num_predict`
values remain capped at the discovered context size. Codex receives context
metadata without this output-budget field; Stratos does not rewrite Ollama's
saved parameters.

OpenCode also uses its resolved output budget for compaction. A configured
context at or below that budget can leave no usable input space; mapping to
zero does not by itself fix small-context compaction loops.

## Sessions

The agent object identifies its conversation. Sequential `execute()` calls continue it; a different object establishes an independent conversation. There is no author-facing session identifier for joining or resuming sessions. Internal native handles and telemetry identifiers are separate.

Sessions belong to one workflow invocation. They cannot be resumed or shared across workflow runs or across workflows. Workflow executions are stateless across runs; conversation state is retained through reuse of the agent object within its owning invocation.

Workflow agent sessions are separate from the parent/calling agent's session, regardless of harness selection or configuration identity.

Every child workflow invocation has its own execution ID and isolated session scope. Parent, child, and sibling invocations never share agent sessions, including repeated or parallel invocations of the same workflow. Each execution is self-contained.

Executions on the same agent object must be sequential. Parallel calls against the same conversation are unsupported; use separate objects for independent conversations.

Sequential calls on one agent object supply a new user prompt and its variables;
the harness, model, effort, system prompt, MCP selection, directory/worktree,
and other settings remain fixed. Cross-harness sessions are not implemented.
See [fixed agent configuration](#fixed-agent-configuration).

## Concurrent use of a shared session

If concurrent `execute()` calls target the same agent object, Stratos must reject the concurrent use as an error. It must not silently queue the calls or create replacement sessions.

The error must propagate to the caller so that it knows the workflow script needs correction. The message must identify the affected agent/conversation and explain that executions on one object must be sequential; parallel execution needs separate agent objects. Reject only the overlapping call; do not cancel, restart, or otherwise interrupt the already-running request because of the conflict. If the workflow catches the error, the first request continues normally. If the error is unhandled, normal workflow failure and cleanup rules apply, including cancellation of active work. Once the active request finishes, the object remains reusable under the normal sequential-execution rules.

Illustrative error message; exact wording and error representation are implementation details:

```text
Concurrent execute calls cannot use the same agent object.
Update the workflow script to execute this agent sequentially,
or create separate agents for parallel execution.
```

## Stratos settings and agent concurrency

User-level defaults live in `~/.stratos/settings.json`, but limits are enforced separately for each top-level execution and its nested children. Separate CLI invocations do not coordinate agent capacity or maintain a machine-wide pool.

`agents.maxConcurrent` is the per-execution maximum of actively running agent calls and defaults to 10. Children share their top-level execution's pool rather than receiving separate allowances.

When all execution slots are occupied, additional calls wait in that execution's queue until capacity is available. Pool/semaphore-based admission is an implementation option, not a selected dependency. This queue does not make concurrent reuse of the same session valid.

`agents.maxOutstanding` bounds running plus queued agent calls, including
children, and defaults to 100. Additional calls beyond that limit fail with a
catchable error instead of being enqueued. Completed calls do not count.
Independent top-level executions have independent counters, even for the same
workflow; there is no aggregate machine-wide bound.

Default settings:

```json
{
  "agents": {
    "maxConcurrent": 10,
    "maxOutstanding": 100
  }
}
```

## Workflow safety and resource validation

Build checks validate configuration, types, schemas, and statically detected workflow dependency cycles. Runtime checks reject ancestor workflow cycles and enforce agent admission limits. These checks do not prove termination, bound ordinary JavaScript resource use, or sandbox workflow code.

Expose authoring-time checks through `stratos build --name <workflow-name>` (also `st build --name <workflow-name>`), so the authoring agent can validate and revise its workflow without invoking `run`. Building installs required dependencies and generates required workflow, referenced, and MCP wrappers, then type-builds as needed. Dependency and wrapper preparation failures are reported to the authoring agent; existing freshness and reuse rules apply.

Recursive workflow invocation is unsupported: direct recursion (`A → A`) and
indirect cycles (`A → B → A`) are errors, even when they could terminate.
Builds reject detected cycles; runtime rejects an active ancestor invocation
with a catchable error. Repeated calls after completion and parallel siblings
are not recursion. Ordinary recursive JavaScript helpers are unaffected.

Child workflows use explicitly imported generated typed wrappers; conditional selection among those wrappers is allowed. Arbitrary workflow-name lookup is unsupported. Static dependency inspection is not complete detection, so the runtime also rejects invocation of an active ancestor. These restrictions concern workflow composition, not ordinary recursive helper functions.

## Agent inactivity watchdog

An inactivity watchdog is **not implemented**. Agent activity events and spans do not enforce a ten-minute timeout, and there is no fixed total agent execution deadline. Use explicit cancellation when needed, subject to the native cancellation limitations above.

## Primitive error contract

Agents, Decision, MCP tools, and child workflows throw exceptions or reject promises that workflow code can handle with `try`/`catch`. MCP `isError: true` results and protocol/transport failures are errors, not successful domain values.

A handled primitive error does not automatically fail the enclosing workflow or cancel unrelated work. An unhandled error fails the enclosing invocation and propagates upward; if unhandled at the top level, the whole run fails and its active work is cancelled and cleaned up. Failed operations must clean up their owned resources as applicable even when their error is caught. Rejecting invalid settings or concurrent session reuse remains required; errors are still exposed through this common contract.

## Workflow termination and cleanup

Each invocation owns its agent sessions. On fatal failure the runtime stops new calls, cancels running work, and closes owned sessions. Catching a child failure does not skip that child's cleanup. Concurrent use of one agent rejects only the overlapping call; catching the conflict allows the active request to continue, while an unhandled conflict follows normal failure cleanup.

On successful completion, the runtime also awaits owned-session cleanup before reporting completion. Cleanup is best effort, subject to native limitations; it does not undo completed side effects or guarantee that detached Codex descendants terminate.

### Automatic agent cleanup through the execution context

Each workflow invocation keeps a registry (`Set`) of its agent objects in its own execution context. Agent creation retrieves that context through `getContext()` and registers the object immediately, before lazy harness initialization. The shared Node.js `AsyncLocalStorage` instance associates asynchronous execution with the correct context; Stratos owns the context contents, registry, and cleanup behavior. Garbage collection is not responsible for harness-session cleanup.

The runtime wraps execution in `try`/`finally`. On return or exception, it
marks the context closing, rejects new agent creation/execution, and awaits
cleanup before reporting completion. `Promise.allSettled()` lets every agent
receive a cleanup attempt even if another close rejects.

Adapter close failures are reported softly: they do not replace an execution
error or fail an otherwise successful result. Internal close cancels queued
or running work, handles initialization still underway, and releases owned
resources. Never-initialized objects are simply marked closed; repeated
cleanup is harmless. Closing one session preserves resources serving others.

Authors do not call cleanup manually. Public `cancel()` signals cancellation
synchronously, and the pending `execute()` reports it through rejection.
Resource disposal is automatic; there is no public early-close method.

Child invocations own separate registries. Parent failure cancels active descendants, each cleaning up its own agents. Worktree removal follows top-level completion and shared-use rules. A crash or `SIGKILL` cannot be handled by `finally`; later startup/run reconciliation is best effort.

## Current limitations

Stratos runs trusted workflow code in-process, not in a sandbox. There is no
durable retry/resume, cross-run conversation sharing, warm-session pool, or
agent inactivity watchdog. Native cancellation and telemetry coverage vary by
harness; the Codex descendant-process limitation is described above.
MCP credentials refresh between requests, not within an active agent request.
See [deferred scope](SPEC.md#deferred-scope) for other unimplemented surfaces.
