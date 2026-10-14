# GitHub Actions security review

This example reviews a repository's GitHub Actions workflows for
vulnerabilities that an outside attacker could exploit. The attacker can open
fork pull requests, issues, and comments but has no write access. It is a
workflow version of Sentry's
[`gha-security-review` skill](https://github.com/getsentry/skills/blob/d18b7aa8ba878354e5c348310230e652f7690f9c/skills/gha-security-review/SKILL.md).

Code does most of the work. It parses each workflow file and applies fixed
rules. Decision then confirms or rejects each flagged pattern. **No coding
agent runs, and the workflow only reads local files.** Read the
[workflow source](workflow.ts) and [configuration](workflow.yaml) together.

## Workflow descriptions

The manifest uses `shortDescription` for selection and `longDescription` for
its usage manual. The short description names the review scope and when to
choose it; the Markdown manual covers inputs, credentials, results, side
effects, limitations, and retries. Both are required; the old `description`
field is not supported.

`list` returns the short description, while `describe` returns the complete
manual alongside `inputSchema` and `outputSchema`. This checked-in example is
outside the discovery roots, so inspect it by path using the commands below.
When authored under a workspace's `.stratos/workflows/`, the equivalent flow
is `stratos list --json`, `stratos describe gha-security-review --json`, then
`stratos run gha-security-review --input '<JSON>' --json`.

## How it works

1. List `.github/workflows/**/*.yml` and `*.yaml` under `repoDir`, and parse
   each file with the `yaml` package declared in [package.json](package.json).
2. Flag candidates for six vulnerability classes:

   | Class | Flagged when |
   |---|---|
   | `pwn_request` | `pull_request_target` checks out the PR head, then runs commands or local actions |
   | `expression_injection` | Attacker-controlled event text, such as a PR title or comment body, is interpolated into a `run` block |
   | `unauthorized_command` | An `issue_comment` command handler has no `author_association` check |
   | `artifact_poisoning` | A privileged `workflow_run` job downloads the triggering run's artifact, then runs commands |
   | `supply_chain` | A privileged job uses a third-party action that is not pinned to a full commit SHA |
   | `self_hosted_runner` | A pull request workflow runs on a self-hosted runner |

3. For each file with candidates, make one Decision request. Its state is
   the file path and content, with one `noul` question per candidate. Each
   question carries the class rule and the threat model.
4. Drop candidates whose `noul` is below 0.2. Keep the rest, using the
   scanner's line and severity and a fixed explanation for each class.

`noul` is the model's probability that the answer is true. A missed
vulnerability costs more than a false alarm, so the workflow drops only
confident "no" answers. The 0.2 value is the `NO` bound in TypeSafe's
[Noul routing example](https://docs.typesafe.ai/primitives/noul). It is
example policy, not a Stratos default.

The output is `{findings: [...]}`, sorted by file and line:

| Field | Meaning |
|---|---|
| `file` | Repository-relative workflow path |
| `line` | Line of the flagged construct |
| `class` | One of the classes above |
| `severity` | `critical`, `high`, or `medium`, set by the scanner rules |
| `explanation` | Exploit path for the class |

## Prerequisites

Use a [source checkout](../../CONTRIBUTING.md#build-from-source) with Node 24+
and `npm ci` completed. The build installs the `yaml` package from the npm
registry. Decision uses Jev and requires `JEV_API_KEY`. Each run makes one
paid Jev request per flagged file.

## Run on the sample repository

[sample-repo](sample-repo) holds ten workflow files. Files `01` to `06` each
contain one vulnerability. Files `07` to `10` are safe decoys:

- `pull_request_target` without a fork checkout;
- a PR title passed through a quoted environment variable;
- a SHA-pinned third-party action;
- a `workflow_dispatch`-only input.

GitHub runs workflows only from a repository's root `.github/workflows/`
directory, so these files never execute here. Do not copy them into a real
repository.

From the repository root, build the CLI, then build the example and show its
manual and schemas:

```sh
npm run build
cd examples
node ../dist/src/cli/main.js build ./gha-security-review --json
node ../dist/src/cli/main.js describe ./gha-security-review --json
```

The description response must contain the manifest's exact short and long
descriptions plus the `repoDir` input and `findings` output schemas.
Build and description retrieval do not scan the sample or make Jev requests.
Use `schema ./gha-security-review --json` instead when only schemas are needed.

Provide `JEV_API_KEY` privately in the process environment. Alternatively, add
this override to the run command when an existing owner-protected key file is
configured:
`--overrides '{"decision":{"triage":{"apiKey":"{file:~/.stratos/secrets/jev-key}"}}}'`.
Never put the key value in arguments or checked-in files.

From `examples/`, review the sample:

```sh
node ../dist/src/cli/main.js run ./gha-security-review \
  --input '{"repoDir":"gha-security-review/sample-repo"}' --json
```

The expected result is six findings, one for each of files `01` to `06`. The
scanner does not flag the decoys, so they are never sent to Jev. Model answers
are not guaranteed.

To review another repository, pass the path to a local clone as `repoDir`.
Relative paths resolve from the directory where you run the command. The
workflow does not contact GitHub.

Run by path, not just `gha-security-review`: this example is outside automatic
`.stratos/workflows/` discovery. Raw OTLP goes to `examples/traces/` when
invoked as above and is ignored by Git. Review trace contents before sharing.

## Compared with the skill

These results come from the sample repository, with two runs of each. The skill
ran in Codex with GPT-6.1 Sol on Azure. The workflow used the checked-in code.
Values are medians, and costs are list-price estimates.

| | Skill | This workflow |
|---|---|---|
| Seeded vulnerabilities found | 5 of 6 | 6 of 6 |
| False positives | 0 | 0 |
| Model input tokens | 210K (GPT) | 4K (Jev) |
| Cost | $0.124 | $0.0002 |
| Wall time | 102 s | 0.8 s |

The skill loads its instructions and reads files with tools. The workflow runs
the scan in code and sends the model only short yes-or-no questions.

## Scope

The rules cover only the six patterns above and may miss variants, such as
reusable workflows, local action metadata, or other injection sinks. An empty
result is not a security audit. Decision can only confirm or reject scanner
candidates; it cannot add findings. Explanations are fixed per class, not
written for the specific file. Jev failures propagate; the workflow does not
fall back to unconfirmed findings.
