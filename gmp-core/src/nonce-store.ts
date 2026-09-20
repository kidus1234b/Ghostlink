import fs from 'fs';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import config from './config.js';
import logger from './logger.js';
import { NONCE_STATE_FILE, NONCE_CLAIMS_FILE } from './paths.js';
import { writeFileAtomicSync, cleanStaleTempFiles } from './atomic-file.js';
import { withFileLock } from './file-lock.js';
import { ClaimLog, type ClaimRecord } from './claim-log.js';
import { StateAuthenticationError } from './types.js';

// Resolved from the package root, not process.cwd(). The bridge is launched
// from the repo root, from electron/, and from a container working directory —
// a cwd-relative path would scatter a different nonce state file per launch
// location, and replay protection that forgets on every restart protects
// nothing. Same reasoning as the peer cache and the public peer list.
const DEFAULT_STATE_FILE = NONCE_STATE_FILE;

/**
 * Version 1 keyed session-key claims per peer, mixed in with the counter
 * entries. Version 2 gave claims their own map, keyed by fingerprint alone.
 * Version 3 moves them out of this file entirely, into the append-only claim
 * log — claims are permanent, and rewriting the whole set on every handshake
 * made latency linear in the number ever made. Older files are migrated on
 * read; anything outside this set is refused rather than silently discarded,
 * see _onUnsupportedVersion.
 */
const CURRENT_STATE_VERSION = 3;
const SUPPORTED_STATE_VERSIONS = new Set([1, 2, 3]);

/**
 * How far past the prune age an entry must look before the pruner distrusts the
 * clock instead of the entry. Ten times the retention window is far outside
 * anything ordinary drift produces, and well inside what a bad NTP correction
 * or a restored VM snapshot produces.
 */
const CLOCK_JUMP_FACTOR = 10;

/**
 * ════════════════════════════════════════════════════════════════════════
 * INVARIANTS
 * ════════════════════════════════════════════════════════════════════════
 *
 * This subsystem is the persisted half of GhostLink's replay protection. Five
 * separate reviews have each found a serious defect in it — it was never
 * constructed; updateCounters() did not exist; claims were reported successful
 * before they were durable; claims were clobbered on load; and claims expired,
 * raced, and were scoped wrongly. Every one was found only because somebody
 * looked straight at it. The properties below are what the subsystem is *for*.
 * Anything that weakens one of them is a security regression, however
 * reasonable it looks locally.
 *
 *   I1. A session-key fingerprint is claimed at most once, ever — across every
 *       process, every peer, and every restart. A second claim of the same
 *       fingerprint means the same AES-GCM key is about to be used twice, which
 *       leaks the XOR of the two plaintexts and the authentication key.
 *       Enforced by: the append-only claim log, keyed by fingerprint alone,
 *       never pruned, never rewritten except to deduplicate.
 *
 *   I2. A high-water mark never decreases. Not on merge, not on reload, not on
 *       an out-of-order frame. A mark that moves backwards reopens exactly the
 *       replay window it exists to close.
 *       Enforced by: Math.max in _mergeEntry, updateCounters, checkNonce and
 *       checkAndUpdate; nothing assigns a mark without comparing first.
 *
 *   I0. An offset into the claim log is always a record boundary. Not a
 *       security property on its own, but every claim this subsystem has lost
 *       has been lost by breaking it — in four separate paths, three of them
 *       written after the class of bug was known. claim-log.ts asserts it after
 *       every mutation under NODE_ENV=test or GMP_DEBUG_ASSERTS.
 *
 *   I3. A claim reported successful is durable. claimSessionKey() does not
 *       return success until the record has been appended and fsynced, and
 *       rejects the claim outright if it cannot — including when the lock
 *       cannot be acquired.
 *       Enforced by: claimSessionKey() -> ClaimLog.append() -> withFileLock +
 *       append + fsync. Counter writes still go through _saveNow(), which
 *       re-reads under the lock and writes atomically.
 *
 *   I4. State is merged, never replaced. Every path that reads the file folds
 *       it into what is already in memory, and every write re-reads under the
 *       lock first. An assignment to this.state outside _mergeState() is a bug.
 *
 * All five reported violations are now closed:
 *
 *   V1 claims expired with the pruner          -> closed by moving claims to
 *      their own file, which _pruneOldEntries() cannot reach at all.
 *   V2 a forward clock jump aged out entries   -> closed for claims by the
 *      same split; counters additionally skip a cycle that looks like a clock
 *      jump rather than genuine age (CLOCK_JUMP_FACTOR).
 *   V3 concurrent processes erased claims      -> closed by withFileLock around
 *      the counter read-merge-write and around each claim append, plus
 *      per-writer temp names in writeFileAtomicSync.
 *   V4 unknown versions vanished in silence    -> closed by
 *      _onUnsupportedVersion: ERROR, and fatal under GMP_STRICT_STATE.
 *   V5 claims were scoped per peer             -> closed by keying claims on
 *      the fingerprint alone; v1 and v2 files are migrated on read.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHERE THE STATE LIVES
 * ════════════════════════════════════════════════════════════════════════
 *
 * Two files, because the two kinds of state have opposite lifetimes:
 *
 *   nonce-state.json   Per-session counters, keyed `${peerHex}:${fingerprint}`.
 *                      They prune, so the set stays bounded and rewriting the
 *                      whole file is fine. Written batched, once a second.
 *
 *   nonce-claims.log   Session-key claims, keyed by fingerprint alone. They are
 *                      permanent, so the set only ever grows. Append-only, one
 *                      independently sealed record per claim — see claim-log.ts.
 *
 * Claims used to live in the JSON, which meant every handshake rewrote,
 * re-encrypted and re-fsynced every claim ever made: about 5.3ms per thousand
 * claims held, synchronously, on the event loop. A node with 100k claims
 * blocked for half a second per handshake and a busy one got there in months.
 * Appending makes a claim a Set lookup plus a couple of hundred bytes, and the
 * lock is held for a constant time rather than for the length of the history.
 * Measured: 0.16ms per claim at 100 claims, 0.29ms at 20,000 — against 0.45ms
 * and 6.53ms for the rewrite it replaced.
 *
 * The log still grows without bound by design. That is now a disk cost rather
 * than a per-handshake or a startup one. Measured at one million claims:
 *
 *     claimSessionKey        0.11 ms    flat: 0.14ms at 1k, 0.11ms at 1M
 *     claim log              215 MiB    225 bytes per claim
 *     checkpoint              31 MiB    33 bytes per claim
 *     in-memory index         20 MiB    21 bytes per claim
 *     load(), from checkpoint 0.90 s
 *     load(), full replay     36.3 s    the fallback when no checkpoint is usable
 *
 * Startup used to be the sharp edge: every record carries its own IV and GCM
 * tag, so replaying a million claims meant a million separate AES-GCM openings.
 * The checkpoint (see claim-log.ts) is a single sealed snapshot of the index at
 * a known byte offset, so a start opens one record and replays only what was
 * appended since — 36.3s to 0.90s. It is a cache and never the authority: a
 * checkpoint that will not authenticate, that disagrees with the log, or that
 * points into a log it does not match is discarded and the log replayed in
 * full.
 *
 * What is bounded, precisely. A checkpoint is written when the tail passes
 * CHECKPOINT_EVERY_RECORDS, inline once it passes twice that, and
 * unconditionally on a clean shutdown. So:
 *
 *   - clean shutdown            replay is empty; the checkpoint is current
 *   - unclean stop              replay is at most CHECKPOINT_CEILING_RECORDS,
 *                               measured at 664ms for 60k claims
 *   - no usable checkpoint      full replay, 36.3s at a million claims. Reached
 *                               when the checkpoint is missing, damaged, or
 *                               describes a different log
 *
 * Startup is not bounded in general — only the middle case is. The last one is
 * the honest worst case and it is proportional to everything ever claimed.
 *
 * Compaction only ever removes duplicates — a claim never expires, so there is
 * nothing else it may drop — and it decides from the record count gathered
 * during load rather than re-reading the file, which would otherwise double
 * startup on exactly the large logs it exists for.
 *
 * A Bloom filter was considered and rejected: a false positive REFUSES a
 * legitimate session key and is indistinguishable from a real collision, which
 * is the one thing this check must never be ambiguous about.
 *
 * ════════════════════════════════════════════════════════════════════════
 * OPEN: TRUNCATION OF THE CLAIM LOG IS NOT DETECTED
 * ════════════════════════════════════════════════════════════════════════
 *
 * Each record is sealed individually, so nothing in the log can be forged or
 * altered without detection. What is not protected is the log's *length*.
 * Somebody with write access to the data directory can cut records off the end,
 * or delete the file, and the claims in the removed span become claimable
 * again. Nothing reports it: a short log is indistinguishable from a log that
 * has not grown yet, which is exactly what an honest young log looks like.
 * GMP_STRICT_STATE does not close this — it governs records that fail to
 * authenticate, and a truncated log contains no such record.
 *
 * The checkpoint closes part of it already, as a side effect rather than by
 * design: it records the byte offset it covers, and a log shorter than that
 * offset is reported at ERROR (claim-log-shorter-than-checkpoint) before the
 * checkpoint is discarded and the remaining log replayed. So truncation *below
 * the last checkpoint* is already loud. Truncation of the tail written since
 * the last checkpoint is still silent, and a checkpoint can itself be deleted.
 *
 * Two ways to close the rest. Both are designs, not code:
 *
 *   A. A running count in a separate sealed file. After each append, write a
 *      small sealed record holding the log's record count and byte length.
 *      On load, compare. Simple, and independent of the checkpoint.
 *      Costs a second sealed write per claim — doubling the work on the
 *      handshake path, which is the cost this whole design exists to avoid —
 *      and introduces its own ordering problem: the counter and the log cannot
 *      both be updated atomically, so a crash between them is indistinguishable
 *      from truncation and would have to be tolerated, which blunts the check.
 *
 *   B. Extend the checkpoint to be the authority on length, and write one
 *      unconditionally at shutdown as well as on the existing threshold. The
 *      checkpoint already carries coveredBytes and recordCount and is already
 *      sealed and atomic; the change is to treat a log shorter than the
 *      checkpoint as fatal under GMP_STRICT_STATE rather than merely loud, and
 *      to make a *missing* checkpoint suspicious once one has ever existed.
 *      Costs nothing on the handshake path — the checkpoint is written at
 *      startup and shutdown, never per claim — and it is the same mechanism
 *      that already gives the startup-time improvement, so one file and one
 *      code path close both problems.
 *
 * B is the better trade and the one to build: A pays a per-handshake price for
 * a narrower guarantee, and would sit alongside the checkpoint rather than
 * reusing it. Neither closes the residual window between the last checkpoint
 * and a crash, in which appended records can still be cut without a record of
 * how many there should have been; tightening that means an unconditional
 * checkpoint at shutdown (which B includes) and accepting that a hard kill
 * leaves the tail unverifiable.
 *
 * Neither is a substitute for the data directory being protected. An attacker
 * who can write there can also delete the log, the checkpoint and the counter
 * file together, and a node that starts with no state at all cannot tell that
 * from a first run. Filesystem access to the data directory is outside the
 * threat model (SECURITY.md §2, Endpoint Integrity); the value of B is making
 * tampering *noisy* for an attacker who has partial access or who tries to be
 * subtle, not making it impossible.
 */


interface NonceStateEntry {
  highWaterMark: number;
  /** Highest nonce this side has sent on this session. */
  sendHighWater?: number;
  /** Highest nonce received from the peer on this session. */
  recvHighWater?: number;
  firstSeen?: number;
  lastActivity: number;
}

/**
 * A session-key fingerprint that has been used, and may never be used again.
 *
 * Keyed by fingerprint alone — never by peer. The check defends against broken
 * ephemeral key generation (RNG failure, a seeded PRNG, a VM snapshot restoring
 * entropy state), and none of those confine a collision to one peer. Keying by
 * peer let the same key be refused for peer1 and then accepted for peer2, which
 * is precisely the case the defence exists for. peerNodeId is kept for
 * diagnostics only.
 */
interface LegacyClaim {
  /** Hex NodeID of the peer this key was first claimed with. Not part of the key. */
  peerNodeId: string;
  claimedAt: number;
}

interface NonceState {
  /** Per-session counters, keyed `${peerHex}:${fingerprint}`. Pruned by age. */
  entries: Record<string, NonceStateEntry>;
  /**
   * Version 2 only. Claims now live in the append-only log; this is read for
   * migration and then never written again.
   */
  claims?: Record<string, LegacyClaim>;
  version: number;
}

export class NonceStore extends EventEmitter {
  private stateFile: string;
  private pruneAgeMs: number;
  private state: NonceState;
  private encryptionKey: Buffer | null;
  private _loaded: boolean;
  private _dirty: boolean;
  private _saveTimer: NodeJS.Timeout | null;
  private lockTimeoutMs: number;
  private claimLog: ClaimLog;

  constructor({ stateFile = DEFAULT_STATE_FILE, pruneAgeMs, seedPhrase, lockTimeoutMs, claimsFile }: {
    stateFile?: string;
    pruneAgeMs?: number;
    seedPhrase?: string;
    lockTimeoutMs?: number;
    claimsFile?: string;
  } = {}) {
    super();
    this.stateFile = stateFile;
    this.lockTimeoutMs = lockTimeoutMs ?? 5000;
    // Unique temp names mean a process killed mid-write leaves its file behind.
    cleanStaleTempFiles(this.stateFile);
    this.pruneAgeMs = pruneAgeMs ?? config.GMP_NONCE_PRUNE_AGE_MS ?? 90 * 24 * 60 * 60 * 1000;
    this.state = {
      entries: {},
      version: CURRENT_STATE_VERSION,
    };
    this.encryptionKey = null;

    if (seedPhrase) {
      this.encryptionKey = crypto.pbkdf2Sync(seedPhrase, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');
    }

    this._loaded = false;
    this._dirty = false;
    this._saveTimer = null;

    // The default deployment gets the documented `data/nonce-claims.log`. A
    // caller that names its own state file gets a log beside it rather than
    // the shared default, so two stores pointed at different state files never
    // silently share one claim log.
    this.claimLog = new ClaimLog({
      filePath: claimsFile
        ?? (stateFile === DEFAULT_STATE_FILE ? NONCE_CLAIMS_FILE : `${stateFile}.claims.log`),
      encryptionKey: this.encryptionKey,
      lockTimeoutMs: this.lockTimeoutMs,
    });
  }

  /** Where the append-only claim log lives. */
  get claimsFile(): string {
    return this.claimLog.path;
  }

  /**
   * How many session keys have been claimed.
   *
   * Loads on first use, like getEntry() and claimSessionKey(). Reading it off a
   * store nothing had touched yet used to answer zero, which reads as "no
   * claims" rather than "not looked yet".
   */
  get claimCount(): number {
    if (!this._loaded) this.load();
    return this.claimLog.size;
  }

  /**
   * Attach the key the state file is sealed with, and reconcile what is
   * already held in memory with what is on disk.
   *
   * link.js calls this *after* the node has derived its identity, which means a
   * store can have been answering claims for the whole of startup before it has
   * any way to persist them. load() used to replace the in-memory state
   * outright, so every one of those claims was silently dropped here and the
   * same session key fingerprint became claimable a second time — AES-GCM key
   * and nonce reuse reached during an ordinary boot, no crash required. The
   * load below merges instead; see _mergeState for the rules.
   *
   * Returns false if the merged state, or a claim taken before the key
   * existed, could not be written. The merge itself has already happened in
   * memory at that point, so this process is protected; what is not guaranteed
   * is that the *next* process will be, which is why this is an ERROR and why
   * strict mode refuses to continue.
   */
  setEncryptionKey(key: Buffer | null): boolean {
    this.encryptionKey = key;
    const carriedForward = this._entryCount() > 0;
    const heldClaims = this.claimLog.pendingCount;

    this.claimLog.setEncryptionKey(key);
    this.load();

    // Claims taken before the key existed are still only in memory. They are
    // the reason this method has a return value at all.
    if (!this.claimLog.flushPending()) {
      const message =
        `${heldClaims} session key claim(s) made before the encryption key was configured could not be ` +
        `written to ${this.claimLog.path}. They are honoured in memory, but a restart would accept a ` +
        `session key this node has already used.`;
      logger.error('nonce-store', 'state-merge-persist-failed', message, { claimsFile: this.claimLog.path });
      if (config.GMP_STRICT_STATE) {
        throw new StateAuthenticationError(`Refusing to continue: ${message}`);
      }
      return false;
    }

    if (!carriedForward || !this.encryptionKey) return true;

    // Something was claimed before the key existed. It is only merged in
    // memory so far, and the whole point of the merge is that it outlives this
    // process.
    if (!this._saveNow()) {
      const message =
        `Merged nonce state could not be written to ${this.stateFile}. Claims made before the ` +
        `encryption key was configured are held in memory only, so a restart would accept a ` +
        `session key this node has already used.`;
      logger.error('nonce-store', 'state-merge-persist-failed', message, { stateFile: this.stateFile });
      if (config.GMP_STRICT_STATE) {
        throw new StateAuthenticationError(`Refusing to continue: ${message}`);
      }
      return false;
    }
    return true;
  }

  private _entryCount(): number {
    return Object.keys(this.state.entries).length;
  }

  private _getKey(peerNodeId: Uint8Array, sessionKeyFingerprint: string): string {
    const peerHex = Buffer.from(peerNodeId).toString('hex');
    return `${peerHex}:${sessionKeyFingerprint}`;
  }

  /**
   * A state file that exists but cannot be authenticated.
   *
   * This is not the same as having no file: starting fresh here throws away
   * every persisted high-water mark, so a peer may reconnect and replay nonces
   * this node has already accepted. Under AES-GCM a reused key/counter pair
   * leaks the XOR of two plaintexts, which is exactly what the store prevents.
   * Logged at ERROR, not WARN, because nothing downstream can tell afterwards
   * that protection was lost.
   *
   * With GMP_STRICT_STATE set, refuse outright rather than run unprotected.
   * The default is to continue, so that a corrupt file does not lock a user out
   * of their own client — but an unattended node should be running strict.
   */
  private _onUnauthenticatedState(error: Error): void {
    logger.error(
      'nonce-store',
      'state-authentication-failed',
      `Nonce state file exists but could not be authenticated; replay protection is being reset: ${error.message}`,
      { err: error.message, stateFile: this.stateFile, strict: !!config.GMP_STRICT_STATE }
    );
    if (config.GMP_STRICT_STATE) {
      throw new StateAuthenticationError(
        `Refusing to start: nonce state at ${this.stateFile} could not be authenticated ` +
        `(${error.message}). Continuing would discard replay protection. ` +
        `Move or delete the file to start fresh deliberately, or unset GMP_STRICT_STATE.`
      );
    }
  }

  /**
   * A state file sealed with our key, well-formed, and written to a version of
   * the format this build does not know.
   *
   * Treated exactly like an authentication failure, and for the same reason:
   * continuing means running with the high-water marks and claims silently
   * discarded, and nothing downstream can tell afterwards that it happened.
   * Usually a downgrade — the file was written by a newer build.
   */
  private _onUnsupportedVersion(version: unknown): void {
    logger.error(
      'nonce-store',
      'state-version-unsupported',
      `Nonce state at ${this.stateFile} is version ${String(version)}, which this build cannot read; ` +
      `replay protection would be reset. Supported versions: ${[...SUPPORTED_STATE_VERSIONS].join(', ')}.`,
      { stateFile: this.stateFile, version: String(version), strict: !!config.GMP_STRICT_STATE }
    );
    if (config.GMP_STRICT_STATE) {
      throw new StateAuthenticationError(
        `Refusing to start: nonce state at ${this.stateFile} is version ${String(version)}, which this ` +
        `build cannot read. Continuing would discard replay protection. Run a build that understands it, ` +
        `or move the file aside to start fresh deliberately.`
      );
    }
  }

  /**
   * Bring an older file up to the current shape, handing back the claims that
   * have to be moved into the append-only log.
   */
  private _migrateToCurrent(loaded: NonceState): { state: NonceState; claims: ClaimRecord[] } {
    const collected = new Map<string, ClaimRecord>();

    const remember = (fingerprint: string, peerNodeId: string, claimedAt: number) => {
      const existing = collected.get(fingerprint);
      if (existing && existing.peerNodeId !== peerNodeId) {
        logger.error(
          'nonce-store',
          'session-key-collision',
          `The same session key fingerprint is claimed by two different peers — session key generation ` +
          `may be broken (fingerprint ${fingerprint.slice(0, 12)}…)`,
          {
            fingerprint: fingerprint.slice(0, 12),
            peerA: existing.peerNodeId.slice(0, 16),
            peerB: peerNodeId.slice(0, 16),
          }
        );
      }
      if (!existing || claimedAt < existing.claimedAt) {
        collected.set(fingerprint, { fingerprint, peerNodeId, claimedAt });
      }
    };

    // v2 kept claims in their own map here.
    for (const [fingerprint, claim] of Object.entries(loaded.claims ?? {})) {
      remember(fingerprint, claim.peerNodeId, claim.claimedAt);
    }

    // v1 had no claims map at all: a claim was an entry under
    // `${peerHex}:${fingerprint}` with a mark of 0, and once the session
    // carried traffic it became indistinguishable from a counter record. So
    // every entry's fingerprint is promoted — claimSessionKey() runs at
    // handshake before any frame can be counted, so every entry implies its key
    // was claimed. Over-claiming is the safe direction: the cost is refusing a
    // key that was already used, which is exactly what the claim is for.
    if (loaded.version < 2) {
      for (const [compositeKey, entry] of Object.entries(loaded.entries)) {
        const separator = compositeKey.indexOf(':');
        if (separator <= 0) continue;
        const fingerprint = compositeKey.slice(separator + 1);
        if (!fingerprint) continue;
        remember(fingerprint, compositeKey.slice(0, separator), entry.lastActivity);
      }
    }

    return {
      state: { entries: loaded.entries, version: CURRENT_STATE_VERSION },
      claims: [...collected.values()],
    };
  }

  /**
   * Read the persisted state, or null if there is nothing usable to read.
   *
   * Split out from load() so that "what is on disk" and "what becomes the
   * live state" are separate decisions — the second is a merge, not an
   * assignment.
   */
  private _readPersistedState(): { state: NonceState; migratedClaims: ClaimRecord[] } | null {
    if (!this.encryptionKey) return null;
    try {
      if (!fs.existsSync(this.stateFile)) return null;

      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as { iv: string; ciphertext: string; version?: number };
      if (!parsed || !parsed.iv || !parsed.ciphertext || parsed.version !== 1) {
        logger.warn('nonce-store', 'format-mismatch', 'Nonce state file format mismatch or plaintext, starting fresh.');
        return null;
      }

      const iv = Buffer.from(parsed.iv, 'hex');
      const encryptedBlob = Buffer.from(parsed.ciphertext, 'hex');
      const authTag = encryptedBlob.slice(0, 16);
      const ciphertext = encryptedBlob.slice(16);

      // Decryption gets its own catch so an authentication failure can be told
      // apart from a missing file or a syntax error. A file that is present and
      // well-formed but will not authenticate has either been tampered with or
      // belongs to a different identity, and discarding it silently resets
      // every high-water mark this store exists to keep.
      let decrypted: Buffer;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
        decipher.setAuthTag(authTag);
        decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch (err) {
        this._onUnauthenticatedState(err as Error);
        return null;
      }

      const stateObj = JSON.parse(decrypted.toString('utf8')) as NonceState;
      if (!stateObj || !stateObj.entries) return null;

      if (!SUPPORTED_STATE_VERSIONS.has(stateObj.version)) {
        // Previously this returned null without a word, so a state file written
        // by a newer build silently took every high-water mark and every claim
        // with it — past the ERROR, past strict mode, past everything.
        this._onUnsupportedVersion(stateObj.version);
        return null;
      }

      if (stateObj.version === CURRENT_STATE_VERSION) {
        return { state: stateObj, migratedClaims: [] };
      }
      const migrated = this._migrateToCurrent(stateObj);
      return { state: migrated.state, migratedClaims: migrated.claims };
    } catch (err) {
      // A strict-mode refusal must not be absorbed here. This catch exists to
      // survive unreadable or malformed files by starting fresh, which is the
      // precise behaviour strict mode is meant to prevent.
      if (err instanceof StateAuthenticationError) throw err;
      const error = err as Error;
      logger.warn('nonce-store', 'load-failed', `Failed to load state file, starting fresh: ${error.message}`, { err: error.message });
      return null;
    }
  }

  /**
   * Combine one session's persisted counters with the ones held in memory.
   *
   * A high-water mark may only ever move forward. Taking the loaded value over
   * the in-memory one — or the reverse — would lower a mark somewhere, and a
   * lowered mark is precisely the replay window this store exists to close.
   * So every counter is the maximum of the two sides, firstSeen is the earlier
   * sighting, and lastActivity the later one.
   */
  private _mergeEntry(mine: NonceStateEntry, theirs: NonceStateEntry): NonceStateEntry {
    // Legacy entries carry only the aggregate mark. Falling back to it rather
    // than to zero keeps a pre-directional state file from reopening the
    // window the aggregate had already closed.
    const sendHighWater = Math.max(
      mine.sendHighWater ?? mine.highWaterMark,
      theirs.sendHighWater ?? theirs.highWaterMark,
    );
    const recvHighWater = Math.max(
      mine.recvHighWater ?? mine.highWaterMark,
      theirs.recvHighWater ?? theirs.highWaterMark,
    );
    const seen = [mine.firstSeen, theirs.firstSeen].filter((v): v is number => typeof v === 'number');

    return {
      highWaterMark: Math.max(mine.highWaterMark, theirs.highWaterMark, sendHighWater, recvHighWater),
      sendHighWater,
      recvHighWater,
      ...(seen.length ? { firstSeen: Math.min(...seen) } : {}),
      lastActivity: Math.max(mine.lastActivity, theirs.lastActivity),
    };
  }

  /**
   * Fold the persisted state into the live one.
   *
   * The union of both entry sets, never the intersection and never a
   * replacement: a fingerprint claimed in memory stays claimed even though the
   * file on disk has never heard of it, and a fingerprint on disk stays claimed
   * even though this process has not seen it. Returns whether anything the
   * caller held in memory is not already represented on disk, which is what
   * tells setEncryptionKey there is something new worth persisting.
   */
  private _mergeState(loaded: NonceState | null): boolean {
    if (!loaded) return this._entryCount() > 0;

    let carriedForward = false;
    const merged: Record<string, NonceStateEntry> = { ...loaded.entries };

    for (const [key, mine] of Object.entries(this.state.entries)) {
      const theirs = loaded.entries[key];
      if (!theirs) {
        merged[key] = mine;
        carriedForward = true;
        continue;
      }
      const combined = this._mergeEntry(mine, theirs);
      // Only a mark that actually moved is worth a write.
      if (
        combined.highWaterMark !== theirs.highWaterMark ||
        combined.sendHighWater !== (theirs.sendHighWater ?? theirs.highWaterMark) ||
        combined.recvHighWater !== (theirs.recvHighWater ?? theirs.highWaterMark)
      ) {
        carriedForward = true;
      }
      merged[key] = combined;
    }

    this.state = { entries: merged, version: CURRENT_STATE_VERSION };
    return carriedForward;
  }

  /**
   * Bring the persisted state in, merging rather than replacing.
   *
   * Every caller reaches this with state that may already matter: the lazy
   * `if (!this._loaded) this.load()` guards run on the first claim, and
   * setEncryptionKey() runs after a whole startup's worth of claims. Assigning
   * over this.state at any of those points drops claims on the floor.
   */
  load(): this {
    const read = this._readPersistedState();
    if (this._mergeState(read?.state ?? null)) {
      // Mark dirty so setEncryptionKey()'s flush has something to write and
      // the batched timer retries if that flush fails.
      this._dirty = true;
    }

    this.claimLog.load();
    this._drainMigratedClaims(read?.migratedClaims ?? []);
    // Deduplicating the log is a startup job and never touches the handshake
    // path; it declines unless the file is both large and provably redundant.
    this.claimLog.compactIfNeeded();

    this._loaded = true;
    this._pruneOldEntries();
    return this;
  }

  /**
   * Move claims read out of an older state file into the append-only log.
   *
   * Once they are in the log the JSON must stop carrying them, so the state is
   * marked dirty and the next write emits a version 3 file with no claims map.
   * Anything the log already knows is skipped — migration runs on every load of
   * an old file until one of those writes lands, and re-appending each time
   * would pad the log with duplicates for compaction to find later.
   */
  private _drainMigratedClaims(claims: ClaimRecord[]): void {
    if (claims.length === 0) return;

    const fresh = claims.filter(c => !this.claimLog.has(c.fingerprint));
    if (fresh.length > 0 && !this.claimLog.append(fresh).ok) {
      logger.error(
        'nonce-store',
        'claim-migration-failed',
        `Could not move ${fresh.length} session key claim(s) into ${this.claimLog.path}; ` +
        `they are held in memory and the state file still carries them.`,
        { claimsFile: this.claimLog.path, count: fresh.length },
      );
      return;
    }

    logger.info(
      'nonce-store',
      'claims-migrated',
      `Moved ${fresh.length} session key claim(s) into the append-only log ` +
      `(${claims.length} read from the state file, ${this.claimLog.size} claims held in total).`,
      { claimsFile: this.claimLog.path, migrated: fresh.length, total: this.claimLog.size },
    );
    this._dirty = true;
  }

  /**
   * Mark the state dirty and let it be written within the next second.
   *
   * This is the routine path, used by updateCounters() on every frame link.js
   * sends or receives. It must stay batched and asynchronous: a per-message
   * fsync would put a disk round-trip in the data path and cost far more than
   * the protection is worth, because a counter lost to a crash is re-derived
   * from the peer's next frame anyway.
   *
   * claimSessionKey() deliberately does not use this — see _saveNow().
   */
  save(): void {
    this._dirty = true;
    if (this._saveTimer) return;

    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, 1000);
  }

  /**
   * Write the state out now, and report whether it actually reached disk.
   *
   * The return value matters to claimSessionKey(), which may not tell a peer
   * its session key was accepted until the claim is durable. Everything else
   * calls this for effect and ignores the result.
   */
  private _saveNow(): boolean {
    if (!this.encryptionKey) return false;
    if (!this._dirty) return true;
    try {
      // The whole read-modify-write runs under an exclusive lock, and re-reads
      // the file inside it. Serialising this.state on its own was an
      // unsynchronised read-modify-write: two nodes sharing a data directory
      // each wrote a file derived from a snapshot taken before the other's
      // write, so each silently erased the other's claims — and both were told
      // their claim had succeeded. An atomic write cannot fix that; only
      // serialising the sequence can.
      withFileLock(this.stateFile, () => {
        this._mergeState(this._readPersistedState()?.state ?? null);
        writeFileAtomicSync(this.stateFile, this._serialize());
      }, { timeoutMs: this.lockTimeoutMs });
      this._dirty = false;
      return true;
    } catch (err) {
      const error = err as Error;
      logger.error('nonce-store', 'save-failed', `Failed to save state: ${error.message}`, { err: error.message });
      return false;
    }
  }

  /** The encrypted on-disk envelope for the current state. */
  private _serialize(): string {
    const plaintextJson = JSON.stringify(this.state);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey as Buffer, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return JSON.stringify({
      iv: iv.toString('hex'),
      ciphertext: Buffer.concat([authTag, ciphertext]).toString('hex'),
      version: 1,
    }, null, 2);
  }

  /**
   * Drop counter entries that have been idle past the retention window.
   *
   * Only `this.state.entries`. `this.state.claims` is deliberately out of reach:
   * a claim is permanent, and pruning one hands the fingerprint back to whoever
   * wants to reuse it. In v1 the two lived in the same map and were
   * indistinguishable, so the pruner ate claims after ninety days — a patient
   * peer only had to wait out the retention window.
   *
   * The pruner also declines to trust a clock that has obviously moved. An
   * entry that looks ten times older than the retention window is far more
   * likely to mean the clock jumped — an NTP correction on hardware with no
   * RTC, a VM restored from a snapshot — than that it really sat idle that
   * long, and acting on it would age out every entry at once.
   */
  private _pruneOldEntries(): void {
    const now = Date.now();
    const implausible = this.pruneAgeMs * CLOCK_JUMP_FACTOR;
    const stale: string[] = [];

    for (const [key, entry] of Object.entries(this.state.entries)) {
      const idle = now - entry.lastActivity;
      if (idle > implausible) {
        logger.warn(
          'nonce-store',
          'prune-skipped-clock-jump',
          `Skipping this prune cycle: an entry appears ${Math.round(idle / 86_400_000)} days idle against a ` +
          `${Math.round(this.pruneAgeMs / 86_400_000)} day retention window, which points at a clock jump ` +
          `rather than genuine age. No counters were removed.`,
          { stateFile: this.stateFile, idleMs: idle, pruneAgeMs: this.pruneAgeMs }
        );
        return;
      }
      if (idle > this.pruneAgeMs) stale.push(key);
    }

    for (const key of stale) delete this.state.entries[key];
    if (stale.length > 0) this.save();
  }

  /**
   * A session key as the entry key. checkNonce is handed an already-computed
   * fingerprint, while link.js passes the raw session key, so accept either and
   * fingerprint it the same way link.js does — otherwise the two would write to
   * different entries for the same session.
   */
  private _fingerprint(sessionKey: Uint8Array | string): string {
    if (typeof sessionKey === 'string') return sessionKey;
    return crypto.createHash('sha256').update(Buffer.from(sessionKey)).digest('hex').slice(0, 32);
  }

  /**
   * Record how far the send and receive counters have got on a session.
   *
   * link.js calls this from 22 places, after every frame it sends or receives —
   * and it did not exist. Any deployment that actually supplied a NonceStore
   * would have thrown "updateCounters is not a function" on the first message.
   * It never fired only because GMPNode never constructs a store, which is a
   * separate problem (see the note on the constructor).
   *
   * Counters only ever move forward: an out-of-order or replayed frame must not
   * drag the high-water mark back down, or it would reopen the window the mark
   * exists to close.
   */
  updateCounters(
    peerNodeId: Uint8Array,
    sessionKey: Uint8Array | string,
    sendCounter: number,
    recvCounter: number,
  ): void {
    if (!this._loaded) this.load();

    const key = this._getKey(peerNodeId, this._fingerprint(sessionKey));
    const now = Date.now();
    const entry = this.state.entries[key];

    if (!entry) {
      this.state.entries[key] = {
        highWaterMark: Math.max(sendCounter, recvCounter),
        sendHighWater: sendCounter,
        recvHighWater: recvCounter,
        firstSeen: now,
        lastActivity: now,
      };
    } else {
      // Fall back to the aggregate mark, not to zero. Entries written by
      // checkNonce — and every entry in a state file from before the
      // directional marks existed — carry only highWaterMark, so defaulting to
      // zero would silently forget everything already recorded for the session.
      entry.sendHighWater = Math.max(entry.sendHighWater ?? entry.highWaterMark, sendCounter);
      entry.recvHighWater = Math.max(entry.recvHighWater ?? entry.highWaterMark, recvCounter);
      // The aggregate has to cover both directions. checkNonce reads it on its
      // own, so leaving it behind the send counter would let checkNonce accept
      // a nonce this session has already moved past.
      entry.highWaterMark = Math.max(entry.highWaterMark, entry.sendHighWater, entry.recvHighWater);
      entry.firstSeen = entry.firstSeen ?? now;
      entry.lastActivity = now;
    }
    this.save();
  }

  /**
   * Replay check for a reconnecting session: both counters must be strictly
   * higher than anything already recorded for it.
   *
   * A peer that reconnects and restarts its nonces at or below the previous
   * high-water mark is either replaying old frames or has reused a session key,
   * and in both cases previously-sent ciphertext could be re-injected. Equal is
   * rejected as well as lower — reusing a counter with the same key is exactly
   * the nonce reuse AES-GCM must never see.
   *
   * The record is only advanced when the pair is accepted, so a rejected
   * attempt cannot move the bar.
   */
  checkAndUpdate(
    peerNodeId: Uint8Array,
    sessionKey: Uint8Array | string,
    sendNonce: number,
    recvNonce: number,
  ): { allowed: boolean; reason?: string } {
    if (!this._loaded) this.load();

    const key = this._getKey(peerNodeId, this._fingerprint(sessionKey));
    const now = Date.now();
    const entry = this.state.entries[key];

    if (!entry) {
      this.state.entries[key] = {
        highWaterMark: Math.max(sendNonce, recvNonce),
        sendHighWater: sendNonce,
        recvHighWater: recvNonce,
        firstSeen: now,
        lastActivity: now,
      };
      this.save();
      return { allowed: true };
    }

    // A legacy entry has only highWaterMark. Defaulting to zero would accept a
    // reconnect at 1/1 against a persisted mark of 100 — the exact replay this
    // check exists to stop. Falling back to the aggregate fails closed instead.
    const sendMark = entry.sendHighWater ?? entry.highWaterMark;
    const recvMark = entry.recvHighWater ?? entry.highWaterMark;

    if (sendNonce <= sendMark) {
      return {
        allowed: false,
        reason: `Replayed or reused send nonce: got ${sendNonce}, high-water mark is ${sendMark}`,
      };
    }
    if (recvNonce <= recvMark) {
      return {
        allowed: false,
        reason: `Replayed or reused recv nonce: got ${recvNonce}, high-water mark is ${recvMark}`,
      };
    }

    entry.sendHighWater = sendNonce;
    entry.recvHighWater = recvNonce;
    // Both counters, not just recv: an accepted pair of 150/101 would otherwise
    // leave the aggregate at 101 and let checkNonce accept 120 afterwards.
    entry.highWaterMark = Math.max(entry.highWaterMark, sendNonce, recvNonce);
    entry.lastActivity = now;
    this.save();
    return { allowed: true };
  }

  /** The stored counters for a session, or null if it has never been seen. */
  getEntry(
    peerNodeId: Uint8Array,
    sessionKey: Uint8Array | string,
  ): NonceStateEntry | null {
    if (!this._loaded) this.load();
    return this.state.entries[this._getKey(peerNodeId, this._fingerprint(sessionKey))] ?? null;
  }

  /**
   * Claim a session key for a peer, once and only once.
   *
   * Session keys are derived from a fresh ephemeral exchange on every
   * connection, so a fingerprint that has been seen before means the same key
   * is in use twice. Under AES-GCM that is nonce reuse, which leaks the XOR of
   * the two plaintexts and the authentication key — so the connection is
   * refused rather than downgraded.
   *
   * This is the persisted half of the check; sessionKeyLRUSet in link.js is the
   * in-memory half and only covers the current process.
   *
   * The claim is GLOBAL, keyed by fingerprint alone. It used to be keyed
   * `${peerHex}:${fingerprint}`, so the same session key could be refused for
   * one peer and accepted for the next — while the in-memory LRU, keyed by
   * fingerprint alone, caught exactly that. The two halves of one check
   * disagreed, and the persisted half was the wrong one: a broken RNG, a seeded
   * PRNG or a restored VM snapshot does not confine a repeated key to one peer.
   *
   * It replaces a bare `checkNonce(peer, fingerprint, 0)` at the call sites. The
   * behaviour is identical — claiming records a mark of 0, and a second claim
   * fails `0 <= 0` — but a literal zero threaded through a function named
   * "checkNonce" said nothing about what was being checked, and produced
   * "Reused or old nonce: received 0, high-water mark is 0" when it fired.
   */
  claimSessionKey(
    peerNodeId: Uint8Array,
    sessionKeyFingerprint: string,
  ): { valid: boolean; reason?: string } {
    if (!this._loaded) this.load();

    // O(1), no I/O, and the common case for a peer that is reconnecting with a
    // key it has already burnt.
    if (this.claimLog.has(sessionKeyFingerprint)) {
      return {
        valid: false,
        reason: `Session key already used (fingerprint ${sessionKeyFingerprint.slice(0, 12)}…)`,
      };
    }

    const peerHex = Buffer.from(peerNodeId).toString('hex');
    const record: ClaimRecord = {
      fingerprint: sessionKeyFingerprint,
      peerNodeId: peerHex,
      claimedAt: Date.now(),
    };

    // One appended, fsynced record before success is reported. The caller acts
    // on this immediately — link.js lets the handshake continue — so a claim
    // that is still only in memory would be a claim the next process does not
    // honour, and the same session key would be accepted a second time. That is
    // the AES-GCM nonce reuse the claim exists to prevent.
    //
    // With no key configured the record is held in memory instead: link.js only
    // supplies one once the identity is derived, and the claim still has to
    // count until then. setEncryptionKey() writes them.
    const outcome = this.claimLog.append([record]);

    // Conflicts are checked first, and separately from write failures. The
    // has() above is an unlocked fast path; between it and the lock another
    // process can claim the same fingerprint, and the log's locked re-check is
    // what catches that. Losing the race means the key IS claimed — just not by
    // us — so this is the ordinary reuse refusal, not a persistence problem.
    if (outcome.conflicts.length > 0) {
      logger.warn(
        'nonce-store',
        'claim-race-lost',
        `Session key claimed concurrently by another writer; refusing this one ` +
        `(fingerprint ${sessionKeyFingerprint.slice(0, 12)}…)`,
        { claimsFile: this.claimLog.path, peerNodeId: peerHex.slice(0, 16) }
      );
      return {
        valid: false,
        reason: `Session key already used (fingerprint ${sessionKeyFingerprint.slice(0, 12)}…, ` +
                `claimed concurrently by another process)`,
      };
    }

    if (!outcome.ok) {
      logger.error(
        'nonce-store',
        'state-claim-persist-failed',
        `Rejecting session key claim: the claim could not be appended to ${this.claimLog.path} ` +
        `(${outcome.reason ?? 'failed'}), and a claim that is not on disk is a claim the next ` +
        `process will not honour (fingerprint ${sessionKeyFingerprint.slice(0, 12)}…)`,
        { claimsFile: this.claimLog.path, peerNodeId: peerHex.slice(0, 16), reason: outcome.reason }
      );
      return {
        valid: false,
        reason: 'Session key claim could not be persisted; refusing the connection rather than ' +
                'accepting a key that would be re-accepted after a restart',
      };
    }

    return { valid: true };
  }

  checkNonce(peerNodeId: Uint8Array, sessionKeyFingerprint: string, nonce: number): { valid: boolean; reason?: string } {
    if (!this._loaded) {
      this.load();
    }

    const key = this._getKey(peerNodeId, sessionKeyFingerprint);
    const entry = this.state.entries[key];

    if (!entry) {
      this.state.entries[key] = {
        highWaterMark: nonce,
        sendHighWater: nonce,
        recvHighWater: nonce,
        firstSeen: Date.now(),
        lastActivity: Date.now(),
      };
      this.save();
      return { valid: true };
    }

    if (nonce <= entry.highWaterMark) {
      return {
        valid: false,
        reason: `Reused or old nonce: received ${nonce}, high-water mark is ${entry.highWaterMark}`,
      };
    }

    // Carry the directional marks up with the aggregate. Raising only the
    // aggregate left checkAndUpdate reading a stale `sendHighWater ??
    // highWaterMark`, so a nonce this call had already accepted could be
    // accepted again through the other door. Nothing reached that today —
    // link.js only calls checkNonce via claimSessionKey — but it was a trap
    // set for the next caller.
    const previousAggregate = entry.highWaterMark;
    entry.sendHighWater = Math.max(entry.sendHighWater ?? previousAggregate, nonce);
    entry.recvHighWater = Math.max(entry.recvHighWater ?? previousAggregate, nonce);
    entry.highWaterMark = Math.max(previousAggregate, nonce);
    entry.lastActivity = Date.now();
    this.save();
    return { valid: true };
  }

  close(): void {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    // Best effort: a failure here is already logged by _saveNow(), and there is
    // nothing left to refuse at shutdown.
    this._saveNow();
    // Leaves a current snapshot behind, so a clean stop never costs the next
    // start a replay of everything since the last threshold crossing.
    this.claimLog.close();
  }
}