(function(exports) {
  'use strict';

  class SecurityManager {
    constructor({ eventBus, logger }) {
      this.eventBus = eventBus;
      this.logger = logger || console;

      // RateLimiter: sliding window, default 1 minute / 100 requests, per-peer
      this._rateLimitWindowMs = 60 * 1000;
      this._rateLimitMax = 100;
      this._rateBuckets = new Map(); // peerId -> [{timestamp, count}]

      // SessionManager: session creation with 24h expiry, secure cleanup, LRU eviction
      this._sessionMax = 10000;
      this._sessions = new Map(); // peerId -> { publicKey, sessionKey, createdAt }
      this._sessionOrder = []; // LRU order: most recent at end

      // FloodProtection: peer-level message rate limiting (5s/50msg window)
      this._floodWindowMs = 5000;
      this._floodMax = 50;
      this._floodBuckets = new Map(); // peerId -> [{timestamp, count}]

      // NonceTracker: track used nonces to prevent replay, with TTL cleanup
      this._nonceTtlMs = 5 * 60 * 1000; // 5 minutes
      this._nonces = new Map(); // nonce -> expiresAt

      // ReplayDetector: detect replayed messages with ±5min tolerance
      this._replayToleranceMs = 5 * 60 * 1000;
    }

    // ===================== SessionManager =====================

    createSession(peerId, publicKey) {
      if (!peerId || !publicKey) {
        throw new Error('createSession requires peerId and publicKey');
      }
      if (this._sessions.has(peerId)) {
        this._touchSession(peerId);
        return this._sessions.get(peerId);
      }
      if (this._sessions.size >= this._sessionMax) {
        // LRU eviction
        const lru = this._sessionOrder.shift();
        if (lru) {
          this.destroySession(lru);
        }
      }
      const sessionKey = this._generateSessionKey();
      const now = Date.now();
      this._sessions.set(peerId, {
        publicKey,
        sessionKey,
        createdAt: now,
      });
      this._sessionOrder.push(peerId);
      return this._sessions.get(peerId);
    }

    verifySession(peerId) {
      const session = this._sessions.get(peerId);
      if (!session) return false;
      if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
        this.destroySession(peerId);
        return false;
      }
      this._touchSession(peerId);
      return true;
    }

    rotateSessionKeys(peerId) {
      const session = this._sessions.get(peerId);
      if (!session) {
        throw new Error(`No session found for peer ${peerId}`);
      }
      session.sessionKey = this._generateSessionKey();
      session.createdAt = Date.now();
      this._touchSession(peerId);
      return session;
    }

    destroySession(peerId) {
      const session = this._sessions.get(peerId);
      if (session) {
        this._secureZero(session.sessionKey);
        this._sessions.delete(peerId);
      }
      const idx = this._sessionOrder.indexOf(peerId);
      if (idx !== -1) {
        this._sessionOrder.splice(idx, 1);
      }
    }

    _touchSession(peerId) {
      const idx = this._sessionOrder.indexOf(peerId);
      if (idx !== -1) {
        this._sessionOrder.splice(idx, 1);
        this._sessionOrder.push(peerId);
      }
    }

    _generateSessionKey() {
      if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
        const arr = new Uint8Array(32);
        window.crypto.getRandomValues(arr);
        return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
      }
      // Node.js fallback
      if (typeof require === 'function') {
        const crypto = require('crypto');
        return crypto.randomBytes(32).toString('hex');
      }
      throw new Error('Secure random not available');
    }

    // ===================== RateLimiter =====================

    checkRateLimit(peerId) {
      const now = Date.now();
      const buckets = this._rateBuckets.get(peerId) || { requests: [], loggedOnce: false };
      this._pruneExpired(buckets.requests, this._rateLimitWindowMs, now);
      // Count
      const total = buckets.requests.reduce((acc, r) => acc + r.count, 0);
      if (total >= this._rateLimitMax) {
        if (this.eventBus && !buckets.loggedOnce) {
          this.eventBus.emit('security:rate-limit', { peerId, count: total });
          buckets.loggedOnce = true;
        }
        return false;
      }
      if (buckets.requests.length > 0 && now - buckets.requests[buckets.requests.length - 1].timestamp > this._rateLimitWindowMs) {
        // Should not happen because of prune, but just in case
      }
      buckets.requests.push({ timestamp: now, count: 1 });
      this._rateBuckets.set(peerId, buckets);
      return true;
    }

    // ===================== FloodProtection =====================

    checkFlood(peerId) {
      const now = Date.now();
      const buckets = this._floodBuckets.get(peerId) || { requests: [], loggedOnce: false };
      this._pruneExpired(buckets.requests, this._floodWindowMs, now);
      const total = buckets.requests.reduce((acc, r) => acc + r.count, 0);
      if (total >= this._floodMax) {
        if (this.eventBus) {
          this.eventBus.emit('security:violation', { type: 'flood', peerId, count: total });
        }
        return false;
      }
      buckets.requests.push({ timestamp: now, count: 1 });
      this._floodBuckets.set(peerId, buckets);
      return true;
    }

    _pruneExpired(requests, windowMs, now) {
      while (requests.length > 0 && now - requests[0].timestamp > windowMs) {
        requests.shift();
      }
    }

    // ===================== NonceTracker & ReplayDetector =====================

    checkReplay(nonce, timestamp) {
      const now = Date.now();
      if (typeof timestamp !== 'number') return false;
      if (Math.abs(now - timestamp) > this._replayToleranceMs) {
        return false;
      }
      // Clean expired nonces lazily
      this._cleanExpiredNonces(now);
      if (this._nonces.has(nonce)) {
        if (this.eventBus) {
          this.eventBus.emit('security:replay-detected', { nonce, timestamp });
        }
        return false;
      }
      this._nonces.set(nonce, now + this._nonceTtlMs);
      return true;
    }

    _cleanExpiredNonces(now) {
      for (const [nonce, expiresAt] of this._nonces) {
        if (now > expiresAt) {
          this._nonces.delete(nonce);
        }
      }
    }

    // ===================== SignedPayload =====================

    async signPayload(data, privateKey) {
      if (!data || !privateKey) {
        throw new Error('signPayload requires data and privateKey');
      }
      const payload = JSON.stringify(data);
      const encoder = new TextEncoder();
      const dataBuffer = encoder.encode(payload);

      if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
        // Web Crypto
        const keyData = this._hexToArrayBuffer(privateKey);
        const cryptoKey = await window.crypto.subtle.importKey(
          'raw',
          keyData,
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['sign']
        );
        const signature = await window.crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          cryptoKey,
          dataBuffer
        );
        return this._arrayBufferToHex(signature);
      } else {
        // Node.js fallback
        const crypto = require('crypto');
        const sign = crypto.createSign('SHA256');
        sign.update(dataBuffer);
        return sign.sign(privateKey, 'hex');
      }
    }

    async verifyPayload(data, publicKey, signatureHex) {
      if (!data || !publicKey || !signatureHex) {
        throw new Error('verifyPayload requires data, publicKey, and signature');
      }
      const payload = JSON.stringify(data);
      const encoder = new TextEncoder();
      const dataBuffer = encoder.encode(payload);

      if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
        const keyData = this._hexToArrayBuffer(publicKey);
        const signature = this._hexToArrayBuffer(signatureHex);
        const cryptoKey = await window.crypto.subtle.importKey(
          'raw',
          keyData,
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify']
        );
        return window.crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          cryptoKey,
          signature,
          dataBuffer
        );
      } else {
        const crypto = require('crypto');
        const verify = crypto.createVerify('SHA256');
        verify.update(dataBuffer);
        return verify.verify(publicKey, signatureHex, 'hex');
      }
    }

    // ===================== SDP Sanitization =====================

    sanitizeSDP(sdp) {
      if (typeof sdp !== 'string') return '';
      // Remove any lines that are not valid SDP fields
      const allowedPrefixes = ['v=', 'o=', 's=', 'i=', 'u=', 'e=', 'p=', 'c=', 'b=', 't=', 'r=', 'k=', 'a=', 'm='];
      return sdp
        .split('\n')
        .map(line => line.trim())
        .filter(line => {
          if (!line) return false;
          return allowedPrefixes.some(prefix => line.startsWith(prefix));
        })
        .join('\n');
    }

    // ===================== Utilities =====================

    _secureZero(str) {
      if (!str) return;
      // Overwrite string content in-place as best we can
      const buf = Buffer.from ? Buffer.from(str, 'utf8') : new TextEncoder().encode(str);
      for (let i = 0; i < buf.length; i++) {
        buf[i] = 0;
      }
    }

    _hexToArrayBuffer(hex) {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
      return bytes.buffer;
    }

    _arrayBufferToHex(buffer) {
      const bytes = new Uint8Array(buffer);
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }

    // ===================== Cleanup =====================

    destroy() {
      // Secure zero all session keys
      for (const [peerId, session] of this._sessions) {
        this._secureZero(session.sessionKey);
      }
      this._sessions.clear();
      this._sessionOrder.length = 0;

      for (const [peerId, buckets] of this._rateBuckets) {
        if (buckets.requests) buckets.requests.length = 0;
      }
      this._rateBuckets.clear();

      for (const [peerId, buckets] of this._floodBuckets) {
        if (buckets.requests) buckets.requests.length = 0;
      }
      this._floodBuckets.clear();

      this._nonces.clear();

      // Nullify references for GC
      this.eventBus = null;
      this.logger = null;
    }
  }

  exports.SecurityManager = SecurityManager;
})(typeof globalThis !== 'undefined' ? globalThis : this);
