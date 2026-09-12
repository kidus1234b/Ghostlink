import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import config from './config.js';
import logger from './logger.js';
import { PEER_CACHE_FILE } from './paths.js';
import type { CachedPeer } from './types.js';

const DEFAULT_CACHE_FILE = PEER_CACHE_FILE;

export class PeerCache {
  private filePath: string;
  private cache: CachedPeer[];
  private encryptionKey: Buffer | null;
  private pruneInterval: NodeJS.Timeout | null;

  constructor({ filePath, seedPhrase }: { filePath?: string; seedPhrase?: string } = {}) {
    this.filePath = filePath || DEFAULT_CACHE_FILE;
    this.cache = [];
    this.encryptionKey = null;

    if (seedPhrase) {
      this.encryptionKey = crypto.pbkdf2Sync(seedPhrase, 'ghostlink-peer-cache-v1', 100000, 32, 'sha256');
    }

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        const error = err as Error;
        logger.error('peer-cache', 'mkdir-failed', `Failed to create data directory: ${error.message}`, { err: error.message });
      }
    }

    this.load();
    this.prune();

    this.pruneInterval = setInterval(() => {
      this.prune();
    }, 24 * 60 * 60 * 1000);

    if (this.pruneInterval && this.pruneInterval.unref) {
      this.pruneInterval.unref();
    }
  }

  setEncryptionKey(key: Buffer | null): void {
    this.encryptionKey = key;
    this.load();
  }

  load(): void {
    if (!this.encryptionKey) {
      this.cache = [];
      return;
    }
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as { iv: string; ciphertext: string; version?: number };
        if (parsed && parsed.iv && parsed.ciphertext && parsed.version === 1) {
          const iv = Buffer.from(parsed.iv, 'hex');
          const encryptedBlob = Buffer.from(parsed.ciphertext, 'hex');
          const authTag = encryptedBlob.slice(0, 16);
          const ciphertext = encryptedBlob.slice(16);
          const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
          decipher.setAuthTag(authTag);
          const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          const parsedCache = JSON.parse(decrypted.toString('utf8'));
          if (Array.isArray(parsedCache)) {
            this.cache = parsedCache;
          } else {
            logger.warn('peer-cache', 'format-mismatch', 'Cache file format mismatch or plaintext, starting fresh.');
            this.cache = [];
          }
        } else {
          logger.warn('peer-cache', 'format-mismatch', 'Cache file format mismatch or plaintext, starting fresh.');
          this.cache = [];
        }
      } else {
        this.cache = [];
      }
    } catch (err) {
      const error = err as Error;
      logger.warn('peer-cache', 'load-failed', `Failed to load cache, starting fresh: ${error.message}`, { err: error.message });
      this.cache = [];
    }
    if (!Array.isArray(this.cache)) {
      this.cache = [];
    }
  }

  save(): void {
    if (!this.encryptionKey) {
      return;
    }
    try {
      const plaintextJson = JSON.stringify(this.cache);
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
      fs.writeFileSync(this.filePath, JSON.stringify(encryptedObj, null, 2), 'utf8');
    } catch (err) {
      const error = err as Error;
      logger.error('peer-cache', 'save-failed', `Failed to save cache: ${error.message}`, { err: error.message });
    }
  }

  recordSuccess(nodeId: string, address: string, port: number, signingPubKey: string | null = null): void {
    if (!nodeId) return;

    const now = Date.now();
    let entry = this.cache.find(e => e.nodeId === nodeId);

    if (entry) {
      entry.address = address;
      entry.port = port;
      entry.lastSeen = now;
      entry.connectionCount++;
      entry.failureCount = 0;
      if (signingPubKey) {
        (entry as CachedPeer & { signingPubKey?: string }).signingPubKey = signingPubKey;
      }
    } else {
      entry = {
        nodeId,
        address,
        port,
        firstSeen: now,
        lastSeen: now,
        connectionCount: 1,
        lastFailedAt: null,
        failureCount: 0,
      };
      this.cache.push(entry);
    }

    const maxSize = config.GMP_PEER_CACHE_MAX_SIZE || 500;
    if (this.cache.length > maxSize) {
      this.cache.sort((a, b) => this.getScore(b) - this.getScore(a));
      this.cache = this.cache.slice(0, maxSize);
    }

    this.save();
  }

  recordFailure(nodeId: string): void {
    if (!nodeId) return;

    const entry = this.cache.find(e => e.nodeId === nodeId);
    if (entry) {
      entry.lastFailedAt = Date.now();
      entry.failureCount++;
      this.save();
    }
  }

  replaceNodeId(oldNodeId: string, newNodeId: string, newPublicKey: string): boolean {
    const entry = this.cache.find(e => e.nodeId === oldNodeId);
    if (entry) {
      entry.nodeId = newNodeId;
      (entry as CachedPeer & { signingPubKey?: string }).signingPubKey = newPublicKey;
      this.save();
      return true;
    }
    return false;
  }

  getScore(entry: CachedPeer): number {
    const now = Date.now();
    const ageMs = now - entry.lastSeen;
    let recencyBonus = 0.1;

    if (ageMs < 60 * 60 * 1000) {
      recencyBonus = 1.0;
    } else if (ageMs < 24 * 60 * 60 * 1000) {
      recencyBonus = 0.7;
    } else if (ageMs < 7 * 24 * 60 * 60 * 1000) {
      recencyBonus = 0.4;
    }

    return (entry.connectionCount / (entry.failureCount + 1)) * recencyBonus;
  }

  getCandidates(): CachedPeer[] {
    return [...this.cache].sort((a, b) => this.getScore(b) - this.getScore(a));
  }

  getDirectPeers24h(): CachedPeer[] {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return this.cache.filter(entry => entry.lastSeen >= oneDayAgo && entry.connectionCount > 0);
  }

  prune(): void {
    const pruneAgeDays = config.GMP_PEER_CACHE_PRUNE_AGE_DAYS || 30;
    const failureThreshold = config.GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD || 10;
    const cutoffTime = Date.now() - pruneAgeDays * 24 * 60 * 60 * 1000;

    this.cache = this.cache.filter(entry => {
      const isDead = entry.failureCount > failureThreshold && entry.lastSeen < cutoffTime;
      return !isDead;
    });
    this.save();
  }

  close(): void {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
  }
}