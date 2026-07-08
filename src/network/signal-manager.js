// signal-manager.js — Production WebSocket signaling for GhostLink
(function(exports) {
  'use strict';

  const G = typeof globalThis !== 'undefined' ? globalThis : this;

  const WS_PING_INTERVAL = 30000;
  const WS_PONG_TIMEOUT = 10000;
  const MAX_RECONNECT_ATTEMPTS = 20;
  const RECONNECT_BASE_DELAY = 1000;
  const RECONNECT_MAX_DELAY = 30000;
  const RATE_LIMIT = 200;

  class SignalManager {
    constructor({ identity, eventBus, logger }) {
      if (!identity) throw new Error('SignalManager: identity required');
      this.identity = identity;
      this.eventBus = eventBus || null;
      this.log = logger ? (logger.child ? logger.child({ module: 'SignalManager' }) : logger) : console;

      this._ws = null;
      this._wsUrl = null;
      this._reconnectAttempts = 0;
      this._savedUrls = [];
      this._destroyed = false;

      this._pingTimer = null;
      this._pongTimer = null;
      this._lastPong = 0;

      this._reconnectTimer = null;

      this._messageTimestamps = [];
      this._rateLimitQueue = [];
      this._processingRateLimit = false;

      this._handlers = new Map();
    }

    get connected() {
      return this._ws && this._ws.readyState === WebSocket.OPEN;
    }

    _emit(event, data) {
      if (this.eventBus) {
        try { this.eventBus.emit(event, data); } catch (e) { this.log.error('[SignalManager] eventBus emit failed', e); }
      }
      this.log.debug(`[SignalManager] emit: ${event}`, data);
    }

    _encode(msg) {
      try { return JSON.stringify(msg); } catch (e) { return null; }
    }

    _decode(raw) {
      try { return JSON.parse(raw); } catch (e) { return null; }
    }

    async _discoverUrls() {
      const urls = [];

      // 1. localStorage GHOSTLINK_SIGNAL_URL
      try {
        const stored = localStorage.getItem('GHOSTLINK_SIGNAL_URL');
        if (stored && typeof stored === 'string') urls.push(stored);
      } catch (e) { /* localStorage may not be available */ }

      // 2. window.GHOSTLINK_SIGNAL_URL
      if (typeof window !== 'undefined' && window.GHOSTLINK_SIGNAL_URL) {
        urls.push(window.GHOSTLINK_SIGNAL_URL);
      }

      // 3. ws://localhost:3001
      urls.push('ws://localhost:3001');

      // 4. [scheme]://[hostname]:[port] — must match page security: an https://
      //    page can only reach a wss:// relay (ws:// to a LAN IP is blocked as
      //    mixed content).
      try {
        if (typeof location !== 'undefined' && location.hostname) {
          const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
          const port = location.port || 3001;
          urls.push(`${scheme}${location.hostname}:${port}`);
          urls.push(`${scheme}${location.hostname}:3001`);
        }
      } catch (e) { /* location not available */ }

      // deduplicate
      const seen = new Set();
      return urls.filter(u => { if (seen.has(u)) return false; seen.add(u); return true; });
    }

    async connect(url) {
      if (this._destroyed) return;
      if (this.connected || this._ws?.readyState === WebSocket.CONNECTING) return;

      let urls = [];
      if (url) urls.push(url);
      urls = urls.concat(await this._discoverUrls());

      for (const u of urls) {
        try {
          await this._doConnect(u);
          this._wsUrl = u;
          this._saveUrl(u);
          this._reconnectAttempts = 0;
          this._startHeartbeat();
          this._sendJoin();
          this._emit('signal:connected', { url: u });
          return;
        } catch (e) {
          this.log.warn(`[SignalManager] Failed to connect to ${u}: ${e.message}`);
          if (this._ws) { try { this._ws.close(); } catch (err) {} this._ws = null; }
        }
      }
      this._scheduleReconnect();
    }

    _doConnect(url) {
      return new Promise((resolve, reject) => {
        try {
          const ws = new WebSocket(url);
          let resolved = false;
          let timeout = setTimeout(() => {
            if (!resolved) { resolved = true; ws.close(); reject(new Error('WS connect timeout')); }
          }, 5000);

          ws.onopen = () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeout);
            this._ws = ws;
            resolve();
          };
          ws.onmessage = (e) => { this._handleMessage(e.data); };
          ws.onclose = (e) => { this._onClose(e); };
          ws.onerror = (e) => {
            if (!resolved) { resolved = true; clearTimeout(timeout); reject(e); }
          };
        } catch (e) { reject(e); }
      });
    }

    _saveUrl(url) {
      try { localStorage.setItem('GHOSTLINK_SIGNAL_URL', url); } catch (e) { /* ignore */ }
    }

    _sendJoin() {
      this.send({
        type: 'join',
        peerId: this.identity.fingerprint,
        publicKey: this.identity.publicKeyHex || this.identity.publicKey,
        name: this.identity.name,
      });
    }

    _startHeartbeat() {
      this._stopHeartbeat();
      this._lastPong = Date.now();
      this._pingTimer = setInterval(() => {
        if (this._destroyed) { this._stopHeartbeat(); return; }
        this._sendPing();
      }, WS_PING_INTERVAL);
    }

    _stopHeartbeat() {
      if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
      if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
    }

    _sendPing() {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      try { this._ws.send('__ping__'); } catch (e) { /* ignore */ }
      if (this._pongTimer) clearTimeout(this._pongTimer);
      this._pongTimer = setTimeout(() => {
        this.log.warn('[SignalManager] Pong timeout');
        this._onClose({ code: 4001, reason: 'heartbeat-timeout' });
      }, WS_PONG_TIMEOUT);
    }

    _sendPong() {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        try { this._ws.send('__pong__'); } catch (e) { /* ignore */ }
      }
    }

    _onClose(e) {
      const wasConnected = this.connected;
      this._stopHeartbeat();
      if (this._ws) { try { this._ws.close(); } catch (err) {} this._ws = null; }

      if (wasConnected) {
        this._emit('signal:disconnected', { reason: e && e.reason ? e.reason : 'unknown' });
        this._reconnectAttempts += 1;
        this._scheduleReconnect();
      }
    }

    _scheduleReconnect() {
      if (this._destroyed) return;
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
      if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        this.log.error(`[SignalManager] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached.`);
        this._emit('signal:error', { type: 'max-reconnect', attempts: this._reconnectAttempts });
        return;
      }
      const baseDelay = RECONNECT_BASE_DELAY * Math.pow(2, this._reconnectAttempts);
      const jitter = Math.random() * 1000;
      const delay = Math.min(RECONNECT_MAX_DELAY, baseDelay) + jitter;
      this.log.info(`[SignalManager] Reconnecting in ${Math.round(delay)}ms (attempt ${this._reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
      this._reconnectTimer = setTimeout(() => {
        this.connect(this._wsUrl);
      }, delay);
    }

    _handleMessage(raw) {
      if (raw === '__pong__') {
        this._lastPong = Date.now();
        if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
        return;
      }
      if (raw === '__ping__') {
        this._sendPong();
        return;
      }
      const msg = this._decode(raw);
      if (!msg || !msg.type) { this.log.debug('[SignalManager] Received malformed message', raw); return; }

      const handlers = this._handlers.get(msg.type) || [];
      handlers.forEach(fn => { try { fn(msg); } catch (e) { this.log.error(`[SignalManager] Handler error for type ${msg.type}`, e); } });

      const { type, ...rest } = msg;
      switch (type) {
        case 'join':
          this._emit('signal:peer-joined', { peerId: msg.peerId, ...rest });
          break;
        case 'join-room':
          this._emit('signal:peer-joined', { peerId: msg.peerId, room: msg.room, ...rest });
          break;
        case 'leave-room':
          this._emit('signal:peer-left', { peerId: msg.peerId, room: msg.room });
          break;
        case 'peer-list':
          this._emit('signal:peer-list', { peers: msg.peers || [] });
          break;
        case 'offer':
          this._emit('signal:offer', { peerId: msg.from || msg.peerId, sdp: msg.sdp, ...rest });
          break;
        case 'answer':
          this._emit('signal:answer', { peerId: msg.from || msg.peerId, sdp: msg.sdp, ...rest });
          break;
        case 'ice-candidate':
          this._emit('signal:ice-candidate', { peerId: msg.from || msg.peerId, candidate: msg.candidate, ...rest });
          break;
        case 'relay':
          this._emit('signal:relay', { peerId: msg.from || msg.peerId, payload: msg.payload, ...rest });
          break;
        case 'peer-left':
          this._emit('signal:peer-left', { peerId: msg.peerId });
          break;
        case 'error':
          this._emit('signal:error', { code: msg.code, message: msg.message });
          break;
        default:
          this._emit('signal:error', { type: 'unknown-type', raw: msg });
      }
    }

    on(type, fn) {
      if (!this._handlers.has(type)) this._handlers.set(type, []);
      this._handlers.get(type).push(fn);
      return () => {
        const arr = this._handlers.get(type);
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx !== -1) arr.splice(idx, 1);
      };
    }

    off(type, fn) {
      const arr = this._handlers.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    }

    _isRateLimited() {
      const now = Date.now();
      const windowStart = now - 60000;
      this._messageTimestamps = this._messageTimestamps.filter(ts => ts > windowStart);
      return this._messageTimestamps.length >= RATE_LIMIT;
    }

    _recordSend() {
      this._messageTimestamps.push(Date.now());
    }

    _sendRaw(data) {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) { return false; }
      const raw = this._encode(data);
      if (!raw) return false;
      try {
        this._ws.send(raw);
        return true;
      } catch (e) { return false; }
    }

    send(msg) {
      if (this._destroyed) return false;
      if (this._isRateLimited()) {
        this._rateLimitQueue.push(msg);
        if (!this._processingRateLimit) {
          this._processingRateLimit = true;
          setTimeout(() => this._flushRateLimitQueue(), 1000);
        }
        this.log.warn('[SignalManager] Rate limited, message queued');
        return false;
      }
      this._recordSend();
      return this._sendRaw(msg);
    }

    _flushRateLimitQueue() {
      if (this._destroyed) { this._processingRateLimit = false; return; }
      while (this._rateLimitQueue.length > 0 && !this._isRateLimited()) {
        const msg = this._rateLimitQueue.shift();
        this._recordSend();
        this._sendRaw(msg);
      }
      if (this._rateLimitQueue.length > 0 && !this._destroyed) {
        setTimeout(() => this._flushRateLimitQueue(), 1000);
      } else {
        this._processingRateLimit = false;
      }
    }

    sendJoin(peerId, publicKey, name) {
      return this.send({ type: 'join', peerId, publicKey, name });
    }

    sendJoinRoom(room, peerId, publicKey) {
      return this.send({ type: 'join-room', room, peerId, publicKey });
    }

    sendLeaveRoom(room, peerId) {
      return this.send({ type: 'leave-room', room, peerId });
    }

    sendOffer(to, from, sdp, publicKey, name) {
      return this.send({ type: 'offer', to, from, sdp, publicKey, name });
    }

    sendAnswer(to, from, sdp) {
      return this.send({ type: 'answer', to, from, sdp });
    }

    sendIceCandidate(to, from, candidate) {
      return this.send({ type: 'ice-candidate', to, from, candidate });
    }

    sendRelay(to, from, payload) {
      return this.send({ type: 'relay', to, from, payload });
    }

    disconnect() {
      this._destroyed = true;
      this._stopHeartbeat();
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
      this._reconnectAttempts = 0;
      this._rateLimitQueue = [];
      if (this._ws) { try { this._ws.close(1000, 'manual'); } catch (e) {} this._ws = null; }
      this._emit('signal:disconnected', { reason: 'manual' });
    }

    destroy() {
      this.disconnect();
    }

    getUrl() { return this._wsUrl; }
  }

  G.GhostLink = G.GhostLink || {};
  G.GhostLink.SignalManager = SignalManager;
})(typeof globalThis !== 'undefined' ? globalThis : this);