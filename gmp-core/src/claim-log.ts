import fs from 'fs';
import crypto from 'crypto';
import config from './config.js';
import logger from './logger.js';
import { withFileLock } from './file-lock.js';
import { writeFileAtomicSync, cleanStaleTempFiles } from './atomic-file.js';
import { StateAuthenticationError } from './types.js';

/**
 * An append-only log of session-key claims.
 *
 * Claims are permanent — a fingerprint that has been used may never be used
 * again — so the set only grows. Holding them in the nonce state JSON meant
 * every claim rewrote, re-encrypted and re-fsynced the whole file under a lock,
 * which made handshake latency linear in the number of claims ever made:
 * roughly 5.3ms per thousand, synchronous, on the event loop. A node with 100k
 * claims blocked for half a second per handshake, and a busy one reached that
 * within months.
 *
 * Appending fixes the shape of the cost. A claim is an O(1) index lookup and,
 * when it is new, one append of a couple of hundred bytes. The lock is still
 * taken — two processes sharing a data directory must not interleave partial
 * records — but it is now held for a constant time rather than for however long
 * it takes to rewrite the accumulated history.
 *
 * ── Record framing ──────────────────────────────────────────────────────
 *
 *   [4 bytes big-endian length][length bytes: IV(12) ‖ GCM tag(16) ‖ ciphertext]
 *
 * Every record carries its own IV and tag, so each authenticates on its own.
 * That is the property that matters for a file which is only ever appended to:
 * a record damaged in the middle cannot forge or invalidate the records before
 * it, and a half-written record at the end is simply not a record yet.
 *
 * Length-prefixed binary rather than one sealed line of hex: it halves the size
 * at the scale this exists to handle, and it makes truncation exact. A short
 * tail is detected by comparing the declared length against the bytes actually
 * remaining, instead of guessing from a missing newline.
 */

/** Binds a record to this log, so one cannot be spliced in from another file. */
const RECORD_AAD = Buffer.from('gmp-nonce-claim-v1');

const LENGTH_PREFIX_BYTES = 4;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * A record longer than this means the framing is broken rather than the file
 * being short. Real records run to a couple of hundred bytes; the cap is the
 * line between "this file was truncated mid-append", which is ordinary, and
 * "these bytes are not a record", which is corruption.
 */
const MAX_RECORD_BYTES = 64 * 1024;

/** Compact only when the log is both large and provably redundant. */
const COMPACT_MIN_BYTES = 8 * 1024 * 1024;
const COMPACT_MIN_REDUNDANCY = 0.1;

interface ClaimPayload {
  /** Session-key fingerprint. The identity of the claim. */
  f: string;
  /** Hex NodeID of the peer it was first claimed with. Diagnostic only. */
  p: string;
  /** Claim timestamp, epoch ms. */
  t: number;
}

export interface ClaimRecord {
  fingerprint: string;
  peerNodeId: string;
  claimedAt: number;
}

export class ClaimLog {
  private filePath: string;
  private encryptionKey: Buffer | null;
  private index: Set<string>;
  /** Claims taken before a key existed, waiting for one so they can be written. */
  private pending: ClaimRecord[];
  /** Bytes of the log already folded into the index, for incremental reloads. */
  private consumedBytes: number;
  private lockTimeoutMs: number;
  private sawCorruption: boolean;
  /** Records folded in so far, duplicates included — the redundancy signal. */
  private recordsSeen: number;

  constructor({ filePath, encryptionKey = null, lockTimeoutMs = 5000 }: {
    filePath: string;
    encryptionKey?: Buffer | null;
    lockTimeoutMs?: number;
  }) {
    this.filePath = filePath;
    this.encryptionKey = encryptionKey;
    this.index = new Set();
    this.pending = [];
    this.consumedBytes = 0;
    this.lockTimeoutMs = lockTimeoutMs;
    this.sawCorruption = false;
    this.recordsSeen = 0;
    cleanStaleTempFiles(this.filePath);
  }

  /** How many distinct fingerprints are claimed. */
  get size(): number {
    return this.index.size;
  }

  get path(): string {
    return this.filePath;
  }

  /** True once a record has failed authentication; the tail after it is untrusted. */
  get corrupt(): boolean {
    return this.sawCorruption;
  }

  has(fingerprint: string): boolean {
    return this.index.has(fingerprint);
  }

  setEncryptionKey(key: Buffer | null): void {
    this.encryptionKey = key;
    // A new key means a different file to read; anything already consumed was
    // read under different terms.
    this.consumedBytes = 0;
    this.recordsSeen = 0;
    this.sawCorruption = false;
  }

  private _seal(record: ClaimRecord): Buffer {
    const payload: ClaimPayload = { f: record.fingerprint, p: record.peerNodeId, t: record.claimedAt };
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey as Buffer, iv);
    cipher.setAAD(RECORD_AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const body = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);

    const framed = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + body.length);
    framed.writeUInt32BE(body.length, 0);
    body.copy(framed, LENGTH_PREFIX_BYTES);
    return framed;
  }

  private _open(body: Buffer): ClaimRecord | null {
    const iv = body.subarray(0, IV_BYTES);
    const tag = body.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = body.subarray(IV_BYTES + TAG_BYTES);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey as Buffer, iv);
      decipher.setAAD(RECORD_AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      const parsed = JSON.parse(plaintext) as ClaimPayload;
      if (!parsed || typeof parsed.f !== 'string' || !parsed.f) return null;
      return { fingerprint: parsed.f, peerNodeId: String(parsed.p ?? ''), claimedAt: Number(parsed.t) || 0 };
    } catch {
      return null;
    }
  }

  /**
   * A record that will not authenticate.
   *
   * Everything after it is untrusted: the framing is derived from the bytes
   * themselves, so once one record is wrong there is no way to know where the
   * next one begins. Records *before* it are unaffected — each carries its own
   * tag — so they stay in the index and the read simply stops here.
   */
  private _onCorruptRecord(offset: number): void {
    this.sawCorruption = true;
    logger.error(
      'nonce-store',
      'state-claim-log-corrupt',
      `Session key claim log ${this.filePath} fails authentication at byte ${offset}; ` +
      `${this.index.size} claims before that point are intact, everything after is being ignored. ` +
      `Session keys recorded in the ignored tail would be accepted again.`,
      { claimsFile: this.filePath, offset, recovered: this.index.size, strict: !!config.GMP_STRICT_STATE }
    );
    if (config.GMP_STRICT_STATE) {
      throw new StateAuthenticationError(
        `Refusing to start: session key claim log at ${this.filePath} is corrupt from byte ${offset}. ` +
        `Continuing would accept session keys that have already been used. Move the file aside to ` +
        `start fresh deliberately, or unset GMP_STRICT_STATE.`
      );
    }
  }

  /**
   * Fold the log into the in-memory index.
   *
   * Incremental: only bytes appended since the last call are read, so a reload
   * (setEncryptionKey, or a poll after another process appended) costs the
   * delta rather than the whole history. A file that shrank was replaced —
   * compaction, or an operator — so it is re-read from the start.
   */
  load(): void {
    if (!this.encryptionKey) return;

    let size: number;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return; // no log yet
    }

    if (size < this.consumedBytes) {
      this.index.clear();
      this.consumedBytes = 0;
      this.recordsSeen = 0;
      this.sawCorruption = false;
    }
    if (size === this.consumedBytes) return;

    let buffer: Buffer;
    try {
      const fd = fs.openSync(this.filePath, 'r');
      try {
        const length = size - this.consumedBytes;
        buffer = Buffer.allocUnsafe(length);
        fs.readSync(fd, buffer, 0, length, this.consumedBytes);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      logger.warn(
        'nonce-store',
        'claim-log-read-failed',
        `Could not read the claim log: ${(err as Error).message}`,
        { claimsFile: this.filePath, err: (err as Error).message },
      );
      return;
    }

    let offset = 0;
    while (offset + LENGTH_PREFIX_BYTES <= buffer.length) {
      const bodyLength = buffer.readUInt32BE(offset);

      if (bodyLength < IV_BYTES + TAG_BYTES || bodyLength > MAX_RECORD_BYTES) {
        // Not a plausible record header. A short tail is ordinary; a nonsense
        // length is the framing having come apart.
        this._onCorruptRecord(this.consumedBytes + offset);
        break;
      }
      if (offset + LENGTH_PREFIX_BYTES + bodyLength > buffer.length) {
        // The tail is a record that was still being written when the process
        // stopped. Normal, and silent: it was never a completed claim.
        break;
      }

      const body = buffer.subarray(offset + LENGTH_PREFIX_BYTES, offset + LENGTH_PREFIX_BYTES + bodyLength);
      const record = this._open(body);
      if (!record) {
        this._onCorruptRecord(this.consumedBytes + offset);
        break;
      }

      this.index.add(record.fingerprint);
      this.recordsSeen++;
      offset += LENGTH_PREFIX_BYTES + bodyLength;
    }

    this.consumedBytes += offset;
  }

  /**
   * Write claims to the log and index them, or report failure.
   *
   * Under the lock so that two processes cannot interleave halves of a record,
   * and fsynced before returning so the caller may treat success as durable.
   * The index is only updated once the bytes are down: a claim the caller is
   * told succeeded must be one the next process will also see.
   *
   * With no key configured the records are held in memory and indexed anyway —
   * link.js supplies the key only after deriving the identity, and a claim made
   * before that still has to be honoured. flushPending() writes them when the
   * key arrives.
   */
  append(records: ClaimRecord[]): boolean {
    if (records.length === 0) return true;

    if (!this.encryptionKey) {
      for (const record of records) {
        this.pending.push(record);
        this.index.add(record.fingerprint);
      }
      return true;
    }

    const framed = Buffer.concat(records.map(r => this._seal(r)));

    try {
      withFileLock(this.filePath, () => {
        const fd = fs.openSync(this.filePath, 'a');
        try {
          fs.writeSync(fd, framed);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }, { timeoutMs: this.lockTimeoutMs });
    } catch (err) {
      logger.error(
        'nonce-store',
        'claim-log-append-failed',
        `Could not append ${records.length} session key claim(s): ${(err as Error).message}`,
        { claimsFile: this.filePath, err: (err as Error).message },
      );
      return false;
    }

    for (const record of records) this.index.add(record.fingerprint);
    this.recordsSeen += records.length;
    this.consumedBytes += framed.length;
    return true;
  }

  /** Write anything claimed before a key existed. Returns false if it could not. */
  flushPending(): boolean {
    if (this.pending.length === 0 || !this.encryptionKey) return true;
    const queued = this.pending;
    this.pending = [];
    if (this.append(queued)) return true;
    this.pending = queued;
    return false;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Rewrite the log with one record per fingerprint.
   *
   * Compaction can only ever remove duplicates — a claim never expires, so
   * there is nothing else it would be entitled to drop. Duplicates come from
   * migration (every counter entry's fingerprint is promoted, and several
   * sessions with one peer share none of them, but a re-migration would repeat
   * them) and from a retried append whose first attempt reached disk.
   *
   * Runs at startup, never on the handshake path, and only when the log is both
   * large enough to matter and redundant enough to be worth the rewrite.
   */
  compactIfNeeded(): boolean {
    if (!this.encryptionKey || this.sawCorruption) return false;

    let size: number;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return false;
    }
    if (size < COMPACT_MIN_BYTES) return false;

    // load() already counted every record and indexed every distinct
    // fingerprint, so redundancy is known without touching the disk. Reading
    // the whole log again to find out would double startup cost on exactly the
    // large logs this check exists for, and would nearly always conclude that
    // there is nothing to do.
    const redundancy = this.recordsSeen ? (this.recordsSeen - this.index.size) / this.recordsSeen : 0;
    if (redundancy < COMPACT_MIN_REDUNDANCY) return false;

    const records = this._readAll();
    if (!records) return false;

    const unique = new Map<string, ClaimRecord>();
    for (const record of records) {
      const seen = unique.get(record.fingerprint);
      // Keep the earliest sighting: it is when the key was actually burnt.
      if (!seen || record.claimedAt < seen.claimedAt) unique.set(record.fingerprint, record);
    }

    try {
      withFileLock(this.filePath, () => {
        // Re-read under the lock: another process may have appended between the
        // scan above and here, and those records must not be dropped.
        const current = this._readAll();
        if (current) {
          for (const record of current) {
            const seen = unique.get(record.fingerprint);
            if (!seen || record.claimedAt < seen.claimedAt) unique.set(record.fingerprint, record);
          }
        }
        const rebuilt = Buffer.concat([...unique.values()].map(r => this._seal(r)));
        writeFileAtomicSync(this.filePath, rebuilt);
      }, { timeoutMs: this.lockTimeoutMs });
    } catch (err) {
      logger.warn(
        'nonce-store',
        'claim-log-compact-failed',
        `Could not compact the claim log: ${(err as Error).message}`,
        { claimsFile: this.filePath, err: (err as Error).message },
      );
      return false;
    }

    logger.info(
      'nonce-store',
      'claim-log-compacted',
      `Compacted the session key claim log: ${records.length} records reduced to ${unique.size} unique claims.`,
      { claimsFile: this.filePath, before: records.length, after: unique.size },
    );

    // The file was replaced, and now holds exactly the unique set.
    this.index = new Set(unique.keys());
    this.recordsSeen = unique.size;
    this.consumedBytes = fs.statSync(this.filePath).size;
    return true;
  }

  /** Every record in the log, or null if it cannot be read in full. */
  private _readAll(): ClaimRecord[] | null {
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(this.filePath);
    } catch {
      return null;
    }

    const records: ClaimRecord[] = [];
    let offset = 0;
    while (offset + LENGTH_PREFIX_BYTES <= buffer.length) {
      const bodyLength = buffer.readUInt32BE(offset);
      if (bodyLength < IV_BYTES + TAG_BYTES || bodyLength > MAX_RECORD_BYTES) break;
      if (offset + LENGTH_PREFIX_BYTES + bodyLength > buffer.length) break;
      const record = this._open(
        buffer.subarray(offset + LENGTH_PREFIX_BYTES, offset + LENGTH_PREFIX_BYTES + bodyLength),
      );
      if (!record) break;
      records.push(record);
      offset += LENGTH_PREFIX_BYTES + bodyLength;
    }
    return records;
  }
}
