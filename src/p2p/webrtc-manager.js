/**
 * GhostLink WebRTC P2P Connection Manager
 *
 * Manages peer-to-peer connections via WebRTC with encrypted data channels,
 * signaling server coordination, NAT traversal (STUN/TURN), and automatic
 * reconnection with exponential backoff.
 *
 * @module webrtc-manager
 */

// ─── ICE Configuration ───────────────────────────────────────────────────────

const DEFAULT_ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'all',
};

// ─── Constants ───────────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const ICE_TIMEOUT_MS = 10000;
const DATA_CHANNEL_CONFIG = {
  messages: { ordered: true, negotiated: true, id: 0 },
  files:    { ordered: true, negotiated: true, id: 1 },
  presence: { ordered: false, maxRetransmits: 0, negotiated: true, id: 2 },
};

// ─── Simple EventEmitter ─────────────────────────────────────────────────────

class EventEmitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Register an event listener.
   * @param {string} event
   * @param {Function} callback
   */
  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(callback);
  }

  /**
   * Remove an event listener.
   * @param {string} event
   * @param {Function} callback
   */
  off(event, callback) {
    const set = this._listeners.get(event);
    if (set) set.delete(callback);
  }

  /**
   * Emit an event to all registered listeners.
   * @param {string} event
   * @param  {...any} args
   */
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (set) {
      for (const fn of set) {
        try { fn(...args); } catch (e) { console.error(`[GhostLink] Event handler error (${event}):`, e); }
      }
    }
  }
}

// ─── Peer Connection Wrapper ─────────────────────────────────────────────────

/**
 * Encapsulates a single RTCPeerConnection and its data channels.
 * @private
 */
class PeerSession {
  /**
   * @param {string} peerId
   * @param {RTCPeerConnection} pc
   */
  constructor(peerId, pc) {
    /** @type {string} */
    this.peerId = peerId;
    /** @type {RTCPeerConnection} */
    this.pc = pc;
    /** @type {Map<string, RTCDataChannel>} */
    this.channels = new Map();
    /** @type {CryptoKey|null} Shared AES key derived via ECDH */
    this.sharedKey = null;
    /** @type {CryptoKey|null} Peer's public ECDH key */
    this.peerPublicKey = null;
    /** @type {string} */
    this.state = 'new';
  }

  /** Close the peer connection and all data channels. */
  close() {
    for (const ch of this.channels.values()) {
      try { ch.close(); } catch (_) { /* ignore */ }
    }
    this.channels.clear();
    try { this.pc.close(); } catch (_) { /* ignore */ }
    this.state = 'closed';
  }
}

// ─── RTCPeerManager ──────────────────────────────────────────────────────────

/**
 * Comprehensive WebRTC connection manager for GhostLink.
 *
 * Handles signaling, ICE negotiation, data channel creation, encryption of
 * all data-channel payloads, TURN credential fetching, and automatic reconnection.
 *
 * @example
 * const mgr = new RTCPeerManager('wss://signal.ghostlink.io', identity);
 * await mgr.connect();
 * await mgr.joinRoom('abc123');
 * mgr.on('message', (peerId, msg) => console.log(msg));
 * await mgr.sendMessage(peerId, { text: 'hello' });
 */
class RTCPeerManager extends EventEmitter {
  /**
   * @param {string} signalingUrl  WebSocket URL of the signaling server.
   * @param {{ publicKey: CryptoKey, privateKey: CryptoKey, peerId: string }} identity
   *   ECDH P-256 key pair and a unique peer identifier.
   * @param {object} [options]
   * @param {object} [options.iceConfig]       Override default ICE configuration.
   * @param {string} [options.turnCredentialUrl] URL to fetch TURN credentials.
   */
  constructor(signalingUrl, identity, options = {}) {
    super();
    /** @private */ this._signalingUrl = signalingUrl;
    /** @private */ this._identity = identity;
    // Normalize: accept both peerId and id
    if (!this._identity.peerId && this._identity.id) this._identity.peerId = this._identity.id;
    /** @private */ this._options = options;
    /** @private */ this._iceConfig = { ...DEFAULT_ICE_CONFIG, ...(options.iceConfig || {}) };
    /** @private @type {WebSocket|null} */ this._ws = null;
    /** @private @type {Map<string, PeerSession>} */ this._peers = new Map();
    /** @private */ this._currentRoom = null;
    /** @private */ this._reconnectAttempt = 0;
    /** @private */ this._reconnectTimer = null;
    /** @private */ this._closed = false;
    /** @private @type {Map<string, number>} */ this._iceTimers = new Map();
  }

  // ── Signaling ────────────────────────────────────────────────────────────

  /**
   * Connect to the signaling server via WebSocket.
   * Resolves once the connection is established.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return;
    return new Promise((resolve, reject) => {
      let settled = false;

      try {
        this._ws = new WebSocket(this._signalingUrl);
      } catch (e) {
        reject(e);
        return;
      }

      this._ws.onopen = () => {
        this._reconnectAttempt = 0;
        this.emit('signaling-connected');
        // Announce identity — server must reply with { type: 'joined' }
        this._send({ type: 'join', peerId: this._identity.peerId });
        // Resolve after sending join — server will ack via 'joined' message
        if (!settled) { settled = true; resolve(); }
      };

      this._ws.onmessage = (evt) => {
        try { this._handleSignal(JSON.parse(evt.data)); }
        catch (e) { console.error('[GhostLink] Signal parse error:', e); }
      };

      this._ws.onclose = () => {
        this.emit('signaling-disconnected');
        // Only reject if we haven't resolved yet (onerror may have already fired)
        if (!settled) { settled = true; reject(new Error('WebSocket closed before connect')); }
        if (!this._closed) this._scheduleReconnect();
      };

      this._ws.onerror = (err) => {
        console.error('[GhostLink] Signaling error:', err);
        // Only reject once (onerror fires before onclose)
        if (!settled) { settled = true; reject(err); }
      };
    });
  }

  /**
   * Send a JSON payload to the signaling server.
   * @private
   * @param {object} msg
   */
  _send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    } else {
      console.warn('[GhostLink] Cannot send — WebSocket not open:', msg.type);
    }
  }

  /**
   * Schedule a reconnect with exponential backoff.
   * @private
   */
  _scheduleReconnect() {
    if (this._closed) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt), RECONNECT_MAX_MS);
    this._reconnectAttempt++;
    console.log(`[GhostLink] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})`);
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.connect().catch((e) => console.error('[GhostLink] Reconnect failed:', e));
    }, delay);
  }

  // ── Room Management ──────────────────────────────────────────────────────

  /**
   * Join a room identified by an invite code.
   * The signaling server will reply with the current peer list.
   * @param {string} inviteCode
   * @returns {Promise<void>}
   */
  async joinRoom(inviteCode) {
    // If WebSocket isn't open, try to connect first
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      try {
        await this.connect();
      } catch (e) {
        throw new Error('Cannot join room — signaling server unreachable');
      }
    }
    this._currentRoom = inviteCode;
    let pubKey = '';
    try { pubKey = await this._exportPublicKey(); } catch (e) {
      pubKey = this._identity.publicKeyHex || this._identity.publicKey || '';
    }
    this._send({
      type: 'join-room',
      room: inviteCode,
      peerId: this._identity.peerId,
      publicKey: pubKey,
    });
  }

  /**
   * Leave the current room and disconnect from all peers.
   * @returns {Promise<void>}
   */
  async leaveRoom() {
    if (!this._currentRoom) return;
    this._send({ type: 'leave-room', room: this._currentRoom, peerId: this._identity.peerId });
    for (const [id] of this._peers) {
      await this.disconnectPeer(id);
    }
    this._currentRoom = null;
  }

  // ── Peer Connection Lifecycle ────────────────────────────────────────────

  /**
   * Create an RTCPeerConnection to a specific peer and open data channels.
   * Generates an SDP offer and sends it via the signaling server.
   *
   * @param {string} peerId
   * @param {string} peerPublicKeyRaw  JWK-exported ECDH public key of the peer.
   * @returns {Promise<void>}
   */
  async connectToPeer(peerId, peerPublicKeyRaw) {
    if (this._peers.has(peerId)) return;

    const pc = new RTCPeerConnection(this._iceConfig);
    const session = new PeerSession(peerId, pc);
    this._peers.set(peerId, session);

    // Derive shared encryption key via ECDH — abort if it fails
    try {
      await this._deriveSharedKey(session, peerPublicKeyRaw);
    } catch (e) {
      console.error(`[GhostLink] Cannot connect to ${peerId}: ${e.message}`);
      session.close();
      this._peers.delete(peerId);
      return;
    }

    // Create data channels
    this._createDataChannels(session);

    // ICE candidate handling
    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        this._send({
          type: 'ice-candidate',
          to: peerId,
          from: this._identity.peerId,
          candidate: evt.candidate,
        });
      }
    };

    // ICE connection state monitoring
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      session.state = state;
      this.emit('connection-state-change', peerId, state);

      if (state === 'connected' || state === 'completed') {
        this._clearIceTimer(peerId);
        this.emit('peer-connected', peerId);
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this._clearIceTimer(peerId);
        if (state === 'failed') {
          this._handleIceFailure(peerId, peerPublicKeyRaw);
        } else if (state === 'disconnected' || state === 'closed') {
          this.emit('peer-disconnected', peerId);
        }
      }
    };

    // Remote stream handling (for voice/video)
    pc.ontrack = (evt) => {
      this.emit('stream-added', peerId, evt.streams[0]);
    };

    // Create and send SDP offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    let pubKey = '';
    try { pubKey = await this._exportPublicKey(); } catch (e) {
      pubKey = this._identity.publicKeyHex || this._identity.publicKey || '';
    }
    this._send({
      type: 'offer',
      to: peerId,
      from: this._identity.peerId,
      sdp: pc.localDescription,
      publicKey: pubKey,
    });

    // Start ICE timeout — if no connection within 10s, try TURN
    this._startIceTimer(peerId, peerPublicKeyRaw);
  }

  /**
   * Disconnect from a specific peer.
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  async disconnectPeer(peerId) {
    const session = this._peers.get(peerId);
    if (!session) return;
    session.close();
    this._peers.delete(peerId);
    this._clearIceTimer(peerId);
    this.emit('peer-disconnected', peerId);
  }

  // ── Data Channels ───────────────────────────────────────────────────────

  /**
   * Create the standard set of data channels on a peer session.
   * @private
   * @param {PeerSession} session
   */
  _createDataChannels(session) {
    for (const [name, config] of Object.entries(DATA_CHANNEL_CONFIG)) {
      const ch = session.pc.createDataChannel(name, config);
      this._setupChannelEvents(session, name, ch);
      session.channels.set(name, ch);
    }
  }

  /**
   * Wire up data channel events.
   * @private
   * @param {PeerSession} session
   * @param {string} name
   * @param {RTCDataChannel} ch
   */
  _setupChannelEvents(session, name, ch) {
    ch.onopen = () => {
      console.log(`[GhostLink] Data channel "${name}" open with ${session.peerId}`);
    };

    ch.onclose = () => {
      console.log(`[GhostLink] Data channel "${name}" closed with ${session.peerId}`);
    };

    ch.onerror = (err) => {
      console.error(`[GhostLink] Data channel "${name}" error with ${session.peerId}:`, err);
    };

    ch.onmessage = async (evt) => {
      try {
        const decrypted = await this._decryptPayload(session, evt.data);
        const parsed = JSON.parse(decrypted);
        this._routeChannelMessage(session.peerId, name, parsed);
      } catch (e) {
        console.error(`[GhostLink] Failed to process message on "${name}" from ${session.peerId}:`, e);
      }
    };
  }

  /**
   * Route an incoming data-channel message to the appropriate event.
   * @private
   * @param {string} peerId
   * @param {string} channelName
   * @param {object} data
   */
  _routeChannelMessage(peerId, channelName, data) {
    switch (channelName) {
      case 'messages':
        if (data.type === 'call-offer') {
          this.emit('call-offer', peerId, data);
        } else if (data.type === 'call-answer') {
          this.emit('call-answer', peerId, data);
        } else {
          this.emit('message', peerId, data);
        }
        break;
      case 'files':
        if (data.type === 'file-meta' || data.type === 'file-ack' || data.type === 'file-reject') {
          this.emit('file-chunk', peerId, data);
        } else if (data.type === 'file-chunk') {
          this.emit('file-chunk', peerId, data);
        } else if (data.type === 'file-done') {
          this.emit('file-complete', peerId, data);
        }
        break;
      case 'presence':
        this.emit('message', peerId, { ...data, _channel: 'presence' });
        break;
    }
  }

  // ── Messaging ───────────────────────────────────────────────────────────

  /**
   * Send an encrypted message to a specific peer over the messages data channel.
   * @param {string} peerId
   * @param {object} message  Plain object to send.
   * @returns {Promise<void>}
   */
  async sendMessage(peerId, message) {
    await this._sendOnChannel(peerId, 'messages', message);
  }

  /**
   * Broadcast an encrypted message to all connected peers.
   * @param {object} message  Plain object to send.
   * @returns {Promise<void>}
   */
  async broadcast(message) {
    const promises = [];
    for (const [peerId, session] of this._peers) {
      if (session.state === 'connected' || session.state === 'completed') {
        promises.push(this.sendMessage(peerId, message));
      }
    }
    await Promise.allSettled(promises);
  }

  /**
   * Send data on a specific data channel (encrypted).
   * @param {string} peerId
   * @param {string} channelName
   * @param {object} data
   * @returns {Promise<void>}
   */
  async sendOnChannel(peerId, channelName, data) {
    await this._sendOnChannel(peerId, channelName, data);
  }

  /**
   * Internal: encrypt and send on a named channel.
   * @private
   * @param {string} peerId
   * @param {string} channelName
   * @param {object} data
   * @returns {Promise<void>}
   */
  async _sendOnChannel(peerId, channelName, data) {
    const session = this._peers.get(peerId);
    if (!session) throw new Error(`No peer session for ${peerId}`);

    const ch = session.channels.get(channelName);
    if (!ch || ch.readyState !== 'open') {
      throw new Error(`Data channel "${channelName}" is not open for ${peerId}`);
    }

    const payload = JSON.stringify(data);
    const encrypted = await this._encryptPayload(session, payload);
    ch.send(encrypted);
  }

  // ── Connection State ────────────────────────────────────────────────────

  /**
   * Get the ICE connection state for a peer.
   * @param {string} peerId
   * @returns {string|null}
   */
  getConnectionState(peerId) {
    const session = this._peers.get(peerId);
    return session ? session.state : null;
  }

  /**
   * Get an array of all connected peer IDs.
   * @returns {string[]}
   */
  getConnectedPeers() {
    const result = [];
    for (const [peerId, session] of this._peers) {
      if (session.state === 'connected' || session.state === 'completed') {
        result.push(peerId);
      }
    }
    return result;
  }

  /**
   * Get the underlying RTCPeerConnection for a peer (used by MediaHandler).
   * @param {string} peerId
   * @returns {RTCPeerConnection|null}
   */
  getPeerConnection(peerId) {
    const session = this._peers.get(peerId);
    return session ? session.pc : null;
  }

  // ── Signaling Message Handler ───────────────────────────────────────────

  /**
   * Handle an incoming signaling message from the WebSocket.
   * @private
   * @param {object} msg
   */
  async _handleSignal(msg) {
    try {
      switch (msg.type) {
        case 'peer-list': {
          // Server sends the list of peers in the room
          for (const peer of msg.peers) {
            if (peer.peerId !== this._identity.peerId) {
              await this.connectToPeer(peer.peerId, peer.publicKey);
            }
          }
          break;
        }

        case 'peer-joined': {
          // A new peer joined the room — they will initiate the offer
          console.log(`[GhostLink] Peer joined: ${msg.peerId}`);
          break;
        }

        case 'offer': {
          await this._handleOffer(msg);
          break;
        }

        case 'answer': {
          await this._handleAnswer(msg);
          break;
        }

        case 'ice-candidate': {
          await this._handleIceCandidate(msg);
          break;
        }

        case 'turn-credentials': {
          this._applyTurnCredentials(msg.credentials);
          break;
        }

        case 'relay': {
          // Fallback: message relayed through signaling server (still encrypted)
          const session = this._peers.get(msg.from);
          if (session) {
            const decrypted = await this._decryptPayload(session, msg.payload);
            const parsed = JSON.parse(decrypted);
            this.emit('message', msg.from, parsed);
          }
          break;
        }

        default:
          console.warn(`[GhostLink] Unknown signal type: ${msg.type}`);
      }
    } catch (e) {
      console.error('[GhostLink] Signal handling error:', e);
    }
  }

  /**
   * Handle an incoming SDP offer.
   * @private
   * @param {object} msg
   */
  async _handleOffer(msg) {
    const { from, sdp, publicKey } = msg;

    let session = this._peers.get(from);
    if (!session) {
      const pc = new RTCPeerConnection(this._iceConfig);
      session = new PeerSession(from, pc);
      this._peers.set(from, session);

      // Derive shared encryption key via ECDH — abort if it fails
      try {
        await this._deriveSharedKey(session, publicKey);
      } catch (e) {
        console.error(`[GhostLink] Cannot accept offer from ${from}: ${e.message}`);
        session.close();
        this._peers.delete(from);
        return;
      }

      // Create matching data channels (negotiated)
      this._createDataChannels(session);

      pc.onicecandidate = (evt) => {
        if (evt.candidate) {
          this._send({
            type: 'ice-candidate',
            to: from,
            from: this._identity.peerId,
            candidate: evt.candidate,
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        session.state = state;
        this.emit('connection-state-change', from, state);

        if (state === 'connected' || state === 'completed') {
          this.emit('peer-connected', from);
        } else if (state === 'disconnected' || state === 'closed') {
          this.emit('peer-disconnected', from);
        } else if (state === 'failed') {
          this._handleIceFailure(from, publicKey);
        }
      };

      pc.ontrack = (evt) => {
        this.emit('stream-added', from, evt.streams[0]);
      };
    }

    await session.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await session.pc.createAnswer();
    await session.pc.setLocalDescription(answer);

    let pubKey = '';
    try { pubKey = await this._exportPublicKey(); } catch (e) {
      pubKey = this._identity.publicKeyHex || this._identity.publicKey || '';
    }
    this._send({
      type: 'answer',
      to: from,
      from: this._identity.peerId,
      sdp: session.pc.localDescription,
      publicKey: pubKey,
    });
  }

  /**
   * Handle an incoming SDP answer.
   * @private
   * @param {object} msg
   */
  async _handleAnswer(msg) {
    const session = this._peers.get(msg.from);
    if (!session) return;
    await session.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  }

  /**
   * Handle an incoming ICE candidate.
   * @private
   * @param {object} msg
   */
  async _handleIceCandidate(msg) {
    const session = this._peers.get(msg.from);
    if (!session) return;
    try {
      await session.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (e) {
      console.warn('[GhostLink] Failed to add ICE candidate:', e);
    }
  }

  // ── NAT Traversal / TURN ───────────────────────────────────────────────

  /**
   * Start an ICE timeout timer. If the peer doesn't connect within 10s,
   * attempt TURN-based renegotiation.
   * @private
   * @param {string} peerId
   * @param {string} peerPublicKeyRaw
   */
  _startIceTimer(peerId, peerPublicKeyRaw) {
    this._clearIceTimer(peerId);
    const timer = setTimeout(() => {
      const session = this._peers.get(peerId);
      if (session && session.state !== 'connected' && session.state !== 'completed') {
        console.log(`[GhostLink] ICE timeout for ${peerId}, attempting TURN fallback`);
        this._handleIceFailure(peerId, peerPublicKeyRaw);
      }
    }, ICE_TIMEOUT_MS);
    this._iceTimers.set(peerId, timer);
  }

  /**
   * Clear an ICE timeout timer.
   * @private
   * @param {string} peerId
   */
  _clearIceTimer(peerId) {
    const timer = this._iceTimers.get(peerId);
    if (timer) {
      clearTimeout(timer);
      this._iceTimers.delete(peerId);
    }
  }

  /**
   * Handle ICE failure: fetch TURN credentials and renegotiate, or fall
   * back to signaling server relay.
   * @private
   * @param {string} peerId
   * @param {string} peerPublicKeyRaw
   */
  async _handleIceFailure(peerId, peerPublicKeyRaw) {
    const turnUrl = this._options.turnCredentialUrl;
    if (turnUrl) {
      try {
        console.log(`[GhostLink] Fetching TURN credentials from ${turnUrl}`);
        const resp = await fetch(turnUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ peerId: this._identity.peerId }),
        });
        const creds = await resp.json();

        // Disconnect the old session and retry with TURN
        await this.disconnectPeer(peerId);

        // Add TURN servers to config
        const turnConfig = {
          ...this._iceConfig,
          iceServers: [
            ...this._iceConfig.iceServers,
            {
              urls: creds.urls,
              username: creds.username,
              credential: creds.credential,
            },
          ],
        };

        // Temporarily override config and reconnect
        const originalConfig = this._iceConfig;
        this._iceConfig = turnConfig;
        await this.connectToPeer(peerId, peerPublicKeyRaw);
        this._iceConfig = originalConfig;

        return;
      } catch (e) {
        console.error('[GhostLink] TURN credential fetch failed:', e);
      }
    }

    // Final fallback: relay through signaling server
    console.log(`[GhostLink] Falling back to signaling relay for ${peerId}`);
    const session = this._peers.get(peerId);
    if (session) {
      session.state = 'relay';
      this.emit('connection-state-change', peerId, 'relay');
    }
  }

  /**
   * Apply TURN credentials received from the signaling server.
   * @private
   * @param {object} credentials
   */
  _applyTurnCredentials(credentials) {
    this._iceConfig = {
      ...this._iceConfig,
      iceServers: [
        ...this._iceConfig.iceServers,
        {
          urls: credentials.urls,
          username: credentials.username,
          credential: credentials.credential,
        },
      ],
    };
  }

  // ── Encryption ──────────────────────────────────────────────────────────

  /**
   * Derive a shared AES-256-GCM key from the local ECDH private key and
   * the peer's ECDH public key.
   * @private
   * @param {PeerSession} session
   * @param {string} peerPublicKeyRaw  JWK JSON string of the peer's public key.
   */
  async _deriveSharedKey(session, peerPublicKeyRaw) {
    // Require a valid private key for ECDH — refuse to fall back to insecure key derivation.
    // Deriving keys from peer IDs would be deterministic from public info and provide zero security.
    const privKey = this._identity.privateKey
      || (this._identity.keyPair && this._identity.keyPair.privateKey);
    if (!privKey) {
      const errMsg = 'No private key available for ECDH key exchange — cannot establish secure channel';
      console.error('[GhostLink]', errMsg);
      this.emit('security-error', session.peerId, errMsg);
      throw new Error(errMsg);
    }

    // Require a valid peer public key — refuse to establish an insecure connection.
    if (!peerPublicKeyRaw) {
      const errMsg = 'No peer public key provided — cannot establish secure channel';
      console.error('[GhostLink]', errMsg);
      this.emit('security-error', session.peerId, errMsg);
      throw new Error(errMsg);
    }

    let peerJwk;
    try {
      peerJwk = typeof peerPublicKeyRaw === 'string'
        ? JSON.parse(peerPublicKeyRaw)
        : peerPublicKeyRaw;
    } catch (e) {
      const errMsg = `Could not parse peer public key as JWK: ${e.message}`;
      console.error('[GhostLink]', errMsg);
      this.emit('security-error', session.peerId, errMsg);
      throw new Error(errMsg);
    }

    const peerKey = await crypto.subtle.importKey(
      'jwk', peerJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    session.peerPublicKey = peerKey;

    // Use deriveKey (not deriveBits) to match the key usages from CryptoEngine.generateKeyPair(),
    // which generates ECDH keys with ['deriveKey'] only.
    session.sharedKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerKey },
      privKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt a string payload with the peer's shared AES-256-GCM key.
   * Returns a base64-encoded JSON string containing { iv, data }.
   * @private
   * @param {PeerSession} session
   * @param {string} plaintext
   * @returns {Promise<string>}
   */
  async _encryptPayload(session, plaintext) {
    if (!session.sharedKey) throw new Error('No shared key for encryption');

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      session.sharedKey,
      encoded
    );

    return JSON.stringify({
      iv: this._arrayToBase64(iv),
      data: this._arrayToBase64(new Uint8Array(ciphertext)),
    });
  }

  /**
   * Decrypt a base64 JSON payload { iv, data } with the shared key.
   * @private
   * @param {PeerSession} session
   * @param {string} encryptedStr
   * @returns {Promise<string>}
   */
  async _decryptPayload(session, encryptedStr) {
    if (!session.sharedKey) throw new Error('No shared key for decryption');

    const { iv, data } = JSON.parse(encryptedStr);
    const ivBytes = this._base64ToArray(iv);
    const ciphertextBytes = this._base64ToArray(data);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes },
      session.sharedKey,
      ciphertextBytes
    );

    return new TextDecoder().decode(decrypted);
  }

  /**
   * Export the local ECDH public key as a JWK JSON string.
   * @private
   * @returns {Promise<string>}
   */
  async _exportPublicKey() {
    // Handle both CryptoKey objects and hex/string public keys
    const pk = this._identity.publicKey;
    if (pk && typeof pk === 'object' && pk.type) {
      // It's a real CryptoKey — export as JWK
      const jwk = await crypto.subtle.exportKey('jwk', pk);
      return JSON.stringify(jwk);
    }
    // Fallback: return the hex string or publicKeyHex directly
    return this._identity.publicKeyHex || pk || '';
  }

  // ── Relay Fallback ──────────────────────────────────────────────────────

  /**
   * Send a message via the signaling server relay (fallback when P2P fails).
   * The payload is still encrypted end-to-end.
   * @param {string} peerId
   * @param {object} message
   * @returns {Promise<void>}
   */
  async sendViaRelay(peerId, message) {
    const session = this._peers.get(peerId);
    if (!session) throw new Error(`No peer session for ${peerId}`);

    const payload = await this._encryptPayload(session, JSON.stringify(message));
    this._send({
      type: 'relay',
      to: peerId,
      from: this._identity.peerId,
      payload,
    });
  }

  // ── Media Helpers (used by MediaHandler) ────────────────────────────────

  /**
   * Add a media track to a peer connection and renegotiate.
   * @param {string} peerId
   * @param {MediaStreamTrack} track
   * @param {MediaStream} stream
   * @returns {Promise<RTCRtpSender>}
   */
  async addTrack(peerId, track, stream) {
    const session = this._peers.get(peerId);
    if (!session) throw new Error(`No peer session for ${peerId}`);

    const sender = session.pc.addTrack(track, stream);

    // Renegotiate
    const offer = await session.pc.createOffer();
    await session.pc.setLocalDescription(offer);
    this._send({
      type: 'offer',
      to: peerId,
      from: this._identity.peerId,
      sdp: session.pc.localDescription,
      publicKey: await this._exportPublicKey(),
    });

    return sender;
  }

  /**
   * Remove a media track sender from a peer connection and renegotiate.
   * @param {string} peerId
   * @param {RTCRtpSender} sender
   * @returns {Promise<void>}
   */
  async removeTrack(peerId, sender) {
    const session = this._peers.get(peerId);
    if (!session) return;

    session.pc.removeTrack(sender);

    const offer = await session.pc.createOffer();
    await session.pc.setLocalDescription(offer);
    this._send({
      type: 'offer',
      to: peerId,
      from: this._identity.peerId,
      sdp: session.pc.localDescription,
      publicKey: await this._exportPublicKey(),
    });
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  /**
   * Completely shut down the manager: disconnect all peers, close signaling.
   */
  destroy() {
    this._closed = true;
    clearTimeout(this._reconnectTimer);

    for (const [peerId] of this._peers) {
      this.disconnectPeer(peerId);
    }
    this._peers.clear();

    for (const timer of this._iceTimers.values()) clearTimeout(timer);
    this._iceTimers.clear();

    if (this._ws) {
      this._ws.onclose = null; // prevent reconnect
      this._ws.close();
      this._ws = null;
    }
  }

  // ── Utility ─────────────────────────────────────────────────────────────

  /**
   * Convert a Uint8Array to a base64 string.
   * @private
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  _arrayToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  /**
   * Convert a base64 string to a Uint8Array.
   * @private
   * @param {string} b64
   * @returns {Uint8Array}
   */
  _base64ToArray(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
}

window.RTCPeerManager = RTCPeerManager;
window.EventEmitter = EventEmitter;
