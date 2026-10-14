import {constants} from 'node:fs';
import {open, type FileHandle} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';

/** Stable guard file; closing the descriptor or process releases the OS lock. */
export async function withFileLock<T>(
  file: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const handle = await open(
    file,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await acquireFileLock(handle, signal, performance.now() + 5000);
    return await action();
  } finally {
    await handle.close();
  }
}

/** The caller owns the descriptor, file validation and acquisition deadline. */
export async function acquireFileLock(
  handle: FileHandle,
  signal?: AbortSignal,
  deadline?: number,
): Promise<void> {
  const {flock} = await import('fs-ext');
  for (;;) {
    signal?.throwIfAborted();
    try {
      await new Promise<void>((resolve, reject) =>
        flock(handle.fd, 'exnb', error => (error ? reject(error) : resolve())),
      );
      break;
    } catch (error) {
      if (
        !['EAGAIN', 'EWOULDBLOCK'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      ) {
        throw error;
      }
      if (deadline !== undefined && performance.now() >= deadline) {
        throw new Error('File lock timed out after five seconds');
      }
      await pause(25, undefined, {signal});
    }
  }
  signal?.throwIfAborted();
}
