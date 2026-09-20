import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/** Temp files older than this are assumed to be debris from a killed process. */
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

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
 *   1. write the new contents to a temp file unique to this call
 *   2. `fsync` the temp file's descriptor. Closing a file only hands its bytes
 *      to the OS page cache; without the fsync the rename below can be durable
 *      while the data it points at is not, which is the classic way to end up
 *      with a file full of zeroes after a power loss
 *   3. `rename` the temp file → `<path>`. Atomic on POSIX: a concurrent reader
 *      sees either the whole old file or the whole new one, never a mixture,
 *      and the old inode survives until the last reader lets go of it
 *   4. `fsync` the containing directory, so the rename itself survives a power
 *      cut — a durable file is no use if the directory entry naming it is lost
 *
 * The temp name carries the pid and random bytes. A fixed `<path>.tmp` was a
 * collision between writers: two processes would open the same temp file, and
 * whichever renamed first published whatever the other had written so far —
 * an "atomic" write that publishes a partial record. Uniqueness means a losing
 * writer can only lose its own whole file, never half of someone else's.
 *
 * On failure the temp file is removed and the error is rethrown, with the
 * original file still in place. Callers that must fail closed can therefore
 * treat a throw as "the previous state is still what is on disk".
 *
 * Note that this makes a single write atomic; it does not make a
 * read-modify-write atomic. Callers that read, alter and write back need a lock
 * around the whole sequence — see withFileLock in ./file-lock.js.
 */
export function writeFileAtomicSync(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;

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

/**
 * Remove temp files left behind for `filePath` by processes that died mid-write.
 *
 * Unique temp names mean a killed writer leaves its file behind rather than
 * having it reused, so something has to sweep up. Only files older than an hour
 * are touched: a temp file younger than that may belong to a live writer, and
 * unlinking it under them would turn their completed write into a failure.
 *
 * Best effort by design — a sweep that cannot read the directory is not a
 * reason to fail a caller's startup.
 */
export function cleanStaleTempFiles(filePath: string): void {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  const cutoff = Date.now() - STALE_TEMP_AGE_MS;

  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).mtimeMs < cutoff) fs.unlinkSync(candidate);
      } catch {
        /* vanished underneath us, or not ours to remove */
      }
    }
  } catch {
    /* directory unreadable or absent; nothing to sweep */
  }
}
