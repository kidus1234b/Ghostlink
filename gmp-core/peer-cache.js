import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import config from './config.js';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CACHE_FILE = path.join(__dirname, 'data', 'peer-cache.json');

/**
 * ============================================================================
 * SECURITY / PRIVACY WARNING:
 * peer-cache.json contains sensitive metadata about the user's communications,
 * including NodeIDs, last known IP addresses, ports, and connection timestamps.
 * 
 * CLOSED PRIVACY GAP (Phase 5):
 * This file is encrypted at rest using AES-256-GCM with key material derived
 * from the user's seed phrase.
 * ============================================================================
 */

export class PeerCache {
  constructor({ filePath, seedPhrase } = {}) {
    this.filePath = filePath || DEFAULT_CACHE_FILE;
    this.cache = [];
    this.encryptionKey = null;

    if (seedPhrase) {
      this.encryptionKey = crypto.pbkdf2Sync(seedPhrase, 'ghostlink-peer-cache-v1', 100000, 32, 'sha256');
    }
    
    // Ensure directory exists
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        logger.error('peer-cache', 'mkdir-failed', `Failed to create data directory: ${err.message}`, { err: err.message });
      }
    }

    this.load();
    this.prune();

    // Prune daily (24h)
    this.pruneInterval = setInterval(() => {
      this.prune();
    }, 24 * 60 * 60 * 1000);
    
    if (this.pruneInterval && this.pruneInterval.unref) {
      this.pruneInterval.unref();
    }
  }

  setEncryptionKey(key) {
    this.encryptionKey = key;
    this.load();
  }

  load() {
    if (!this.encryptionKey) {
      this.cache = [];
      return;
    }
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.iv && parsed.ciphertext && parsed.version === 1) {
          const iv = Buffer.from(parsed.iv, 'hex');
          const encryptedBlob = Buffer.from(parsed.ciphertext, 'hex');
          const authTag = encryptedBlob.slice(0, 16);
          const ciphertext = encryptedBlob.slice(16);
          const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
          decipher.setAuthTag(authTag);
          const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          this.cache = JSON.parse(decrypted.toString('utf8'));
        } else {
          logger.warn('peer-cache', 'format-mismatch', 'Cache file format mismatch or plaintext, starting fresh.');
          this.cache = [];
        }
      } else {
        this.cache = [];
      }
    } catch (err) {
      logger.warn('peer-cache', 'load-failed', `Failed to load cache, starting fresh: ${err.message}`, { err: err.message });
      this.cache = [];
    }
    if (!Array.isArray(this.cache)) {
      this.cache = [];
    }
  }

  save() {
    if (!this.encryptionKey) {
      return; // Cannot save without encryption key
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
      logger.error('peer-cache', 'save-failed', `Failed to save cache: ${err.message}`, { err: err.message });
    }
  }

  recordSuccess(nodeId, address, port, signingPubKey = null) {
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
        entry.signingPubKey = signingPubKey;
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
        signingPubKey
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

  recordFailure(nodeId) {
    if (!nodeId) return;

    const entry = this.cache.find(e => e.nodeId === nodeId);
    if (entry) {
      entry.lastFailedAt = Date.now();
      entry.failureCount++;
      this.save();
    }
  }

  replaceNodeId(oldNodeId, newNodeId, newPublicKey) {
    const entry = this.cache.find(e => e.nodeId === oldNodeId);
    if (entry) {
      entry.nodeId = newNodeId;
      entry.signingPubKey = newPublicKey;
      this.save();
      return true;
    }
    return false;
  }

  getScore(entry) {
    const now = Date.now();
    const ageMs = now - entry.lastSeen;
    let recencyBonus = 0.1;

    if (ageMs < 60 * 60 * 1000) {
      // < 1 hour ago
      recencyBonus = 1.0;
    } else if (ageMs < 24 * 60 * 60 * 1000) {
      // < 24 hours ago
      recencyBonus = 0.7;
    } else if (ageMs < 7 * 24 * 60 * 60 * 1000) {
      // < 7 days ago
      recencyBonus = 0.4;
    }

    return (entry.connectionCount / (entry.failureCount + 1)) * recencyBonus;
  }

  getCandidates(options = {}) {
    return [...this.cache].sort((a, b) => this.getScore(b) - this.getScore(a));
  }

  getDirectPeers24h() {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return this.cache.filter(entry => entry.lastSeen >= oneDayAgo && entry.connectionCount > 0);
  }

  prune() {
    const pruneAgeDays = config.GMP_PEER_CACHE_PRUNE_AGE_DAYS || 30;
    const failureThreshold = config.GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD || 10;
    const cutoffTime = Date.now() - pruneAgeDays * 24 * 60 * 60 * 1000;
    
    this.cache = this.cache.filter(entry => {
      const isDead = entry.failureCount > failureThreshold && entry.lastSeen < cutoffTime;
      return !isDead;
    });
    this.save();
  }

  close() {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
  }
}
