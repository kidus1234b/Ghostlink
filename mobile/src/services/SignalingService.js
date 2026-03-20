/**
 * GhostLink Mobile — Signaling Service
 *
 * WebSocket connection to the GhostLink signaling server.
 * Provides auto-reconnect with exponential backoff, heartbeat keepalive,
 * message queueing when disconnected, and an event emitter interface
 * matching the web RTCPeerManager signaling layer.
 *
 * @module SignalingService
 */

// ─── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_SERVER_URL = 'ws://localhost:3001';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 25000;

// ─── Connection States ──────────────────────────────────────────────────────

export const ConnectionState = Object.freeze({
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
});

// ─── SignalingService ───────────────────────────────────────────────────────

class SignalingService {
  /**
   * @param {string} [serverUrl] WebSocket URL of the signaling server.
   */
  constructor(serverUrl = DEFAULT_SERVER_URL) {
    /** @private */ this._serverUrl = serverUrl;
    /** @private @type {WebSocket|null} */ this._ws = null;
    /** @private @type {Map<string, Set<Function>>} */ this._listeners = new Map();
    /** @private */ this._state = ConnectionState.DISCONNECTED;
    /** @private */ this._reconnectAttempt = 0;
    /** @private */ this._reconnectTimer = null;
    /** @private */ this._heartbeatTimer = null;
    /** @private */ this._closed = false;
    /** @private @type {Array<object>} */ this._queue = [];
    /** @private */ this._peerId = null;
  }

  // ── Getters ─────────────────────────────────────────────────────────────

  /** Current connection state. */
  get state() {
    return this._state;
  }

  /** Whether the socket is open and ready. */
  get isConnected() {
    return this._state === ConnectionState.CONNECTED;
  }

  // ── Event Emitter ───────────────────────────────────────────────────────

  /**
   * Register an event listener.
   * @param {string} event
   * @param {Function} callback
   * @returns {SignalingService} this (for chaining)
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return this;
  }

  /**
   * Remove an event listener.
   * @param {string} event
   * @param {Function} callback
   * @returns {SignalingService}
   */
  off(event, callback) {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(callback);
      if (set.size === 0) this._listeners.delete(event);
    }
    return this;
  }

  /**
   * Emit an event to all registered listeners.
   * @param {string} event
   * @param {...any} args
   */
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (set) {
      for (const fn of set) {
        try {
          fn(...args);
        } catch (err) {
          console.error(`[GhostLink:Signal] Handler error (${event}):`, err);
        }
      }
    }
  }

  // ── Connection Lifecycle ────────────────────────────────────────────────

  /**
   * Connect to the signaling server.
   * Resolves once the WebSocket is open, or rejects on failure.
   *
   * @param {string} [peerId] Unique identifier for this device/peer.
   * @returns {Promise<void>}
   */
  connect(peerId) {
    if (peerId) this._peerId = peerId;
    this._closed = false;

    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    this._setState(ConnectionState.CONNECTING);

    return new Promise((resolve, reject) => {
      try {
        this._ws = new WebSocket(this._serverUrl);
      } catch (err) {
        this._setState(ConnectionState.ERROR);
        reject(err);
        return;
      }

      this._ws.onopen = () => {
        this._reconnectAttempt = 0;
        this._setState(ConnectionState.CONNECTED);
        this._startHeartbeat();

        // Announce identity to server
        if (this._peerId) {
          this._sendImmediate({ type: 'join', peerId: this._peerId });
        }

        // Flush queued messages
        this._flushQueue();

        this.emit('connected');
        resolve();
      };

      this._ws.onmessage = (event) => {
        this._handleMessage(event);
      };

      this._ws.onclose = (event) => {
        this._stopHeartbeat();
        this._setState(ConnectionState.DISCONNECTED);
        this.emit('disconnected', { code: event.code, reason: event.reason });

        if (!this._closed) {
          this._scheduleReconnect();
        }
      };

      this._ws.onerror = (err) => {
        console.error('[GhostLink:Signal] WebSocket error:', err.message || err);
        this._setState(ConnectionState.ERROR);
        this.emit('error', err);
        reject(err);
      };
    });
  }

  /**
   * Disconnect from the signaling server and stop reconnecting.
   */
  disconnect() {
    this._closed = true;
    this._stopHeartbeat();
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;

    if (this._ws) {
      try {
        this._ws.close(1000, 'client disconnect');
      } catch (_) {
        /* ignore */
      }
      this._ws = null;
    }

    this._setState(ConnectionState.DISCONNECTED);
    this.emit('disconnected', { code: 1000, reason: 'client disconnect' });
  }

  // ── Sending Messages ───────────────────────────────────────────────────

  /**
   * Send a JSON message to the signaling server.
   * If disconnected the message is queued and flushed on reconnect.
   *
   * @param {object} msg Plain object to serialize as JSON.
   */
  send(msg) {
    if (this.isConnected) {
      this._sendImmediate(msg);
    } else {
      this._queue.push(msg);
    }
  }

  /**
   * Join a room (invite code).
   * @param {string} room
   * @param {string} [publicKey] JWK-exported ECDH public key.
   */
  joinRoom(room, publicKey) {
    this.send({
      type: 'join-room',
      room,
      peerId: this._peerId,
      ...(publicKey ? { publicKey } : {}),
    });
  }

  /**
   * Leave a room.
   * @param {string} room
   */
  leaveRoom(room) {
    this.send({
      type: 'leave-room',
      room,
      peerId: this._peerId,
    });
  }

  /**
   * Send an SDP offer to a specific peer.
   * @param {string} targetPeerId
   * @param {object} offer RTCSessionDescription.
   */
  sendOffer(targetPeerId, offer) {
    this.send({
      type: 'offer',
      to: targetPeerId,
      from: this._peerId,
      offer,
    });
  }

  /**
   * Send an SDP answer to a specific peer.
   * @param {string} targetPeerId
   * @param {object} answer RTCSessionDescription.
   */
  sendAnswer(targetPeerId, answer) {
    this.send({
      type: 'answer',
      to: targetPeerId,
      from: this._peerId,
      answer,
    });
  }

  /**
   * Send an ICE candidate to a specific peer.
   * @param {string} targetPeerId
   * @param {object} candidate RTCIceCandidate.
   */
  sendIceCandidate(targetPeerId, candidate) {
    this.send({
      type: 'ice-candidate',
      to: targetPeerId,
      from: this._peerId,
      candidate,
    });
  }

  /**
   * Relay an arbitrary payload to a specific peer via the server.
   * @param {string} targetPeerId
   * @param {object} payload
   */
  relay(targetPeerId, payload) {
    this.send({
      type: 'relay',
      to: targetPeerId,
      from: this._peerId,
      payload,
    });
  }

  // ── Private Helpers ────────────────────────────────────────────────────

  /**
   * Send a message directly (no queueing).
   * @private
   * @param {object} msg
   */
  _sendImmediate(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Flush queued messages in order.
   * @private
   */
  _flushQueue() {
    while (this._queue.length > 0) {
      const msg = this._queue.shift();
      this._sendImmediate(msg);
    }
  }

  /**
   * Handle an incoming WebSocket message.
   * @private
   * @param {MessageEvent} event
   */
  _handleMessage(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      console.warn('[GhostLink:Signal] Invalid JSON received:', event.data);
      return;
    }

    // Emit a generic 'message' event and a type-specific event
    this.emit('message', data);

    if (data.type) {
      this.emit(data.type, data);
    }
  }

  /**
   * Update connection state and emit a state-change event.
   * @private
   * @param {string} newState
   */
  _setState(newState) {
    if (this._state === newState) return;
    const previousState = this._state;
    this._state = newState;
    this.emit('state-change', { state: newState, previousState });
  }

  /**
   * Schedule an automatic reconnect with exponential backoff.
   * Delays: 1s, 2s, 4s, 8s, 16s, capped at 30s.
   * @private
   */
  _scheduleReconnect() {
    if (this._closed) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt),
      RECONNECT_MAX_MS,
    );
    this._reconnectAttempt++;

    console.log(
      `[GhostLink:Signal] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})`,
    );

    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        console.error('[GhostLink:Signal] Reconnect failed:', err);
      });
    }, delay);
  }

  /**
   * Start a heartbeat ping every 25 seconds to keep the connection alive.
   * @private
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this.isConnected) {
        this._sendImmediate({ type: 'ping', ts: Date.now() });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop the heartbeat timer.
   * @private
   */
  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Remove all listeners and clean up.
   */
  destroy() {
    this.disconnect();
    this._listeners.clear();
    this._queue = [];
  }
}

export default SignalingService;
