# Telemetry

Stratos records what happened across workflows, agents, MCP tools, and System
One calls. Local logs and events are available by default. Optional OpenTelemetry
traces show how those operations fit together and can be exported to a file or
a backend such as Langfuse.

| Evidence | Available when | What it contains |
|---|---|---|
| `run.json` | Every top-level run | Identity, timestamps, and completion metadata |
| `run.log` | Every top-level run | Captured workflow console output |
| `events.jsonl` | Every top-level run | Available native agent events, including descendants |
| OpenTelemetry traces | A workflow or ancestor configures an exporter | Timed operations, parent/child relationships, inputs, outputs, and available usage |

Logs, events, and traces can contain sensitive task data. Credential redaction
does not make arbitrary prompts or tool results safe to publish. Collection and
export are best effort: failures are reported without failing the workflow.

For a first run, start with [local logs and events](#default-local-logs-and-agent-events).
To follow the operation tree, add a [file exporter](#export-to-a-local-file)
or send traces to [Langfuse](#send-traces-to-langfuse). The later sections define
the exact hierarchy, timing boundaries, and native observation limits.

## Trace exporter configuration

Add one exporter under `otel.traces.exporter` in `workflow.yaml`. A child
workflow can add its own destination to those inherited from its ancestors.
Without a local or inherited exporter, no traces are exported; Stratos does
not enable a console exporter implicitly.

### Export to a local file

```yaml
otel:
  traces:
    exporter:
      type: file
      path: ".stratos/telemetry"
```

`path` is a directory, relative to the invocation's working directory unless
absolute. Run the workflow normally; completed spans are written as standard
OTLP JSON payloads in a JSONL file. This is separate from the default
`events.jsonl`, which records agent events rather than trace export payloads.

See [trace file export](#trace-file-export) for filenames and child routing.

### Export over OTLP

```yaml
otel:
  traces:
    exporter:
      type: otlp
      endpoint: "https://telemetry.example.com/v1/traces"
      protocol: http/protobuf
      headers:
        Authorization: "{env:STRATOS_OTLP_AUTHORIZATION}"
```

For HTTP, `endpoint` is the full trace signal URL, including `/v1/traces` when
required by the backend. For gRPC, it is the service address. Supported
protocols are `http/json`, `http/protobuf`, and `grpc` (Protobuf).

Headers are optional; omit them for a destination that needs none. Set the
referenced environment variable to the complete header value required by your
backend. Stratos exports directly through the OpenTelemetry SDK, so a separate
Collector or per-run receiver is not required.

### Send traces to Langfuse

Use your Langfuse project's public and secret API keys to prepare a Basic
authorization header: `Basic ` followed by the base64 encoding of
`public_key:secret_key`. Store the complete value in `LANGFUSE_AUTHORIZATION`,
not in the workflow manifest or version control. Base64 is encoding, not
encryption.

For a local Langfuse deployment listening on port 3000:

```yaml
otel:
  traces:
    exporter:
      type: otlp
      endpoint: "http://127.0.0.1:3000/api/public/otel/v1/traces"
      protocol: http/protobuf
      headers:
        Authorization: "{env:LANGFUSE_AUTHORIZATION}"
```

Replace the origin with your deployment's address and port, or the correct
Langfuse Cloud regional address. Use HTTPS for remote destinations. Langfuse
accepts OTLP over HTTP JSON or Protobuf, not gRPC. For Langfuse v4 real-time
ingestion, its current guidance also specifies the header
`x-langfuse-ingestion-version: "4"`.

Run a workflow with this configuration, then open the corresponding project's
trace view. Workflow, agent, model, and tool operations share a trace and retain
their parent relationships; [trace hierarchy](#trace-hierarchy-and-node-spans)
explains the expected tree.

Stratos does not install or start Langfuse. See the
[Langfuse OpenTelemetry documentation](https://langfuse.com/integrations/native/opentelemetry)
for deployment/version requirements, regional endpoints, and ingestion behavior.

## Telemetry authentication references

Exporter headers support environment variables and file contents:

```yaml
headers:
  Authorization: "{env:STRATOS_OTLP_AUTHORIZATION}"
```

Alternatively, keep the complete header value in an owner-protected file:

```yaml
headers:
  Authorization: "{file:~/.stratos/secrets/otlp-authorization}"
```

`{env:VARIABLE}` reads an environment variable; `{file:path}` reads a file.
Secret-file paths resolve relative to the configuration file's directory,
or use absolute paths and `~/` for the home directory. This differs from a
relative **trace output** path, which resolves against the invocation directory.

Keep secret files outside version control and restrict their permissions.
References supply values, not token refresh. Missing environment variables,
unreadable files, and exporter failures produce soft telemetry errors; the
affected exporter is skipped without failing business work. Resolved
credentials remain excluded from logs, errors, and telemetry content.

## Default local logs and agent events

Local artifacts are stored centrally under `~/.stratos/runs/`, even when trace
export is not configured. Each top-level run has one directory containing the
parent and all descendant workflows, not separate child directories.

```text
~/.stratos/runs/
  -work-projects-example/
    workspace.json
    2026-10-01T21-04-49.964Z-review-pr-<execution-id>/
      run.json
      run.log
      events.jsonl
```

The workspace is the invoking process's working directory, not a discovered
Git root. Different subdirectories are therefore separate workspaces. Children
retain the parent working directory.

Workspace directory names encode the full absolute path with separators
replaced by hyphens. `workspace.json` stores the original path, for example
`{"path":"/work/projects/example"}`. Stratos verifies this identity metadata
before reusing the directory.

If that readable name belongs to a different workspace, Stratos appends
`-<hash>`, using the first 12 lowercase hexadecimal characters of the path's
SHA-256 hash. Long names truncate the readable prefix while keeping the hash
suffix. The hash describes the path, not repository contents. A collision at
the hash-suffixed path is a soft error rather than permission to mix or overwrite
data.

Run directories use `<UTC-start-time>-<workflow-name>-<execution-id>`, retaining
milliseconds and the full execution UUID. Timestamp colons become hyphens.
Characters outside ASCII letters, digits, `_`, and `-` in the workflow name
become hyphens; only that name portion is truncated to fit the component limit.

### Reading logs and events

`run.json` holds run identity, workflow name, timestamps, and completion
metadata. `run.log` contains readable console output qualified by execution
identity. `events.jsonl` combines events from every agent session in the run;
it may be empty for a code-only workflow.

Event records include `timestamp`, `workflowName`, `executionId`,
`parentExecutionId` and `agentSessionId` where applicable, and the payload in
`event`. Log records carry the same identity qualifiers plus `level` and
`message`. Repeated and parallel invocations remain distinguishable. Concurrent
events can interleave, but serialized writes keep each JSONL record intact;
independent top-level runs are not merged.

Workflow scripts use ordinary `console.log`, `console.info`, `console.debug`,
`console.warn`, and `console.error`. Stratos subscribes to Node's experimental
`diagnostics_channel` console channels without replacing console methods. It
uses the current async execution context and Node formatting, capturing
arguments immediately rather than retaining their mutable array.

There is no custom logging library, level filter, `logging.level` setting, or
`--log-level` flag. All captured agent events are retained, subject to credential
exclusion. Capture does not promise direct stdout writes, other console methods,
or subprocess streams. Write failures are reported to stderr and leave the
workflow running, possibly with incomplete artifacts.

### Retention

By default, Stratos retains the latest 10 completed runs per workspace and at
most 100 overall. Both limits apply together and can be set under
`logging.retention` in `~/.stratos/settings.json`:

```json
{
  "logging": {
    "retention": {
      "maxRunsPerWorkspace": 10,
      "maxRunsTotal": 100
    }
  }
}
```

A parent and all descendants count as one retained run. The group stays intact
while any part is active. After execution finishes and artifacts are saved, a
short-lived detached process deletes the oldest completed groups as needed.
The result returns without waiting for cleanup, which can continue after the
CLI exits without a permanent daemon. Cleanup failures are soft errors.

Retention covers logs, events, and trace files **inside the run directory**.
It does not remove workflow definitions, trace files exported elsewhere, or
data sent to an OTLP backend. Artifact persistence does not establish native
event coverage or capture of direct stdout/subprocess streams.

## Harness telemetry collection

Stratos consumes native harness observations, creates OpenTelemetry spans using
GenAI conventions, and exports them through the SDK. Available model calls,
tool calls, and compaction are recorded alongside workflow and agent spans.
Prompts, responses, and tool contents are captured by default; credentials are
excluded.

Destinations compose with workflows. Each workflow exports its own spans and
descendants to its local destination plus inherited ancestor destinations.
An unconfigured child inherits; a configured child can export even when its
parent has no exporter. Independently invoked workflows use their own settings.
Identical destination/configuration combinations receive each span once.

Every destination receives the same trace, span, and parent-span identities.
An ancestor destination receives its whole subtree. A child-specific destination
receives only that child's subtree, so its root may refer to a parent absent
from that destination. Trace context survives ancestors without exporters.
Failure at one destination does not stop another export or fail execution.

Collection, observation integration, unavailable transcripts, parsing, span
creation, and export failures are logged softly. This is separate from
[control-hook failures](RUNTIME.md#agent-hooks), which affect execution.

Codex uses persisted session rollout transcripts to reconstruct model-response
steps, inputs/outputs, tool calls, and available per-step usage. The input is
reconstructed history, not a guaranteed exact provider request; transcript
intervals are not exact API latency. The transcript format is not a stable
Codex interface. Hooks expose a nullable `transcript_path`; missing transcripts
are a reported observation gap, not a workflow failure.

## Trace hierarchy and node spans

A trace describes a complete top-level run. Each span describes a timed
operation and points to its **immediate parent span**, not a separate parent
trace. Child workflow invocations keep their own execution IDs within the
same trace.

```text
workflow
|-- decision model call
|-- MCP tool call (typed wrapper)
|-- harness.preflight
|-- harness.initialize
|-- agent
|   |-- harness.startup (Codex native turn readiness)
|   |-- model call
|   |-- compaction
|   `-- tool call
`-- child workflow
    `-- agent
        |-- model call
        |-- compaction
        `-- tool call
```

| Span | Captured information, when available |
|---|---|
| Workflow, including children | Name, description, inputs, invocation overrides, output, and outcome |
| Agent invocation | Invocation input, resolved user/system prompts, effective configuration including harness/model/effort, output, and outcome |
| Model call | Model settings, input/output, token usage, and outcome |
| Tool call | Tool name, arguments, result or error, and outcome |
| Compaction | Observed boundaries, outcome/error details, and exposed usage |

With the [workflow-description split](SPEC.md#workflow-descriptions),
the existing `stratos.workflow.description` span attribute uses
`shortDescription`. Do not copy `longDescription` into workflow-description
attributes or add a separate manual attribute.

All captured values follow the credential-exclusion policy. Every span carries
its owning workflow name and execution ID. Durations derive from observed
start/end timestamps; unavailable boundaries are not invented.

In an agent's main conversation, model and tool calls are siblings directly
under the agent span. Native task, spawning-tool, and compaction ownership is
preserved when exposed. Background work stays attached to its originating
invocation across later prompts and may finish after that prompt returns;
foreground success does not establish background success.

Direct MCP calls and Decision calls sit directly under their calling workflow.
Decision question builders (`choice`, `score`, and `noul`) do not execute
requests and create no separate spans.

Compaction has a timed span only when both boundaries are observed. A completion
without a start is an event marked as missing-start, not an invented duration.
Codex reconstructed compaction is completion-only. Owner cleanup closes remaining
open observations as incomplete if no native completion was seen.

### Errors, cancellation, and parent status

A parent reflects its own outcome, not an automatic roll-up of child failures.
A caught child error remains an error on that child while the parent can succeed.
An unhandled error that fails the parent marks the parent as failed.

Cancellation or timeout closes affected open spans with its outcome and reason.
Timeout sets OpenTelemetry Error status. Intentional cancellation records a
cancelled outcome without marking the operation as an error; OpenTelemetry has
no dedicated cancelled or timeout status. Already-completed spans stay unchanged.
When the whole workflow is intentionally cancelled, affected operations record
cancellation. Events and spans do not implement an inactivity watchdog.

## Harness preparation and startup timing

Preparation is timed separately from agent and model work:

| Span | Boundary and parent |
|---|---|
| `harness.preflight <harness>` | Native installation/authentication/catalog probe, including its cleanup; child of the owning workflow |
| `harness.initialize <harness>` | Selected adapter's `initialize()` call; child of the owning workflow |
| `harness.startup codex` | Each native turn, from before hook-server/SDK execution preparation to the first observed `turn.started`; child of that `invoke_agent` span |

Preparation spans repeat only when the operation runs, including selection
attempts or an explicit retry after failed initialization. Successive prompts
reuse initialization. Codex retains the conversation but starts a native process
on each SDK turn, so startup is measured each time.

OpenCode initialization starts its owned server, creates the session, and waits
for event-subscription readiness. Its preflight uses a separate temporary server;
no separate startup span or extra readiness request is added. Claude has
preflight/initialize timing but no separate instrumented native-ready boundary:
initialization is not proof of full readiness for model work.

SDK-timed spans carry `stratos.harness.name`, `stratos.harness.phase`,
`stratos.workflow.name`, `stratos.workflow.execution.id`,
`stratos.agent.session.id`, and `gen_ai.agent.name`. Provider is included when
known, and the selected canonical model is included for initialize/startup.
Codex adds `stratos.harness.ready_boundary = codex.turn.started`.

`stratos.completion.status` is `success`, `unavailable`, `error`, `cancelled`,
or `incomplete`. Unavailable/error sets OpenTelemetry Error; intentional
cancellation and missing readiness retain Unset. If execution ends before
readiness, startup closes with the observed failure, cancellation, or incomplete
outcome. That duration includes cleanup and is an upper bound, not successful
startup timing.

These spans exclude earlier prompt rendering, worktree acquisition, MCP
credentials, and queue waits. Readiness is not pure process-spawn time, complete
MCP readiness, exact provider-request start, or time to first token. Startup
overlaps the agent span; do not add nested durations as if they were independent.
Instrumentation does not change selection, fallback, reuse, or configuration.
Timing errors remain soft; timing spans contain neither native configuration
nor native error text.

## Decision measurements

Each `decision(...)` invocation creates a model-call span under its workflow.
It records structured `state` and `questions`, validated `answers`, requested
and returned model, available tokens, and outcome. It does not invent a chat
conversation. The API and question semantics remain in the
[Decision reference](DECISION.md).

### Content and measurement mapping

Alongside GenAI model/usage attributes, Stratos uses OpenInference's
`input.value` and `output.value` JSON strings with matching `*.mime_type` set
to `application/json`, and `openinference.span.kind: LLM`. Langfuse recognizes
these as the observation's Input and Output. Stratos also records
`stratos.decision.input` and `stratos.decision.output` with the same values;
credential redaction applies to both copies.

| Measurement | Source and meaning |
|---|---|
| Input | `input.value`: the submitted `state` and `questions` |
| Output | `output.value`: validated, unchanged `answers`, including supplied probabilities, confidence, and scores |
| Invocation latency | Span end minus start, after configuration/input validation and before credential resolution through retries/waits and response validation; client-observed time, not isolated model compute or time to first token |
| Model | `gen_ai.request.model` and `gen_ai.response.model`; returned model may differ from the requested alias |
| Tokens | `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` from the successful response; no estimates for failed attempts |
| Outcome | `stratos.completion.status`: `success`, `error`, or `cancelled`; errors carry an exception event, `error.type`, and Error status; intentional cancellation carries a reason without Error status |

A failed request without a validated result does not synthesize output or token
counts. Cost is not inferred without known provider pricing. Confidence is a
model-reported value, not measured accuracy.

Langfuse can round a short duration to `0.00s`; its observations API exposes
`latency` in seconds and span timestamps. Fixture timings are not Jev performance
evidence. Total CLI time also includes builds and process startup, so it differs
from the Decision span duration.

## Trace file export

A file destination writes one JSONL file per configured export scope, named
with the owning workflow's formatted UTC start time, name, and execution ID:

```text
2026-09-24T18-30-45.123Z-review-pr-<execution-id>.jsonl
```

Hyphens replace time-component colons for portability; execution IDs distinguish
concurrent runs. Each line is a standard OTLP JSON trace export payload, which
may contain several spans and preserves resource/scope information, IDs,
attributes, and timing.

An ancestor's file receives its workflow and descendant spans. A child with a
different destination gets its own subtree file. Parent and child sharing the
same resolved destination/configuration reuse the inherited file and write each
span once. This file is not the agent `events.jsonl`.

## OTEL metrics (deferred)

Separate OpenTelemetry metrics collection/export and metric correlation are not
implemented. Traces carry available token usage and span timestamps. Native
visibility limitations still apply, including approximate Codex transcript
durations rather than exact provider-request latency.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Logs exist, but no traces appear | Configure `otel.traces.exporter`; local logs do not imply a trace exporter is enabled. Check stderr for soft export/authentication errors. |
| Langfuse has no new trace | Check the full signal URL, HTTP protocol, project credentials, and ingestion behavior for your Langfuse version. |
| The trace tree is incomplete | Use an ancestor destination for the complete run. A child-only destination intentionally lacks ancestor spans; missing native observations also remain gaps. |
| `events.jsonl` is empty | Code-only workflows need not emit agent events. Native coverage also varies by harness. |
| Duration differs from CLI elapsed time | Build, preparation, queueing, agent work, and model calls have different boundaries. Nested spans overlap. |
| Blocking a tool result did not remove it from artifacts | An after-tool hook controls model-visible feedback, not artifact redaction or rollback of tool side effects. |
