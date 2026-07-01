/**
 * GMP Rate Limiter — Phase 2a
 * Per-IP connection rate limiting and global connection cap.
 *
 * Defense against:
 * - Connection flood attacks (many rapid connections from same IP)
 * - Resource exhaustion from handshake crypto amplification
 * - Slow-loris style attacks (connections opened but never completing handshake)
 *
 * Default limits:
 * - Per-IP: 10 new connections per 60-second sliding window
 * - Global: 100 concurrent connections
 * - Handshake timeout: 10s for initial HELLO, 10s for full handshake completion
 */

import { EventEmitter } from 'events';

const DEFAULT_WINDOW_MS = 60000;
const DEFAULT_MAX_PER_IP = 10;
const DEFAULT_MAX_GLOBAL = 100;
const DEFAULT_HELLO_TIMEOUT_MS = 10000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000;

class RateLimiter extends EventEmitter {
  constructor({
    windowMs = DEFAULT_WINDOW_MS,
    maxPerIp = DEFAULT_MAX_PER_IP,
    maxGlobal = DEFAULT_MAX_GLOBAL,
    helloTimeoutMs = DEFAULT_HELLO_TIMEOUT_MS,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  } = {}) {
    super();
    this.windowMs = windowMs;
    this.maxPerIp = maxPerIp;
    this.maxGlobal = maxGlobal;
    this.helloTimeoutMs = helloTimeoutMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;

    this._ipWindows = new Map();
    this._globalCount = 0;
    this._pendingConnections = new Map();
  }

  _getIP(socket) {
    return socket.remoteAddress || 'unknown';
  }

  _cleanWindow(ip) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = this._ipWindows.get(ip);
    if (!timestamps) return 0;

    const before = timestamps.length;
    const filtered = timestamps.filter(ts => ts > cutoff);
    this._ipWindows.set(ip, filtered);
    return before - filtered.length;
  }

  checkConnection(socket) {
    const ip = this._getIP(socket);

    if (this._globalCount >= this.maxGlobal) {
      this.emit('rate-limited', { ip, reason: 'global-cap-reached', current: this._globalCount });
      return false;
    }

    this._cleanWindow(ip);
    const timestamps = this._ipWindows.get(ip) || [];

    if (timestamps.length >= this.maxPerIp) {
      this.emit('rate-limited', { ip, reason: 'per-ip-limit', current: timestamps.length, limit: this.maxPerIp });
      return false;
    }

    timestamps.push(Date.now());
    this._ipWindows.set(ip, timestamps);
    this._globalCount++;

    return true;
  }

  recordPendingConnection(socket, linkId) {
    const ip = this._getIP(socket);
    this._pendingConnections.set(linkId, {
      ip,
      helloTimer: setTimeout(() => {
        this.emit('hello-timeout', { linkId, ip });
      }, this.helloTimeoutMs),
    });
  }

  recordHelloReceived(linkId) {
    const pending = this._pendingConnections.get(linkId);
    if (pending && pending.helloTimer) {
      clearTimeout(pending.helloTimer);
    }
    const pending2 = this._pendingConnections.get(linkId);
    if (pending2) {
      pending2.handshakeTimer = setTimeout(() => {
        this.emit('handshake-timeout', { linkId, ip: pending2.ip });
      }, this.handshakeTimeoutMs);
    }
  }

  recordHandshakeComplete(linkId) {
    const pending = this._pendingConnections.get(linkId);
    if (pending) {
      if (pending.helloTimer) clearTimeout(pending.helloTimer);
      if (pending.handshakeTimer) clearTimeout(pending.handshakeTimer);
      this._pendingConnections.delete(linkId);
    }
  }

  recordConnectionClosed(linkId) {
    const pending = this._pendingConnections.get(linkId);
    if (pending) {
      if (pending.helloTimer) clearTimeout(pending.helloTimer);
      if (pending.handshakeTimer) clearTimeout(pending.handshakeTimer);
      this._pendingConnections.delete(linkId);
    }
    this._globalCount--;
  }

  getStats() {
    return {
      globalCount: this._globalCount,
      maxGlobal: this.maxGlobal,
      pendingConnections: this._pendingConnections.size,
    };
  }

  close() {
    for (const pending of this._pendingConnections.values()) {
      if (pending.helloTimer) clearTimeout(pending.helloTimer);
      if (pending.handshakeTimer) clearTimeout(pending.handshakeTimer);
    }
    this._pendingConnections.clear();
    this._ipWindows.clear();
  }
}

export { RateLimiter, DEFAULT_WINDOW_MS, DEFAULT_MAX_PER_IP, DEFAULT_MAX_GLOBAL, DEFAULT_HELLO_TIMEOUT_MS, DEFAULT_HANDSHAKE_TIMEOUT_MS };