import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import config from './config.js';
import logger from './logger.js';
import { NONCE_STATE_FILE } from './paths.js';
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

  setEncryptionKey(key: Buffer | null): void {
    this.encryptionKey = key;
    this.load();
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

  load(): this {
    if (!this.encryptionKey) {
      this.state = { entries: {}, version: 1 };
      this._loaded = true;
      return this;
    }
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, 'utf8');
        const parsed = JSON.parse(raw) as { iv: string; ciphertext: string; version?: number };
        if (parsed && parsed.iv && parsed.ciphertext && parsed.version === 1) {
          const iv = Buffer.from(parsed.iv, 'hex');
          const encryptedBlob = Buffer.from(parsed.ciphertext, 'hex');
          const authTag = encryptedBlob.slice(0, 16);
          const ciphertext = encryptedBlob.slice(16);

          // Decryption gets its own catch so an authentication failure can be
          // told apart from a missing file or a syntax error. A file that is
          // present and well-formed but will not authenticate has either been
          // tampered with or belongs to a different identity, and discarding it
          // silently resets every high-water mark this store exists to keep.
          let decrypted: Buffer;
          try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
            decipher.setAuthTag(authTag);
            decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          } catch (err) {
            this._onUnauthenticatedState(err as Error);
            this.state = { entries: {}, version: 1 };
            this._loaded = true;
            return this;
          }

          const stateObj = JSON.parse(decrypted.toString('utf8')) as NonceState;
          if (stateObj && stateObj.version === 1) {
            this.state = stateObj;
          }
        } else {
          logger.warn('nonce-store', 'format-mismatch', 'Nonce state file format mismatch or plaintext, starting fresh.');
          this.state = { entries: {}, version: 1 };
        }
      } else {
        this.state = { entries: {}, version: 1 };
      }
    } catch (err) {
      // A strict-mode refusal must not be absorbed here. This catch exists to
      // survive unreadable or malformed files by starting fresh, which is the
      // precise behaviour strict mode is meant to prevent.
      if (err instanceof StateAuthenticationError) throw err;
      const error = err as Error;
      logger.warn('nonce-store', 'load-failed', `Failed to load state file, starting fresh: ${error.message}`, { err: error.message });
      this.state = { entries: {}, version: 1 };
    }
    this._loaded = true;
    this._pruneOldEntries();
    return this;
  }

  save(): void {
    this._dirty = true;
    if (this._saveTimer) return;

    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, 1000);
  }

  private _saveNow(): void {
    if (!this._dirty || !this.encryptionKey) return;
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
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
      fs.writeFileSync(this.stateFile, JSON.stringify(encryptedObj, null, 2));
      this._dirty = false;
    } catch (err) {
      const error = err as Error;
      logger.error('nonce-store', 'save-failed', `Failed to save state: ${error.message}`, { err: error.message });
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
    if (result.valid) return result;
    return {
      valid: false,
      reason: `Session key already used with this peer (fingerprint ${sessionKeyFingerprint.slice(0, 12)}…)`,
    };
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
    this._saveNow();
  }
}