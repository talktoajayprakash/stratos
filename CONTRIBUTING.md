# Contributing to Stratos

This guide is for developing Stratos itself: building the CLI and SDK, changing
integrations, and contributing documentation. To create a workflow that uses
Stratos, start with [Author a workflow](docs/authoring.md) instead.

## Build from source

Use macOS or Linux with Node.js 24 or newer; the latest Node 24 LTS update is
recommended.

```sh
git clone https://github.com/talktoajayprakash/stratos.git
cd stratos
npm ci
npm run build
node dist/src/cli/main.js --help
```

`npm ci` installs the locked dependencies and local Git hooks. You can run the
CLI through `node dist/src/cli/main.js` without changing a global installation.
If you deliberately want the checkout to supply the `stratos` and `st` commands,
`npm link` creates those global links; it does not publish the package.

Keep changes focused and preserve documented contracts. A proposed interface
change needs review before implementation. The
[specification](docs/reference/SPEC.md), [runtime reference](docs/reference/RUNTIME.md), and
[design philosophy](DESIGN_PHILOSOPHY.md) explain the existing behavior and
recorded decisions. Repository instructions for coding agents are in
[AGENTS.md](AGENTS.md).

## JavaScript and TypeScript style

Follow the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)
and the applicable [Google JavaScript Style Guide](https://google.github.io/styleguide/jsguide.html)
conventions. Google's JavaScript guide is frozen and recommends the TypeScript
guide for new work. For TypeScript-specific syntax, the TypeScript guide takes
precedence; do not duplicate TypeScript types in Closure-style JSDoc.

Stratos uses [Google's `gts`](https://github.com/google/gts) shared ESLint and
Prettier configurations. The guides are documentation; `gts` supplies the linter,
formatter and automatic fixes. Tooling enforces the rules it implements, not
every judgment in the written guides. API design, meaningful names, useful
comments and justified type assertions still require review.

```sh
npm run lint       # Check lint and formatting; warnings fail the check
npm run lint:fix   # Apply safe automatic fixes, then report remaining issues
npm run lint:staged # Fix and check only staged JavaScript/TypeScript files
npm test          # Compile with TypeScript 7 and run unit/integration tests
```

ESLint also works directly on individual files:

```sh
npm exec eslint -- src/agents/agent.ts
npm exec eslint -- src/agents/agent.ts --fix
```

### Automatic pre-commit fixes

`npm ci` (or `npm install`) installs the local Husky hooks through `prepare`.
On each commit, `.husky/pre-commit` runs lint-staged, which applies the same
Google ESLint/Prettier fixes to staged JavaScript/TypeScript files and includes
the fixes in the commit. Remaining lint errors block the commit.

Only staged files are processed. For partially staged files, lint-staged hides
unstaged hunks before fixing and restores them afterward; unrelated unstaged
and untracked files are not added. Its backup/revert behavior stays enabled.
If restoring unstaged changes conflicts with a fix, the commit is blocked rather
than silently including those changes. Review the reported recovery instructions
and retain the backup stash until your changes are restored.

Existing ESLint exclusions still apply, including dependencies and generated
output. Files outside the JavaScript/TypeScript lint scope are untouched.
Git must run with Node.js 24 or newer and the local development dependencies
installed. If dependencies were installed with `--ignore-scripts`, run
`npm run prepare` once to activate hooks. CI still checks the entire maintained
codebase because local Git hooks can be bypassed.

With Volta and an older default Node version, run the commit under the supported
runtime without changing the global default:

```sh
volta run --node 24 git commit -m "Your commit message"
```

### Enforced conventions

- Use `gts` formatting: two-space indentation, single quotes, semicolons, trailing
  commas, no spaces inside object/import braces, and Prettier's 80-column target.
  Long literals and other expressions that cannot be wrapped may exceed the target.
- Put static imports before implementation code. Group Node built-ins, external
  packages, then local modules, with blank lines between groups and alphabetic
  module-path ordering. Keep relative `.js` extensions for NodeNext ESM.
- Use `import type` or inline `type` specifiers for type-only dependencies. Do not
  use `import('./module.js').Type` annotations. Actual `await import(...)` remains
  available for intentional lazy loading, native bindings and runtime-selected
  workflow modules; it is not a substitute for ordinary static imports.
- Prefer `const`, never `var`; use strict equality, braces for control statements,
  one variable per declaration and named exports.
- Prefer `unknown` and proper narrowing to explicit `any`. Handle promises with
  `await`, rejection handlers, or an intentional `void`. `void` does not handle
  rejection: Node test registration is safe because the test runner owns its
  outcome, and telemetry observation uses the existing event sink's error handling.

### Scope and exceptions

Lint covers maintained `src/`, `test/`, `scripts/`, `examples/*/workflow.ts` and
root JavaScript/TypeScript tooling. Example entrypoints retain the SDK-required
default workflow export. Dependency directories, build/coverage/generated
output and local `.stratos` workspaces are excluded. Embedded fixture source
strings are not linted as separate programs.

The ESLint configuration needs a default export. The approved default-export
workflow and generated-wrapper interfaces are unchanged; repository style must
not redesign those author-facing contracts. Required third-party default imports
remain supported.

Unused fields deliberately removed by object-rest destructuring are allowed.
Variables read by a callback before their later assignment may remain `let`.
Intentional cleanup-error precedence and control-character validation use narrow,
explained rule suppressions. Do not disable a rule file-wide to avoid fixing a
violation.

### Compiler and editor integration

`gts` 7 uses ESLint 9 and `typescript-eslint`. The currently published `gts`
dependency range still selects ESLint 9; npm reports its upstream deprecation
warning. These lint dependencies are development-only.

The `gts` dependency chain pins `tmp` to 0.2.7 through an npm override to fix
its temporary-path vulnerabilities. Remove the override when an upstream `gts`
release resolves to a patched version without it.

`typescript-eslint` does not yet support the
TypeScript 7 compiler API. Following Microsoft's
[side-by-side setup](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0),
the development-only `typescript` alias provides `@typescript/typescript6` for
lint analysis; the runtime dependency `@typescript/native` aliases TypeScript
7.0.2 and still provides `tsc`. Installed Stratos workflow builds resolve that
native compiler explicitly. This does not downgrade the build compiler.

`tsconfig.eslint.json` supplies only the linter's type-analysis settings. The
existing CLI compiler flags and the no-authored-tsconfig workflow contract remain
unchanged. `package.json` points Prettier directly at the `gts` configuration.
Editors can use their ESLint and Prettier integrations with these checked-in
settings; no global installation is required.

## Testing

`npm test` builds and runs the unit/local integration suite with coverage.
Use the existing tests relevant to the change before running the full suite.
Do not rebuild a shared checkout's native dependencies under another Node major.

For changed harness or MCP integrations, local fixtures do not replace real
authenticated checks. Exercise actual tool effects, structured output,
same-session continuation and owned-resource cleanup as applicable. Live tests
in `test/integration/` are explicit opt-ins; inspect their configuration and
cost before running them. Report passes, failures, skips and blocked checks
separately, and keep raw logs, traces and credentials outside the repository.

Live GPT-model tests through Codex and OpenCode must use direct Azure Foundry,
not OpenAI subscription login or OpenRouter as a fallback. Use approved
credentials and synthetic/public data; see the
[Codex Azure contract](docs/reference/RUNTIME.md#codex-azure-provider). Respect native
authentication and tool policies. Tests must clean up their owned resources
on success and failure without removing user credentials or unrelated state.

### Live verification commands

These opt-in commands make real provider calls and may incur charges. They are
not part of the default offline suite. Use only providers permitted by your
native harness and organization policies; missing credentials fail explicitly.

| Command | Purpose and configuration |
|---|---|
| `npm run test:agents:claude` | Six hook scenarios and conversation continuation. Set `ANTHROPIC_API_KEY` or an explicit `STRATOS_TEST_ANTHROPIC_KEY_FILE`. Optional `STRATOS_TEST_PROVIDER=openrouter` requires `OPENROUTER_API_KEY`. |
| `npm run test:agents:codex` | The same scenarios through direct Azure using the Codex configuration described above. |
| `npm run test:agents:opencode` | The same scenarios; defaults to OpenRouter with `OPENROUTER_API_KEY`. GPT models require `STRATOS_TEST_PROVIDER=azure` and configured Azure credentials. |
| `npm run test:agents:mcp` | Read-only GitHub `get_me` through all three harnesses. Requires `OPENROUTER_API_KEY` for Claude/OpenCode, direct Azure for Codex, and `GITHUB_TOKEN` or an authenticated `gh` CLI. |

Agent integration tests accept `STRATOS_TEST_MODEL` and a comma-separated
`STRATOS_TEST_MODES` subset of `allow,deny,modify,throw,block,afterThrow`.
They remove owned temporary workspaces and report results through the test
runner. No credential-file location is assumed. The cases live in
`test/integration/` and are skipped by the default `npm test` run unless
the corresponding command sets its opt-in flag.

OpenCode GPT hook checks use its native `apply_patch` and `read` tools, including
patch argument modification and the trailing newline written by the patch tool.
Other harness/model combinations retain the shell-based scenarios. Maintainer-
authorized OpenRouter GPT checks pin Azure routing with provider fallback disabled. Each scenario
allows up to five minutes for its model calls, within the ten-minute test limit.

For local-model coverage, run the existing Ollama integration test with an
installed tool-capable model and its configured context/output limits:

```sh
STRATOS_TEST_OLLAMA_AGENT_HARNESS=opencode \
STRATOS_TEST_OLLAMA_AGENT_MODEL=<installed-model-name> \
node --test dist/test/integration/agent-ollama-live.test.js
```

Use `codex` for the other supported harness. Setting
`STRATOS_TEST_GITHUB_TOKEN` enables the authenticated GitHub MCP portion, which
exposes only read-only `get_file_contents`. It verifies the returned package
manifest as well as tool execution, hooks, conversation continuity, structured
output, trace redaction and cleanup. Without that variable, a passing local
agent check does not establish MCP coverage.

### Continuous integration

GitHub Actions runs the full test suite on Linux/macOS with Node 24 for PRs and
Linux/24 on pushes to `main`. Only Linux/24 runs lint and collects coverage;
other jobs still build and execute the same tests without coverage. Run the
manual CI workflow for the full Linux/macOS x Node 24/26 matrix before releases.
Feature-branch pushes do not duplicate PR checks, superseded PR runs are cancelled,
npm downloads are cached, and jobs time out after 30 minutes. Ordinary CI does
not run paid-provider or credentialed remote checks; do not expose credentials
to untrusted contributor code.

## Pull requests and releases

PRs are squash-merged, so each PR title becomes one commit on `main`. Titles
follow [Conventional Commits](https://www.conventionalcommits.org/):
`<type>[(scope)][!]: <summary>`, where type is `feat`, `fix`, `docs`, `style`,
`refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`. The
`PR title` workflow enforces this; commits inside a PR are not checked.

[release-please](https://github.com/googleapis/release-please) keeps one open
release PR that collects these titles. Before 1.0, `feat` and `fix` bump the
patch version and a breaking change (`!` or a `BREAKING CHANGE:` footer) bumps
the minor version; other types do not start a release. Before merging the
release PR, run the manual CI workflow on `main`. Merging it updates
`package.json`, `package-lock.json` and `CHANGELOG.md`, tags `vX.Y.Z`, creates
the GitHub release and publishes to npm with provenance.

The `Release` workflow requires two maintainer settings. The
`RELEASE_PLEASE_TOKEN` secret is a fine-grained personal access token for this
repository with read/write Contents, Issues and Pull requests permissions, so
the release PR triggers CI. npm trusts `release-please.yml` in this repository
as the publisher of `@stratoscli/stratos`; no npm token is stored.

## Documentation site

The GitHub Pages site has reader-facing guides in `docs/`, detailed references
in `docs/reference/`, and walkthroughs alongside the examples. Edit those
sources, not generated copies. The README, contributor-agent instructions, and
bundled agent skill remain repository/package documents rather than website
pages; links to them open the source on GitHub.

Preserve the distinction between a tutorial and a reference. Tutorials should
explain prerequisites, file locations, complete commands, expected results, and
failure boundaries. References retain exact types, defaults, precedence, and
limitations. Keep existing anchors when renaming sections with inbound links.
The code-only authoring and composition examples are exercised directly from
their Markdown in the test suite.

Navigation and presentation live in `docs/`.
`scripts/docs/prepare.mjs` publishes an explicit file list; new files do not
become public simply because they exist in the repository.

The `Documentation` workflow builds with GitHub's Jekyll Pages action, verifies
rendered local links and heading anchors, and uploads a `github-pages` artifact.
Pull requests only build; they never deploy. No provider credentials or workflow
execution are needed.

To preview with Docker already running, use the same image as the Pages action:

```sh
node scripts/docs/prepare.mjs .pages-source
docker run --rm \
  --volume "$PWD:/github/workspace" \
  --workdir /github/workspace \
  --env GITHUB_WORKSPACE=/github/workspace \
  --env GITHUB_REPOSITORY=talktoajayprakash/stratos \
  --env INPUT_SOURCE=.pages-source \
  --env INPUT_DESTINATION=.pages-site/stratos \
  ghcr.io/actions/jekyll-build-pages:v1.0.13
node scripts/docs/check.mjs .pages-site/stratos /stratos
```

To browse locally with Python 3, run
`python3 -m http.server 8000 --bind 127.0.0.1 --directory .pages-site` and open
`http://127.0.0.1:8000/stratos/`. Stop the server with Ctrl+C.

The source/output directories are ignored local build products. Preparation
requires a new destination rather than overwriting an existing directory;
remove only those generated directories before rebuilding. If Docker is
unavailable, inspect the `Documentation` workflow's build and download its site
artifact instead. The rendered site uses the `/stratos/` project URL prefix.

**Publishing is opt-in.** GitHub Pages may expose a site publicly even when its
repository is private. Before enabling it, review the publication decision and
the file list. A maintainer enables **Settings > Pages > Build and deployment >
Source: GitHub Actions**, then sets the repository Actions variable
`PAGES_ENABLED` to `true`. Run `Documentation` on `main` for the first deployment;
subsequent documentation changes on `main` deploy automatically. The default
address is `https://talktoajayprakash.github.io/stratos/`.

Changing the variable back prevents future deployments but does not unpublish
an existing site; unpublish it separately in Pages settings when needed.
