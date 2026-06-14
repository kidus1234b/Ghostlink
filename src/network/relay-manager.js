// relay-manager.js — Encrypted relay fallback with priority queue, ACK tracking, and TTL support
(function(exports) {
  'use strict';

  const G = typeof globalThis !== 'undefined' ? globalThis : this;

  const DEFAULT_RELAY_TIMEOUT = 30000;
  const DEFAULT_MAX_QUEUE_SIZE = 100;
  const DEFAULT_TTL = 60000;

  class RelayManager {
    constructor(options = {}) {
      this._bus = options.eventBus || (G.GhostLink && G.GhostLink.globalBus) || null;
      this._log = options.logger || (G.GhostLink && G.GhostLink.log) || console;
      this._signalManager = options.signalManager || null;
      this._sendFn = options.sendFn || null;
      this._encryptFn = options.encryptFn || null;

      this._queue = [];
      this._acks = new Map();
      this._retryTimers = new Map();

      this._relayTimeout = options.relayTimeout || DEFAULT_RELAY_TIMEOUT;
      this._maxQueueSize = options.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE;
      this._defaultTtl = options.defaultTtl || DEFAULT_TTL;

      this._enabled = true;
      this._relayMode = false;
      this._processing = false;
      this._destroyed = false;
    }

    _emit(topic, data) {
      if (this._bus && this._bus.emit) {
        try { this._bus.emit(`relay:${topic}`, data); } catch (e) { this._log.error('[RelayManager] emit failed', e); }
      }
      this._log.debug(`[Relay] ${topic}`, data || {});
    }

    queuePacket(peerId, payload, options = {}) {
      if (this._destroyed) return null;
      const { priority = 0, msgId, expectAck = true, ttl = this._defaultTtl, encrypted = false } = options;
      const id = msgId || 'relay-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);

      if (this._queue.length >= this._maxQueueSize) {
        this._log.warn('[Relay] Queue full, dropping oldest');
        const removed = this._queue.shift();
        if (removed && this._acks.has(removed.id)) {
          this._acks.delete(removed.id);
        }
      }

      const entry = {
        id,
        peerId,
        payload,
        priority,
        expectAck,
        ttl,
        encrypted,
        enqueuedAt: Date.now(),
        attempt: 0,
        status: 'pending',
      };

      const insertAt = this._queue.findIndex(e => e.priority < priority);
      if (insertAt === -1) this._queue.push(entry);
      else this._queue.splice(insertAt, 0, entry);

      if (expectAck) {
        this._acks.set(id, { sentAt: Date.now(), acked: false, peerId });
        this._startAckTimeout(id);
      }

      this._processQueue();
      return id;
    }

    _startAckTimeout(msgId) {
      if (this._retryTimers.has(msgId)) {
        clearTimeout(this._retryTimers.get(msgId));
      }
      const timer = setTimeout(() => {
        const ack = this._acks.get(msgId);
        if (ack && !ack.acked) {
          this._acks.delete(msgId);
          this._retryTimers.delete(msgId);
          this._log.debug(`[Relay] ACK timeout for ${msgId}`);
          this._emit('ack-timeout', { msgId });
          this._processQueue();
        }
      }, this._relayTimeout);
      this._retryTimers.set(msgId, timer);
    }

    async _processQueue() {
      if (!this._enabled || this._processing || this._destroyed) return;
      if (this._queue.length === 0) return;

      this._processing = true;

      try {
        while (this._queue.length > 0) {
          const entry = this._queue[0];

          if (Date.now() - entry.enqueuedAt > entry.ttl) {
            this._queue.shift();
            this._acks.delete(entry.id);
            this._log.debug(`[Relay] TTL expired for ${entry.id}`);
            this._emit('ttl-expired', { msgId: entry.id, peerId: entry.peerId });
            continue;
          }

          if (entry.status === 'pending' && this._sendFn) {
            let sent = false;
            try {
              sent = this._sendFn(entry.peerId, entry.payload);
            } catch (e) {
              this._log.debug(`[Relay] Direct send failed for ${entry.id}`, e);
            }

            if (sent) {
              this._queue.shift();
              entry.status = 'sent';
              if (!entry.expectAck) {
                this._acks.delete(entry.id);
              }
              this._emit('sent', { msgId: entry.id, peerId: entry.peerId, direct: true });
              continue;
            }
          }

          if (this._signalManager && this._signalManager.connected) {
            let payloadToSend = entry.payload;

            if (this._encryptFn && !entry.encrypted) {
              try {
                payloadToSend = await this._encryptFn(entry.peerId, entry.payload);
                entry.encrypted = true;
              } catch (e) {
                this._log.debug(`[Relay] Encryption failed for ${entry.id}`, e);
              }
            }

            try {
              const relayPayload = {
                type: 'relay',
                id: entry.id,
                payload: payloadToSend,
                encrypted: entry.encrypted,
                ts: Date.now(),
              };

              const sent = this._signalManager.send({
                type: 'relay',
                to: entry.peerId,
                payload: relayPayload,
              });

              if (sent) {
                this._queue.shift();
                entry.status = 'relayed';
                if (!entry.expectAck) {
                  this._acks.delete(entry.id);
                }
                this._relayMode = true;
                this._emit('relayed', { msgId: entry.id, peerId: entry.peerId });
                this._emit('mode', { enabled: true, mode: 'relay-secure' });
                continue;
              }
            } catch (e) {
              this._log.debug(`[Relay] Relay send failed for ${entry.id}`, e);
            }
          }

          break;
        }
      } finally {
        this._processing = false;
      }
    }

    receiveAck(msgId) {
      const ack = this._acks.get(msgId);
      if (ack) {
        ack.acked = true;
        const timer = this._retryTimers.get(msgId);
        if (timer) { clearTimeout(timer); this._retryTimers.delete(msgId); }
        this._acks.delete(msgId);
        this._emit('acked', { msgId });
        return true;
      }
      return false;
    }

    receiveMessage(msgId, payload) {
      this._emit('message', { msgId, payload });
    }

    _retryPacket(msgId) {
      const entry = this._queue.find(e => e.id === msgId);
      if (!entry) return;

      entry.attempt += 1;
      if (entry.attempt > 5) {
        this._queue = this._queue.filter(e => e.id !== msgId);
        this._acks.delete(msgId);
        this._log.warn(`[Relay] Max retries reached for ${msgId}`);
        this._emit('max-retries', { msgId, peerId: entry.peerId });
        return;
      }

      this._processQueue();
    }

    setEnabled(enabled) {
      this._enabled = enabled;
      if (enabled) this._processQueue();
    }

    isEnabled() { return this._enabled; }
    isRelayMode() { return this._relayMode; }
    get queueSize() { return this._queue.length; }
    get ackCount() { return this._acks.size; }
    get pendingCount() { return this._queue.length; }

    getQueueStatus() {
      return {
        size: this._queue.length,
        acks: this._acks.size,
        relayMode: this._relayMode,
        enabled: this._enabled,
        items: this._queue.map(e => ({
          id: e.id,
          peerId: e.peerId,
          priority: e.priority,
          attempt: e.attempt,
          status: e.status,
          age: Date.now() - e.enqueuedAt,
        })),
      };
    }

    clear() {
      this._queue.forEach(e => {
        const timer = this._retryTimers.get(e.id);
        if (timer) { clearTimeout(timer); this._retryTimers.delete(e.id); }
      });
      this._queue = [];
      this._acks.clear();
    }

    destroy() {
      this._destroyed = true;
      this.clear();
      this._enabled = false;
      this._signalManager = null;
      this._sendFn = null;
      this._encryptFn = null;
    }
  }

  G.GhostLink = G.GhostLink || {};
  G.GhostLink.RelayManager = RelayManager;
})(typeof globalThis !== 'undefined' ? globalThis : this);