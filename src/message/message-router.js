(function(exports) {
  'use strict';

  const { StateMachine, RetryQueue } = (typeof window !== 'undefined' && window.GhostLink) || {};

  class MessageRouter {
    constructor({ eventBus, logger, connectionManager, securityManager, offlineQueue }) {
      this.eventBus = eventBus;
      this.logger = logger || console;
      this.connectionManager = connectionManager;
      this.securityManager = securityManager;
      this.offlineQueue = offlineQueue;

      // Async message queue with ordered delivery
      this._messageQueue = new Map(); // peerId -> [{ resolve, reject, envelope }]

      // Deduplication: key = messageId_sender_timestamp
      this._dedupCache = new Map(); // key -> boolean
      this._dedupMaxAge = 5 * 60 * 1000; // 5 minutes

      // ACK tracking with retry (exponential backoff)
      this._pendingAcks = new Map(); // messageId -> { peerId, resolve, reject, retries, timeout, lastSent, envelope }
      this._maxRetries = 5;
      this._baseBackoffMs = 500;

      // Delivery receipts
      this._deliveryStatus = new Map(); // messageId -> 'pending' | 'delivered' | 'failed'

      // Supported types
      this._validTypes = new Set([
        'chat',
        'file-metadata',
        'reaction',
        'edit',
        'deletion',
        'system-event',
      ]);
    }

    // ===================== Outgoing =====================

    async sendMessage(peerId, type, payload) {
      if (!this._validTypes.has(type)) {
        throw new Error(`Unsupported message type: ${type}`);
      }
      if (!peerId) {
        throw new Error('sendMessage requires peerId');
      }

      const messageId = this._generateMessageId();
      const timestamp = Date.now();
      const nonce = this._generateNonce();

      // Sign payload
      let signature;
      try {
        // Assuming securityManager.signPayload returns a string signature
        signature = await this.securityManager.signPayload({ messageId, type, payload, timestamp }, this._getPrivateKey());
      } catch (err) {
        this.logger.error('[MessageRouter] Failed to sign payload', err);
        throw err;
      }

      const envelope = {
        messageId,
        sender: this._getMyPeerId(),
        type,
        payload,
        timestamp,
        nonce,
        signature,
      };

      // Return a promise that resolves on ACK or rejects on failure
      return new Promise((resolve, reject) => {
        this._queueForPeer(peerId, envelope, resolve, reject);
        this._attemptSend(peerId, envelope);
      });
    }

    async broadcast(type, payload) {
      if (!this._validTypes.has(type)) {
        throw new Error(`Unsupported message type: ${type}`);
      }
      if (!this.connectionManager || !this.connectionManager.getConnectedPeers) {
        throw new Error('connectionManager.getConnectedPeers is required for broadcast');
      }
      const peers = this.connectionManager.getConnectedPeers();
      const results = await Promise.allSettled(
        peers.map(peerId => this.sendMessage(peerId, type, payload))
      );
      return results;
    }

    // ===================== Incoming =====================

    async handleIncoming(peerId, envelope) {
      if (!envelope || typeof envelope !== 'object') {
        this.logger.warn('[MessageRouter] Invalid envelope received');
        return;
      }
      const { messageId, sender, type, payload, timestamp, nonce, signature } = envelope;

      // Validate required fields
      if (!messageId || !sender || !type || !timestamp || !nonce || !signature) {
        this.logger.warn('[MessageRouter] Malformed envelope');
        if (this.eventBus) this.eventBus.emit('message:failed', { peerId, reason: 'malformed-envelope' });
        return;
      }

      // Rate / flood checks via securityManager
      if (this.securityManager) {
        if (!this.securityManager.checkRateLimit(peerId)) {
          this.logger.warn(`[MessageRouter] Rate limit exceeded for peer ${peerId}`);
          return;
        }
        if (!this.securityManager.checkFlood(peerId)) {
          this.logger.warn(`[MessageRouter] Flood protection triggered for peer ${peerId}`);
          return;
        }
        if (!this.securityManager.checkReplay(nonce, timestamp)) {
          this.logger.warn(`[MessageRouter] Replay detected for peer ${peerId}`);
          return;
        }
      }

      // Deduplication
      const dedupKey = `${messageId}_${sender}_${timestamp}`;
      if (this._dedupCache.has(dedupKey)) {
        this.logger.debug(`[MessageRouter] Duplicate message dropped: ${messageId}`);
        // Still send ACK to avoid the sender retrying indefinitely
        this._sendAck(peerId, messageId);
        return;
      }
      this._dedupCache.set(dedupKey, true);

      // Verify signature if security manager is present
      if (this.securityManager) {
        const isValid = await this.securityManager.verifyPayload(
          { messageId, type, payload, timestamp },
          this._getPublicKey(sender),
          signature
        );
        if (!isValid) {
          this.logger.warn(`[MessageRouter] Invalid signature from peer ${peerId}`);
          if (this.eventBus) this.eventBus.emit('message:failed', { peerId, messageId, reason: 'invalid-signature' });
          return;
        }
      }

      // Send ACK
      this._sendAck(peerId, messageId);

      // Emit received event
      if (this.eventBus) this.eventBus.emit('message:received', { peerId, messageId, type, payload, timestamp });
    }

    // ===================== Offline / Flush =====================

    flushOffline(peerId) {
      if (!this.offlineQueue) return;
      const queue = this.offlineQueue.get(peerId) || [];
      while (queue.length > 0) {
        const envelope = queue.shift();
        this._attemptSend(peerId, envelope);
      }
    }

    getPendingCount(peerId) {
      if (!this._pendingAcks) return 0;
      let count = 0;
      for (const [, info] of this._pendingAcks) {
        if (info.peerId === peerId) count++;
      }
      return count;
    }

    getDeliveryStatus(messageId) {
      return this._deliveryStatus.get(messageId) || 'unknown';
    }

    // ===================== Private Helpers =====================

    _queueForPeer(peerId, envelope, resolve, reject) {
      if (!this._messageQueue.has(peerId)) {
        this._messageQueue.set(peerId, []);
      }
      this._messageQueue.get(peerId).push({ envelope, resolve, reject });
    }

    _attemptSend(peerId, envelope) {
      if (!this.connectionManager) {
        this._bufferOffline(peerId, envelope);
        return;
      }
      const conn = this.connectionManager.getConnection(peerId);
      if (!conn || !conn.open) {
        this._bufferOffline(peerId, envelope);
        return;
      }

      try {
        conn.send(envelope);
        this._trackAck(peerId, envelope);
      } catch (err) {
        this._bufferOffline(peerId, envelope);
      }
    }

    _bufferOffline(peerId, envelope) {
      if (!this.offlineQueue) return;
      if (!this.offlineQueue.has(peerId)) {
        this.offlineQueue.set(peerId, []);
      }
      this.offlineQueue.get(peerId).push(envelope);
    }

    _trackAck(peerId, envelope) {
      const messageId = envelope.messageId;
      if (!messageId) return;

      this._deliveryStatus.set(messageId, 'pending');

      const handleAck = () => {
        this._clearAckTracker(messageId);
        this._deliveryStatus.set(messageId, 'delivered');
        if (this.eventBus) this.eventBus.emit('message:delivered', { peerId, messageId });
        // Resolve the promise if it is still in the queue
        this._resolveQueueMessage(peerId, messageId, true);
      };

      const handleTimeout = () => {
        const info = this._pendingAcks.get(messageId);
        if (!info) return;
        if (info.retries >= this._maxRetries) {
          this._clearAckTracker(messageId);
          this._deliveryStatus.set(messageId, 'failed');
          if (this.eventBus) this.eventBus.emit('message:failed', { peerId, messageId, reason: 'max-retries-exceeded' });
          this._resolveQueueMessage(peerId, messageId, false);
          return;
        }
        info.retries += 1;
        const backoff = this._baseBackoffMs * Math.pow(2, info.retries);
        info.timeout = setTimeout(() => {
          this._attemptSend(peerId, envelope);
          handleTimeout();
        }, backoff);
      };

      this._pendingAcks.set(messageId, {
        peerId,
        retries: 0,
        timeout: setTimeout(handleTimeout, this._baseBackoffMs),
      });
    }

    _clearAckTracker(messageId) {
      const info = this._pendingAcks.get(messageId);
      if (info && info.timeout) {
        clearTimeout(info.timeout);
      }
      this._pendingAcks.delete(messageId);
    }

    _sendAck(peerId, messageId) {
      if (!this.connectionManager) return;
      const conn = this.connectionManager.getConnection(peerId);
      if (conn && conn.open) {
        try {
          conn.send({ type: 'ack', messageId });
        } catch (err) {
          // ignore
        }
      }
    }

    _resolveQueueMessage(peerId, messageId, success) {
      const queue = this._messageQueue.get(peerId);
      if (!queue) return;
      let idx = -1;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].envelope.messageId === messageId) {
          idx = i;
          break;
        }
      }
      if (idx !== -1) {
        const { resolve, reject } = queue.splice(idx, 1)[0];
        if (success) resolve(messageId);
        else reject(new Error(`Message ${messageId} failed`));
      }
    }

    // ===================== Utilities =====================

    _generateMessageId() {
      const ts = Date.now().toString(36);
      const rand = Math.random().toString(36).slice(2, 10);
      return `${ts}_${rand}`;
    }

    _generateNonce() {
      if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
        const arr = new Uint8Array(16);
        window.crypto.getRandomValues(arr);
        return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
      }
      if (typeof require === 'function') {
        const crypto = require('crypto');
        return crypto.randomBytes(16).toString('hex');
      }
      throw new Error('Secure random not available');
    }

    _getMyPeerId() {
      return (this.connectionManager && this.connectionManager.myPeerId) || 'self';
    }

    _getPrivateKey() {
      // Placeholder: In a real implementation, retrieve from secure storage
      return '';
    }

    _getPublicKey(peerId) {
      // Placeholder: In a real implementation, fetch peer's public key from storage/session
      return '';
    }

    // ===================== Cleanup =====================

    destroy() {
      for (const [, info] of this._pendingAcks) {
        if (info.timeout) clearTimeout(info.timeout);
      }
      this._pendingAcks.clear();
      this._dedupCache.clear();
      this._messageQueue.clear();
      this._deliveryStatus.clear();
      this.eventBus = null;
      this.logger = null;
      this.connectionManager = null;
      this.securityManager = null;
      this.offlineQueue = null;
    }
  }

  exports.MessageRouter = MessageRouter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
