import fs from 'fs';
import os from 'os';
import path from 'path';
import logger from './logger.js';

/** How long to keep trying before giving up and letting the caller fail closed. */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * A lock older than this is treated as debris, provided its owner also looks
 * dead. Generous relative to how long a write actually takes (single-digit
 * milliseconds) so that a slow disk is never mistaken for a crash.
 */
const DEFAULT_STALE_MS = 30_000;

/** Gap between acquisition attempts. */
const RETRY_INTERVAL_MS = 25;

interface LockRecord {
  pid: number;
  hostname: string;
  acquiredAt: number;
}

export class LockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number, holder: LockRecord | null) {
    const held = holder
      ? ` It is held by pid ${holder.pid} on ${holder.hostname}, acquired ${new Date(holder.acquiredAt).toISOString()}.`
      : '';
    super(`Could not acquire ${lockPath} within ${timeoutMs}ms.${held}`);
    this.name = 'LockTimeoutError';
  }
}

/**
 * Block until a sleep elapses, without an event loop turn.
 *
 * The state files are written synchronously from inside handshake handling, so
 * the retry loop has to be synchronous too — an async lock would let a second
 * claim interleave between the check and the write, which is the race being
 * closed. Atomics.wait on a throwaway SharedArrayBuffer is the only true
 * synchronous sleep available; a busy loop would burn a core while a peer
 * writes.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLock(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockRecord;
    if (typeof parsed?.pid === 'number' && typeof parsed?.acquiredAt === 'number') return parsed;
    return null;
  } catch {
    // Absent, unreadable, or half-written — in every case there is nothing here
    // that can be shown to belong to a living process.
    return null;
  }
}

/**
 * Is this lock debris from a process that will never release it?
 *
 * Requires both age and a dead owner. Age alone would break a lock held by a
 * process merely stalled on a slow disk, and liveness alone is unknowable for a
 * pid on another machine — so a lock whose hostname is not ours is only ever
 * broken on age, and only well past the point a write could still be running.
 */
function isStale(record: LockRecord | null, staleMs: number): boolean {
  if (!record) return true;

  const age = Date.now() - record.acquiredAt;
  // A lock stamped in the future means the clock moved; do not let that make
  // every lock look fresh forever.
  if (age < 0) return Math.abs(age) > staleMs;
  if (age <= staleMs) return false;

  if (record.hostname !== os.hostname()) return true;

  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything. It throws ESRCH when no such process exists.
    process.kill(record.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Run `fn` holding an exclusive lock on `targetPath`.
 *
 * The nonce store's save is a read-modify-write: it reads the file, folds its
 * own state into it, and writes the result back. Two processes doing that
 * without a lock silently discard each other's claims — each writes a file
 * derived from a snapshot taken before the other's write. An atomic write
 * cannot fix that on its own; only serialising the whole sequence can.
 *
 * Exclusivity comes from `open(O_CREAT|O_EXCL)`, which the kernel guarantees
 * will succeed for exactly one caller. Throws LockTimeoutError if the lock is
 * still held when the timeout expires, so the caller can fail closed rather
 * than proceeding unsynchronised.
 */
export function withFileLock<T>(
  targetPath: string,
  fn: () => T,
  { timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS }: {
    timeoutMs?: number;
    staleMs?: number;
  } = {},
): T {
  const lockPath = `${targetPath}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  let lastSeen: LockRecord | null = null;

  while (!acquired) {
    try {
      const record: LockRecord = { pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() };
      // 'wx' is O_CREAT|O_EXCL|O_WRONLY: it fails if anything is already there.
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(record));
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      lastSeen = readLock(lockPath);
      if (isStale(lastSeen, staleMs)) {
        logger.warn(
          'file-lock',
          'stale-lock-broken',
          `Removing a stale lock at ${lockPath}` +
          (lastSeen ? ` left by pid ${lastSeen.pid} on ${lastSeen.hostname}` : ' with no readable owner'),
          { lockPath, ...(lastSeen ? { pid: lastSeen.pid, hostname: lastSeen.hostname } : {}) },
        );
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* someone else broke it first, which is just as good */
        }
        continue;
      }

      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, timeoutMs, lastSeen);
      sleepSync(RETRY_INTERVAL_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Already gone — another process judged us stale and broke it. Nothing to
      // do here; the damage, if any, is in the write that just completed.
    }
  }
}
