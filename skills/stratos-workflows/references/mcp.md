# MCP tools in workflows

## Configure and prepare before writing calls

Read the user's supplied MCP configuration; do not guess endpoints, tools or
authentication. Put servers under `mcp.servers` in `workflow.yaml`. For example,
replace the placeholder URL with the user's OAuth server:

```yaml
mcp:
  servers:
    catalog:
      type: http
      url: https://mcp.example.com/mcp
      auth:
        type: oauth
```

HTTP also supports `headers`; stdio uses `type: stdio`, `command`, optional `args`
and `env`. Header/environment values can contain `{env:NAME}` or `{file:path}`.
Credential files must be owner-only. Never embed actual secrets in YAML or code.
OAuth optionally accepts the server's `clientId`, `clientSecret`, `scope`,
`callbackPort`, `redirectUri` and `clientMetadataUrl`; only set what its login
requires. Do not change an editor's authentication configuration.

After saving the manifest, before creating `workflow.ts`:

```sh
stratos build <workflow> --json
```

This authenticates/discovers **all declared MCPs** and writes
`generated/mcp/<server>.ts`, without calling tools. It can request browser login.
Manifest-only `status: "prepared"` is not a compiled workflow. Discovery failure
must be fixed, not bypassed with stale wrappers. Explicit login is also available:

```sh
stratos mcp list --json
stratos mcp login catalog --workflow <workflow>
```

## Read only the types you need

**Do not read the entire generated MCP file.** Searching scans it locally; only
the returned matches need to enter the model context. Prefer symbol navigation
when available, otherwise use `rg`/`grep` and bounded file reads.

1. Search names or descriptions using task keywords. Cap returned matches and
   long lines: forwarding lines also embed raw JSON schemas.
2. Locate `declare namespace Tool_<escaped-name>Schema {` for a selected tool.
3. Read that tool's block, ending before the next top-level `declare namespace`
   or `export default`. It contains both input/output and nested definitions.
   For a large block, read only relevant fields and follow referenced types
   within that block. Read the method's preceding description if needed.

For example, from the workflow directory:

```sh
rg -n -i -m 20 --max-columns 180 --max-columns-preview 'lookup|search' generated/mcp/catalog.ts
rg -n -F 'declare namespace Tool_lookupSchema {' generated/mcp/catalog.ts
```

If only shell tools are available, extract exactly that tool block:

```sh
awk '
  /^declare namespace / || /^export default / {
    selected = ($0 == "declare namespace Tool_lookupSchema {")
  }
  selected { print }
' generated/mcp/catalog.ts
```

Replace `lookup` with the actual generated name. Exports are
`Tool_<escaped-name>Input` and, when declared, `Tool_<escaped-name>Output`.
ASCII letters, digits and underscores retain their spelling; other code points
use uppercase `$<HEX>$` escapes (`foo-bar` becomes `Tool_foo$2D$barInput` and
literal `$` becomes `$24$`). Do not use old positional names like `Tool169Input`.
Original tool method names are unchanged: `catalog['foo-bar'](...)`.

## Author using the discovered contract

The module default export is an **async factory**. Import it at module scope;
await it inside `run`, then invoke its methods. Method arguments and result types
are inferred; explicitly importing generated aliases is optional.

Illustration only: if discovery declares `lookup({key: string})` with structured
output `{value: string}`, the entrypoint can be:

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

Rebuild to compile the real discovered types, then exercise only authorized
calls. A successful discovery/build does not prove downstream tool permission.

Declared output types describe `response.structuredContent`, not the full
envelope; `content` and metadata remain available. The SDK validates structured
output against the generated schema. Without a declared output schema, results
remain generic with optional unknown structured content: narrow/validate what
you actually use. An empty schema `{}` means unknown, not a known dictionary.
JSON encoded in a server's string stays a string; parse it only if the actual
tool contract requires it, then validate before use.

`isError`, missing/malformed declared output and transport failures throw.
Connections close with the workflow; requests time out after five minutes, with
no automatic failed-call retry. Do not add retries around mutating calls without
the user's policy. Build-time refresh and ordinary OAuth refresh do not imply
supported credential replacement during an active native agent request.
