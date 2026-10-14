import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open, mkdir, lstat, rename, unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {z} from 'zod';

import {acquireFileLock} from '../file-lock.js';

const recordSchema = z.object({
  serverUrl: z.string(),
  authorizationServer: z.string(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  clientSecretExpiresAt: z.number().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  scope: z.string().optional(),
  tokenEndpointAuthMethod: z.string().optional(),
});
const fileSchema = z.strictObject({
  version: z.literal(1),
  records: z.array(recordSchema),
});
export type CredentialRecord = z.infer<typeof recordSchema>;
export type CredentialIdentity = Pick<
  CredentialRecord,
  'serverUrl' | 'authorizationServer' | 'clientId'
>;
const identity = (value: CredentialIdentity) =>
  JSON.stringify([value.serverUrl, value.authorizationServer, value.clientId]);

/** Internal persistence format. Secrets are never included in validation errors. */
export class CredentialStore {
  constructor(readonly directory = join(homedir(), '.stratos')) {}
  private async prepare(): Promise<void> {
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.mode & 0o077) {
      throw new Error('Credential directory must have owner-only permissions');
    }
  }
  async list(): Promise<CredentialRecord[]> {
    await this.prepare();
    let handle;
    try {
      handle = await open(
        join(this.directory, 'credentials.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw new Error('Cannot safely open MCP credentials');
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.mode & 0o077) {
        throw new Error('MCP credentials require owner-only permissions');
      }
      try {
        return fileSchema.parse(JSON.parse(await handle.readFile('utf8')))
          .records;
      } catch {
        throw new Error('Malformed MCP credential file');
      }
    } finally {
      await handle.close();
    }
  }
  async find(
    serverUrl: string,
    authorizationServer: string,
    clientId?: string,
  ): Promise<CredentialRecord | undefined> {
    const matches = (await this.list()).filter(
      record =>
        record.serverUrl === serverUrl &&
        record.authorizationServer === authorizationServer &&
        (!clientId || record.clientId === clientId),
    );
    if (matches.length > 1) {
      throw new Error('Multiple MCP registrations found; specify a client ID');
    }
    return matches[0];
  }
  /** Remember the first server before a configured secret can be sent. */
  async bindAuthorizationServer(
    key: CredentialIdentity,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.change(records => {
      const matches = records.filter(
        record =>
          record.serverUrl === key.serverUrl &&
          record.clientId === key.clientId,
      );
      if (
        matches.some(
          record => record.authorizationServer !== key.authorizationServer,
        )
      ) {
        throw new Error(
          'MCP OAuth authorization server changed; stored credentials were preserved. Verify the change, then use stratos mcp logout and login to trust the new server',
        );
      }
      return matches.length ? records : [...records, key];
    }, signal);
  }
  async save(record: CredentialRecord, signal?: AbortSignal): Promise<void> {
    await this.change(
      records => [
        ...records.filter(item => identity(item) !== identity(record)),
        recordSchema.parse(record),
      ],
      signal,
    );
  }
  async remove(key: CredentialIdentity, signal?: AbortSignal): Promise<void> {
    await this.change(
      records => records.filter(record => identity(record) !== identity(key)),
      signal,
    );
  }
  async lock<T>(
    key: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.prepare();
    const filename = `.credentials-${createHash('sha256').update(key).digest('hex')}.lock`;
    const handle = await open(
      join(this.directory, filename),
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.mode & 0o077) {
        throw new Error('Unsafe credential lock permissions');
      }
      await acquireFileLock(handle, signal);
      return await action();
    } finally {
      await handle.close();
    } // OS releases the lock on close or process exit.
  }
  refreshLock<T>(
    key: CredentialIdentity,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.lock(identity(key), action, signal);
  }
  private async change(
    update: (records: CredentialRecord[]) => CredentialRecord[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.lock(
      'file-update',
      async () => {
        const current = await this.list();
        const records = update(current);
        if (records === current) {
          return;
        }
        const temporary = join(
          this.directory,
          `.credentials-${randomUUID()}.tmp`,
        );
        const handle = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        try {
          await handle.writeFile(JSON.stringify({version: 1, records}));
          await handle.sync();
          await handle.close();
          await rename(temporary, join(this.directory, 'credentials.json'));
        } finally {
          await handle.close();
          await unlink(temporary).catch(error => {
            if (error.code !== 'ENOENT') {
              throw error;
            }
          });
        }
      },
      signal,
    );
  }
}
