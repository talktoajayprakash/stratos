---
title: MCP tools
permalink: /guides/mcp/
---

# MCP tools

MCP connects applications to external tools and data. In Stratos, you can call
a tool directly from workflow code when you already know which operation to
perform, or make selected servers available to an agent that chooses its tools.
Both paths use the workflow's server definitions, but they own separate clients.

This guide covers direct calls. It assumes you have an MCP server and know its
address, transport, and authentication requirements. The `catalog` server and
`lookup` tool below are illustrative contracts, not a service bundled with
Stratos. Use your server's discovered definitions instead of assuming those
names exist.

## Configure the server

Create a workflow directory such as `.stratos/workflows/catalog-lookup/`.
Before writing the entrypoint, add a `workflow.yaml` with the real server URL:

```yaml
name: catalog-lookup
shortDescription: Retrieve a catalog item's value by key through a configured MCP server.
longDescription: |
  Configure the real catalog MCP server and authenticate before use. Supply
  key to receive value from its lookup tool. The server contract here is
  illustrative; inspect the discovered schema and replace it with your server's
  actual contract. Server errors propagate; retry only if the operation is safe.
version: "1"
mcp:
  servers:
    catalog:
      type: http
      url: https://mcp.example.com/mcp
      auth:
        type: oauth
```

The map key `catalog` is the workflow-local server name. HTTP also supports
headers for services using a token or another header-based credential. Stdio
servers use `type: stdio`, `command`, optional `args`, and `env` instead.
Header and environment values can reference `{env:NAME}` or `{file:path}`;
keep actual secrets outside the manifest and restrict secret files to their
owner.

OAuth supports optional registration and callback settings for servers that
need them. Use only the fields your server requires; see the
[transport and authentication specification](reference/SPEC.md#mcp-connections-and-authentication).
Stratos does not inherit unrelated workspace or user MCP settings.

## Discover tools and generate types

From your workspace, build the manifest:

```sh
stratos build catalog-lookup --json
```

An explicit build authenticates and discovers all declared MCP servers, even
before `workflow.ts` exists. OAuth may open a browser; existing valid
credentials are reused. You can also sign in explicitly with
`stratos mcp login catalog --workflow catalog-lookup`.

Stratos generates `generated/mcp/catalog.ts` inside the workflow directory
without executing any tools. With no entrypoint, the build reports
`status: "prepared"`: the wrappers are ready, but the workflow is not yet
compiled or runnable.

Open the generated declarations and find the tool you need. A large server can
have many tools, so search names and descriptions before reading selected
definitions. For example, from the workflow directory:

```sh
rg -n -i -m 20 --max-columns 180 --max-columns-preview 'lookup|search' generated/mcp/catalog.ts
```

A tool named `lookup` exports `Tool_lookupInput` and, if the server declares an
output schema, `Tool_lookupOutput`. Its namespace contains the relevant nested
types. Arguments passed directly to the method are inferred; explicit type
imports are optional. The
[naming contract](reference/SPEC.md#mcp-wrapper-generation-and-storage) covers tool
names containing punctuation.

## Call the tool from a workflow

Suppose discovery declares `lookup({key: string})` with structured output
`{value: string}`. Under that assumption, `workflow.ts` can be:

```typescript
import {workflow} from '@stratoscli/stratos';
import {z} from 'zod';
import createCatalog from './generated/mcp/catalog.js';

export default workflow({
  input: z.strictObject({
    key: z.string().describe('Item key'),
  }),
  output: z.strictObject({
    value: z.string().describe('Looked-up value'),
  }),
  async run(input) {
    const catalog = await createCatalog();
    const response = await catalog.lookup({key: input.key});
    return {value: response.structuredContent.value};
  },
});
```

Use the `.js` import extension in TypeScript; compilation resolves the generated
source and preserves a valid runtime import. The factory is asynchronous:
`await createCatalog()` returns a ready client after authentication and protocol
preparation. Create it inside `run`, not at module scope.

Build again to check the actual discovered contract. Only after reviewing the
tool's effects and your permissions should you run it:

```sh
stratos build catalog-lookup
stratos list --json
stratos describe catalog-lookup --json
stratos run catalog-lookup --input '{"key":"example"}' --json
```

If your tool has a different name or shape, adapt the entrypoint and input
before running these commands. A successful build proves schema compatibility,
not downstream tool permissions or future server availability.

## Understand the result and lifecycle

A direct tool call returns the MCP envelope, not just the domain result.
Declared output types describe `response.structuredContent`; `content` blocks
and metadata remain available. Stratos validates declared structured output.
Without an output schema, the result remains generic and structured content
is optional and unknown: validate the data you consume instead of assuming
a shape or parsing arbitrary text into a success value.

Calls reuse the ready client and may run concurrently. A separate factory call
creates a separate client. The workflow owns cleanup, including partially
initialized resources. Tool errors, malformed declared output, and transport
failures throw; requests time out after five minutes and are not automatically
retried. Retrying a mutating operation can repeat its side effects.

Explicit builds refresh server schemas even when workflow source is unchanged.
Keep generated wrappers out of Git and rebuild after configuration or tool
catalog changes. See [MCP lifecycle](reference/RUNTIME.md#direct-mcp-client-lifecycle)
for the detailed contract.

## Make tools available to an agent

In an agent's configuration, `allowedMcps: [catalog]` selects this server from
the same manifest. The harness then manages its own MCP client and calls;
those calls do not pass through the direct wrapper above.

An empty `allowedMcps` list enables no workflow MCP servers, but does not
disable the harness's built-in shell or file tools. Filter those separately
with `allowedTools` and `disallowedTools`; use `stratos tools list <harness>`
to discover the accepted names. Conversely, the built-in tool lists do not
select or disable MCP tools. They also do not restrict direct calls made by
workflow code through the generated client.

See [choosing agent tools](primitives.md#choose-an-agents-tools) for examples
and limits, and [control hooks](reference/RUNTIME.md#agent-hooks) for decisions about
individual agent tool calls.

Before a workflow's body runs, Stratos checks all OAuth servers declared by
that invoked workflow. It also refreshes credentials between agent requests.
Renewal during an active agent request is not implemented, so long-running
requests can still encounter expiry. Failed tool calls are not silently
replayed after authentication.
