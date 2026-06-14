// KeyManager — GhostLink session key management, nonce tracking, key rotation
(function(exports) {
  'use strict';

  /**
   * NonceTracker - Tracks seen nonces to prevent replay attacks
   * Maintains a rolling window of observed nonces with timestamps
   * @class
   */
  class NonceTracker {
    /**
     * Creates a new NonceTracker
     * @param {number} [maxTrack=1000] - Maximum nonces to track
     */
    constructor(maxTrack = 1000) {
      /** @type {Map<string, number>} Nonce to timestamp mapping */
      this._seen = new Map();
      /** @type {number} Maximum nonces to track */
      this._maxTrack = maxTrack;
    }

    /**
     * Checks if a nonce is unique (not been seen before)
     * @param {string} nonce - Nonce value to check
     * @returns {boolean} True if nonce is new and now marked as seen
     */
    isUnique(nonce) {
      if (this._seen.has(nonce)) return false;
      this._seen.set(nonce, Date.now());
      if (this._seen.size > this._maxTrack) {
        const oldest = [...this._seen.entries()].sort((a, b) => a[1] - b[1])[0];
        this._seen.delete(oldest[0]);
      }
      return true;
    }

    /**
     * Clears all tracked nonces
     */
    clear() { this._seen.clear(); }

    /**
     * Gets the current number of tracked nonces
     * @returns {number} Number of nonces being tracked
     */
    get size() { return this._seen.size; }
  }

  /**
   * KeyManager - Manages session keys, nonces, key rotation, and encryption
   * Handles deriving cryptographic keys from master keys and maintains per-peer sessions
   * @class
   */
  class KeyManager {
    /**
     * Creates a new KeyManager
     * @param {Object} [options={}] - Configuration options
     * @param {number} [options.maxNonceTrack=2000] - Maximum nonces to track per peer
     * @param {number} [options.rotationIntervalMs] - Key rotation interval (default 7 days)
     * @param {number} [options.sessionExpiryMs] - Session expiry time (default 24 hours)
     * @param {Object} [options.logger] - Logger instance for debug output
     */
    constructor(options = {}) {
      /** @type {Map<string, Object>} Peer ID to session data mapping */
      this._sessionKeys = new Map();
      /** @type {NonceTracker} Global nonce tracker for replay protection */
      this._nonceTracker = new NonceTracker(options.maxNonceTrack || 2000);
      /** @type {number} Key rotation interval in milliseconds */
      this._rotationInterval = options.rotationIntervalMs || (7 * 24 * 60 * 60 * 1000);
      /** @type {number} Session expiry time in milliseconds */
      this._sessionExpiry = options.sessionExpiryMs || (24 * 60 * 60 * 1000);
      /** @type {Map<string, number>} Peer ID to rotation timer mapping */
      this._rotationTimers = new Map();
      /** @type {Object} Logger instance */
      this._log = options.logger || { info: () => {}, error: console.error };
    }

    /**
     * Derives a cryptographic key from a master key using PBKDF2
     * @param {BufferSource} masterKey - Master key material
     * @param {string} info - Context-specific info string for key derivation
     * @returns {Promise<CryptoKey>} Derived AES-GCM 256-bit key
     */
    async deriveKey(masterKey, info) {
      const enc = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        masterKey,
        'PBKDF2',
        false,
        ['deriveBits', 'deriveKey']
      );
      return crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: enc.encode(info),
          iterations: 100000,
          hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }

    /**
     * Initializes a session for a peer with new derived keys
     * @param {string} peerId - Peer identifier
     * @param {BufferSource} masterKey - Master key material for derivation
     * @returns {Promise<{sendKey: CryptoKey, recvKey: CryptoKey}>} Session key pair
     */
    async initSession(peerId, masterKey) {
      const now = Date.now();
      const sendInfo = `ghostlink-send-${peerId}-${now}`;
      const recvInfo = `ghostlink-recv-${peerId}-${now}`;
      const sendKey = await this.deriveKey(masterKey, sendInfo);
      const recvKey = await this.deriveKey(masterKey, recvInfo);

      this._sessionKeys.set(peerId, {
        sendKey,
        recvKey,
        masterKey,
        createdAt: now,
        rotatedAt: now,
        messageCount: 0,
      });

      this._scheduleRotation(peerId);
      return { sendKey, recvKey };
    }

    /**
     * Gets the session data for a peer
     * @param {string} peerId - Peer identifier
     * @returns {Object|null} Session data or null if not found
     */
    getSession(peerId) { return this._sessionKeys.get(peerId) || null; }

    /**
     * Rotates the keys for a peer by deriving new key pairs
     * @param {string} peerId - Peer identifier
     * @returns {Promise<boolean>} True if rotation succeeded
     */
    async rotateKey(peerId) {
      const session = this._sessionKeys.get(peerId);
      if (!session) return false;

      const newSendInfo = `ghostlink-send-${peerId}-${Date.now()}`;
      const newRecvInfo = `ghostlink-recv-${peerId}-${Date.now()}`;
      session.sendKey = await this.deriveKey(session.masterKey, newSendInfo);
      session.recvKey = await this.deriveKey(session.masterKey, newRecvInfo);
      session.rotatedAt = Date.now();
      this._log.info(`Key rotated for ${peerId}`);
      return true;
    }

    /**
     * Schedules automatic key rotation for a peer
     * @param {string} peerId - Peer identifier
     * @private
     */
    _scheduleRotation(peerId) {
      if (this._rotationTimers.has(peerId)) {
        clearTimeout(this._rotationTimers.get(peerId));
      }
      const timer = setTimeout(() => {
        this.rotateKey(peerId);
        this._scheduleRotation(peerId);
      }, this._rotationInterval);
      this._rotationTimers.set(peerId, timer);
    }

    /**
     * Checks if a nonce is unique across all sessions
     * @param {string} nonce - Nonce value to check
     * @returns {boolean} True if nonce is new
     */
    isNonceUnique(nonce) { return this._nonceTracker.isUnique(nonce); }

    /**
     * Encrypts data using the peer's session key
     * @param {string} data - Plaintext data to encrypt
     * @param {string} peerId - Peer identifier
     * @returns {Promise<{iv: Uint8Array, ciphertext: ArrayBuffer, messageCount: number}>} Encrypted data
     * @throws {Error} If no session exists for peer
     */
    async encrypt(data, peerId) {
      const session = this._sessionKeys.get(peerId);
      if (!session) throw new Error('No session for ' + peerId);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(data);
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        session.sendKey,
        encoded
      );
      return { iv, ciphertext, messageCount: ++session.messageCount };
    }

    /**
     * Decrypts data using the peer's session key
     * @param {Uint8Array} iv - Initialization vector used for encryption
     * @param {ArrayBuffer} ciphertext - Encrypted data
     * @param {string} peerId - Peer identifier
     * @returns {Promise<string>} Decrypted plaintext
     * @throws {Error} If no session exists for peer
     */
    async decrypt(iv, ciphertext, peerId) {
      const session = this._sessionKeys.get(peerId);
      if (!session) throw new Error('No session for ' + peerId);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        session.recvKey,
        ciphertext
      );
      return new TextDecoder().decode(decrypted);
    }

    /**
     * Destroys a peer's session and clears associated timers
     * @param {string} peerId - Peer identifier
     */
    destroySession(peerId) {
      this._sessionKeys.delete(peerId);
      this._nonceTracker.clear();
      if (this._rotationTimers.has(peerId)) {
        clearTimeout(this._rotationTimers.get(peerId));
        this._rotationTimers.delete(peerId);
      }
    }

    /**
     * Destroys all peer sessions and clears all timers
     */
    destroyAll() {
      for (const peerId of this._sessionKeys.keys()) {
        this.destroySession(peerId);
      }
    }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.KeyManager = KeyManager;
  exports.GhostLink.NonceTracker = NonceTracker;
})(typeof globalThis !== 'undefined' ? globalThis : this);
