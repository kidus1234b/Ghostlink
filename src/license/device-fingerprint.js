// DeviceFingerprintManager — Creates deterministic device fingerprint from public key
// Privacy-preserving: no hardware/browser fingerprinting abuse
(function(exports) {
  'use strict';

  /**
   * License tier constants
   * @enum {string}
   */
  const LICENSE_TIER = {
    FREE: 'free',
    PRO: 'pro',
    TEAM: 'team',
    ENTERPRISE: 'enterprise'
  };

  /**
   * Default feature limits for free tier
   */
  const FREE_LIMITS = {
    maxPeers: 5,
    maxTransferBytes: 25 * 1024 * 1024, // 25MB
    exportDepth: 500,
    workspaces: 0,
    themes: ['default']
  };

  /**
   * Feature names available for gating
   * @enum {string}
   */
  const FEATURE_NAME = {
    UNLIMITED_PEERS: 'unlimited_peers',
    LARGE_FILE_TRANSFER: 'large_file_transfer',
    FULL_EXPORT: 'full_export',
    TEAM_WORKSPACES: 'team_workspaces',
    PRO_THEMES: 'pro_themes'
  };

  /**
   * DeviceFingerprintManager — Generates and validates device fingerprints
   * Uses SHA256(pubKeyHex) for deterministic, privacy-preserving identification
   * @class
   */
  class DeviceFingerprintManager {
    /**
     * Creates a new DeviceFingerprintManager
     * @param {Object} [options={}] - Configuration options
     * @param {Object} [options.keyManager] - KeyManager instance for pubKey access
     */
    constructor(options = {}) {
      /** @type {Object|null} Cached fingerprint */
      this._cachedFingerprint = null;
      /** @type {Object|null} Cached public key hex */
      this._cachedPubKeyHex = null;
      /** @type {Object} KeyManager instance */
      this._keyManager = options.keyManager || null;
    }

    /**
     * Gets the public key hex from KeyManager or generates a mock one
     * @returns {Promise<string>} Public key as hex string
     */
    async getPubKeyHex() {
      if (this._cachedPubKeyHex) {
        return this._cachedPubKeyHex;
      }

      let pubKeyHex = null;

      // Try to get from KeyManager
      if (this._keyManager) {
        try {
          // KeyManager stores identity key pair, try to get public key
          const pubKey = await this._getPublicKeyFromKeyManager();
          if (pubKey) {
            pubKeyHex = this._pubKeyToHex(pubKey);
          }
        } catch (e) {
          // Fall through to alternative methods
        }
      }

      // Fallback: generate deterministic key from available sources
      if (!pubKeyHex) {
        pubKeyHex = await this._generateFallbackPubKey();
      }

      this._cachedPubKeyHex = pubKeyHex;
      return pubKeyHex;
    }

    /**
     * Gets public key from KeyManager if available
     * @returns {Promise<CryptoKey|null>}
     * @private
     */
    async _getPublicKeyFromKeyManager() {
      // KeyManager doesn't directly expose pubKey, but we can derive from stored keys
      // Look for identity key in key manager storage
      if (this._keyManager._identityKey) {
        const exported = await crypto.subtle.exportKey('spki', this._keyManager._identityKey);
        return new Uint8Array(exported);
      }
      return null;
    }

    /**
     * Converts public key to hex string
     * @param {Uint8Array} pubKey - Public key bytes
     * @returns {string} Hex string
     * @private
     */
    _pubKeyToHex(pubKey) {
      return Array.from(pubKey)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }

    /**
     * Generates a fallback deterministic pubKey based on stored identity
     * @returns {Promise<string>} Deterministic hex string
     * @private
     */
    async _generateFallbackPubKey() {
      // Try to get stored identity key from localStorage
      const storedIdentity = localStorage.getItem('gl_identity');
      if (storedIdentity) {
        try {
          const parsed = JSON.parse(storedIdentity);
          const hex = parsed.pubKeyHex || parsed.publicKeyHex;
          if (hex) return hex;
        } catch (e) {
          // Ignore parse errors
        }
      }

      // Generate new identity if none exists
      const keyPair = await crypto.subtle.generateKey(
        {
          name: 'ECDSA',
          namedCurve: 'P-256'
        },
        true,
        ['sign', 'verify']
      );

      const exported = await crypto.subtle.exportKey('spki', keyPair.publicKey);
      const pubKeyHex = this._pubKeyToHex(new Uint8Array(exported));

      // Store for future use
      try {
        localStorage.setItem('gl_identity', JSON.stringify({
          pubKeyHex: pubKeyHex,
          createdAt: Date.now()
        }));
      } catch (e) {
        // Storage might be full or unavailable
      }

      return pubKeyHex;
    }

    /**
     * Generates SHA256 fingerprint of public key hex
     * @returns {Promise<string>} 64-character hex fingerprint
     */
    async getFingerprint() {
      if (this._cachedFingerprint) {
        return this._cachedFingerprint;
      }

      const pubKeyHex = await this.getPubKeyHex();
      const fingerprint = await this._sha256(pubKeyHex);

      this._cachedFingerprint = fingerprint;
      return fingerprint;
    }

    /**
     * Computes SHA256 hash of input
     * @param {string} input - Input string to hash
     * @returns {Promise<string>} Hex-encoded hash
     * @private
     */
    async _sha256(input) {
      const encoded = new TextEncoder().encode(input);
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
      const hashArray = new Uint8Array(hashBuffer);
      return Array.from(hashArray)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }

    /**
     * Verifies a fingerprint matches expected value
     * @param {string} expected - Expected fingerprint
     * @returns {Promise<boolean>} True if matches
     */
    async verifyFingerprint(expected) {
      const actual = await this.getFingerprint();
      return actual === expected;
    }

    /**
     * Exports current fingerprint for storage
     * @returns {Promise<Object>} Exportable fingerprint data
     */
    async export() {
      return {
        fingerprint: await this.getFingerprint(),
        pubKeyHex: await this.getPubKeyHex(),
        exportedAt: Date.now()
      };
    }

    /**
     * Clears cached fingerprint (forces recomputation)
     */
    clearCache() {
      this._cachedFingerprint = null;
      this._cachedPubKeyHex = null;
    }
  }

  // Export symbols
  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.DeviceFingerprintManager = DeviceFingerprintManager;
  exports.GhostLink.LICENSE_TIER = LICENSE_TIER;
  exports.GhostLink.FREE_LIMITS = FREE_LIMITS;
  exports.GhostLink.FEATURE_NAME = FEATURE_NAME;

})(typeof globalThis !== 'undefined' ? globalThis : this);