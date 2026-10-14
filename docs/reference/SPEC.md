# Specification

This is the detailed contract for workflow definitions and MCP integration.
It specifies the data callers can rely on, how generated tool interfaces work,
and where authentication and execution boundaries lie. For a step-by-step
introduction, use [Author a workflow](../authoring.md) or
[MCP tools](../mcp.md).

The reference is split by responsibility:

| Reference | Covers |
|---|---|
| This page | Workflow format, schemas, MCP transports, generated types, and credentials |
| [Runtime](RUNTIME.md) | Builds, configuration precedence, agents, composition, hooks, and cleanup |
| [CLI](CLI.md) | Commands, options, results, and exit codes |
| [Decision](DECISION.md) | Decision API, question/answer schemas, provider limits, and retries |
| [Telemetry](TELEMETRY.md) | Logs, events, retention, trace hierarchy, and exporters |

[Design philosophy](../../DESIGN_PHILOSOPHY.md) brings together the decisions and
rationale behind these contracts, including directions not yet implemented.

Use the [contributor guide](../../CONTRIBUTING.md) when developing Stratos.
Unimplemented capabilities are listed under [deferred scope](#deferred-scope)
or explicitly marked as approved but not yet implemented. The remaining
sections define supported contracts, with provider-policy uncertainties
identified where they apply.

## Invocation, runtime, and agent authoring

### Workflow contract

A workflow has a manifest and a TypeScript entrypoint. The manifest makes it
discoverable; the entrypoint default-exports `workflow({input, output, run})`.
Saved workflows execute through the CLI or generated child-workflow wrappers.
Invoking one reuses the authored files rather than generating new workflow code.

Currently supported manifest fields:

| Field | Requirement | Meaning |
|---|---|---|
| `name` | Required nonempty string | Public name, unique within its discovery root |
| `shortDescription` | Required nonblank string, at most 400 Unicode code points | Single-paragraph summary of what the workflow does and when to choose it |
| `longDescription` | Required nonblank string, at most 12,000 Unicode code points | Markdown usage manual, loaded with schemas on demand |
| `version` | Required string | Workflow version; quote numeric-looking YAML values |
| `entrypoint` | Optional; defaults to `workflow.ts` | Module inside the workflow directory |
| `agents` | Optional named map | Agent settings; see [configuration](RUNTIME.md#named-agent-configurations) |
| `decision` | Optional named map | Structured-decision settings; see [Decision](DECISION.md#credential-sources) |
| `mcp.servers` | Optional named map | Workflow-local server definitions, described below |
| `otel.traces.exporter` | Optional | File or OTLP destination; see [telemetry](TELEMETRY.md#trace-exporter-configuration) |

Input/output schemas belong in TypeScript, not duplicated in YAML. Agent
admission limits and log retention are user settings in
`~/.stratos/settings.json`, not additional manifest fields.

<a id="workflow-descriptions-approved-not-yet-implemented"></a>

### Workflow descriptions

The manifest uses two explicit description fields. The short
description helps an agent select a workflow; the long description teaches it
how to use the selected workflow. The shared manifest validator enforces the
following hard limits; authoring targets are guidance, not minimums.

| Field | Required content | Authoring target | Hard limit |
|---|---|---|---|
| `shortDescription` | Nonblank string in a single paragraph: what the workflow does and when to choose it | 150-300 characters, usually 1-2 sentences | 400 characters |
| `longDescription` | Nonblank Markdown string: an agent-facing usage manual | About 300-800 words when warranted | 12,000 characters, excluding schemas |

Shorter descriptions are valid when sufficient; there is no minimum beyond
nonblank content. Count Unicode code points in the parsed strings, including
spaces and line breaks, rather than bytes or JavaScript UTF-16 code units.
Both limits apply to the entire respective field, without trimming or truncating
the stored value. A short description may have surrounding whitespace but no
internal line breaks (including Unicode line/paragraph separators).
Use YAML `>-` to fold source lines into one paragraph.

The short description should identify the action, domain, and important
selection boundaries. Do not put parameter instructions, examples, or
procedures in the catalog text. For example:

> Generates release notes from merged pull requests. Use when preparing a
> release summary; it does not create tags or publish releases.

The long description covers relevant preconditions and credentials, input
conventions and relationships, output interpretation, side effects,
limitations, failure recovery, and retry/idempotency gotchas. Include a minimal
valid example when it resolves genuine ambiguity. Do not require every section
or duplicate every schema field. Structural constraints belong in Zod; the
manual explains correct use beyond structural validity.

These are Stratos authoring budgets, not universal optima or token guarantees.
For typical English prose, 12,000 characters is roughly 3,000 tokens; model,
language, and content affect tokenization. Schemas are loaded separately from
catalog discovery and are not included in either description limit, so the
full description response can be larger.

The research basis is progressive disclosure, not a prescribed industry limit:

- The [Agent Skills specification](https://agentskills.io/specification#progressive-disclosure)
  targets roughly 100 tokens for discovery metadata, caps its description at
  1,024 characters, and recommends instructions below 5,000 tokens.
- [OpenAI's function-calling guidance](https://developers.openai.com/api/docs/guides/function-calling#best-practices-for-defining-functions)
  separates concise discovery descriptions from detailed deferred-tool guidance.
- [Anthropic's advanced tool-use guidance](https://www.anthropic.com/engineering/advanced-tool-use)
  supports on-demand definitions and usage examples beyond schemas, with an
  additional discovery-step latency tradeoff.

Stratos's tighter short-description budget limits repeated catalog context.
Assess semantic quality with review and representative agent evaluations of
selection, argument correctness, and gotcha adherence, not an LLM validator in
the build path. See [runtime enforcement](RUNTIME.md#workflow-description-enforcement)
and the [progressive-discovery commands](CLI.md#progressive-discovery).

This is a breaking manifest migration: authors must replace `description` with
both new fields and write an appropriate manual. Do not infer the split,
silently truncate text, or retain `description` as a compatibility alias.
The split does not rename Zod field descriptions or the bundled authoring
skill's Agent Skills frontmatter `description`.

### Signature and schema rules

`run` accepts one input object and returns an output object, synchronously or
through a promise. Callers send the object's fields directly, such as
`{"repo":"org/repo","pr_number":42}`, without an extra `inp` wrapper.
The following example formats a request summary; it does not fetch or review
the pull request.

`workflow.yaml`:

```yaml
name: pr-review
shortDescription: Format a pull-request review request.
longDescription: |
  Supply repo in owner/name format and a positive pr_number.
  Returns a request summary only; it does not fetch or review the pull request
  and needs no GitHub credentials. Example input: {"repo":"org/repo","pr_number":42}.
version: "1.0.0"
```

`workflow.ts`:

```typescript
import {workflow} from '@stratoscli/stratos';
import {z} from 'zod';

export default workflow({
  input: z.strictObject({
    repo: z.string().describe('GitHub repository in owner/name format'),
    pr_number: z.number().int().positive().describe('Pull request number'),
  }),
  output: z.object({
    summary: z.string().describe('Review request summary'),
  }),
  run({repo, pr_number}) {
    return {summary: `Review requested for ${repo}#${pr_number}`};
  },
});
```

The public schemas may be declared inline or separately and referenced by
the definition. Stratos derives TypeScript types and JSON Schemas from them.

- Both input and successful output are objects. A workflow with no result data declares an empty output object and returns `{}`.
- Every input/output field, including nested fields, needs a description. An empty description is valid for self-explanatory names; an absent description is invalid.
- Inputs reject unknown fields, including within nested input objects. Defaults apply only to omitted fields; `null` is accepted only when explicitly declared.
- JSON Schema preserves descriptions, required fields, defaults, enums, nested definitions, and representable constraints. All references resolve inside the exported schema.
- Public schemas contain JSON-compatible types. Unsupported signatures, transformations, and custom refinements that cannot be exported are rejected. Put transformations and business checks in `run`; they cannot silently broaden the accepted input contract.
- The top-level input name `overrides` is reserved for invocation configuration.

Schema retrieval evaluates the declaring modules without invoking `run`.
Keep actions out of module-level code. See
[code-derived schemas](RUNTIME.md#code-derived-workflow-schemas) for conversion,
freshness, and generated-wrapper behavior.

### Invocation and runtime boundary

`stratos list` discovers saved workflows, `stratos describe <name>` returns their
manuals and schemas, and `stratos run <name> --input '<json>'` executes them.
`stratos schema <name>` returns schemas alone. The runtime
prepares required builds, validates input, establishes invocation-local
configuration and trace context, runs workflow-start MCP authentication,
invokes `run`, validates its output, and closes owned resources.

The function receives domain input only. Run IDs, clients, secrets, and trace
state stay in the runtime's async context. CLI JSON mode puts its result/error
envelope on stdout and logs/progress on stderr. Failure exits `1`; success and
warning-only outcomes exit `0`. See [diagnostics](CLI.md#diagnostics-and-exit-codes).

Execution is local and in-process: the CLI runs a workflow and exits, while
agent primitives may create subprocesses. Compiled JavaScript runs on Node.js
with the process's permissions; there is no sandbox. Stratos owns compiler
flags, dependency preparation, and build reuse, so authors do not need
a `tsconfig.json`. See [build behavior](RUNTIME.md#dependencies-and-build).

There is no automatic whole-workflow retry or crash resume. A repeated call
is a new execution and may repeat side effects. Runtime agent calls are
explicit workflow steps, not an implicit source-regeneration phase.

### Agent authoring lifecycle

A person or coding agent can author the files. The same cycle applies:

1. Discover existing workflows and inspect their contracts before creating another.
2. Write the manifest, entrypoint, documented schemas, required prompts, and representative inputs and expected outputs.
3. Run `stratos build <workflow>` and correct diagnostics. Builds check configuration, types, schemas, and supported safety rules, install dependencies, and generate required wrappers without invoking `run`.
4. Verify behavior with fixtures or controlled runs, then use errors and traces to improve the authored files.

A dedicated Stratos generation service is not required. The bundled
[authoring skill](../../skills/stratos-workflows/SKILL.md) teaches this cycle and
on-demand MCP/composition patterns. Its advice to inspect selected tool
declarations instead of loading whole generated catalogs is context guidance,
not a file-access restriction.

The package includes the complete skill directory. Root help prints its
`SKILL.md` after the command summary, with the absolute path for relative
references. `stratos skill install --agent <names>` or `--all` creates user-level
symlinks; `status` inspects them and `uninstall` removes only owned links.
There is no project scope, remote registry, settings rewrite, or automatic
install/update hook. Ownership records preserve unrelated entries and support
repair after package moves. See [skill management](CLI.md#global-authoring-skill).
Installing guidance does not add execution harnesses.

<a id="workflow-description-rollout-and-authoring-skill-plan"></a>

### Workflow-description migration and authoring

**Breaking change:** existing manifests using `description` must be migrated
before discovery, build, schema retrieval or execution. Remove that field,
write `shortDescription` for selection and `longDescription` for correct use,
then rebuild. Legacy `description` is rejected even alongside the new fields;
there is no compatibility alias or automatic prose migration.

List consumers must read `shortDescription` instead of `description`. JSON
`message` is now a brief count, not a duplicate of the catalog in `data`.
Schema-only output and direct `run` invocation remain unchanged.

The bundled `skills/stratos-workflows/SKILL.md` teaches the description budgets
and `list` -> `describe` -> `run` flow. Fetch the current manual and schemas
when they are not already available; a prior discovery call is not an execution
requirement. Its manifest and composition examples use the same fields as the
authoring tutorials. Root help includes the bundled skill, without duplicating
its instructions elsewhere in the prompt.

The shared manifest validator, CLI and workflow telemetry use these fields.
Regression coverage includes description boundaries, discovery payloads,
build reuse/failures, schema-only compatibility, trace metadata and executable
authoring examples. Description length is not proof of semantic quality;
representative model evaluations remain necessary before revising the targets.

## Design principles

### Design principle: harness and model independence

Stratos's CLI, SDK, workflow configuration, MCP clients, runtime, and telemetry use shared contracts rather than exposing one harness's or model's native API.

Harness- and model-specific integration details must not define the shared contracts. Selecting or substituting a harness or model must use those generic contracts. This principle governs future design and implementation; named harnesses and models elsewhere in this document are examples or integration targets, not the basis of the system's abstractions.

### Design principle: straightforward LLM authoring

Keep workflow-authoring syntax, configuration, and primitives straightforward for coding agents to understand and generate. Workflows can use different models for different tasks, including smaller local models. This is not a guarantee of authoring quality from every model.

### Design principle: minimal context and conservative token usage

Stratos must add only the context needed for correct execution and remain conservative with token usage. Keep runtime-supplied instructions and metadata concise; avoid unnecessary detail, redundant information already supplied by the harness, and needless repetition across requests. This principle applies across Stratos integrations and primitives.

## Execution and operations

Harness selection, named agent configuration, and session behavior are documented in [RUNTIME.md](./RUNTIME.md).

Harness authentication supports configured API credentials and existing native local login. For Claude Code, the intended behavior includes both API keys and the user's existing subscription login through the Claude Code binary. If no usable authentication is available, workflow invocation must raise an authentication error. The harness/provider owns its login flow and credentials; Stratos manages MCP authentication separately. Authentication precedence and the unresolved applicability of Anthropic's SDK subscription policy are recorded in [RUNTIME.md](./RUNTIME.md#harness-authentication).

### MCP connections and authentication

All MCP configuration belongs in `workflow.yaml`, which defines the workflow's main list of MCP servers. Each agent configuration in the same file must support a setting that selects which MCPs to enable for that agent from the main list. Agent selections reference those shared definitions.

`mcp.servers` is a map keyed by server name, not an array. Each key identifies
the server in agent configurations and workflow code. Its value contains the
transport and authentication configuration:

```yaml
mcp:
  servers:
    github:
      type: http
      url: https://api.githubcopilot.com/mcp/
      headers:
        Authorization: "Bearer {env:GITHUB_TOKEN}"
    company:
      type: http
      url: https://mcp.example.com/mcp
      auth:
        type: oauth
    local:
      type: stdio
      command: node
      args: ["tools/server.js"]
      env:
        API_KEY: "{file:~/.stratos/secrets/service-key}"
```

HTTP supports headers and optional OAuth managed by Stratos. Stdio supports command, arguments, and environment variables. Header/environment values support `{env:NAME}` and `{file:path}` references. Secret files use owner-only permissions. File references resolve relative to the workflow directory, or use absolute/`~/` paths as for telemetry references. Agents receive only their `allowedMcps` selection. OAuth registration, callbacks, credential persistence, and refresh are implemented as described below.

Workflow execution must ignore workspace-level and user-level MCP settings, including those otherwise inherited from an agent harness. Agents must load only the workflow-defined MCPs selected by their agent configuration or the call's `allowedMcps` array. Omission uses the configured selection; a provided array replaces it, `[]` enables none, and unknown names raise a catchable configuration error. See [agent MCP selection](./RUNTIME.md#agent-mcp-selection). This keeps unnecessary MCP integrations out of workflow agents and avoids their startup overhead.

For direct calls from workflow code, the Stratos runtime uses an MCP client to create and manage connections to the configured servers.

Direct MCP client creation is explicitly asynchronous. The author awaits the generated server factory (illustratively, `const github = await createGithub()`); it resolves only after required authentication, transport setup, and protocol preparation succeed. No separate public initialization call is needed, and tool methods do not perform lazy first-use initialization. Initialization failures propagate as catchable errors, releasing partially acquired resources.

Each created object owns its own client and transport resources. Tool calls reuse that client and may be issued concurrently; another factory call creates a separate client even for the same server. This does not require a protocol session or a dedicated HTTP socket. Stratos tracks clients in the workflow execution context and automatically cleans them up when the invocation finishes, including partially initialized resources. Direct requests time out after five minutes. Failed or timed-out tool calls throw catchable errors without automatic retry or replay. Workflow cleanup cancels owned pending work. Harness-managed MCP connections have separate ownership as described below.

Stratos detects the supported MCP protocol during client setup. The `2026-07-28` protocol has no initialization handshake or HTTP protocol session; legacy revisions still use `initialize`. Version handling stays inside the client integration and does not change generated tool-call syntax. See the [MCP TypeScript SDK version-negotiation documentation](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions).


Stratos detects direct MCP tool usage from TypeScript imports and actual references in workflow code, rather than a separate usage declaration in `workflow.yaml`. For each server configured in `workflow.yaml` and used directly by workflow code, Stratos prepares wrappers for all tools exposed by that server, regardless of whether tool calls use static names or dynamically computed names. Wrapper generation is not limited to individually referenced tools.

Automatic preparation for `run`, `describe` and `schema` skips wrapper-related schema prechecks and generation for MCPs not used directly. MCP configuration passed only to agents does not count as direct usage. Explicit authoring builds also prepare declared but not-yet-imported MCPs, as specified below.

For agent tool use, Stratos passes enabled server configurations and authentication headers to the harness SDK. The harness establishes its own connections and handles tool calls; Stratos does not forward those calls through its direct MCP client.

Stratos manages MCP authentication. Connection and tool-call abstractions must remain generic across agent harnesses and models, consistent with the design principles above.

**OAuth:** Stratos uses the official MCP SDK for authorization-server discovery, registration, authorization-code flow with PKCE, and token exchange. It supplies browser launching, callback validation, and credential persistence. Registration prefers supplied/pre-registered information, then configured Client ID Metadata Documents when supported, then Dynamic Client Registration. Stratos does not host a metadata document.

OAuth configuration supports optional `clientId`, `clientSecret` (including env/file references), `scope`, `callbackPort`, `redirectUri`, and `clientMetadataUrl`. By default the callback listener binds to `127.0.0.1` on an available port at `/mcp/oauth/callback`. Fixed port/URI overrides support pre-registered redirect addresses. Browser-launch failure or the five-minute sign-in timeout raises a catchable authentication error. The listener closes on success, failure, cancellation, or timeout.

When `clientId` and `clientSecret` are supplied, Stratos automatically trusts
and remembers the first discovered authorization server for that MCP URL and
client ID. No authorization-server URL or additional confirmation is required.
The binding is saved before browser sign-in or token exchange and survives a
failed or cancelled sign-in. Later discovery must return the same authorization
server, even when the client secret has been rotated. A mismatch raises a
catchable error before stored tokens are reused or credentials are sent; existing
credentials are preserved. After verifying an intentional server change, use
`stratos mcp logout` followed by `stratos mcp login` to establish a new binding.
This trusts the initial discovery result; it cannot establish that the first
server is legitimate. Automatic client registration retains its existing flow.

MCP authentication supports both explicit setup through `stratos mcp login --name <server-name>` before execution and interactive authentication during workflow execution. When required MCP credentials are missing during a run, Stratos must detect this and launch the authentication flow. Stratos stores the resulting MCP credentials for subsequent use. If the browser cannot be opened, throw a catchable authentication error.

The CLI provides `stratos mcp list` (or `st mcp list`) to list all MCPs found in discovered workflows. See [CLI.md](./CLI.md).

**Workflow-start authentication:** Before calling a workflow's
`run` function, authenticate every OAuth-enabled HTTP MCP declared in that
workflow's `workflow.yaml`. This applies to cached builds and each child when
invoked, not to unused child workflows or other discovered workflows. Validate
workflow input first. Reuse fresh stored credentials, refresh near-expiry tokens,
or use the existing browser sign-in flow when authentication is required.
Preflight does not discover tools, start stdio servers or initialize agents;
non-OAuth credential resolution and native connections remain on demand.

Use the existing five-minute refresh margin: a token with a known expiry must
have **more than five minutes remaining**. Check newly issued/refreshed tokens
as well as stored ones, and recheck all preflight credentials after the last
server authenticates. Authentication failure or insufficient remaining lifetime
prevents the workflow body from running. Save rotated credentials even when the
provider issues a token too short-lived to proceed; do not repeatedly refresh
or sign in to obtain a longer token. Parent cleanup cancels pending child
authentication. Existing tokens without expiry metadata remain usable, but
their remaining lifetime cannot be verified; no expiry is inferred from token
contents. A start-time margin does not guarantee validity throughout an
arbitrarily long workflow.

Before each agent request, Stratos rechecks expiry, refreshes near-expiry tokens when possible, and saves rotated credentials before updating selected native MCP configurations. Concurrent refreshes for the same credentials are coordinated. This does not guarantee token validity during an arbitrarily long request.

No pre-tool renewal path is shipped. Native in-flight credential-update
capabilities differ; between-request refresh does not guarantee that an
already-selected tool call can use newly refreshed credentials. Unsupported
mid-turn behavior must not trigger automatic tool replay.

### MCP wrapper generation and storage

Workflows can be shared with a team through Git. Their code uses stable relative imports for wrappers stored inside the workflow's `generated/mcp/` directory. Wrapper filenames use the corresponding readable key from `mcp.servers` in `workflow.yaml`; hashed directory names must not appear in workflow imports.

```text
pr-review/
├── workflow.yaml
├── workflow.ts
├── package.json
└── generated/             # Local artifacts, excluded from Git
    └── mcp/
        └── github.ts
```

For example, workflow code imports from `./generated/mcp/github.js`. TypeScript resolves the `.ts` source during compilation, and Node.js executes the generated `.js` file. Wrappers expose an asynchronously created server object with generated typed tool methods. Each module default-exports an async factory: `import createGithub from "./generated/mcp/github.js"; const github = await createGithub(); await github.get_me({...})`. Methods accept generated input types and return the MCP result envelope. An `isError` tool result throws a catchable error (with the result retained as its cause); the connection lifecycle is defined above.

**Stable input type names:** Each tool exports
`Tool_<escaped-tool-name>Input`, with declarations isolated inside
`Tool_<escaped-tool-name>Schema`. Preserve ASCII letters (including case),
digits and underscores exactly. Escape every other Unicode code point as
`$<uppercase hexadecimal>$`, without leading zero padding. This includes literal
`$` characters, which become `$24$` and cannot impersonate an escape sequence.
For example:

| Tool name | Exported input type |
|---|---|
| `get_me` | `Tool_get_meInput` |
| `foo-bar` | `Tool_foo$2D$barInput` |
| `foo_bar` | `Tool_foo_barInput` |
| `fooBar` | `Tool_fooBarInput` |
| `foo$2D$bar` | `Tool_foo$24$2D$24$barInput` |

These identifiers depend only on the exact tool name, not discovery order,
enabled namespaces or the presence of other tools. Workflow code may explicitly
import them; arguments passed directly to methods remain inferred. MCP method
names and dispatched tool names retain their original spelling. Removing a
referenced tool or incompatibly changing its schema still fails consumer type
checking on rebuild.

The schema compiler uses private `Input` and `Output` roots in separate `InputSchema` and
`OutputSchema` scopes within the tool's namespace, avoiding both public-name
normalization and collisions between input/output definitions.

For servers requiring wrappers under the direct-usage rules above, Stratos generates wrappers when required for the workflow's schema retrieval or first run, before compiling it, and reuses them on subsequent runs. Generated wrappers are not checked into Git; each teammate generates them locally.

**Prepare before writing calls:** Use
`stratos build <workflow>` command, not a new MCP preparation command. After
configuring MCPs in `workflow.yaml`, an author can build before `workflow.ts`
(or the configured entrypoint) exists. The explicit build prepares wrappers
for every configured MCP regardless of imports, authenticating as needed
through the existing credential flow, discovering the tools available to that
user, and generating `generated/mcp/<server>.ts`. Valid credentials are reused;
OAuth sign-in is requested only when required. Discovery does not execute tools.
Without an entrypoint, report MCP preparation success without claiming a
compiled workflow or recording a successful workflow build. The author reads
the stubs, writes the workflow code, then builds again before execution.
Child-workflow wrapper generation is unchanged. The freshness policy is below.

Wrappers contain types, documentation, and forwarding code, with credentials supplied by the runtime rather than embedded in generated files. Use declared output schemas when available and a generic MCP result when absent. Capturing output examples and inferring output schemas are deferred.

**Declared output schemas:** When a tool supplies `outputSchema`,
export `Tool_<escaped-tool-name>Output` using the same stable naming rule as its
input. This type describes `result.structuredContent`, not the entire MCP
envelope. The method returns
`Promise<McpToolResult & { structuredContent: Tool_<escaped-tool-name>Output }>`.
Preserve `content`, metadata and other envelope fields; do not parse text into
invented structured output or unwrap server-specific fields such as `result`.
For example, if a tool `lookup` declares an object with a string `name`:

```typescript
const response = await server.lookup({});
const name: string = response.structuredContent.name;
// response.content still contains the MCP content blocks.
```

Carry the discovered input/output schema definition into the existing SDK call
for output validation against the same snapshot used for type generation, with
no additional runtime discovery. Missing or nonconforming structured output
throws a catchable error; tool-level `isError` handling and no-retry behavior
remain unchanged. Runtime JSON Schema validation covers constraints that
TypeScript types cannot express. An explicit build regenerates changed output
schemas and rechecks affected consumers.

Without `outputSchema`, keep the generic `McpToolResult` and do not invent an
output alias or validate against an inferred schema. Its `structuredContent`
remains optional and unknown. A declared empty schema `{}` instead yields an
`unknown` output alias: structured content is required but no field shape is
promised. Modern protocol output schemas may describe arrays, primitives or
null; preserve their values rather than forcing them into dictionaries.

Generated files are workflow-local. A shared cache and configuration-hash
storage are not implemented.

**Build-time freshness:** Every explicit
build rediscovers tools and regenerates wrappers for its configured MCPs using
the current configuration and authentication context. Unchanged authored-file
hashes or existing stubs must not skip discovery. Authentication or discovery
failure fails the build without a stale-wrapper success fallback. If workflow
code exists, changed generated wrappers must invalidate affected compiled
artifacts and be type-checked with their consumers before build success.
Discovery does not call tools: it establishes the currently visible schemas,
not a guarantee of successful tool execution or continued server availability.
This does not add background schema polling or change the existing reuse of
current builds by `run`/`describe`/`schema`; active-request credential expiry remains open.

### MCP credential storage

Stratos stores MCP credentials in a user-level plaintext JSON file at
`~/.stratos/credentials.json`, separate from workflow definitions. The directory
uses permissions `0700` and the file uses `0600`, including restrictive
permissions on temporary files from creation. This protects through filesystem
permissions, not a keyring or application-level encryption.

Credential records contain the server URL, authorization server, client ID, and available access token, refresh token, expiry, scopes, and client secret. Optional values need not be present. Credentials are identified by server URL, authorization server, and client ID rather than the workflow-local MCP name. The initial design supports one authenticated account per such connection; multiple-account selection is not defined. The internal serialized format is a versioned object (`version: 1`) containing a `records` array. Record keys include `serverUrl`, `authorizationServer`, `clientId`, optional `clientSecret`, `clientSecretExpiresAt`, `tokenEndpointAuthMethod`, `accessToken`, `refreshToken`, `expiresAt` (Unix seconds), and `scope`.

Explicit login and authentication during execution share the same credential-management flow. Stratos retains refresh tokens and client secrets and passes only access tokens to harness SDKs. Credentials persist after workflow completion; agent sessions and connections still end with the run.

First-use bindings for supplied client secrets use the existing credential
record identity with no tokens or secret until sign-in saves them. Existing
records already establish a binding; no file-format migration is required.
Checking and creating a binding occurs under the short credential-file lock,
so concurrent first uses cannot bind the same MCP URL and client ID to different
authorization servers. Logout removes the binding with the credential record.

Use a per-credential refresh lock and re-read credentials after acquiring it. Protect file modifications with a short file lock, and use a temporary file plus atomic rename for writes. Locks must not span browser sign-in.

A missing credential file means no stored credentials. Malformed data or unsafe permissions produce a clear error rather than silent replacement. Refresh network failures preserve credentials and report the failure; invalid or revoked refresh tokens require renewed authentication. Explicit logout removes the matching local credentials; remote revocation is a separate operation where supported.

Credential values must be excluded from logs, telemetry, errors, and CLI listings. Filesystem permissions protect against other ordinary local users, but do not isolate credentials from unrestricted processes running as the same user, privileged processes, or backups containing the file.

### Telemetry

Telemetry has a [dedicated reference](TELEMETRY.md) covering all primitives.
Use these sections for the corresponding contracts:

- <a id="harness-telemetry-collection"></a>[Harness telemetry collection](TELEMETRY.md#harness-telemetry-collection)
- <a id="trace-hierarchy-and-node-spans"></a>[Trace hierarchy and node spans](TELEMETRY.md#trace-hierarchy-and-node-spans)
- <a id="harness-preparation-and-startup-timing"></a>[Harness preparation and startup timing](TELEMETRY.md#harness-preparation-and-startup-timing)
- <a id="trace-exporter-configuration"></a>[Trace exporter configuration](TELEMETRY.md#trace-exporter-configuration)
- <a id="telemetry-authentication-references"></a>[Telemetry authentication references](TELEMETRY.md#telemetry-authentication-references)
- <a id="trace-file-export"></a>[Trace file export](TELEMETRY.md#trace-file-export)
- <a id="default-local-logs-and-agent-events"></a>[Default local logs and agent events](TELEMETRY.md#default-local-logs-and-agent-events)
- <a id="otel-metrics-deferred"></a>[OTEL metrics (deferred)](TELEMETRY.md#otel-metrics-deferred)

## Deferred scope

Durable retry/resume, warm-session pooling, an agent inactivity watchdog, Pi,
A2A, persistent memory, and additional primitive APIs are not implemented.
Stratos does not expose workflows through an MCP server; its external MCP
clients and harness-managed MCP connections are separate capabilities.
OAuth renewal during an active agent request is also not implemented.
Code orchestration's cost, latency and reliability benefits must be measured;
they are goals, not general performance guarantees.
