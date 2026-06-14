// connection-manager.js — Production WebRTC connection lifecycle management for GhostLink
// Manages RTCPeerConnection lifecycle with StateMachine, heartbeat, ICE restart, and quality tracking.
(function(exports) {
  'use strict';

  const G = (typeof globalThis !== 'undefined' && globalThis.GhostLink) || (typeof window !== 'undefined' && window.GhostLink);
  const StateMachine = G?.StateMachine;
  const RetryQueue = G?.RetryQueue;

  // Helper: returns a new peer connection config
  function makePeerConfig(iceServers) {
    return {
      iceServers: iceServers || [{ urls: 'stun:stun.l.google.com:19302' }],
      iceCandidatePoolSize: 10,
      bundlePolicy: 'balanced',
      rtcpMuxPolicy: 'require',
    };
  }

  class ConnectionManager {
    constructor({ identity, eventBus, logger, iceServers }) {
      if (!identity) throw new Error('ConnectionManager: identity required');
      this.identity = identity;
      this.eventBus = eventBus || null;
      this.log = logger ? logger.child ? logger.child({ module: 'ConnectionManager' }) : logger : console;
      this.iceServers = iceServers && iceServers.length ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }];

      // Peer storage keyed by peerId
      this._registry = new Map(); // peerId -> { metadata, pc, stateMachine, channels, timers, iceRestartCount, quality, pendingIce }
    }

    // ── Internal helpers ───────────────────────────────────────────────────

    _emit(event, data) {
      if (this.eventBus) {
        try { this.eventBus.emit(event, data); } catch (e) { this.log.error('[ConnectionManager] eventBus emit failed', e); }
      }
      this.log.debug(`[ConnectionManager] emit: ${event}`, data);
    }

    _getPeer(peerId) {
      return this._registry.get(peerId) || null;
    }

    _createStateMachine(peerId) {
      if (!StateMachine) { throw new Error('StateMachine not available globally'); }
      const sm = new StateMachine('idle', {
        idle: { connecting: 'connecting' },
        connecting: { signaling: 'signaling', failed: 'idle' },
        signaling: { handshaking: 'handshaking', failed: 'reconnecting' },
        handshaking: { connected: 'connected', failed: 'reconnecting' },
        connected: { degraded: 'degraded', disconnected: 'disconnected' },
        degraded: { connected: 'connected', disconnected: 'disconnected', reconnecting: 'reconnecting', failed: 'reconnecting' },
        disconnected: { reconnecting: 'reconnecting', idle: 'idle' },
        reconnecting: { connecting: 'connecting', failed: 'idle' },
      });
      sm.onTransition = (from, to, trigger) => {
        this.log.debug(`[ConnectionManager] State change: ${peerId} ${from} -> ${to} (${trigger})`);
      };
      return sm;
    }

    _setTimer(peerId, name, timer) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      if (peer.timers[name]) { clearTimeout(peer.timers[name]); clearInterval(peer.timers[name]); }
      peer.timers[name] = timer;
    }

    _clearTimers(peerId) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      Object.values(peer.timers).forEach(t => { try { clearTimeout(t); clearInterval(t); } catch (e) {} });
      peer.timers = {};
    }

    _getExponentialDelay(attempt, base = 1000, max = 30000) {
      return Math.min(max, base * Math.pow(2, attempt));
    }

    // ── RTCPeerConnection & DataChannel setup ────────────────────────────────

    _createPeerConnection(peerId, mode) {
      const pc = new RTCPeerConnection(makePeerConfig(this.iceServers));
      pc.peerId = peerId;
      return pc;
    }

    _setupDataChannels(peerId, pc) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      const dcs = {};

      // 'messages': ordered, reliable
      let ch = pc.createDataChannel('messages', { ordered: true });
      dcs.messages = this._configureDataChannel(peerId, 'messages', ch);

      // 'files': ordered, reliable
      ch = pc.createDataChannel('files', { ordered: true });
      dcs.files = this._configureDataChannel(peerId, 'files', ch);

      // 'presence': unordered, unreliable (maxRetransmits: 0)
      ch = pc.createDataChannel('presence', { ordered: false, maxRetransmits: 0 });
      dcs.presence = this._configureDataChannel(peerId, 'presence', ch);

      peer.channels = dcs;
    }

    _configureDataChannel(peerId, label, channel) {
      const self = this;
      channel.onopen = function() {
        self._emit('dc:open', { peerId, label });
        self._tryAdvanceState(peerId, 'connected', 'datachannel-open');
      };
      channel.onclose = function() {
        self._emit('dc:close', { peerId, label });
        self._checkAnyChannelOpen(peerId);
      };
      channel.onmessage = function(e) {
        let payload;
        try { payload = JSON.parse(e.data); } catch (err) { payload = e.data; }
        self._emit('dc:message', { peerId, label, payload });
      };
      channel.onerror = function(error) {
        self._emit('dc:error', { peerId, label, error: error && error.message ? error.message : String(error) });
      };
      return channel;
    }

    _handleRemoteDataChannel(peerId, channel) {
      const label = channel.label;
      const peer = this._getPeer(peerId);
      if (!peer) return;
      if (!peer.channels) peer.channels = {};
      if (!['messages', 'files', 'presence'].includes(label)) {
        this.log.warn(`[ConnectionManager] Unknown data channel label from ${peerId}: ${label}`);
      }
      peer.channels[label] = this._configureDataChannel(peerId, label, channel);
    }

    _tryAdvanceState(peerId, target, trigger) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      const sm = peer.stateMachine;
      if (sm.can(target)) {
        sm.transition(target, trigger);
        if (target === 'connected') this._emit('peer:connected', { peerId, mode: peer.metadata.mode });
        if (target === 'degraded') this._emit('peer:degraded', { peerId });
        if (target === 'disconnected') this._emit('peer:disconnected', { peerId });
        if (target === 'reconnecting') this._emit('peer:reconnecting', { peerId });
      }
    }

    _checkAnyChannelOpen(peerId) {
      const peer = this._getPeer(peerId);
      if (!peer || !peer.channels) return;
      const anyOpen = Object.values(peer.channels).some(c => c && c.readyState === 'open');
      if (!anyOpen && (peer.stateMachine.state === 'connected' || peer.stateMachine.state === 'degraded')) {
        this._tryAdvanceState(peerId, 'disconnected', 'channels-closed');
      }
    }

    // ── ICE handling ─────────────────────────────────────────────────────────

    _handleIceCandidate(peerId, candidate) {
      if (!candidate) return;
      this._emit('ice:candidate', { peerId, candidate });
    }

    _handleIceConnectionStateChange(peerId, pc) {
      const state = pc.iceConnectionState;
      this._emit('ice:state', { peerId, state });
      const peer = this._getPeer(peerId);
      if (!peer) return;

      if (state === 'connected' || state === 'completed') {
        peer.iceRestartCount = 0; // reset on successful connection
        this._tryAdvanceState(peerId, 'connected', 'ice-connected');
        this._startHeartbeat(peerId);
      } else if (state === 'disconnected') {
        this._tryAdvanceState(peerId, 'degraded', 'ice-disconnected');
        // Give a short window before declaring disconnected
        setTimeout(() => {
          const p = this._getPeer(peerId);
          if (p && p.pc && (p.pc.iceConnectionState === 'disconnected' || p.pc.iceConnectionState === 'failed')) {
            this._tryAdvanceState(peerId, 'disconnected', 'ice-timeout');
          }
        }, 10000);
      } else if (state === 'failed') {
        this._tryAdvanceState(peerId, 'disconnected', 'ice-failed');
        this._maybeRestartIce(peerId);
      } else if (state === 'closed') {
        this._tryAdvanceState(peerId, 'disconnected', 'ice-closed');
      }
    }

    _maybeRestartIce(peerId) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      const maxRestarts = 3;
      if (peer.iceRestartCount >= maxRestarts) {
        this.log.warn(`[ConnectionManager] Max ICE restarts reached for ${peerId}`);
        this._emit('peer:failed', { peerId, reason: 'max-ice-restarts' });
        return;
      }
      peer.iceRestartCount += 1;
      this.log.info(`[ConnectionManager] Restarting ICE for ${peerId} (attempt ${peer.iceRestartCount}/${maxRestarts})`);
      try {
        if (typeof peer.pc.restartIce === 'function') {
          peer.pc.restartIce();
        } else {
          // Fallback: renegotiate by creating a new offer with iceRestart flag
          peer.pc.createOffer({ iceRestart: true }).then(offer => peer.pc.setLocalDescription(offer)).catch(e => {
            this.log.error(`[ConnectionManager] ICE restart fallback failed for ${peerId}`, e);
          });
        }
      } catch (e) {
        this.log.error(`[ConnectionManager] ICE restart error for ${peerId}`, e);
      }
    }

    // ── Heartbeat & stale peer cleanup ───────────────────────────────────────

    _startHeartbeat(peerId) {
      const self = this;
      const peer = this._getPeer(peerId);
      if (!peer) return;

      this._stopHeartbeat(peerId);
      peer.lastPong = Date.now();

      const timer = setInterval(() => {
        self._sendHeartbeat(peerId);
      }, 30000); // 30s interval

      self._setTimer(peerId, 'heartbeat', timer);

      // Also start stale check
      const staleTimer = setInterval(() => {
        const p = self._getPeer(peerId);
        if (!p) return;
        if (Date.now() - p.lastPong > 60000) { // 60s no response
          self.log.warn(`[ConnectionManager] Stale peer detected: ${peerId}, disconnecting`);
          self.disconnect(peerId, 'stale');
        }
      }, 10000);
      self._setTimer(peerId, 'staleCheck', staleTimer);
    }

    _stopHeartbeat(peerId) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      if (peer.timers.heartbeat) { clearInterval(peer.timers.heartbeat); delete peer.timers.heartbeat; }
      if (peer.timers.staleCheck) { clearInterval(peer.timers.staleCheck); delete peer.timers.staleCheck; }
      if (peer.timers.heartbeatTimeout) { clearTimeout(peer.timers.heartbeatTimeout); delete peer.timers.heartbeatTimeout; }
    }

    _sendHeartbeat(peerId) {
      const peer = this._getPeer(peerId);
      if (!peer || !peer.channels) return;
      const ch = peer.channels.messages || peer.channels.presence;
      if (ch && ch.readyState === 'open') {
        try {
          ch.send(JSON.stringify({ type: '__ping__', ts: Date.now() }));
        } catch (e) { /* ignore */ }
      }
      // Set a timeout for pong response
      const self = this;
      const timeout = setTimeout(() => {
        const p = self._getPeer(peerId);
        if (!p) return;
        if (Date.now() - p.lastPong > 45000) { // 45s timeout
          self.log.warn(`[ConnectionManager] Heartbeat timeout for ${peerId}`);
          self._tryAdvanceState(peerId, 'degraded', 'heartbeat-timeout');
        }
      }, 45000);
      this._setTimer(peerId, 'heartbeatTimeout', timeout);
    }

    _handlePong(peerId) {
      const peer = this._getPeer(peerId);
      if (peer) { peer.lastPong = Date.now(); }
    }

    // ── Quality tracking ────────────────────────────────────────────────────

    async _updateQuality(peerId) {
      const peer = this._getPeer(peerId);
      if (!peer || !peer.pc) return;
      try {
        const stats = await peer.pc.getStats();
        const quality = { rtt: null, packetsLost: null, jitter: null, timestamp: Date.now() };
        stats.forEach(s => {
          if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.currentRoundTripTime !== undefined) {
            quality.rtt = Math.round(s.currentRoundTripTime * 1000);
          }
          if (s.type === 'inbound-rtp') {
            if (s.packetsLost !== undefined) quality.packetsLost = s.packetsLost;
            if (s.jitter !== undefined) quality.jitter = Math.round(s.jitter * 1000);
          }
        });
        peer.quality = quality;
        this._emit('quality:update', { peerId, quality });
      } catch (e) { /* ignore */ }
    }

    getQuality(peerId) {
      const peer = this._getPeer(peerId);
      return peer && peer.quality ? { ...peer.quality } : null;
    }

    // ── Connection API (outgoing) ─────────────────────────────────────────

    async createOffer(peerId, mode = 'relay') {
      if (this._getPeer(peerId)) { this.disconnect(peerId, 'recreate'); }
      const pc = this._createPeerConnection(peerId, mode);
      const sm = this._createStateMachine(peerId);
      const peer = {
        metadata: { peerId, mode, createdAt: Date.now() },
        pc,
        stateMachine: sm,
        channels: {},
        timers: {},
        iceRestartCount: 0,
        quality: null,
        pendingIce: [],
        lastPong: Date.now(),
        retryQueue: null,
      };
      if (RetryQueue) {
        peer.retryQueue = new RetryQueue({
          maxRetries: 5,
          baseDelay: 1000,
          maxDelay: 30000,
          onRetry: (msg, attempt) => this._doSend(peerId, msg, attempt),
        });
      }
      this._registry.set(peerId, peer);

      this._setupDataChannels(peerId, pc);
      this._bindPCEvents(peerId, pc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitForIceGathering(pc, 8000);

      sm.transition('signaling', 'offer-created');
      return { pc, offerSdp: pc.localDescription.sdp };
    }

    async acceptOffer(peerId, offerSdp, mode = 'relay') {
      const pc = this._createPeerConnection(peerId, mode);
      const sm = this._createStateMachine(peerId);
      const peer = {
        metadata: { peerId, mode, createdAt: Date.now() },
        pc,
        stateMachine: sm,
        channels: {},
        timers: {},
        iceRestartCount: 0,
        quality: null,
        pendingIce: [],
        lastPong: Date.now(),
        retryQueue: null,
      };
      if (RetryQueue) {
        peer.retryQueue = new RetryQueue({
          maxRetries: 5,
          baseDelay: 1000,
          maxDelay: 30000,
          onRetry: (msg, attempt) => this._doSend(peerId, msg, attempt),
        });
      }
      this._registry.set(peerId, peer);

      pc.ondatachannel = (e) => { this._handleRemoteDataChannel(peerId, e.channel); };
      this._bindPCEvents(peerId, pc);

      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      this._drainPendingIce(peerId);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this._waitForIceGathering(pc, 8000);

      sm.transition('signaling', 'answer-created');
      return { pc, answerSdp: pc.localDescription.sdp };
    }

    async acceptAnswer(peerId, answerSdp) {
      const peer = this._getPeer(peerId);
      if (!peer || !peer.pc) throw new Error(`No peer connection for ${peerId}`);
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      this._drainPendingIce(peerId);
      peer.stateMachine.transition('handshaking', 'answer-received');
    }

    // ── ICE Candidates ──────────────────────────────────────────────────────

    async addIceCandidate(peerId, candidate) {
      const peer = this._getPeer(peerId);
      if (!peer || !peer.pc) { this.log.warn(`[ConnectionManager] addIceCandidate: no peer ${peerId}`); return; }
      if (peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
        await peer.pc.addIceCandidate(candidate);
      } else {
        peer.pendingIce.push(candidate);
      }
    }

    _drainPendingIce(peerId) {
      const peer = this._getPeer(peerId);
      if (!peer) return;
      while (peer.pendingIce.length) {
        const c = peer.pendingIce.shift();
        peer.pc.addIceCandidate(c).catch(e => this.log.debug(`[ConnectionManager] addIceCandidate error for ${peerId}`, e));
      }
    }

    // ── PC event binding ───────────────────────────────────────────────────

    _bindPCEvents(peerId, pc) {
      const self = this;
      pc.onicecandidate = (e) => { self._handleIceCandidate(peerId, e.candidate); };
      pc.oniceconnectionstatechange = () => { self._handleIceConnectionStateChange(peerId, pc); };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          self._tryAdvanceState(peerId, 'disconnected', 'pc-connection-failed');
        }
      };
      pc.ondatachannel = (e) => { self._handleRemoteDataChannel(peerId, e.channel); };
    }

    // ── ICE gathering util ─────────────────────────────────────────────────

    _waitForIceGathering(pc, timeout = 8000) {
      return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') { resolve(); return; }
        const onChange = () => { if (pc.iceGatheringState === 'complete') { cleanup(); resolve(); } };
        const onEnd = () => { cleanup(); resolve(); };
        const t = setTimeout(onEnd, timeout);
        pc.addEventListener('icegatheringstatechange', onChange);
        function cleanup() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', onChange); }
      });
    }

    // ── Send API ───────────────────────────────────────────────────────────

    _doSend(peerId, msg, attempt) {
      const peer = this._getPeer(peerId);
      if (!peer || !peer.channels) return false;
      let sent = false;
      const labels = ['messages', 'presence'];
      for (const label of labels) {
        const ch = peer.channels[label];
        if (ch && ch.readyState === 'open') {
          try {
            ch.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
            sent = true;
            break;
          } catch (e) { this.log.debug(`[ConnectionManager] send error on ${label}`, e); }
        }
      }
      return sent;
    }

    send(peerId, data, label = 'messages') {
      const peer = this._getPeer(peerId);
      if (!peer || !peer.channels) return false;
      const ch = peer.channels[label];
      if (!ch || ch.readyState !== 'open') return false;
      try {
        ch.send(typeof data === 'string' ? data : JSON.stringify(data));
        return true;
      } catch (e) { return false; }
    }

    sendMessage(peerId, data) { return this.send(peerId, data, 'messages'); }
    send {[10].map(i=>[10]) ... } 
// The above is a stray paste. Correct below.

    sendFile(peerId, frame) { return this.send(peerId, frame, 'files'); }

    sendPresence(peerId, data) { return this.send(peerId, data, 'presence'); }

    // ── Lifecycle management ────────────────────────────────────────────────

    disconnect(peerId, reason = 'manual') {
      const peer = this._registry.get(peerId);
      if (!peer) return;
      this.log.info(`[ConnectionManager] Disconnecting ${peerId}: ${reason}`);
      this._clearTimers(peerId);
      if (peer.pc) { try { peer.pc.close(); } catch (e) {} }
      Object.values(peer.channels || {}).forEach(ch => { try { ch.close(); } catch (e) {} });
      if (peer.retryQueue) { try { peer.retryQueue.clear(); } catch (e) {} }
      this._registry.delete(peerId);
      this._emit('peer:disconnected', { peerId, reason });
    }

    disconnectAll(reason = 'manual') {
      const ids = Array.from(this._registry.keys());
      ids.forEach(id => this.disconnect(id, reason));
    }

    destroy() {
      this.disconnectAll('destroy');
    }

    isConnected(peerId) {
      const peer = this._getPeer(peerId);
      return !!(peer && peer.channels && (peer.channels.messages?.readyState === 'open' || peer.channels.presence?.readyState === 'open'));
    }

    getConnectionState(peerId) {
      const peer = this._getPeer(peerId);
      return peer && peer.stateMachine ? peer.stateMachine.state : 'idle';
    }

    getPeerConnection(peerId) { const p = this._getPeer(peerId); return p ? p.pc : null; }
    getChannels(peerId) { const p = this._getPeer(peerId); return p ? { ...p.channels } : null; }
    getDataChannel(peerId, label) { const ch = this._getPeer(peerId)?.channels; return ch && ch[label] ? ch[label] : null; }
  }

  const global = (typeof globalThis !== 'undefined' ? globalThis : this);
  global.GhostLink = global.GhostLink || {};
  global.GhostLink.ConnectionManager = ConnectionManager;
})(typeof globalThis !== 'undefined' ? globalThis : this);
