/**
 * GMP Nonce Store — Phase 2a / Phase 5 / Phase 7
 * Persists nonce high-water marks to defend against nonce reuse attacks.
 * Encrypted at rest using AES-256-GCM.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import config from './config.js';
import logger from './logger.js';

const DEFAULT_STATE_FILE = path.join(process.cwd(), 'gmp-core', 'data', 'nonce-state.json');

class NonceStore extends EventEmitter {
  constructor({ stateFile = DEFAULT_STATE_FILE, pruneAgeMs, seedPhrase } = {}) {
    super();
    this.stateFile = stateFile;
    this.pruneAgeMs = pruneAgeMs || config.GMP_NONCE_PRUNE_AGE_MS || 90 * 24 * 60 * 60 * 1000;
    this.state = {
      entries: {},      // keyed by "peerNodeId:sessionKeyFingerprint"
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

  setEncryptionKey(key) {
    this.encryptionKey = key;
    this.load();
  }

  _getKey(peerNodeId, sessionKeyFingerprint) {
    const peerHex = Buffer.from(peerNodeId).toString('hex');
    return `${peerHex}:${sessionKeyFingerprint}`;
  }

  load() {
    if (!this.encryptionKey) {
      this.state = { entries: {}, version: 1 };
      this._loaded = true;
      return this;
    }
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.iv && parsed.ciphertext && parsed.version === 1) {
          const iv = Buffer.from(parsed.iv, 'hex');
          const encryptedBlob = Buffer.from(parsed.ciphertext, 'hex');
          const authTag = encryptedBlob.slice(0, 16);
          const ciphertext = encryptedBlob.slice(16);
          const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
          decipher.setAuthTag(authTag);
          const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          const stateObj = JSON.parse(decrypted.toString('utf8'));
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
      logger.warn('nonce-store', 'load-failed', `Failed to load state file, starting fresh: ${err.message}`, { err: err.message });
      this.state = { entries: {}, version: 1 };
    }
    this._loaded = true;
    this._pruneOldEntries();
    return this;
  }

  save() {
    this._dirty = true;
    if (this._saveTimer) return;

    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, 1000); // Debounce disk writes by 1 second
  }

  _saveNow() {
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
      logger.error('nonce-store', 'save-failed', `Failed to save state: ${err.message}`, { err: err.message });
    }
  }

  _pruneOldEntries() {
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

  checkNonce(peerNodeId, sessionKeyFingerprint, nonce) {
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

  close() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveNow();
  }
}

export { NonceStore };