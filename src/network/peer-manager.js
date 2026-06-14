// peer-manager.js — Production peer lifecycle coordinator for GhostLink
(function(exports) {
  'use strict';

  const G = typeof globalThis !== 'undefined' ? globalThis : this;

  const SM = G && G.StateMachine ? G.StateMachine : null;
  const ConnectionManager = G && G.ConnectionManager ? G.ConnectionManager : null;
  const SignalManager = G && G.SignalManager ? G.SignalManager : null;
  const RelayManager = G && G.RelayManager ? G.RelayManager : null;
  const KeyManager = G && G.KeyManager ? G.KeyManager : null;
  const MessageRouter = G && G.MessageRouter ? G.MessageRouter : null;
  const FileTransferManager = G && G.FileTransferManager ? G.FileTransferManager : null;
  const PresenceManager = G && G.PresenceManager ? G.PresenceManager : null;

  const STATE_TRANSITIONS = {
    idle: { connect: 'connecting', signaling: 'signaling', failed: 'idle' },
    connecting: { signaling: 'signaling', failed: 'idle' },
    signaling: { handshaking: 'handshaking', failed: 'idle' },
    handshaking: { connected: 'connected', failed: 'idle' },
    connected: { degraded: 'degraded', disconnected: 'disconnected', reconnecting: 'reconnecting' },
    degraded: { connected: 'connected', disconnected: 'disconnected', reconnecting: 'reconnecting', failed: 'idle' },
    disconnected: { reconnecting: 'reconnecting', idle: 'idle' },
    reconnecting: { connecting: 'connecting', signaling: 'signaling', failed: 'idle' },
  };

  function getBackoffDelay(attempt, base = 1000, max = 30000) {
    const delay = Math.min(max, base * Math.pow(2, attempt));
    return delay + Math.random() * 1000;
  }

  class PeerManager {
    constructor({ identity, eventBus, logger, connectionManager, signalManager, messageRouter, fileTransferManager, presenceManager, relayManager, keyManager }) {
      if (!identity) throw new Error('PeerManager: identity required');
      this.identity = identity;
      this.eventBus = eventBus || null;
      this.log = logger ? (logger.child ? logger.child({ module: 'PeerManager' }) : logger) : console;

      this._conn = connectionManager || null;
      this._signal = signalManager || null;
      this._messageRouter = messageRouter || null;
      this._fileTransfer = fileTransferManager || null;
      this._presence = presenceManager || null;
      this._relay = relayManager || null;
      this._keyManager = keyManager || null;

      this._peers = new Map();
      this._keyExchange = new Map();
      this._retryQueues = new Map();
      this._unbinds = [];
      this._isDestroyed = false;
      this._wired = false;
      this._qualityInterval = null;

      if (this._conn && this._signal) {
        this._wireSubManagers();
      }
    }

    _emit(event, data) {
      if (this.eventBus) {
        try { this.eventBus.emit(event, data); } catch (e) { this.log.error('[PeerManager] eventBus emit failed', e); }
      }
      this.log.debug(`[PeerManager] emit: ${event}`, data);
    }

    _getPeer(peerId) {
      return this._peers.get(peerId) || null;
    }

    _createStateMachine(peerId) {
      if (!SM) {
        const sm = {
          state: 'idle',
          _listeners: [],
          transition(target, trigger) { this.state = target; this._listeners.forEach(cb => cb(this.state, target, trigger)); },
          onTransition(cb) { this._listeners.push(cb); },
          can(target) { const paths = STATE_TRANSITIONS[this.state]; return paths && target in paths; }
        };
        return sm;
      }
      const sm = new SM('idle', STATE_TRANSITIONS);
      sm.onTransition = (from, to, trigger) => {
        this.log.debug(`[PeerManager] Peer ${peerId} state: ${from} -> ${to} (${trigger})`);
        this._emit('peer:state-change', { peerId, from, to, trigger });
      };
      return sm;
    }

    _setTimer(peerId, name, timer) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      if (peer.timers[name]) { try { clearTimeout(peer.timers[name]); clearInterval(peer.timers[name]); } catch (e) {} }
      peer.timers[name] = timer;
    }

    _clearTimers(peerId) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      Object.values(peer.timers).forEach(t => { try { clearTimeout(t); clearInterval(t); } catch (e) {} });
      peer.timers = {};
    }

    _createPeer(peerId, metadata = {}) {
      if (this._peers.has(peerId)) {
        this._clearTimers(peerId);
      }

      const sm = this._createStateMachine(peerId);
      const peer = {
        peerId,
        metadata: { ...metadata, addedAt: Date.now() },
        stateMachine: sm,
        timers: {},
        retryCount: 0,
        quality: null,
        mode: metadata.mode || 'relay',
        lastSeen: Date.now(),
        fingerprint: metadata.fingerprint || null,
        publicKey: metadata.publicKey || null,
        name: metadata.name || null,
      };

      this._peers.set(peerId, peer);

      if (this._keyManager) {
        this._keyExchange.set(peerId, { publicKeySent: false, sessionKeyReceived: false, handshakeComplete: false });
      }

      if (this._relay) {
        this._retryQueues.set(peerId, []);
      }

      this._emit('peer:add', { peerId, metadata: peer.metadata });
      return peer;
    }

    _removePeer(peerId, reason = 'manual') {
      const peer = this._getPeer(peerId);
      if (!peer) return;

      this._clearTimers(peerId);

      const retryQueue = this._retryQueues.get(peerId);
      if (retryQueue) { retryQueue.length = 0; this._retryQueues.delete(peerId); }

      if (this._conn) this._conn.disconnect(peerId, reason);
      this._peers.delete(peerId);
      this._keyExchange.delete(peerId);

      this._emit('peer:remove', { peerId, reason });
    }

    setSubManagers({ connectionManager, signalManager, messageRouter, fileTransferManager, presenceManager, relayManager, keyManager } = {}) {
      if (this._isDestroyed) return;
      let changed = false;
      if (connectionManager && connectionManager !== this._conn) { this._conn = connectionManager; changed = true; }
      if (signalManager && signalManager !== this._signal) { this._signal = signalManager; changed = true; }
      if (messageRouter && messageRouter !== this._messageRouter) { this._messageRouter = messageRouter; changed = true; }
      if (fileTransferManager && fileTransferManager !== this._fileTransfer) { this._fileTransfer = fileTransferManager; changed = true; }
      if (presenceManager && presenceManager !== this._presence) { this._presence = presenceManager; changed = true; }
      if (relayManager && relayManager !== this._relay) { this._relay = relayManager; changed = true; }
      if (keyManager && keyManager !== this._keyManager) { this._keyManager = keyManager; changed = true; }
      if (changed) this._wireSubManagers();
    }

    _wireSubManagers() {
      if (this._wired) return;
      if (!this._conn || !this._signal) return;
      this._wired = true;

      this._unwireConnectionManager();
      this._unwireSignalManager();

      this._wireConnectionManagerEvents();
      this._wireSignalManagerEvents();
      this._wireMessageRouter();
      this._wireFileTransfer();
      this._wirePresence();
      this._wireRelay();
      this._wireKeyManager();

      this._qualityInterval = setInterval(() => {
        this._updatePeerQuality();
      }, 10000);
    }

    _unwireConnectionManager() {
      this._unbinds.forEach(fn => { try { fn(); } catch (e) {} });
      this._unbinds = [];
    }

    _unwireSignalManager() {
      // handled by _unwireConnectionManager
    }

    _wireConnectionManagerEvents() {
      if (!this.eventBus) return;

      const push = (fn) => this._unbinds.push(fn);

      push(this.eventBus.on('peer:connected', (data) => {
        if (!data || !data.peerId) return;
        this._handlePeerConnected(data.peerId, data.mode);
      }));

      push(this.eventBus.on('peer:disconnected', (data) => {
        if (!data || !data.peerId) return;
        this._handlePeerDisconnected(data.peerId);
      }));

      push(this.eventBus.on('peer:degraded', (data) => {
        if (!data || !data.peerId) return;
        this._handlePeerDegraded(data.peerId);
      }));

      push(this.eventBus.on('peer:reconnecting', (data) => {
        if (!data || !data.peerId) return;
        this._handlePeerReconnecting(data.peerId);
      }));

      push(this.eventBus.on('peer:failed', (data) => {
        if (!data || !data.peerId) return;
        this._handlePeerFailed(data.peerId, data.reason);
      }));

      push(this.eventBus.on('dc:open', (data) => {
        if (!data || !data.peerId) return;
        this._handleDataChannelOpen(data.peerId, data.label);
      }));

      push(this.eventBus.on('dc:message', (data) => {
        if (!data || !data.peerId) return;
        this._handleDataChannelMessage(data.peerId, data.label, data.payload);
      }));

      push(this.eventBus.on('dc:close', (data) => {
        if (!data || !data.peerId) return;
        this._handleDataChannelClose(data.peerId, data.label);
      }));

      push(this.eventBus.on('ice:candidate', (data) => {
        if (!data || !data.peerId || !data.candidate) return;
        this._handleIceCandidate(data.peerId, data.candidate);
      }));

      push(this.eventBus.on('quality:update', (data) => {
        if (!data || !data.peerId) return;
        this._handleQualityUpdate(data.peerId, data.quality);
      }));
    }

    _wireSignalManagerEvents() {
      if (!this.eventBus) return;

      const push = (fn) => this._unbinds.push(fn);

      push(this.eventBus.on('signal:offer', (data) => {
        if (!data || !data.peerId || !data.sdp) return;
        this._handleIncomingOffer(data.peerId, data.sdp, data);
      }));

      push(this.eventBus.on('signal:answer', (data) => {
        if (!data || !data.peerId || !data.sdp) return;
        this._handleIncomingAnswer(data.peerId, data.sdp);
      }));

      push(this.eventBus.on('signal:ice-candidate', (data) => {
        if (!data || !data.peerId || !data.candidate) return;
        this._handleIncomingIce(data.peerId, data.candidate);
      }));

      push(this.eventBus.on('signal:peer-joined', (data) => {
        if (!data || !data.peerId) return;
        this._handlePeerDiscovered(data.peerId, data);
      }));

      push(this.eventBus.on('signal:peer-left', (data) => {
        if (!data || !data.peerId) return;
        this._handlePeerLeft(data.peerId);
      }));

      push(this.eventBus.on('signal:relay', (data) => {
        if (!data || !data.peerId) return;
        this._handleSignalRelay(data.peerId, data.payload);
      }));

      push(this.eventBus.on('signal:connected', () => {
        this._onSignalConnected();
      }));

      push(this.eventBus.on('signal:disconnected', (data) => {
        this._onSignalDisconnected(data);
      }));
    }

    _wireMessageRouter() {
      if (!this._messageRouter) return;
      // MessageRouter handles routing incoming/outgoing messages
      // Wire presence updates
    }

    _wireFileTransfer() {
      if (!this._fileTransfer) return;
      // FileTransfer receives file chunks via data channels
    }

    _wirePresence() {
      if (!this._presence) return;
      // Presence manager handles presence broadcasts
    }

    _wireRelay() {
      if (!this._relay || !this._signal) return;
      this._relay._sendFn = (peerId, payload) => {
        if (this._conn && this._conn.isConnected(peerId)) {
          return this._conn.sendMessage(peerId, { type: 'relay', payload });
        }
        return false;
      };
      this._relay._signalManager = this._signal;
    }

    _wireKeyManager() {
      if (!this._keyManager) return;
      // KeyManager handles key exchange and session key derivation
    }

    _onSignalConnected() {
      this._emit('signal:connected', {});
    }

    _onSignalDisconnected(data) {
      this._emit('signal:disconnected', data || {});
    }

    _handlePeerDiscovered(peerId, info) {
      if (this._isDestroyed) return;
      const existing = this._getPeer(peerId);
      if (existing) {
        existing.lastSeen = Date.now();
        if (info.publicKey) existing.metadata.publicKey = info.publicKey;
        if (info.fingerprint) existing.metadata.fingerprint = info.fingerprint;
        if (info.name) existing.metadata.name = info.name;
        this._emit('peer:updated', { peerId, update: info });
        return;
      }
      this._createPeer(peerId, {
        publicKey: info.publicKey,
        fingerprint: info.fingerprint,
        name: info.name,
        mode: info.connectionMode || 'relay',
      });
    }

    async _connect(peerId, mode = 'relay') {
      if (this._isDestroyed) return;
      if (!this._conn) { this.log.error('[PeerManager] ConnectionManager not available'); return; }
      if (!this._signal) { this.log.error('[PeerManager] SignalManager not available'); return; }

      const peer = this._getPeer(peerId) || this._createPeer(peerId, { connectionMode: mode });
      peer.mode = mode;
      peer.stateMachine.transition('connecting', 'connect');
      this._emit('peer:connect', { peerId, mode });

      try {
        const { offerSdp } = await this._conn.createOffer(peerId, mode);
        peer.stateMachine.transition('signaling', 'offer-ready');
        this._signal.sendOffer(peerId, this.identity.fingerprint, offerSdp, this.identity.publicKeyHex || this.identity.publicKey, this.identity.name);
      } catch (e) {
        this.log.error(`[PeerManager] createOffer failed for ${peerId}`, e);
        peer.stateMachine.transition('idle', 'offer-failed');
        this._scheduleReconnect(peerId);
      }
    }

    async _handleIncomingOffer(peerId, offerSdp, info) {
      if (this._isDestroyed) return;
      if (!this._conn) { this.log.error('[PeerManager] ConnectionManager not available'); return; }
      const peer = this._getPeer(peerId) || this._createPeer(peerId, { mode: 'relay' });

      if (info.publicKey) peer.metadata.publicKey = info.publicKey;
      if (info.name) peer.metadata.name = info.name;
      if (info.fingerprint) peer.metadata.fingerprint = info.fingerprint;

      peer.stateMachine.transition('signaling', 'incoming-offer');
      try {
        const { answerSdp } = await this._conn.acceptOffer(peerId, offerSdp);
        peer.stateMachine.transition('handshaking', 'answer-ready');
        if (this._signal) {
          this._signal.sendAnswer(peerId, this.identity.fingerprint, answerSdp);
        }
      } catch (e) {
        this.log.error(`[PeerManager] acceptOffer failed for ${peerId}`, e);
        peer.stateMachine.transition('idle', 'accept-failed');
      }
    }

    async _handleIncomingAnswer(peerId, answerSdp) {
      if (this._isDestroyed) return;
      if (!this._conn) return;
      const peer = this._getPeer(peerId);
      if (!peer) { this.log.warn(`[PeerManager] Answer from unknown peer ${peerId}`); return; }
      try {
        await this._conn.acceptAnswer(peerId, answerSdp);
        peer.stateMachine.transition('handshaking', 'answer-received');
      } catch (e) {
        this.log.error(`[PeerManager] acceptAnswer failed for ${peerId}`, e);
        peer.stateMachine.transition('idle', 'answer-failed');
      }
    }

    async _handleIncomingIce(peerId, candidate) {
      if (this._isDestroyed) return;
      if (!this._conn) return;
      try {
        await this._conn.addIceCandidate(peerId, candidate);
      } catch (e) { this.log.debug(`[PeerManager] addIceCandidate error for ${peerId}`, e); }
    }

    _handleIceCandidate(peerId, candidate) {
      if (!this._signal) return;
      this._signal.sendIceCandidate(peerId, this.identity.fingerprint, candidate);
    }

    _handleSignalRelay(peerId, payload) {
      if (this._conn && this._conn.sendMessage) {
        this._conn.sendMessage(peerId, { type: 'relay', payload });
      } else if (this._relay) {
        this._relay.queuePacket(peerId, payload, { priority: 0, expectAck: true });
      }
    }

    _handlePeerConnected(peerId, mode) {
      const peer = this._getPeer(peerId);
      if (!peer) { this.log.warn(`[PeerManager] Connected event for unknown peer ${peerId}`); return; }
      peer.stateMachine.transition('connected', 'connected');
      peer.retryCount = 0;
      peer.lastSeen = Date.now();
      this._emit('peer:connected', { peerId, mode: mode || peer.mode });
      this._beginKeyExchange(peerId);
    }

    _handlePeerDisconnected(peerId) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      const currentState = peer.stateMachine.state;
      if (currentState === 'connected') {
        peer.stateMachine.transition('degraded', 'disconnected');
        this._scheduleReconnect(peerId);
      } else if (currentState === 'degraded' || currentState === 'reconnecting') {
        peer.stateMachine.transition('disconnected', 'disconnected');
        this._scheduleReconnect(peerId);
      }
      this._emit('peer:disconnected', { peerId });
    }

    _handlePeerDegraded(peerId) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      if (peer.stateMachine.state === 'connected') {
        peer.stateMachine.transition('degraded', 'degraded');
      }
      peer.quality = this._conn ? this._conn.getQuality(peerId) : null;
      this._emit('peer:degraded', { peerId, quality: peer.quality });
    }

    _handlePeerReconnecting(peerId) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      peer.stateMachine.transition('reconnecting', 'reconnecting');
      this._emit('peer:reconnecting', { peerId });
      this._scheduleReconnect(peerId);
    }

    _handlePeerFailed(peerId, reason) {
      this._emit('peer:failed', { peerId, reason });
      this._removePeer(peerId, reason || 'failed');
    }

    _handlePeerLeft(peerId) {
      this._removePeer(peerId, 'signal-left');
    }

    _handleDataChannelOpen(peerId, label) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      if (label === 'messages' && !peer.metadata.encrypted) {
        this._beginKeyExchange(peerId);
      }
      this._emit('dc:open', { peerId, label });
    }

    _handleDataChannelClose(peerId, label) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      this._emit('dc:close', { peerId, label });
    }

    _handleDataChannelMessage(peerId, label, payload) {
      if (!payload || !label) return;
      if (label === 'messages' && payload.type === 'key-exchange') {
        this._handleKeyExchangeMessage(peerId, payload);
        return;
      }
      if (label === 'messages' && payload.type === 'ack') {
        this._handleAckReceived(peerId, payload.msgId);
        return;
      }
      if (this._messageRouter) {
        this._messageRouter.route(peerId, label, payload);
      }
    }

    _handleQualityUpdate(peerId, quality) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      peer.quality = quality;
      this._emit('peer:quality', { peerId, quality });
    }

    _beginKeyExchange(peerId) {
      if (!this._keyManager && !this._conn) return;
      const peer = this._getPeer(peerId);
      if (!peer) return;

      const ke = this._keyExchange.get(peerId) || { publicKeySent: false, sessionKeyReceived: false, handshakeComplete: false };
      this._keyExchange.set(peerId, ke);
      ke.publicKeySent = true;

      if (this._keyManager && this._keyManager.getPublicKey) {
        const pubKey = this._keyManager.getPublicKey();
        if (this._conn) {
          this._conn.sendMessage(peerId, {
            type: 'key-exchange',
            publicKey: pubKey,
            fingerprint: this.identity.fingerprint,
          });
        }
      }
    }

    _handleKeyExchangeMessage(peerId, payload) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      const ke = this._keyExchange.get(peerId);
      if (!ke) return;

      if (payload.publicKey) {
        ke.sessionKeyReceived = true;
        if (this._keyManager && this._keyManager.deriveSessionKey) {
          this._keyManager.deriveSessionKey(peerId, payload.publicKey);
        }
      }

      if (ke.publicKeySent && ke.sessionKeyReceived) {
        ke.handshakeComplete = true;
        peer.metadata.encrypted = true;
        this._emit('peer:encrypted', { peerId });
      }
    }

    _handleAckReceived(peerId, msgId) {
      const queue = this._retryQueues.get(peerId);
      if (!queue) return;
      const idx = queue.findIndex(e => e.msgId === msgId);
      if (idx !== -1) queue.splice(idx, 1);
      this._emit('peer:ack', { peerId, msgId });
    }

    _scheduleReconnect(peerId) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      if (peer.retryCount > 20) { this._removePeer(peerId, 'max-reconnect'); return; }

      const delay = getBackoffDelay(peer.retryCount);
      this.log.info(`[PeerManager] Reconnecting ${peerId} in ${Math.round(delay)}ms (attempt ${peer.retryCount + 1})`);
      peer.retryCount += 1;

      const timer = setTimeout(() => {
        if (this._isDestroyed) return;
        const p = this._getPeer(peerId);
        if (!p) return;
        const state = p.stateMachine.state;
        if (state === 'reconnecting' || state === 'disconnected' || state === 'idle') {
          this._connect(peerId, p.mode);
        }
      }, delay);

      this._setTimer(peerId, 'reconnect', timer);
    }

    async _updatePeerQuality() {
      if (!this._conn) return;
      for (const [peerId, peer] of this._peers) {
        try {
          const quality = this._conn.getQuality(peerId);
          if (quality) {
            peer.quality = quality;
            this._emit('peer:quality', { peerId, quality });
          }
        } catch (e) { /* ignore */ }
      }
    }

    _queueMessage(peerId, data) {
      const queue = this._retryQueues.get(peerId);
      if (!queue) return;
      const msgId = 'msg-' + Date.now() + Math.random().toString(36).slice(2);
      queue.push({ msgId, data, attempts: 0, enqueuedAt: Date.now() });
      this._processRetryQueue(peerId);
    }

    _processRetryQueue(peerId) {
      if (this._isDestroyed) return;
      const peer = this._getPeer(peerId);
      if (!peer || peer.stateMachine.state !== 'connected') return;

      const queue = this._retryQueues.get(peerId);
      if (!queue || queue.length === 0) return;

      const entry = queue[0];
      if (this._conn && this._conn.sendMessage) {
        const sent = this._conn.sendMessage(peerId, entry.data);
        if (sent) {
          queue.shift();
          if (queue.length > 0) {
            setTimeout(() => this._processRetryQueue(peerId), 100);
          }
        } else {
          entry.attempts += 1;
          if (entry.attempts > 5) {
            queue.shift();
            this.log.warn(`[PeerManager] Message send failed after ${entry.attempts} attempts: ${entry.msgId}`);
          } else {
            setTimeout(() => this._processRetryQueue(peerId), 1000 * entry.attempts);
          }
        }
      }
    }

    getPeer(peerId) {
      const peer = this._getPeer(peerId);
      if (!peer) return null;
      return {
        id: peerId,
        publicKey: peer.publicKey,
        fingerprint: peer.fingerprint,
        name: peer.name,
        stateMachine: peer.stateMachine,
        mode: peer.mode,
        quality: peer.quality,
        lastSeen: peer.lastSeen,
        metadata: { ...peer.metadata },
      };
    }

    getAllPeers() {
      const peers = [];
      for (const [peerId, peer] of this._peers) {
        peers.push({
          id: peerId,
          publicKey: peer.publicKey,
          fingerprint: peer.fingerprint,
          name: peer.name,
          state: peer.stateMachine.state,
          mode: peer.mode,
          quality: peer.quality,
          lastSeen: peer.lastSeen,
          metadata: { ...peer.metadata },
        });
      }
      return peers;
    }

    getPeerState(peerId) {
      const peer = this._getPeer(peerId);
      return peer ? peer.stateMachine.state : 'idle';
    }

    sendMessage(peerId, data) {
      if (this._isDestroyed) return false;
      const peer = this._getPeer(peerId);
      if (!peer) return false;

      if (peer.stateMachine.state === 'connected' && this._conn) {
        const sent = this._conn.sendMessage(peerId, data);
        if (!sent) {
          this._queueMessage(peerId, data);
        }
        return sent;
      }

      if (this._relay) {
        this._relay.queuePacket(peerId, data, { priority: 0, expectAck: true });
        return true;
      }

      this._queueMessage(peerId, data);
      return false;
    }

    sendFile(peerId, frame) {
      if (this._conn && this._conn.sendFile) {
        return this._conn.sendFile(peerId, frame);
      }
      return false;
    }

    sendPresence(peerId, data) {
      if (this._conn && this._conn.sendPresence) {
        return this._conn.sendPresence(peerId, data);
      }
      return false;
    }

    connect(peerId, mode = 'relay') {
      this._connect(peerId, mode);
    }

    disconnect(peerId) {
      this._removePeer(peerId, 'manual');
    }

    disconnectAll() {
      const ids = Array.from(this._peers.keys());
      ids.forEach(id => this.disconnect(id));
    }

    destroy() {
      this._isDestroyed = true;
      if (this._qualityInterval) { clearInterval(this._qualityInterval); this._qualityInterval = null; }
      this._unbinds.forEach(fn => { try { fn(); } catch (e) {} });
      this._unbinds = [];
      this.disconnectAll();
      this._retryQueues.forEach(q => q.length = 0);
      this._retryQueues.clear();
      if (this._relay) this._relay.clear();
      if (this._signal) this._signal.disconnect();
      if (this._conn) this._conn.destroy();
      this._peers.clear();
      this._keyExchange.clear();
    }
  }

  G.GhostLink = G.GhostLink || {};
  G.GhostLink.PeerManager = PeerManager;
})(typeof globalThis !== 'undefined' ? globalThis : this);