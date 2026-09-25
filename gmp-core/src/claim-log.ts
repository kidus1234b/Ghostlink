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
/** A different context for the checkpoint, so the two can never be confused. */
const CHECKPOINT_AAD = Buffer.from('gmp-nonce-ckpt-v1');
const CHECKPOINT_VERSION = 2;

/**
 * How many bytes immediately before `coveredBytes` are digested to tie a
 * checkpoint to the log it describes. Enough to be unique in practice, small
 * enough that verifying it is a single short read.
 */
const CHECKPOINT_ANCHOR_BYTES = 4096;

/**
 * Whether to check the consumedBytes invariant after every mutation.
 *
 * On for the test suite, and available in production behind GMP_DEBUG_ASSERTS
 * for diagnosing a node that is losing claims. Read once so that leaving it off
 * costs one boolean test per mutation.
 */
const ASSERT_BOUNDARIES =
  process.env.NODE_ENV === 'test' || /^(1|true)$/i.test(process.env.GMP_DEBUG_ASSERTS ?? '');

/**
 * Above this the boundary check walks no further than its O(1) part. A full
 * framing walk is cheap — it reads length prefixes and decrypts nothing — but
 * it still reads the whole file, and doing that per claim on a 215 MiB log
 * would cost more than the bug it is looking for.
 */
const DEEP_ASSERT_MAX_BYTES = 1024 * 1024;

/**
 * How many records may accumulate past the checkpoint before a new one is
 * written. Replay costs roughly 34µs per record, so this caps the replay part
 * of startup at about a second; the checkpoint write that clears it is paid
 * once, at startup, never on the handshake path.
 */
const CHECKPOINT_EVERY_RECORDS = 25_000;

/**
 * A hard ceiling on how far the tail may run past the last checkpoint before
 * one is written inline rather than deferred.
 *
 * The deferred write needs an event loop turn, which a node handling handshakes
 * gets constantly — but nothing guarantees it. Without a ceiling, a burst of
 * claims that never yields leaves the tail unbounded, and the replay bound this
 * whole mechanism promises becomes conditional on scheduling. One claim in
 * fifty thousand pays for the write; every other claim stays off the path.
 */
const CHECKPOINT_CEILING_RECORDS = CHECKPOINT_EVERY_RECORDS * 2;

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

/**
 * Why _consumeTail stopped. The distinction drives what append() is allowed to
 * do next, so it is a returned value rather than a field someone might forget
 * to read.
 */
type TailState =
  /** Every byte parsed as a complete, authentic record. */
  | 'clean'
  /** A final record was still being written when a process stopped. Ordinary. */
  | 'partial'
  /** A record failed authentication, or a length header was not plausible. */
  | 'corrupt'
  /**
   * The file could not be read at all — EMFILE, EACCES, EIO, a vanished mount.
   * This says nothing whatever about its contents, and must never be treated
   * as damage: rebuilding a log from an index that was never populated throws
   * away every claim on disk because one open() failed.
   */
  | 'unreadable';

export interface AppendOutcome {
  /** True when every requested fingerprint is claimed on disk afterwards. */
  ok: boolean;
  /**
   * Requested fingerprints another writer had already claimed by the time the
   * lock was held. Not an error for a caller replaying known claims; for
   * claimSessionKey it means this process lost the race and must refuse.
   * Check this BEFORE `ok`: everything requested may be claimed, just not by us.
   */
  conflicts: string[];
  /** Why `ok` is false. Absent when the only outcome was conflicts. */
  reason?: 'corrupt' | 'failed';
}

export interface ClaimRecord {
  fingerprint: string;
  peerNodeId: string;
  claimedAt: number;
}

export class ClaimLog {
  private basePath: string;
  private filePath: string;
  private encryptionKey: Buffer | null;
  private index: Set<string>;
  /** Claims taken before a key existed, waiting for one so they can be written. */
  private pending: ClaimRecord[];
  /** Bytes of the log already folded into the index, for incremental reloads. */
  private consumedBytes: number;
  /**
   * The same number, arrived at independently: only ever incremented by the
   * length of records this instance has verified, or set to the length of a
   * buffer it built itself. Never read from the filesystem. Where the two
   * disagree, consumedBytes has been set from something that is not a record
   * boundary — which is the bug that has now appeared in four separate paths.
   */
  private bytesAccountedFor: number;
  private lockTimeoutMs: number;
  private sawCorruption: boolean;
  /** Records folded in so far, duplicates included — the redundancy signal. */
  private recordsSeen: number;
  /** Records already represented by the checkpoint, so the tail can be sized. */
  private checkpointedRecords: number;
  private checkpointPath: string;
  private checkpointTimer: NodeJS.Timeout | null;

  constructor({ filePath, encryptionKey = null, lockTimeoutMs = 5000 }: {
    filePath: string;
    encryptionKey?: Buffer | null;
    lockTimeoutMs?: number;
  }) {
    this.basePath = filePath;
    this.filePath = filePath;
    this.encryptionKey = encryptionKey;
    this.index = new Set();
    this.pending = [];
    this.consumedBytes = 0;
    this.bytesAccountedFor = 0;
    this.lockTimeoutMs = lockTimeoutMs;
    this.sawCorruption = false;
    this.recordsSeen = 0;
    this.checkpointedRecords = 0;
    this.checkpointTimer = null;
    this._scopePathToKey();
    cleanStaleTempFiles(this.filePath);
    cleanStaleTempFiles(this.checkpointPath);
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
    // A new key means a different file entirely; anything already consumed was
    // read under different terms.
    this.consumedBytes = 0;
    this.bytesAccountedFor = 0;
    this.recordsSeen = 0;
    this.checkpointedRecords = 0;
    this.sawCorruption = false;
    this._scopePathToKey();
  }

  /**
   * Name the log after the key that seals it.
   *
   * Every record is sealed with a key derived from the node's seed phrase, so a
   * log only means anything to the identity that wrote it. Giving all
   * identities one filename made that mismatch look like corruption: a second
   * node on the same data directory reads records it cannot open, and since a
   * corrupt log refuses appends — correctly, because appending behind an
   * unreadable record would put the new claim past a boundary replay stops at —
   * neither node could record a claim. Two nodes sharing a data directory, or
   * one node after a seed rotation, both landed there.
   *
   * The suffix is a domain-separated digest of the key rather than the key or
   * the NodeID: it has to be stable for one identity and unlinkable to anything
   * else, and a directory listing should not become a handle on either.
   */
  private _scopePathToKey(): void {
    if (this.encryptionKey) {
      const id = crypto.createHash('sha256')
        .update('gmp-claim-log-id')
        .update(this.encryptionKey)
        .digest('hex')
        .slice(0, 16);
      const suffix = this.basePath.endsWith('.log') ? this.basePath.slice(0, -4) : this.basePath;
      this.filePath = `${suffix}.${id}.log`;
    } else {
      this.filePath = this.basePath;
    }
    this.checkpointPath = `${this.filePath}.ckpt`;
    cleanStaleTempFiles(this.filePath);
    cleanStaleTempFiles(this.checkpointPath);
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
      // The file shrank, so it is not the one this index was built from —
      // compaction, or an operator. Start over.
      this._reset();
    }

    // A cold start begins from the checkpoint when there is a usable one, so
    // only the records appended since it have to be decrypted individually.
    if (this.consumedBytes === 0 && this.index.size === 0) {
      this._applyCheckpoint(size);
    }

    const state = this._consumeTail(size);

    if (state === 'unreadable') {
      // Nothing was read, so nothing may be rebuilt from what is in memory.
      this._onUnreadableLog();
      return;
    }

    if (state === 'corrupt') {
      // Under strict mode _onCorruptRecord has already thrown. Here the choice
      // is between a node that cannot complete a handshake and one that keeps
      // the claims it could read; the damaged file is preserved either way.
      this._quarantineCorruptLog();
    }

    if (this.recordsSeen - this.checkpointedRecords >= CHECKPOINT_EVERY_RECORDS) {
      this._writeCheckpoint();
    }
  }

  private _reset(): void {
    this.index.clear();
    this.consumedBytes = 0;
    this.bytesAccountedFor = 0;
    this.recordsSeen = 0;
    this.checkpointedRecords = 0;
    this.sawCorruption = false;
    this._assertConsumedBoundary('reset');
  }

  /**
   * Check that `consumedBytes` still names the end of a record.
   *
   * Every claim this log has ever lost has come from the same mistake: setting
   * this offset to something that is not a record boundary — the file's length
   * while a half-written record sat at the end, or a length measured outside
   * the lock while another process was appending. It has now happened in four
   * separate paths, three of them written after the class of bug was already
   * known. Remembering is evidently not a strategy; this is.
   *
   * Three checks, cheapest first:
   *
   *   1. The accounting witness. `bytesAccountedFor` is only ever advanced by
   *      the length of verified records or set to the size of a buffer this
   *      instance built. It is never read from the filesystem, so any offset
   *      that came from a stat() diverges from it immediately. O(1), and it
   *      catches every one of the four historical bugs.
   *   2. The offset must lie within the file, and if the file continues past
   *      it, a plausible length header must begin exactly there — unless
   *      corruption has already been reported, in which case the bytes after
   *      the offset are the damage and are expected to be unparseable. O(1).
   *   3. On a log small enough to afford it, walk the framing from zero and
   *      confirm the offset falls exactly on a record edge. No decryption, so
   *      this is arithmetic over length prefixes.
   *
   * Under test a violation throws, because a test that continues past this has
   * nothing left to tell us. In production it is CRITICAL and execution
   * continues: the process is already in a state this code cannot reason about,
   * and taking a running node down is not obviously the safer of the two.
   */
  private _assertConsumedBoundary(context: string): void {
    if (!ASSERT_BOUNDARIES) return;

    const problems: string[] = [];

    if (this.consumedBytes !== this.bytesAccountedFor) {
      problems.push(
        `offset is ${this.consumedBytes} but only ${this.bytesAccountedFor} bytes have been accounted ` +
        `for as verified records`,
      );
    }

    let size: number | null = null;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      size = null; // no log yet, or unreadable; the checks below need one
    }

    if (size !== null) {
      if (this.consumedBytes > size) {
        problems.push(`offset ${this.consumedBytes} is past the end of a ${size} byte file`);
      } else if (this.consumedBytes < size && !this.sawCorruption) {
        // Skipped once corruption has been seen: the offset is then the last
        // good boundary by construction, and the bytes after it are the damage
        // itself. Demanding a record header there would flag the handled case.
        const header = this._readAt(this.consumedBytes, Math.min(LENGTH_PREFIX_BYTES, size - this.consumedBytes));
        if (!header || header.length < LENGTH_PREFIX_BYTES) {
          problems.push(`could not read a length header at offset ${this.consumedBytes}`);
        } else {
          const bodyLength = header.readUInt32BE(0);
          if (bodyLength < IV_BYTES + TAG_BYTES || bodyLength > MAX_RECORD_BYTES) {
            problems.push(
              `offset ${this.consumedBytes} is not the start of a record: the length there is ${bodyLength}`,
            );
          }
        }
      }

      if (size <= DEEP_ASSERT_MAX_BYTES && problems.length === 0) {
        const walked = this._walkFramingTo(this.consumedBytes, size);
        if (walked !== this.consumedBytes) {
          problems.push(
            `walking the framing from zero lands on ${walked}, not ${this.consumedBytes}`,
          );
        }
      }
    }

    if (problems.length === 0) return;

    const message =
      `Claim log offset invariant violated after ${context}: ${problems.join('; ')}. ` +
      `Claims recorded past this point would be silently lost.`;

    if (process.env.NODE_ENV === 'test') {
      throw new Error(message);
    }
    logger.critical('nonce-store', 'claim-log-offset-invariant', message, {
      claimsFile: this.filePath,
      context,
      consumedBytes: this.consumedBytes,
      bytesAccountedFor: this.bytesAccountedFor,
    });
  }

  /** A short read from the log, or null if it could not be satisfied in full. */
  private _readAt(offset: number, length: number): Buffer | null {
    if (length <= 0) return null;
    try {
      const buffer = Buffer.allocUnsafe(length);
      const fd = fs.openSync(this.filePath, 'r');
      let read: number;
      try {
        read = fs.readSync(fd, buffer, 0, length, offset);
      } finally {
        fs.closeSync(fd);
      }
      return read < length ? null : buffer;
    } catch {
      return null;
    }
  }

  /**
   * Follow the record framing from the start of the file and report the last
   * boundary at or before `limit`. Reads length prefixes only.
   */
  private _walkFramingTo(limit: number, size: number): number {
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(this.filePath);
    } catch {
      return limit; // cannot read it; the other checks stand on their own
    }
    if (buffer.length !== size) return limit;

    let offset = 0;
    while (offset < limit && offset + LENGTH_PREFIX_BYTES <= buffer.length) {
      const bodyLength = buffer.readUInt32BE(offset);
      if (bodyLength < IV_BYTES + TAG_BYTES || bodyLength > MAX_RECORD_BYTES) break;
      const next = offset + LENGTH_PREFIX_BYTES + bodyLength;
      if (next > buffer.length) break;
      offset = next;
    }
    return offset;
  }

  /**
   * Fold the records between `consumedBytes` and `size` into the index.
   *
   * Shared by load() and append(): an appending process has to catch up on
   * anything another process wrote first, or its own idea of how much of the
   * file it has consumed runs ahead of what it has actually read.
   */
  private _consumeTail(size: number): TailState {
    if (size <= this.consumedBytes) return 'clean';

    let buffer: Buffer;
    try {
      const fd = fs.openSync(this.filePath, 'r');
      try {
        const length = size - this.consumedBytes;
        buffer = Buffer.allocUnsafe(length);
        // readSync may return fewer bytes than asked for without throwing. The
        // buffer is uninitialized memory, so parsing past what was actually
        // read would interpret whatever happened to be on the heap as records.
        const read = fs.readSync(fd, buffer, 0, length, this.consumedBytes);
        if (read < length) buffer = buffer.subarray(0, read);
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
      return 'unreadable';
    }

    let state: TailState = 'clean';
    let offset = 0;
    while (offset + LENGTH_PREFIX_BYTES <= buffer.length) {
      const bodyLength = buffer.readUInt32BE(offset);

      if (bodyLength < IV_BYTES + TAG_BYTES || bodyLength > MAX_RECORD_BYTES) {
        // Not a plausible record header. A short tail is ordinary; a nonsense
        // length is the framing having come apart.
        state = 'corrupt';
        this._onCorruptRecord(this.consumedBytes + offset);
        break;
      }
      if (offset + LENGTH_PREFIX_BYTES + bodyLength > buffer.length) {
        // The tail is a record that was still being written when the process
        // stopped. Normal, and silent: it was never a completed claim.
        state = 'partial';
        break;
      }

      const body = buffer.subarray(offset + LENGTH_PREFIX_BYTES, offset + LENGTH_PREFIX_BYTES + bodyLength);
      const record = this._open(body);
      if (!record) {
        state = 'corrupt';
        this._onCorruptRecord(this.consumedBytes + offset);
        break;
      }

      this.index.add(record.fingerprint);
      this.recordsSeen++;
      offset += LENGTH_PREFIX_BYTES + bodyLength;
    }

    // `offset` is the end of the last record that parsed and authenticated, so
    // consumedBytes stays on a verified record boundary. It is never set from
    // the file's length: a file can end in a partial record, and treating that
    // length as consumed would skip past the incomplete tail and lose every
    // record written after it.
    this.consumedBytes += offset;
    this.bytesAccountedFor += offset;
    this._assertConsumedBoundary('consumeTail');
    return state;
  }

  /**
   * The claim log exists but this process cannot read it.
   *
   * Distinct from corruption in every way that matters: the bytes may be
   * perfectly good, and nothing has been learned about them. So nothing is
   * rebuilt, nothing is renamed, and the file is left exactly as it is.
   *
   * It is still an ERROR, and still fatal under strict mode. A node that cannot
   * read its claim log is running with no persisted record of which session
   * keys have been used — precisely the unprotected state strict mode exists to
   * refuse, and until now only an authentication failure reached it.
   */
  private _onUnreadableLog(): void {
    logger.error(
      'nonce-store',
      'state-log-unreadable',
      `Session key claim log ${this.filePath} exists but could not be read; this node has no record of ` +
      `which session keys have already been used, and would accept every one of them again. The file ` +
      `has not been modified.`,
      { claimsFile: this.filePath, strict: !!config.GMP_STRICT_STATE },
    );
    if (config.GMP_STRICT_STATE) {
      throw new StateAuthenticationError(
        `Refusing to start: session key claim log at ${this.filePath} could not be read. Continuing ` +
        `would accept session keys that have already been used. Fix the permissions or the underlying ` +
        `I/O problem, or move the file aside to start fresh deliberately.`,
      );
    }
  }

  /**
   * Move a log that will not authenticate aside, and start a fresh one holding
   * everything that could still be read from it.
   *
   * Without this a corrupt log is terminal: appends are refused, so no
   * handshake can complete, and there is no way out that does not involve an
   * operator finding the file by hand. That is the right answer for a node
   * under strict mode — _onCorruptRecord has already refused to start — but not
   * for a client, and it fires in one entirely ordinary case: the log is sealed
   * with a key derived from the node's seed phrase, so rotating the seed makes
   * every existing record unreadable. They are not damaged, they belong to
   * somebody else.
   *
   * The damaged file is renamed, never deleted, so nothing is destroyed and the
   * evidence survives for inspection. Claims read before the damage are carried
   * into the new log; claims after it were already unreadable and are lost,
   * which is the same availability-over-hard-fail trade the other state files
   * make (see _onUnauthenticatedState) and the reason unattended nodes should
   * run with GMP_STRICT_STATE.
   *
   * Only the fingerprints survive. The peer and timestamp on each record are
   * diagnostic, and reconstructing them would mean holding every record in
   * memory during a replay that may be a million long.
   */
  private _quarantineCorruptLog(): boolean {
    if (!this.encryptionKey) return false;

    const quarantinePath = `${this.filePath}.corrupt-${Date.now()}`;
    const recovered = [...this.index];

    let rebuiltSize = 0;
    try {
      withFileLock(this.filePath, () => {
        fs.renameSync(this.filePath, quarantinePath);
        const rebuilt = Buffer.concat(
          recovered.map(fingerprint => this._seal({ fingerprint, peerNodeId: '', claimedAt: Date.now() })),
        );
        if (rebuilt.length > 0) writeFileAtomicSync(this.filePath, rebuilt);
        // Measured under the lock. Taken afterwards, another process could have
        // appended in between, and this offset would skip past a record that
        // was never read — the same mistake append() used to make.
        rebuiltSize = rebuilt.length;
      }, { timeoutMs: this.lockTimeoutMs });
    } catch (err) {
      logger.error(
        'nonce-store',
        'claim-log-quarantine-failed',
        `Could not set aside the corrupt claim log: ${(err as Error).message}. Claims cannot be ` +
        `recorded until ${this.filePath} is moved away by hand.`,
        { claimsFile: this.filePath, err: (err as Error).message },
      );
      return false;
    }

    logger.error(
      'nonce-store',
      'claim-log-quarantined',
      `Moved the unreadable claim log to ${quarantinePath} and rebuilt it from the ${recovered.length} ` +
      `claim(s) that could still be authenticated. Any claim recorded past the damage is gone, and the ` +
      `session keys it held would now be accepted again. If the seed phrase was not changed, treat this ` +
      `as tampering and inspect the quarantined file.`,
      { claimsFile: this.filePath, quarantinePath, recovered: recovered.length },
    );

    this.sawCorruption = false;
    this.recordsSeen = recovered.length;
    this.checkpointedRecords = 0;
    this.consumedBytes = rebuiltSize;
    this.bytesAccountedFor = rebuiltSize;
    this._assertConsumedBoundary('quarantine');
    this._writeCheckpoint();
    return true;
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
  append(records: ClaimRecord[]): AppendOutcome {
    if (records.length === 0) return { ok: true, conflicts: [] };

    if (!this.encryptionKey) {
      // Nothing is persisted yet, so this process's own index is the whole
      // truth and no other writer can be racing it.
      const conflicts = records.filter(r => this.index.has(r.fingerprint)).map(r => r.fingerprint);
      for (const record of records) {
        if (this.index.has(record.fingerprint)) continue;
        this.pending.push(record);
        this.index.add(record.fingerprint);
      }
      return { ok: true, conflicts };
    }

    let outcome: AppendOutcome = { ok: true, conflicts: [] };

    try {
      withFileLock(this.filePath, () => {
        // Catch up on anything another process appended since this one last
        // read. Without it `consumedBytes` would advance past records this
        // index has never seen, and a checkpoint built on that offset would
        // claim to cover claims it does not hold.
        let state: TailState = 'clean';
        try {
          state = this._consumeTail(fs.statSync(this.filePath).size);
        } catch {
          /* no log yet; nothing to catch up on */
        }

        if (state === 'unreadable') {
          // The log may be perfectly intact; this process just could not read
          // it. Reported as a write failure so the caller refuses the claim and
          // the next attempt tries again, rather than as damage.
          logger.error(
            'nonce-store',
            'claim-log-append-blocked',
            `Refusing to append ${records.length} session key claim(s): the claim log could not be read, ` +
            `so a new record cannot be placed safely. The file is untouched.`,
            { claimsFile: this.filePath, count: records.length },
          );
          outcome = { ok: false, conflicts: [], reason: 'failed' };
          return;
        }

        if (state === 'corrupt') {
          // Appending behind a record that will not authenticate would write
          // into a file whose framing is already unreadable from that point on,
          // and truncating back to the last good boundary would destroy both
          // the evidence and any valid records beyond the damage. Refuse.
          logger.error(
            'nonce-store',
            'claim-log-append-blocked',
            `Refusing to append ${records.length} session key claim(s): the claim log is corrupt, so a ` +
            `new record could not be read back. The damaged file is left untouched for inspection; move ` +
            `${this.filePath} aside to start a fresh log, accepting that the session keys it recorded ` +
            `would then be accepted again.`,
            { claimsFile: this.filePath, count: records.length },
          );
          outcome = { ok: false, conflicts: [], reason: 'corrupt' };
          return;
        }

        // The authoritative at-most-once check. The unlocked has() in
        // claimSessionKey is only a fast path: between it and this lock another
        // process can append the very same fingerprint, and _consumeTail above
        // has just folded that in. Re-checking here is what keeps the claim
        // globally at-most-once rather than at-most-once-per-process.
        const conflicts: string[] = [];
        const fresh: ClaimRecord[] = [];
        for (const record of records) {
          if (this.index.has(record.fingerprint)) conflicts.push(record.fingerprint);
          else fresh.push(record);
        }

        if (fresh.length === 0) {
          outcome = { ok: true, conflicts };
          return;
        }

        if (state === 'partial') {
          // A record that was still being written when some process stopped.
          // It was never acknowledged to anyone — append() only returns success
          // after its own fsync — so discarding it costs nothing, and appending
          // behind it would put the new records past a boundary that replay
          // stops at, losing them silently on the next start.
          fs.truncateSync(this.filePath, this.consumedBytes);
          logger.debug(
            'nonce-store',
            'claim-log-partial-discarded',
            `Discarded an incomplete trailing record before appending.`,
            { claimsFile: this.filePath, truncatedTo: this.consumedBytes },
          );
        }

        const framed = Buffer.concat(fresh.map(r => this._seal(r)));
        const fd = fs.openSync(this.filePath, 'a', 0o600);
        try {
          fs.writeSync(fd, framed);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }

        // The file was at exactly `consumedBytes` before this write — either
        // because the tail parsed clean, or because the partial tail was
        // truncated away — so advancing by what was written keeps the offset on
        // a verified record boundary. Checked rather than assumed, because
        // getting this wrong loses acknowledged claims silently.
        const expected = this.consumedBytes + framed.length;
        const actual = fs.statSync(this.filePath).size;
        if (actual !== expected) {
          logger.error(
            'nonce-store',
            'claim-log-offset-mismatch',
            `Claim log is ${actual} bytes after appending but ${expected} was expected; ` +
            `re-reading it from the start rather than trusting the offset.`,
            { claimsFile: this.filePath, expected, actual },
          );
          // Re-read from the start, but keep the index: these fingerprints were
          // acknowledged to callers and must stay unusable. Over-claiming is
          // the safe direction; forgetting a claim is not.
          this.consumedBytes = 0;
          this.bytesAccountedFor = 0;
          this.recordsSeen = 0;
          this.checkpointedRecords = 0;
          for (const record of fresh) this.index.add(record.fingerprint);
          this._assertConsumedBoundary('append-offset-mismatch');
        } else {
          this.consumedBytes = expected;
          this.bytesAccountedFor += framed.length;
          for (const record of fresh) this.index.add(record.fingerprint);
          this.recordsSeen += fresh.length;
          this._assertConsumedBoundary('append');
        }

        outcome = { ok: true, conflicts };
      }, { timeoutMs: this.lockTimeoutMs });
    } catch (err) {
      logger.error(
        'nonce-store',
        'claim-log-append-failed',
        `Could not append ${records.length} session key claim(s): ${(err as Error).message}`,
        { claimsFile: this.filePath, err: (err as Error).message },
      );
      return { ok: false, conflicts: [], reason: 'failed' };
    }

    if (outcome.ok) this._maybeScheduleCheckpoint();
    return outcome;
  }

  /**
   * Checkpoint once enough claims have accumulated since the last one.
   *
   * Driven by appends, not by a start discovering a long tail: checking only at
   * load meant the checkpoint never prevented the replay it exists to prevent,
   * because by the time the check ran the whole log had already been replayed.
   *
   * Deferred off the handshake path. Writing the snapshot is proportional to
   * the number of claims held, so doing it inline would put a spike into one
   * unlucky handshake every CHECKPOINT_EVERY_RECORDS claims. The timer is
   * unref'd so it never holds the process open, and close() writes one
   * unconditionally for the case where the timer had not yet fired.
   */
  private _maybeScheduleCheckpoint(): void {
    const tail = this.recordsSeen - this.checkpointedRecords;
    if (tail < CHECKPOINT_EVERY_RECORDS) return;

    if (tail >= CHECKPOINT_CEILING_RECORDS) {
      // The deferred write has not had a turn — a synchronous burst, or a
      // process too busy to reach the timer. Pay for it here rather than let
      // the replay bound quietly stop being true.
      if (this.checkpointTimer) {
        clearTimeout(this.checkpointTimer);
        this.checkpointTimer = null;
      }
      this._writeCheckpoint();
      return;
    }

    if (this.checkpointTimer) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      this._writeCheckpoint();
    }, 0);
    this.checkpointTimer.unref?.();
  }

  /**
   * Flush a checkpoint on the way out, whatever the count.
   *
   * Without this, an orderly shutdown between thresholds leaves the next start
   * replaying everything since the last checkpoint. With it, a clean stop always
   * leaves a current snapshot, and the unbounded-replay case narrows to an
   * unclean stop.
   */
  close(): void {
    if (this.checkpointTimer) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    this._writeCheckpoint();
  }

  /**
   * Write anything claimed before a key existed. Returns false if it could not.
   *
   * A conflict is not a failure here: another process having already claimed
   * the fingerprint means it is recorded, which is all this caller needs. Only
   * an actual write failure puts the records back on the queue.
   */
  flushPending(): boolean {
    if (this.pending.length === 0 || !this.encryptionKey) return true;
    const queued = this.pending;
    this.pending = [];

    // Drop them from the index first. append() treats an indexed fingerprint as
    // somebody else's claim and declines to write it — which is exactly right
    // for a racing process, and exactly wrong for the records this process put
    // there itself while it had no key to seal them with. Removing them lets
    // the locked check do its real job: if another writer claimed one of these
    // in the meantime, _consumeTail puts it back and the conflict is reported.
    for (const record of queued) this.index.delete(record.fingerprint);

    const outcome = this.append(queued);
    if (outcome.ok) {
      // A conflict here means another process claimed it first. The fingerprint
      // is claimed either way, which is all this caller needs; re-index any
      // that append() skipped so nothing is forgotten.
      for (const fingerprint of outcome.conflicts) this.index.add(fingerprint);
      return true;
    }

    // The write failed, so these go back exactly as they were: callers were
    // already told the claims succeeded, and the keys must stay unusable.
    for (const record of queued) this.index.add(record.fingerprint);
    this.pending = queued;
    return false;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * A sealed snapshot of the index, so a cold start need not decrypt the whole
   * log.
   *
   * Every record in the log carries its own IV and tag — the property that
   * stops one damaged record from invalidating the rest — which means replaying
   * a million claims means a million separate AES-GCM openings, about 34
   * seconds. The checkpoint is one sealed blob holding every fingerprint known
   * at a given byte offset, so a start reads it in one opening and then replays
   * only the records appended since.
   *
   * It is a cache, never the authority. The log is what a claim was written to;
   * a checkpoint that will not authenticate, or that disagrees with the log, is
   * discarded and the log replayed in full. It holds fingerprints only — the
   * peer and timestamp on each record are diagnostic, and compaction reads the
   * log itself when it needs them.
   *
   * Payload layout, sealed as a single record:
   *
   *   [4-byte header length][header JSON][fingerprints: [1-byte length][utf8] …]
   */
  /**
   * A digest of the bytes ending at `coveredBytes`, tying a checkpoint to the
   * exact log it summarises.
   *
   * `coveredBytes` on its own says only how far to skip, and a checkpoint that
   * outlives its log — the log deleted and rebuilt, or replaced by another —
   * would have the next start skip that far into a file it has never read,
   * silently dropping every claim in the skipped span. Comparing the bytes
   * immediately before the offset catches that in one short read, without the
   * replay the checkpoint exists to avoid.
   */
  private _anchorDigest(upTo: number): { length: number; digest: string } | null {
    if (upTo <= 0) return null;
    const length = Math.min(CHECKPOINT_ANCHOR_BYTES, upTo);
    try {
      const window = Buffer.allocUnsafe(length);
      const fd = fs.openSync(this.filePath, 'r');
      let read: number;
      try {
        read = fs.readSync(fd, window, 0, length, upTo - length);
      } finally {
        fs.closeSync(fd);
      }
      // A short read leaves uninitialized memory in the tail of the window,
      // which would digest to something different every time — a checkpoint
      // whose anchor never matches, forcing the full replay it exists to avoid.
      if (read < length) return null;
      return { length, digest: crypto.createHash('sha256').update(window).digest('hex') };
    } catch {
      return null;
    }
  }

  private _writeCheckpoint(): boolean {
    if (!this.encryptionKey || this.sawCorruption) return false;
    // Claims taken before a key existed are in the index but not yet in the
    // log. Snapshotting now would produce a checkpoint asserting claims that
    // the byte range it names does not contain.
    if (this.pending.length > 0) return false;

    try {
      const parts: Buffer[] = [];
      for (const fingerprint of this.index) {
        const bytes = Buffer.from(fingerprint, 'utf8');
        if (bytes.length === 0 || bytes.length > 255) {
          // Not representable in this format. Skipping it would produce a
          // checkpoint that silently under-reports the index, so abandon the
          // whole thing and let the log stay authoritative.
          return false;
        }
        const framed = Buffer.allocUnsafe(1 + bytes.length);
        framed.writeUInt8(bytes.length, 0);
        bytes.copy(framed, 1);
        parts.push(framed);
      }

      const anchor = this._anchorDigest(this.consumedBytes);
      if (!anchor) return false;   // nothing consumed yet; nothing worth pinning

      const header = Buffer.from(JSON.stringify({
        version: CHECKPOINT_VERSION,
        coveredBytes: this.consumedBytes,
        recordCount: this.recordsSeen,
        fingerprintCount: this.index.size,
        anchor,
        createdAt: Date.now(),
      }), 'utf8');

      const headerLength = Buffer.allocUnsafe(4);
      headerLength.writeUInt32BE(header.length, 0);
      const plaintext = Buffer.concat([headerLength, header, ...parts]);

      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
      cipher.setAAD(CHECKPOINT_AAD);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      writeFileAtomicSync(this.checkpointPath, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
    } catch (err) {
      logger.warn(
        'nonce-store',
        'claim-checkpoint-write-failed',
        `Could not write the claim checkpoint: ${(err as Error).message}`,
        { checkpointFile: this.checkpointPath, err: (err as Error).message },
      );
      return false;
    }

    this.checkpointedRecords = this.recordsSeen;
    logger.debug(
      'nonce-store',
      'claim-checkpoint-written',
      `Checkpointed ${this.index.size} session key claims at byte ${this.consumedBytes}.`,
      { checkpointFile: this.checkpointPath, claims: this.index.size, coveredBytes: this.consumedBytes },
    );
    return true;
  }

  /**
   * Seed the index from the checkpoint, if there is one that can be trusted.
   *
   * Three ways it is refused, all of them falling back to replaying the log in
   * full — the log is the authority and is never skipped on the strength of a
   * checkpoint that does not add up:
   *
   *   - it will not authenticate, or is malformed
   *   - its version is not one this build writes
   *   - it claims to cover more bytes than the log contains
   *
   * The last is worth its own ERROR. A checkpoint is only ever written for a
   * prefix that was actually read, so a log shorter than one means the log has
   * been shortened since — compaction (which clears the checkpoint), an
   * operator, or something removing claims. Whatever the cause, the claims in
   * the missing span are no longer being enforced.
   */
  private _applyCheckpoint(logSize: number): void {
    if (!this.encryptionKey) return;

    let sealed: Buffer;
    try {
      sealed = fs.readFileSync(this.checkpointPath);
    } catch {
      return; // no checkpoint; ordinary for a young log
    }

    let plaintext: Buffer;
    try {
      const iv = sealed.subarray(0, IV_BYTES);
      const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAAD(CHECKPOINT_AAD);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([
        decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      logger.warn(
        'nonce-store',
        'claim-checkpoint-unusable',
        `The claim checkpoint will not authenticate; replaying the full log instead.`,
        { checkpointFile: this.checkpointPath },
      );
      return;
    }

    try {
      const headerLength = plaintext.readUInt32BE(0);
      const header = JSON.parse(plaintext.subarray(4, 4 + headerLength).toString('utf8')) as {
        version: number; coveredBytes: number; recordCount: number; fingerprintCount: number;
        anchor?: { length: number; digest: string };
      };

      if (header.version !== CHECKPOINT_VERSION) {
        logger.warn(
          'nonce-store',
          'claim-checkpoint-unusable',
          `Claim checkpoint is version ${header.version}, which this build does not read; replaying the full log.`,
          { checkpointFile: this.checkpointPath, version: header.version },
        );
        return;
      }

      if (header.coveredBytes > logSize) {
        logger.error(
          'nonce-store',
          'claim-log-shorter-than-checkpoint',
          `The claim log is ${logSize} bytes but the checkpoint covers ${header.coveredBytes}; ` +
          `the log has been shortened since it was written, and any claims in the missing ` +
          `${header.coveredBytes - logSize} bytes are no longer enforced. Replaying what remains.`,
          { claimsFile: this.filePath, checkpointFile: this.checkpointPath, logSize, coveredBytes: header.coveredBytes },
        );
        return;
      }

      // Does this checkpoint describe the log that is actually on disk?
      const anchor = this._anchorDigest(header.coveredBytes);
      if (!header.anchor || !anchor || anchor.digest !== header.anchor.digest) {
        logger.warn(
          'nonce-store',
          'claim-checkpoint-unusable',
          `The claim checkpoint does not match the log it points into — the log has been replaced ` +
          `since it was written. Replaying the full log instead.`,
          { checkpointFile: this.checkpointPath, claimsFile: this.filePath, coveredBytes: header.coveredBytes },
        );
        return;
      }

      const restored = new Set<string>();
      let offset = 4 + headerLength;
      while (offset < plaintext.length) {
        const length = plaintext.readUInt8(offset);
        offset += 1;
        if (length === 0 || offset + length > plaintext.length) break;
        restored.add(plaintext.subarray(offset, offset + length).toString('utf8'));
        offset += length;
      }

      if (restored.size !== header.fingerprintCount) {
        logger.warn(
          'nonce-store',
          'claim-checkpoint-unusable',
          `Claim checkpoint holds ${restored.size} fingerprints but declares ${header.fingerprintCount}; ` +
          `replaying the full log instead.`,
          { checkpointFile: this.checkpointPath },
        );
        return;
      }

      this.index = restored;
      this.consumedBytes = header.coveredBytes;
      this.bytesAccountedFor = header.coveredBytes;
      this.recordsSeen = header.recordCount;
      this.checkpointedRecords = header.recordCount;
      this._assertConsumedBoundary('applyCheckpoint');
    } catch (err) {
      logger.warn(
        'nonce-store',
        'claim-checkpoint-unusable',
        `Claim checkpoint is malformed (${(err as Error).message}); replaying the full log instead.`,
        { checkpointFile: this.checkpointPath, err: (err as Error).message },
      );
      this._reset();
    }
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

    let compactedSize = 0;

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
        compactedSize = rebuilt.length;
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

    // The file was replaced, and now holds exactly the unique set. Every byte
    // offset the old checkpoint recorded refers to the log that no longer
    // exists, so it is replaced rather than left to be distrusted later.
    this.index = new Set(unique.keys());
    this.recordsSeen = unique.size;
    this.checkpointedRecords = 0;
    // As in the quarantine path: sized under the lock, never restatted after.
    this.consumedBytes = compactedSize;
    this.bytesAccountedFor = compactedSize;
    this._assertConsumedBoundary('compact');
    this._writeCheckpoint();
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
