import fs from 'fs';
import path from 'path';

/**
 * Replace a file's contents durably, or leave the previous contents untouched.
 *
 * `fs.writeFileSync` opens the target with O_TRUNC, so the live file is emptied
 * before the new bytes are written. A crash, a full disk, an OOM kill or a power
 * cut in that window leaves a truncated file — and for the nonce store and the
 * peer cache a truncated file is worse than no write at all, because it destroys
 * the replay state that was already there. Writing somewhere else and then
 * moving the result into place never puts the live file in an intermediate
 * state:
 *
 *   1. write the new contents to `<path>.tmp`
 *   2. `fsync` the temp file's descriptor. Closing a file only hands its bytes
 *      to the OS page cache; without the fsync the rename below can be durable
 *      while the data it points at is not, which is the classic way to end up
 *      with a file full of zeroes after a power loss
 *   3. `rename` `<path>.tmp` → `<path>`. Atomic on POSIX: a concurrent reader
 *      sees either the whole old file or the whole new one, never a mixture,
 *      and the old inode survives until the last reader lets go of it
 *   4. `fsync` the containing directory, so the rename itself survives a power
 *      cut — a durable file is no use if the directory entry naming it is lost
 *
 * On failure the temp file is removed and the error is rethrown, with the
 * original file still in place. Callers that must fail closed can therefore
 * treat a throw as "the previous state is still what is on disk".
 *
 * Assumes one writer per path, which is what the data directory already
 * assumes: two processes sharing a state file would be racing over its contents
 * regardless of how each one writes.
 */
export function writeFileAtomicSync(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp`;

  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Leave nothing half-written behind for the next start to trip over. If the
    // temp file is not there, or is a directory the caller planted, there is
    // nothing to clean up and the original error is the one worth reporting.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* nothing to remove */
    }
    throw err;
  }

  // Not every platform lets a directory be opened for fsync — Windows rejects
  // it outright. The rename is still atomic there; only its durability across a
  // power cut is weaker, so this must never turn a completed write into a
  // reported failure.
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* directory fsync unsupported on this platform */
  }
}
