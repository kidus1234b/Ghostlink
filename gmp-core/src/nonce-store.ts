import fs from 'fs';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import config from './config.js';
import logger from './logger.js';
import { NONCE_STATE_FILE } from './paths.js';
import { writeFileAtomicSync } from './atomic-file.js';
import { StateAuthenticationError } from './types.js';

// Resolved from the package root, not process.cwd(). The bridge is launched
// from the repo root, from electron/, and from a container working directory —
// a cwd-relative path would scatter a different nonce state file per launch
// location, and replay protection that forgets on every restart protects
// nothing. Same reasoning as the peer cache and the public peer list.
const DEFAULT_STATE_FILE = NONCE_STATE_FILE;

interface NonceStateEntry {
  highWaterMark: number;
  /** Highest nonce this side has sent on this session. */
  sendHighWater?: number;
  /** Highest nonce received from the peer on this session. */
  recvHighWater?: number;
  firstSeen?: number;
  lastActivity: number;
}

interface NonceState {
  entries: Record<string, NonceStateEntry>;
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

  constructor({ stateFile = DEFAULT_STATE_FILE, pruneAgeMs, seedPhrase }: {
    stateFile?: string;
    pruneAgeMs?: number;
    seedPhrase?: string;
  } = {}) {
    super();
    this.stateFile = stateFile;
    this.pruneAgeMs = pruneAgeMs ?? config.GMP_NONCE_PRUNE_AGE_MS ?? 90 * 24 * 60 * 60 * 1000;
    this.state = {
      entries: {},
      version: 1,
    };
    this.encryptionKey = null;

    if (seedPhrase) {
      this.encryptionKey = crypto.pbkdf2Sync(seedPhrase, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');
    }

    this._loaded = false;
    this._dirty = false;
    this._saveTimer = null;
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
   * Returns false if the merged state could not be written. The merge itself
   * has already happened in memory at that point, so the process is protected;
   * what is not guaranteed is that the *next* process will be, which is why
   * this is an ERROR and why strict mode refuses to continue.
   */
  setEncryptionKey(key: Buffer | null): boolean {
    this.encryptionKey = key;
    const carriedForward = this._entryCount() > 0;
    this.load();

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
   * Read the persisted state, or null if there is nothing usable to read.
   *
   * Split out from load() so that "what is on disk" and "what becomes the
   * live state" are separate decisions — the second is a merge, not an
   * assignment.
   */
  private _readPersistedState(): NonceState | null {
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
      if (stateObj && stateObj.version === 1 && stateObj.entries) return stateObj;
      return null;
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

    this.state = { entries: merged, version: 1 };
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
    const loaded = this._readPersistedState();
    if (this._mergeState(loaded)) {
      // Mark dirty so setEncryptionKey()'s flush has something to write and
      // the batched timer retries if that flush fails.
      this._dirty = true;
    }
    this._loaded = true;
    this._pruneOldEntries();
    return this;
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
      const plaintextJson = JSON.stringify(this.state);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const encryptedBlob = Buffer.concat([authTag, ciphertext]);
      const encryptedObj = {
        iv: iv.toString('hex'),
        ciphertext: encryptedBlob.toString('hex'),
        version: 1
      };
      writeFileAtomicSync(this.stateFile, JSON.stringify(encryptedObj, null, 2));
      this._dirty = false;
      return true;
    } catch (err) {
      const error = err as Error;
      logger.error('nonce-store', 'save-failed', `Failed to save state: ${error.message}`, { err: error.message });
      return false;
    }
  }

  private _pruneOldEntries(): void {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of Object.entries(this.state.entries)) {
      if (now - entry.lastActivity > this.pruneAgeMs) {
        delete this.state.entries[key];
        pruned++;
      }
    }
    if (pruned > 0) {
      this.save();
    }
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
    const result = this.checkNonce(peerNodeId, sessionKeyFingerprint, 0);
    if (!result.valid) {
      return {
        valid: false,
        reason: `Session key already used with this peer (fingerprint ${sessionKeyFingerprint.slice(0, 12)}…)`,
      };
    }

    // checkNonce() recorded the claim in memory and queued a write for up to a
    // second from now. Returning here would hand the caller a success it cannot
    // rely on: a crash, an OOM kill or a container restart inside that second
    // loses the claim, the next process loads a state file that has never heard
    // of this session key, and the same key is accepted a second time — which
    // is the AES-GCM nonce reuse the claim exists to prevent. Flush before
    // saying yes.
    if (!this.encryptionKey) {
      // No key yet means no state file to write to — link.js only supplies one
      // once the identity has been derived. This is not a lost claim: load()
      // merges rather than replaces, so everything recorded here survives
      // setEncryptionKey() and is flushed to disk at that point.
      logger.debug(
        'nonce-store',
        'claim-held-in-memory',
        `Session key claim held in memory until an encryption key is configured ` +
        `(fingerprint ${sessionKeyFingerprint.slice(0, 12)}…)`,
        { stateFile: this.stateFile }
      );
      return result;
    }

    if (!this._saveNow()) {
      logger.error(
        'nonce-store',
        'state-claim-persist-failed',
        `Rejecting session key claim: the claim could not be persisted, and a claim that is not on disk ` +
        `is a claim the next process will not honour (fingerprint ${sessionKeyFingerprint.slice(0, 12)}…)`,
        { stateFile: this.stateFile, peerNodeId: Buffer.from(peerNodeId).toString('hex').slice(0, 16) }
      );
      // The in-memory entry stays. Rolling it back would make this process
      // willing to hand out a key that may in fact have reached disk; leaving
      // it means the key is refused either way, which is the direction to fail
      // in. The queued retry from checkNonce()'s save() may still land it later,
      // and a claim that persists after being refused costs nothing.
      return {
        valid: false,
        reason: 'Session key claim could not be persisted; refusing the connection rather than ' +
                'accepting a key that would be re-accepted after a restart',
      };
    }

    return result;
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

    entry.highWaterMark = nonce;
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
  }
}