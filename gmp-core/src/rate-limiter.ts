import { EventEmitter } from 'events';
import config from './config.js';
import logger from './logger.js';

interface RateLimitEntry {
  ip: string;
  helloTimer: NodeJS.Timeout | null;
  handshakeTimer: NodeJS.Timeout | null;
}

export class RateLimiter extends EventEmitter {
  private windowMs: number;
  private maxPerIp: number;
  private maxGlobal: number;
  private helloTimeoutMs: number;
  private handshakeTimeoutMs: number;
  private _ipWindows: Map<string, number[]>;
  private _globalCount: number;
  private _pendingConnections: Map<string, RateLimitEntry>;

  constructor(options: {
    windowMs?: number;
    maxPerIp?: number;
    maxGlobal?: number;
    helloTimeoutMs?: number;
    handshakeTimeoutMs?: number;
  } = {}) {
    super();
    this.windowMs = options.windowMs ?? config.GMP_RATE_LIMIT_WINDOW_MS ?? 60000;
    this.maxPerIp = options.maxPerIp ?? config.GMP_RATE_LIMIT_MAX_PER_IP ?? 10;
    this.maxGlobal = options.maxGlobal ?? config.GMP_RATE_LIMIT_MAX_GLOBAL ?? 100;
    this.helloTimeoutMs = options.helloTimeoutMs ?? config.GMP_HELLO_TIMEOUT_MS ?? 10000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? config.GMP_HANDSHAKE_TIMEOUT_MS ?? 10000;
    this._ipWindows = new Map();
    this._globalCount = 0;
    this._pendingConnections = new Map();
  }

  private _getIP(socket: { remoteAddress?: string }): string {
    return socket.remoteAddress || 'unknown';
  }

  private _cleanWindow(ip: string): number {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = this._ipWindows.get(ip);
    if (!timestamps) return 0;

    const before = timestamps.length;
    const filtered = timestamps.filter(ts => ts > cutoff);
    this._ipWindows.set(ip, filtered);
    return before - filtered.length;
  }

  checkConnection(socket: { remoteAddress?: string }): boolean {
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

  recordPendingConnection(socket: { remoteAddress?: string }, linkId: string): void {
    const ip = this._getIP(socket);
    this._pendingConnections.set(linkId, {
      ip,
      helloTimer: setTimeout(() => {
        this.emit('hello-timeout', { linkId, ip });
      }, this.helloTimeoutMs),
      handshakeTimer: null,
    });
  }

  recordHelloReceived(linkId: string): void {
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

  recordHandshakeComplete(linkId: string): void {
    const pending = this._pendingConnections.get(linkId);
    if (pending) {
      if (pending.helloTimer) clearTimeout(pending.helloTimer);
      if (pending.handshakeTimer) clearTimeout(pending.handshakeTimer);
      this._pendingConnections.delete(linkId);
    }
  }

  recordConnectionClosed(linkId: string): void {
    const pending = this._pendingConnections.get(linkId);
    if (pending) {
      if (pending.helloTimer) clearTimeout(pending.helloTimer);
      if (pending.handshakeTimer) clearTimeout(pending.handshakeTimer);
      this._pendingConnections.delete(linkId);
    }
    this._globalCount--;
  }

  getStats(): { globalCount: number; maxGlobal: number; pendingConnections: number } {
    return {
      globalCount: this._globalCount,
      maxGlobal: this.maxGlobal,
      pendingConnections: this._pendingConnections.size,
    };
  }

  close(): void {
    for (const pending of this._pendingConnections.values()) {
      if (pending.helloTimer) clearTimeout(pending.helloTimer);
      if (pending.handshakeTimer) clearTimeout(pending.handshakeTimer);
    }
    this._pendingConnections.clear();
    this._ipWindows.clear();
  }
}