# Working on Stratos

## User ownership of architecture and design

The user owns all architecture and design decisions, including which design ideas to consider.

- Do not independently make architecture or design decisions.
- Do not introduce design suggestions, alternatives, or recommendations unless the user explicitly asks for them.
- When asked for suggestions or critique, provide the requested analysis and wait for the user to select or approve a design before incorporating it into the specification or implementation.
- Do not treat a discussion, an unanswered question, or an earlier agent proposal as an approved decision.
- If work requires an unresolved design decision, explain the specific decision needed and ask the user. Do not choose a default or fill the gap with an assumption.
- Record and implement the user's decisions faithfully. Do not expand them into additional requirements or behaviors without direction.

## Keep the system simple

- Do not overengineer. Implement only the scope and behavior the user has requested or approved.
- Do not add speculative abstractions, extension points, infrastructure, dependencies, or future-proofing.
- Make the smallest change that fulfills the approved requirements and fits the existing code.
- Routine implementation details that do not change architecture, interfaces, behavior, or scope may be handled directly. Escalate decisions that do change those things to the user.

## Repository hygiene

- Follow [the contribution and Google style guidelines](CONTRIBUTING.md). Run
  `npm run lint` for JavaScript/TypeScript changes; `npm run lint:fix` applies
  automatic formatting and lint fixes without replacing behavioral verification.
- Keep one-off debugging, smoke-test, and verification scripts outside the repository, in the session workspace or an isolated temporary directory. Do not commit scratch scripts, generated workflows, trace dumps, logs, or credentials.
- Remove temporary scripts and artifacts you created when the task is finished, along with their package commands and documentation references. Review the final diff for leftover scaffolding before committing.
- Keep durable regression tests and their necessary fixtures in the existing test suite. Tests that create files or processes must clean up their owned resources on success and failure.
- Preserve pre-existing tooling, user data, credentials, and explicitly requested local services; cleanup is limited to artifacts owned by the task.

## Specifications and implementation

- Keep workflow-authoring syntax, configuration, and primitives straightforward for capable coding models given the right context. Different models, including smaller local models, can be used inside workflows. This does not require special support for every model or authorize independently redesigning APIs.
- Keep Stratos-added model context to the minimum needed for correct execution. Be conservative with token usage; avoid redundant instructions, repeated context, and unnecessary detail.
- Keep confirmed requirements distinct from unresolved questions and unapproved proposals.
- Updating the specification does not authorize implementing it.
- Do not implement features during a design discussion unless the user asks for implementation.

## Implementation sessions

- Start with [the contributor guide](CONTRIBUTING.md), then read the relevant
  references in [`docs/reference/`](docs/reference/): [specification](docs/reference/SPEC.md),
  [runtime](docs/reference/RUNTIME.md), [CLI](docs/reference/CLI.md),
  [Decision](docs/reference/DECISION.md), and [telemetry](docs/reference/TELEMETRY.md).
- Distinguish unresolved designs from routine implementation and verification work. Confirm unresolved decisions with the maintainer rather than treating a proposal as approved.
- A documented design does not mean a production feature is implemented. Record actual code, dependencies, test evidence and remaining limitations in the change description. Keep private session notes and raw evidence outside this repository.
- CI means continuous integration. Follow [the testing requirements](CONTRIBUTING.md#testing), including real authenticated harness and MCP coverage when implementing those integrations.
- All live GPT-model testing with OpenCode and Codex must use direct Azure
  Foundry; follow [the provider and credential requirements](CONTRIBUTING.md#testing)
  and the [Codex Azure contract](docs/reference/RUNTIME.md#codex-azure-provider).
