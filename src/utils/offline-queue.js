/**
 * GhostLink Offline Message Queue
 * Persistent offline message queuing with peer relay support.
 * Browser ES module — no external dependencies.
 */

const DB_NAME = 'ghostlink-offline-queue';
const DB_VERSION = 1;
const STORE_MESSAGES = 'messages';
const STORE_RELAY = 'relay';
const DEFAULT_TTL = 86400000; // 24 hours

// ─── Helpers ───────────────────────────────────────────────────────────

function generateId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function now() {
  return Date.now();
}

// ─── IndexedDB wrapper ─────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const msgStore = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
        msgStore.createIndex('peerId', 'to', { unique: false });
        msgStore.createIndex('timestamp', 'timestamp', { unique: false });
        msgStore.createIndex('delivered', 'delivered', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_RELAY)) {
        const relayStore = db.createObjectStore(STORE_RELAY, { keyPath: 'id' });
        relayStore.createIndex('targetPeerId', 'targetPeerId', { unique: false });
        relayStore.createIndex('fromPeerId', 'fromPeerId', { unique: false });
        relayStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbTransaction(db, storeNames, mode) {
  const tx = db.transaction(storeNames, mode);
  const stores = Array.isArray(storeNames)
    ? storeNames.reduce((acc, n) => { acc[n] = tx.objectStore(n); return acc; }, {})
    : { [storeNames]: tx.objectStore(storeNames) };
  return { tx, stores };
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(index, query) {
  return new Promise((resolve, reject) => {
    const req = index.getAll(query);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── OfflineQueue ──────────────────────────────────────────────────────

class OfflineQueue {
  /**
   * @param {string} signalingUrl  WebSocket URL of the signaling server
   */
  constructor(signalingUrl) {
    this.signalingUrl = signalingUrl;
    this._db = null;
    this._listeners = {};
    this._pendingCounts = new Map(); // peerId → count (cache)
    this._ws = null;
    this._wsReady = false;
    this._wsQueue = [];
    this._initPromise = this._init();
  }

  // ── Initialization ───────────────────────────────────────────────────

  async _init() {
    this._db = await openDB();
    await this._rebuildPendingCounts();
    this._connectSignaling();
  }

  async _ready() {
    await this._initPromise;
  }

  async _rebuildPendingCounts() {
    this._pendingCounts.clear();
    const { stores } = dbTransaction(this._db, STORE_MESSAGES, 'readonly');
    const all = await idbGetAll(stores[STORE_MESSAGES].index('delivered'), IDBKeyRange.only(0));
    for (const msg of all) {
      this._pendingCounts.set(msg.to, (this._pendingCounts.get(msg.to) || 0) + 1);
    }
  }

  // ── Signaling WebSocket ──────────────────────────────────────────────

  _connectSignaling() {
    if (!this.signalingUrl) return;

    try {
      this._ws = new WebSocket(this.signalingUrl);
    } catch (_) {
      return; // signaling unavailable
    }

    this._ws.onopen = () => {
      this._wsReady = true;
      // flush queued signaling messages
      for (const msg of this._wsQueue) {
        this._ws.send(JSON.stringify(msg));
      }
      this._wsQueue = [];
    };

    this._ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'relay-delivery') {
          this._handleServerRelayDelivery(data.messages);
        }
      } catch (_) {
        // ignore malformed frames
      }
    };

    this._ws.onclose = () => {
      this._wsReady = false;
      // reconnect after 5s
      setTimeout(() => this._connectSignaling(), 5000);
    };

    this._ws.onerror = () => {
      this._wsReady = false;
    };
  }

  _sendSignaling(message) {
    if (this._wsReady && this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(message));
      return true;
    }
    this._wsQueue.push(message);
    return false;
  }

  // ── Queue a message ──────────────────────────────────────────────────

  /**
   * Queue an encrypted message for an offline peer.
   *
   * @param {string} peerId           Target peer identifier
   * @param {object} encryptedMessage { iv: hex, ciphertext: hex }
   * @returns {object} The queued message record
   */
  async queueMessage(peerId, encryptedMessage) {
    await this._ready();

    const record = {
      id: generateId(),
      to: peerId,
      from: this._getLocalPeerId(),
      encrypted: {
        iv: encryptedMessage.iv,
        ciphertext: encryptedMessage.ciphertext,
      },
      timestamp: now(),
      ttl: DEFAULT_TTL,
      attempts: 0,
      delivered: 0,   // 0 = pending, 1 = delivered
      createdAt: now(),
    };

    // Persist to IndexedDB
    const { stores } = dbTransaction(this._db, STORE_MESSAGES, 'readwrite');
    await idbRequest(stores[STORE_MESSAGES].put(record));

    // Update cached count
    this._pendingCounts.set(peerId, (this._pendingCounts.get(peerId) || 0) + 1);

    // Try signaling server relay
    this._sendSignaling({
      type: 'relay-store',
      to: peerId,
      message: {
        id: record.id,
        from: record.from,
        encrypted: record.encrypted,
        timestamp: record.timestamp,
        ttl: record.ttl,
      },
    });

    record.attempts += 1;
    const { stores: s2 } = dbTransaction(this._db, STORE_MESSAGES, 'readwrite');
    await idbRequest(s2[STORE_MESSAGES].put(record));

    this._emit('message-queued', { id: record.id, to: peerId });
    return record;
  }

  // ── Flush queue when peer comes online ───────────────────────────────

  /**
   * Send all queued messages to a peer that just came online.
   *
   * @param {string}          peerId      Target peer
   * @param {RTCDataChannel}  dataChannel Open data channel to the peer
   * @returns {number} Number of messages flushed
   */
  async flushQueue(peerId, dataChannel) {
    await this._ready();

    const { stores } = dbTransaction(this._db, STORE_MESSAGES, 'readonly');
    const pending = await idbGetAll(stores[STORE_MESSAGES].index('peerId'), IDBKeyRange.only(peerId));
    const toSend = pending.filter(m => m.delivered === 0);

    let flushed = 0;

    for (const msg of toSend) {
      if (dataChannel.readyState !== 'open') break;

      try {
        dataChannel.send(JSON.stringify({
          type: 'queued-message',
          id: msg.id,
          from: msg.from,
          encrypted: msg.encrypted,
          timestamp: msg.timestamp,
        }));

        // Mark delivered
        msg.delivered = 1;
        msg.deliveredAt = now();
        const { stores: ws } = dbTransaction(this._db, STORE_MESSAGES, 'readwrite');
        await idbRequest(ws[STORE_MESSAGES].put(msg));
        flushed++;
      } catch (_) {
        // channel closed mid-flush, stop
        break;
      }
    }

    // Update pending count
    const remaining = Math.max(0, (this._pendingCounts.get(peerId) || 0) - flushed);
    if (remaining === 0) {
      this._pendingCounts.delete(peerId);
    } else {
      this._pendingCounts.set(peerId, remaining);
    }

    // Clean up delivered messages
    await this._removeDelivered(peerId);

    this._emit('queue-flushed', { peerId, count: flushed });
    return flushed;
  }

  async _removeDelivered(peerId) {
    const { stores } = dbTransaction(this._db, STORE_MESSAGES, 'readwrite');
    const store = stores[STORE_MESSAGES];
    const all = await idbGetAll(store.index('peerId'), IDBKeyRange.only(peerId));
    for (const msg of all) {
      if (msg.delivered === 1) {
        store.delete(msg.id);
      }
    }
  }

  // ── Check server queue ───────────────────────────────────────────────

  /**
   * Fetch messages queued for us on the signaling server.
   *
   * @returns {Array<object>} Array of encrypted messages
   */
  async checkServerQueue() {
    await this._ready();

    const httpUrl = this.signalingUrl
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:');

    const peerId = this._getLocalPeerId();
    if (!peerId) return [];

    try {
      const resp = await fetch(`${httpUrl}/relay/queue/${peerId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!resp.ok) return [];

      const data = await resp.json();
      return Array.isArray(data.messages) ? data.messages : [];
    } catch (_) {
      return [];
    }
  }

  _handleServerRelayDelivery(messages) {
    if (!Array.isArray(messages)) return;
    for (const msg of messages) {
      this._emit('message-delivered', {
        id: msg.id,
        from: msg.from,
        encrypted: msg.encrypted,
        timestamp: msg.timestamp,
        source: 'server-relay',
      });
    }
  }

  // ── Peer relay ───────────────────────────────────────────────────────

  /**
   * Ask an online peer to relay a message to an offline peer.
   * The relay message is end-to-end encrypted — only the target can decrypt.
   *
   * @param {string} onlinePeerId     Peer currently connected to us
   * @param {string} targetPeerId     The offline peer we want to reach
   * @param {object} encryptedMessage { iv, ciphertext } encrypted for targetPeerId
   * @returns {object} The relay record
   */
  async relayThroughPeer(onlinePeerId, targetPeerId, encryptedMessage) {
    await this._ready();

    const relayRecord = {
      id: generateId(),
      fromPeerId: this._getLocalPeerId(),
      targetPeerId,
      relayPeerId: onlinePeerId,
      encrypted: {
        iv: encryptedMessage.iv,
        ciphertext: encryptedMessage.ciphertext,
      },
      timestamp: now(),
      ttl: DEFAULT_TTL,
      status: 'pending', // pending | relayed | delivered
    };

    // Store locally in case we need to retry
    const { stores } = dbTransaction(this._db, STORE_RELAY, 'readwrite');
    await idbRequest(stores[STORE_RELAY].put(relayRecord));

    this._emit('message-relayed', {
      id: relayRecord.id,
      target: targetPeerId,
      relay: onlinePeerId,
    });

    return relayRecord;
  }

  /**
   * Build the data-channel message to send to the relay peer.
   *
   * @param {object} relayRecord  Record from relayThroughPeer
   * @returns {string} JSON string to send over the data channel
   */
  buildRelayChannelMessage(relayRecord) {
    return JSON.stringify({
      type: 'peer-relay',
      id: relayRecord.id,
      from: relayRecord.fromPeerId,
      target: relayRecord.targetPeerId,
      encrypted: relayRecord.encrypted,
      timestamp: relayRecord.timestamp,
      ttl: relayRecord.ttl,
    });
  }

  // ── Handle incoming relay request ────────────────────────────────────

  /**
   * Process an incoming relay request from another peer asking us
   * to hold a message for delivery to a target peer.
   *
   * @param {string} fromPeerId   The peer who sent the relay request
   * @param {object} relayMessage Parsed relay message from the data channel
   */
  async handleRelayRequest(fromPeerId, relayMessage) {
    await this._ready();

    const record = {
      id: relayMessage.id || generateId(),
      fromPeerId,
      targetPeerId: relayMessage.target,
      encrypted: relayMessage.encrypted,
      timestamp: relayMessage.timestamp || now(),
      ttl: relayMessage.ttl || DEFAULT_TTL,
      receivedAt: now(),
      status: 'holding', // holding until target connects
    };

    const { stores } = dbTransaction(this._db, STORE_RELAY, 'readwrite');
    await idbRequest(stores[STORE_RELAY].put(record));

    // Also queue as a regular message so flushQueue picks it up
    await this._queueRelayedMessage(record);

    this._emit('message-queued', {
      id: record.id,
      to: record.targetPeerId,
      source: 'peer-relay',
      from: fromPeerId,
    });
  }

  async _queueRelayedMessage(relayRecord) {
    const record = {
      id: relayRecord.id,
      to: relayRecord.targetPeerId,
      from: relayRecord.fromPeerId,
      encrypted: relayRecord.encrypted,
      timestamp: relayRecord.timestamp,
      ttl: relayRecord.ttl,
      attempts: 0,
      delivered: 0,
      createdAt: now(),
      relayed: true,
    };

    const { stores } = dbTransaction(this._db, STORE_MESSAGES, 'readwrite');
    await idbRequest(stores[STORE_MESSAGES].put(record));

    this._pendingCounts.set(
      relayRecord.targetPeerId,
      (this._pendingCounts.get(relayRecord.targetPeerId) || 0) + 1
    );
  }

  // ── Pending counts ───────────────────────────────────────────────────

  /**
   * @param {string} peerId
   * @returns {number}
   */
  getPendingCount(peerId) {
    return this._pendingCounts.get(peerId) || 0;
  }

  /**
   * Get all pending (undelivered) messages.
   *
   * @returns {Array<object>}
   */
  async getAllPending() {
    await this._ready();

    const { stores } = dbTransaction(this._db, STORE_MESSAGES, 'readonly');
    const all = await idbGetAll(stores[STORE_MESSAGES].index('delivered'), IDBKeyRange.only(0));
    return all;
  }

  // ── Cleanup ──────────────────────────────────────────────────────────

  /**
   * Remove expired messages.
   *
   * @param {number} maxAge  Maximum age in milliseconds (default 24h)
   * @returns {number} Number of records removed
   */
  async cleanup(maxAge = DEFAULT_TTL) {
    await this._ready();

    const cutoff = now() - maxAge;
    let removed = 0;

    // Clean messages store
    {
      const { stores } = dbTransaction(this._db, STORE_MESSAGES, 'readwrite');
      const store = stores[STORE_MESSAGES];
      const all = await idbGetAll(store.index('timestamp'), IDBKeyRange.upperBound(cutoff));
      for (const msg of all) {
        store.delete(msg.id);
        removed++;
      }
    }

    // Clean relay store
    {
      const { stores } = dbTransaction(this._db, STORE_RELAY, 'readwrite');
      const store = stores[STORE_RELAY];
      const all = await idbGetAll(store.index('timestamp'), IDBKeyRange.upperBound(cutoff));
      for (const msg of all) {
        store.delete(msg.id);
        removed++;
      }
    }

    await this._rebuildPendingCounts();
    return removed;
  }

  // ── Events ───────────────────────────────────────────────────────────

  /**
   * @param {'message-queued'|'message-delivered'|'message-relayed'|'queue-flushed'} event
   * @param {function} callback
   */
  on(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  }

  off(event, callback) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(fn => fn !== callback);
  }

  _emit(event, data) {
    const cbs = this._listeners[event];
    if (!cbs) return;
    for (const cb of cbs) {
      try { cb(data); } catch (_) { /* listener error */ }
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  _getLocalPeerId() {
    // Attempt to read from well-known localStorage key used by GhostLink
    try {
      const identity = localStorage.getItem('ghostlink-identity');
      if (identity) {
        const parsed = JSON.parse(identity);
        return parsed.peerId || parsed.publicKeyHex || null;
      }
    } catch (_) { /* */ }
    return null;
  }

  /**
   * Destroy the queue instance — close DB and WebSocket.
   */
  destroy() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
    if (this._ws) {
      this._ws.onclose = null; // prevent reconnect
      this._ws.close();
      this._ws = null;
    }
  }
}

window.OfflineQueue = OfflineQueue;
