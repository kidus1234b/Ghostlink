/**
 * GMP Nonce Store — Phase 2a
 * Persists nonce high-water marks to defend against nonce reuse attacks.
 *
 * Defense in depth: Even if ephemeral key uniqueness (LRU check in link.js) fails,
 * this provides a second independent check by persisting and comparing nonce counters
 * across process restarts.
 *
 * File format: gmp-core/data/nonce-state.json
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';

const DEFAULT_STATE_FILE = path.join(process.cwd(), 'gmp-core', 'data', 'nonce-state.json');
const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

class NonceStore extends EventEmitter {
  constructor({ stateFile = DEFAULT_STATE_FILE } = {}) {
    super();
    this.stateFile = stateFile;
    this.state = {
      entries: {},      // keyed by "peerNodeId:sessionKeyFingerprint"
      version: 1,
    };
    this._loaded = false;
    this._dirty = false;
    this._saveTimer = null;
  }

  _getKey(peerNodeId, sessionKeyFingerprint) {
    const peerHex = Buffer.from(peerNodeId).toString('hex');
    return `${peerHex}:${sessionKeyFingerprint}`;
  }

  _fingerprintKey(sessionKey) {
    return crypto.createHash('sha256').update(Buffer.from(sessionKey)).digest('hex').slice(0, 16);
  }

  async load() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = fs.readFileSync(this.stateFile, 'utf8');
        const parsed = JSON.parse(data);
        if (parsed.version === 1) {
          this.state = parsed;
        }
      }
    } catch (err) {
      console.warn(`[NonceStore] Failed to load state file: ${err.message}`);
    }
    this._loaded = true;
    this._pruneOldEntries();
    return this;
  }

  _persist() {
    if (!this._loaded) return;
    this._dirty = true;

    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }

    this._saveTimer = setTimeout(() => {
      this._saveNow();
    }, 1000);
  }

  _saveNow() {
    if (!this._dirty) return;
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
      this._dirty = false;
    } catch (err) {
      console.error(`[NonceStore] Failed to save state: ${err.message}`);
    }
  }

  _pruneOldEntries() {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of Object.entries(this.state.entries)) {
      if (now - entry.lastActivity > PRUNE_AGE_MS) {
        delete this.state.entries[key];
        pruned++;
      }
    }
    if (pruned > 0) {
      this._persist();
    }
    return pruned;
  }

  checkAndUpdate(peerNodeId, sessionKey, sendNonceCounter, recvNonceCounter) {
    const fingerprint = this._fingerprintKey(sessionKey);
    const key = this._getKey(peerNodeId, fingerprint);
    const now = Date.now();

    let entry = this.state.entries[key];

    if (!entry) {
      entry = {
        sendHighWater: -1,
        recvHighWater: -1,
        firstSeen: now,
        lastActivity: now,
      };
      this.state.entries[key] = entry;
    }

    if (sendNonceCounter <= entry.sendHighWater) {
      return {
        allowed: false,
        reason: 'send nonce would overlap',
        existingHighWater: entry.sendHighWater,
        requestedCounter: sendNonceCounter,
      };
    }

    if (recvNonceCounter <= entry.recvHighWater) {
      return {
        allowed: false,
        reason: 'recv nonce would overlap',
        existingHighWater: entry.recvHighWater,
        requestedCounter: recvNonceCounter,
      };
    }

    entry.sendHighWater = sendNonceCounter;
    entry.recvHighWater = recvNonceCounter;
    entry.lastActivity = now;
    this._persist();

    return { allowed: true };
  }

  updateCounters(peerNodeId, sessionKey, sendNonceCounter, recvNonceCounter) {
    const fingerprint = this._fingerprintKey(sessionKey);
    const key = this._getKey(peerNodeId, fingerprint);
    const now = Date.now();

    let entry = this.state.entries[key];

    if (!entry) {
      entry = {
        sendHighWater: -1,
        recvHighWater: -1,
        firstSeen: now,
        lastActivity: now,
      };
      this.state.entries[key] = entry;
    }

    if (sendNonceCounter > entry.sendHighWater) {
      entry.sendHighWater = sendNonceCounter;
    }
    if (recvNonceCounter > entry.recvHighWater) {
      entry.recvHighWater = recvNonceCounter;
    }
    entry.lastActivity = now;
    this._persist();
  }

  getEntry(peerNodeId, sessionKey) {
    const fingerprint = this._fingerprintKey(sessionKey);
    const key = this._getKey(peerNodeId, fingerprint);
    return this.state.entries[key] || null;
  }

  close() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }
    this._saveNow();
  }
}

export { NonceStore, PRUNE_AGE_MS };