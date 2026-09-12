import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import config from './config.js';
import logger from './logger.js';

const DEFAULT_STATE_FILE = path.join(process.cwd(), 'gmp-core', 'data', 'nonce-state.json');

interface NonceStateEntry {
  highWaterMark: number;
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
          const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
          decipher.setAuthTag(authTag);
          const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
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