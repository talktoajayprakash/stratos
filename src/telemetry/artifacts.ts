import {
  mkdir,
  open,
  readFile,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {format} from 'node:util';

import {z} from 'zod';

import {
  artifactWarning,
  directory,
  retentionSchema,
  runName,
  saveJson,
  workspaceDirectory,
  type Retention,
  type RunMetadata,
} from './artifact-storage.js';
import type {RunTelemetry} from './export.js';
import {launchRetention} from './retention.js';
import type {AgentEvent} from '../agents/events.js';
import {withFileLock} from '../file-lock.js';

export interface ArtifactIdentity {
  workflowName: string;
  executionId: string;
  parentExecutionId?: string;
  agentSessionId?: string;
}

export class RunArtifacts {
  private writes = Promise.resolve();
  private active = new Set<string>();
  private outcome: 'success' | 'error' = 'success';
  private failed = new Set<FileHandle>();

  private constructor(
    readonly path: string,
    private readonly root: string,
    private readonly metadata: RunMetadata,
    private readonly logFile: FileHandle,
    private readonly eventsFile: FileHandle,
    private readonly telemetry: RunTelemetry,
    private readonly retention: Retention | undefined,
  ) {}

  static async create(
    workspace: string,
    workflowName: string,
    executionId: string,
    telemetry: RunTelemetry,
    home = homedir(),
  ): Promise<RunArtifacts | undefined> {
    const root = join(home, '.stratos/runs');
    const handles: FileHandle[] = [];
    try {
      await mkdir(root, {recursive: true, mode: 0o700});
      await directory(root);
      const canonical = await realpath(root);
      let retention: Retention | undefined;
      try {
        let settings: unknown = {};
        try {
          settings = JSON.parse(
            await readFile(join(home, '.stratos/settings.json'), 'utf8'),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
        retention =
          z
            .object({
              logging: z
                .object({retention: retentionSchema.optional()})
                .optional(),
            })
            .parse(settings).logging?.retention ?? retentionSchema.parse({});
      } catch {
        artifactWarning('retention configuration');
      }
      return await withFileLock(join(canonical, '.lock'), async () => {
        const parent = await workspaceDirectory(canonical, resolve(workspace));
        const metadata: RunMetadata = {
          version: 1,
          workflowName,
          executionId,
          startedAt: new Date().toISOString(),
          status: 'running',
        };
        const path = join(parent, runName(metadata));
        await mkdir(path, {mode: 0o700});
        await saveJson(join(path, 'run.json'), metadata);
        const log = await open(join(path, 'run.log'), 'ax', 0o600);
        handles.push(log);
        const events = await open(join(path, 'events.jsonl'), 'ax', 0o600);
        handles.push(events);
        return new RunArtifacts(
          path,
          canonical,
          metadata,
          log,
          events,
          telemetry,
          retention,
        );
      });
    } catch {
      await Promise.all(
        handles.map(file =>
          file
            .close()
            .catch(() => artifactWarning('partial initialization cleanup')),
        ),
      );
      artifactWarning('initialization');
      return undefined;
    }
  }

  enter(executionId: string): void {
    this.active.add(executionId);
  }

  private append(file: FileHandle, text: string): void {
    this.writes = this.writes.then(async () => {
      if (this.failed.has(file)) {
        return;
      }
      try {
        await file.writeFile(text);
      } catch {
        this.failed.add(file);
        artifactWarning('write');
      }
    });
  }

  log(identity: ArtifactIdentity, level: string, args: unknown[]): void {
    if (!this.active.has(identity.executionId)) {
      return;
    }
    try {
      // Diagnostics-channel arguments are mutable; format and redact immediately.
      const message = this.telemetry.redact(
        format(...args.map(arg => this.telemetry.redact(arg))),
      );
      const fields = JSON.stringify({...identity, level});
      for (const line of String(message).split(/\r?\n/)) {
        this.append(
          this.logFile,
          `${new Date().toISOString()} ${fields} ${line}\n`,
        );
      }
    } catch {
      artifactWarning('console capture');
    }
  }

  event(identity: ArtifactIdentity, event: AgentEvent): void {
    if (!this.active.has(identity.executionId)) {
      return;
    }
    try {
      const record = {
        timestamp: event.timestamp,
        ...identity,
        event: this.telemetry.redact(event),
      };
      this.append(
        this.eventsFile,
        JSON.stringify(record, (_key, value: unknown) =>
          value instanceof Error
            ? {
                ...value,
                name: value.name,
                message: value.message,
                stack: value.stack,
                cause: value.cause,
              }
            : typeof value === 'bigint'
              ? String(value)
              : value,
        ) + '\n',
      );
    } catch {
      artifactWarning('event capture');
    }
  }

  async leave(
    executionId: string,
    outcome: 'success' | 'error',
  ): Promise<void> {
    if (!this.active.delete(executionId)) {
      return;
    }
    if (executionId === this.metadata.executionId) {
      this.outcome = outcome;
    }
    // A returned parent does not make a still-running child eligible for deletion.
    if (this.active.size) {
      return;
    }
    try {
      await this.writes;
      await Promise.all([this.logFile.close(), this.eventsFile.close()]);
      await withFileLock(join(this.root, '.lock'), async () => {
        await directory(this.path);
        await saveJson(join(this.path, 'run.json'), {
          ...this.metadata,
          status: this.outcome,
          completedAt: new Date().toISOString(),
        });
      });
      if (this.retention) {
        launchRetention(this.root, this.retention);
      }
    } catch {
      artifactWarning('finalization');
    }
  }
}
