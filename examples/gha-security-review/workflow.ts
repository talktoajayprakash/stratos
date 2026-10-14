import {readdir, readFile, stat} from 'node:fs/promises';
import {join, relative} from 'node:path';

import {noul, decision, workflow} from '@stratoscli/stratos';
import {parseDocument} from 'yaml';
import {z} from 'zod';

const FindingSchema = z.strictObject({
  file: z.string().describe('Repository-relative workflow file path.'),
  line: z
    .number()
    .int()
    .positive()
    .describe('Best line number for the vulnerable construct.'),
  class: z.string().min(1).describe('Vulnerability class.'),
  severity: z.string().min(1).describe('Severity: critical, high, or medium.'),
  explanation: z.string().min(1).describe('Concrete exploit path and impact.'),
});

type Severity = 'critical' | 'high' | 'medium';

type Candidate = {
  file: string;
  line: number;
  class: string;
  severity: Severity;
  reason: string;
  evidence: string;
};

type Data = Record<string, unknown>;

type WorkflowFile = {
  relPath: string;
  text: string;
  lines: string[];
  data: Data;
  triggers: Set<string>;
};

const classGuidance: Record<string, string> = {
  pwn_request:
    'Exploitable only when pull_request_target checks out fork PR code (PR head ref/sha) and then executes it (scripts, installs, tests, local actions) with write token or secrets.',
  expression_injection:
    'Exploitable only when an attacker-controlled github.event value (PR title/body/head ref, issue/comment body) is interpolated with ${{ }} directly inside a run: shell block, under an externally triggerable event. Values passed through env: and quoted are safe. workflow_dispatch inputs are not attacker-controlled.',
  unauthorized_command:
    'Exploitable when an issue_comment command handler lacks an author_association check for OWNER, MEMBER or COLLABORATOR before running a privileged path.',
  artifact_poisoning:
    'Exploitable when a privileged workflow_run job downloads an artifact from the triggering (possibly fork PR) run and executes or deploys it without verifying source branch or integrity.',
  supply_chain:
    'Exploitable when a privileged job (secrets, OIDC, write tokens, publish/deploy) uses a third-party action pinned to a mutable tag or branch. Full 40-character SHA pins, actions/*, github/* and local actions are safe.',
  self_hosted_runner:
    'Exploitable when fork pull_request code runs on a persistent self-hosted runner.',
};

const THREAT_MODEL =
  'Attacker has no write access. They can open fork PRs, create issues and comment. They cannot trigger workflow_dispatch or push to protected branches.';
// A missed vulnerability costs more than a false positive, so drop only confident "no" answers (TypeSafe Noul docs: < 0.2).
const CONFIRM_THRESHOLD = 0.2;

function asRecord(value: unknown): Data {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Data)
    : {};
}

function collectStrings(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }
  if (typeof value === 'object') {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function parseTriggers(onValue: unknown): Set<string> {
  if (typeof onValue === 'string') {
    return new Set([onValue]);
  }
  if (Array.isArray(onValue)) {
    return new Set(onValue.map(String));
  }
  return new Set(Object.keys(asRecord(onValue)));
}

function hasAny(set: Set<string>, names: string[]): boolean {
  return names.some(name => set.has(name));
}

function lineFor(lines: string[], needles: Array<string | RegExp>): number {
  for (const needle of needles) {
    const index = lines.findIndex(line =>
      typeof needle === 'string' ? line.includes(needle) : needle.test(line),
    );
    if (index >= 0) {
      return index + 1;
    }
  }
  return 1;
}

function permissionText(value: unknown): string {
  return collectStrings(value).join(' ').toLowerCase();
}

function hasWritePower(
  rootPermissions: unknown,
  jobPermissions: unknown,
  text: string,
): boolean {
  const combined = `${permissionText(rootPermissions)} ${permissionText(jobPermissions)} ${text.toLowerCase()}`;
  return /write-all|:\s*write|\bwrite\b|id-token:\s*write|secrets\./.test(
    combined,
  );
}

function isForkCheckoutRef(ref: unknown): boolean {
  const text = collectStrings(ref).join(' ').toLowerCase();
  return /pull_request\.head\.(sha|ref|label)|github\.head_ref|refs\/pull\/|head\.sha|head\.ref/.test(
    text,
  );
}

function isDangerousRunExpression(expr: string): boolean {
  const e = expr.toLowerCase();
  if (
    /github\.event\.pull_request\.number|github\.event\.issue\.number|github\.run_id|github\.run_number|github\.sha|github\.repository(?!\.)|github\.repository_owner|secrets\./.test(
      e,
    )
  ) {
    return false;
  }
  return /github\.head_ref|pull_request\.(title|body|head\.ref|head\.label)|github\.event\.issue\.(title|body)|github\.event\.comment\.body|github\.event\.review\.body|github\.event\.discussion\.(title|body)|steps\.[^.]+\.outputs\.(files|all_changed_files|pr_head_ref)/.test(
    e,
  );
}

function runExpressions(runBlock: unknown): string[] {
  if (typeof runBlock !== 'string') {
    return [];
  }
  return [...runBlock.matchAll(/\$\{\{([^}]+)}}/g)].map(m => m[1] ?? '');
}

function parseUses(value: string): {source: string; ref: string} | null {
  if (value.startsWith('./') || value.startsWith('../')) {
    return null;
  }
  const at = value.lastIndexOf('@');
  if (at < 0) {
    return {source: value, ref: ''};
  }
  return {source: value.slice(0, at), ref: value.slice(at + 1)};
}

function isFirstPartyOrLocalUse(uses: string): boolean {
  return (
    uses.startsWith('actions/') ||
    uses.startsWith('github/') ||
    uses.startsWith('./') ||
    uses.startsWith('../')
  );
}

function isPinnedSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

async function listWorkflowFiles(root: string): Promise<string[]> {
  async function walk(current: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return [];
    }
    const found: string[] = [];
    for (const entry of entries) {
      const full = join(current, entry);
      if ((await stat(full)).isDirectory()) {
        found.push(...(await walk(full)));
      } else if (/\.ya?ml$/i.test(entry)) {
        found.push(full);
      }
    }
    return found;
  }
  return (await walk(join(root, '.github', 'workflows'))).sort();
}

async function loadWorkflow(
  repoDir: string,
  absPath: string,
): Promise<WorkflowFile> {
  const text = await readFile(absPath, 'utf8');
  const data = asRecord(parseDocument(text, {prettyErrors: false}).toJSON());
  return {
    relPath: relative(repoDir, absPath).replace(/\\/g, '/'),
    text,
    lines: text.split('\n'),
    data,
    triggers: parseTriggers(data.on),
  };
}

function scanWorkflow(file: WorkflowFile): Candidate[] {
  const candidates: Candidate[] = [];
  const rootPermissions = file.data.permissions;
  const jobs = asRecord(file.data.jobs);
  const add = (
    klass: string,
    severity: Severity,
    line: number,
    reason: string,
    evidence: string,
  ) => {
    if (candidates.some(c => c.class === klass)) {
      return;
    }
    candidates.push({
      file: file.relPath,
      line,
      class: klass,
      severity,
      reason,
      evidence,
    });
  };

  const wholeText = file.text;
  const hasIssueCommentAuth =
    /author_association\s*==\s*['"](?:MEMBER|OWNER|COLLABORATOR)['"]/.test(
      wholeText,
    );

  for (const [jobName, jobValue] of Object.entries(jobs)) {
    const job = asRecord(jobValue);
    const steps = Array.isArray(job.steps) ? job.steps.map(asRecord) : [];
    const writePower = hasWritePower(
      rootPermissions,
      job.permissions,
      wholeText,
    );

    const runsOnText = collectStrings(job['runs-on']).join(' ').toLowerCase();
    if (
      hasAny(file.triggers, ['pull_request', 'pull_request_target']) &&
      runsOnText.includes('self-hosted')
    ) {
      add(
        'self_hosted_runner',
        'critical',
        lineFor(file.lines, [/runs-on:.*self-hosted/i, /self-hosted/i]),
        'fork pull requests can execute on a persistent self-hosted runner',
        `job ${jobName} runs on ${runsOnText}`,
      );
    }

    if (hasAny(file.triggers, ['issue_comment'])) {
      const conditions = [job.if, ...steps.map(step => step.if)]
        .map(v => String(v ?? ''))
        .join('\n');
      if (
        /github\.event\.comment\.body/.test(conditions) &&
        /['"]\/[a-z][\w-]*/i.test(conditions) &&
        !hasIssueCommentAuth
      ) {
        add(
          'unauthorized_command',
          writePower ? 'high' : 'medium',
          lineFor(file.lines, [/comment\.body/, /issue_comment/]),
          'issue_comment command parser lacks a trusted author_association gate',
          conditions.trim(),
        );
      }
    }

    let forkCheckoutIndex = -1;
    let forkCheckoutLine = 1;
    for (const [index, step] of steps.entries()) {
      const uses = String(step.uses ?? '');
      if (
        /^actions\/checkout@/.test(uses) &&
        isForkCheckoutRef(asRecord(step.with).ref)
      ) {
        forkCheckoutIndex = index;
        forkCheckoutLine = lineFor(file.lines, [
          /pull_request\.head\.(sha|ref|label)/,
          /github\.head_ref/,
          /refs\/pull\//,
        ]);
      }
    }
    if (file.triggers.has('pull_request_target') && forkCheckoutIndex >= 0) {
      const executesFork = steps
        .slice(forkCheckoutIndex + 1)
        .some(
          step =>
            typeof step.run === 'string' ||
            String(step.uses ?? '').startsWith('./'),
        );
      if (executesFork) {
        add(
          'pwn_request',
          writePower ? 'critical' : 'high',
          forkCheckoutLine,
          'pull_request_target checks out fork PR code and later executes commands/local code',
          `job ${jobName} checks out a pull_request.head ref before executable steps`,
        );
      }
    }

    const externalRunTrigger = hasAny(file.triggers, [
      'pull_request',
      'pull_request_target',
      'issues',
      'issue_comment',
      'pull_request_review',
      'discussion',
      'discussion_comment',
    ]);
    if (externalRunTrigger) {
      for (const step of steps) {
        const expressions = runExpressions(step.run).filter(
          isDangerousRunExpression,
        );
        if (expressions.length) {
          add(
            'expression_injection',
            'high',
            lineFor(
              file.lines,
              expressions.map(expr => expr.trim()).filter(Boolean),
            ),
            'attacker-controlled GitHub context is interpolated directly into a run shell block',
            expressions.join(', '),
          );
        }
      }
    }

    if (file.triggers.has('workflow_run')) {
      const downloadIndex = steps.findIndex(step =>
        String(step.uses ?? '').startsWith('actions/download-artifact@'),
      );
      if (downloadIndex >= 0) {
        const executesArtifact = steps
          .slice(downloadIndex + 1)
          .some(step => typeof step.run === 'string');
        const referencesTriggeringRun =
          /github\.event\.workflow_run\.id|run-id:/.test(wholeText);
        if (executesArtifact && referencesTriggeringRun && writePower) {
          add(
            'artifact_poisoning',
            'high',
            lineFor(file.lines, [
              /actions\/download-artifact/,
              /workflow_run\.id/,
            ]),
            'privileged workflow_run job downloads and executes or deploys an artifact from the triggering run',
            `job ${jobName} downloads artifact then runs a deploy command`,
          );
        }
      }
    }

    for (const step of steps) {
      const usesValue = String(step.uses ?? '');
      if (!usesValue || isFirstPartyOrLocalUse(usesValue)) {
        continue;
      }
      const parsed = parseUses(usesValue);
      if (!parsed || isPinnedSha(parsed.ref)) {
        continue;
      }
      const privileged =
        writePower ||
        /secrets\.|id-token:\s*write|packages:\s*write|contents:\s*write|deployments:\s*write/.test(
          wholeText,
        );
      if (privileged) {
        add(
          'supply_chain',
          hasAny(file.triggers, ['pull_request_target']) ? 'critical' : 'high',
          lineFor(file.lines, [usesValue]),
          'privileged job uses a mutable third-party action reference instead of a full commit SHA',
          usesValue,
        );
      }
    }
  }

  return candidates;
}

function explain(candidate: Candidate): string {
  switch (candidate.class) {
    case 'pwn_request':
      return 'An external attacker opens a fork PR that modifies package scripts or dependency install hooks. The pull_request_target workflow checks out the PR head and then runs commands from that checkout with base-repository write permissions, allowing token theft or unauthorized repository writes.';
    case 'expression_injection':
      return 'An external attacker controls the PR title or branch name. GitHub expands that value directly into a run shell block before the shell starts, so a title or branch containing shell metacharacters can execute commands on the runner.';
    case 'unauthorized_command':
      return 'An external attacker comments the command on a fork PR. Because the issue_comment job lacks an author_association gate, it checks out the PR merge ref and runs a PR-controlled script with write-scoped repository permissions.';
    case 'artifact_poisoning':
      return 'An external attacker opens a fork PR whose build uploads a malicious artifact. The privileged workflow_run path downloads the triggering run artifact and deploys or executes it without verifying the source branch or artifact integrity.';
    case 'supply_chain':
      return 'A third-party action maintainer account or tag can be compromised and move the mutable action ref. This privileged publishing job passes secrets and write/OIDC permissions to that unpinned action, enabling secret theft or package/repository compromise.';
    case 'self_hosted_runner':
      return 'An external attacker opens a fork PR containing malicious install or test commands. The pull_request workflow executes that code on a persistent self-hosted runner, where it can leave state, steal cached credentials, or pivot into internal resources.';
    default:
      return candidate.reason;
  }
}

export default workflow({
  input: z.strictObject({
    repoDir: z
      .string()
      .min(1)
      .describe('Path to the repository clone to review.'),
  }),
  output: z.strictObject({
    findings: z
      .array(FindingSchema)
      .describe('Confirmed GitHub Actions security findings.'),
  }),
  async run(input) {
    const paths = await listWorkflowFiles(input.repoDir);
    const files = await Promise.all(
      paths.map(path => loadWorkflow(input.repoDir, path)),
    );

    const confirmed: Candidate[] = [];
    await Promise.all(
      files.map(async file => {
        const candidates = scanWorkflow(file);
        if (!candidates.length) {
          return;
        }
        const questions = Object.fromEntries(
          candidates.map((candidate, i) => [
            `c${i}`,
            noul(
              {
                candidate,
                rule: classGuidance[candidate.class] ?? candidate.class,
                threat_model: THREAT_MODEL,
                question:
                  'Under `threat_model` and `rule`, is `candidate` an exploitable vulnerability in this workflow file?',
              },
              {
                true: 'Exploitable as described by the rule',
                false: 'Safe pattern or not attacker-reachable',
              },
            ),
          ]),
        );
        const {answers} = await decision({
          configId: 'triage',
          state: {workflow_file: file.relPath, content: file.text},
          questions,
        });
        candidates.forEach((candidate, i) => {
          if (answers[`c${i}`]!.noul >= CONFIRM_THRESHOLD) {
            confirmed.push(candidate);
          }
        });
      }),
    );

    const findings = confirmed.map(candidate => ({
      file: candidate.file,
      line: candidate.line,
      class: candidate.class,
      severity: candidate.severity,
      explanation: explain(candidate),
    }));
    findings.sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.class.localeCompare(b.class),
    );
    return {findings};
  },
});
