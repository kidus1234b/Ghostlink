// SecurityHardening — Performance and security hardening for GhostLink Pro
// Addresses: license parsing crashes, malformed keys, storage corruption,
// replayed invites, stale keys, memory leaks, and performance optimization
(function(exports) {
  'use strict';

  /**
   * Maximum storage size limit (5MB)
   * @type {number}
   */
  const MAX_STORAGE_SIZE = 5 * 1024 * 1024;

  /**
   * Replay cache max age (5 minutes)
   * @type {number}
   */
  const REPLAY_CACHE_MAX_AGE = 5 * 60 * 1000;

  /**
   * Invite validity period (7 days)
   * @type {number}
   */
  const INVITE_VALIDITY_PERIOD = 7 * 24 * 60 * 60 * 1000;

  /**
   * Revoked key cache max age (1 hour)
   * @type {number}
   */
  const REVOKED_KEY_MAX_AGE = 60 * 60 * 1000;

  /**
   * SecurityHardening — Security and performance hardening utilities
   * @class
   */
  class SecurityHardening {
    /**
     * Creates a new SecurityHardening instance
     */
    constructor() {
      /** @type {Set<string>} Seen invite signatures */
      this._seenInvites = new Map();
      /** @type {Set<string>} Revoked workspace keys */
      this._revokedKeys = new Map();
      /** @type {WeakMap} Object to cleanup function mapping */
      this._cleanupHandlers = new WeakMap();
      /** @type {boolean} Is destroyed */
      this._destroyed = false;
    }

    // ═══════════════════════════════════════════════════════════════════
    // INPUT VALIDATION & SANITIZATION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Validates and sanitizes license key input
     * Prevents malformed key exploits
     * @param {string} key - License key to validate
     * @returns {{valid: boolean, sanitized: ?string, error: ?string}}
     */
    validateLicenseKey(key) {
      if (typeof key !== 'string') {
        return { valid: false, sanitized: null, error: 'Key must be a string' };
      }

      // Length check
      if (key.length < 10 || key.length > 100) {
        return { valid: false, sanitized: null, error: 'Invalid key length' };
      }

      // Allowed characters only (after removing dashes)
      const cleanKey = key.replace(/-/g, '');
      if (!/^[A-Z0-9]+$/.test(cleanKey)) {
        return { valid: false, sanitized: null, error: 'Invalid characters in key' };
      }

      // Sanitize: trim and uppercase
      const sanitized = key.trim().toUpperCase();

      // Check for obvious injection patterns
      if (this._containsInjectionPattern(sanitized)) {
        return { valid: false, sanitized: null, error: 'Suspicious key pattern detected' };
      }

      return { valid: true, sanitized: sanitized, error: null };
    }

    /**
     * Checks for injection patterns
     * @param {string} input - Input to check
     * @returns {boolean} True if suspicious pattern found
     * @private
     */
    _containsInjectionPattern(input) {
      const patterns = [
        /<script/i,
        /javascript:/i,
        /data:/i,
        /vbscript:/i,
        /\.\./,  // Path traversal
        /[\x00-\x1f]/  // Control characters
      ];

      for (const pattern of patterns) {
        if (pattern.test(input)) {
          return true;
        }
      }

      return false;
    }

    /**
     * Validates workspace invite structure
     * @param {Object} invite - Invite to validate
     * @returns {{valid: boolean, error: ?string}}
     */
    validateWorkspaceInvite(invite) {
      if (!invite || typeof invite !== 'object') {
        return { valid: false, error: 'Invite must be an object' };
      }

      // Required fields
      const required = ['workspaceId', 'inviter', 'signature', 'createdAt', 'expiresAt'];
      for (const field of required) {
        if (!(field in invite)) {
          return { valid: false, error: `Missing required field: ${field}` };
        }
      }

      // Validate types
      if (typeof invite.workspaceId !== 'string') {
        return { valid: false, error: 'Invalid workspaceId type' };
      }

      if (typeof invite.signature !== 'string') {
        return { valid: false, error: 'Invalid signature type' };
      }

      if (typeof invite.createdAt !== 'number' || typeof invite.expiresAt !== 'number') {
        return { valid: false, error: 'Invalid timestamp type' };
      }

      // Check timestamp sanity
      const now = Date.now();
      if (invite.createdAt > now + 60000 || invite.createdAt < now - INVITE_VALIDITY_PERIOD * 2) {
        return { valid: false, error: 'Suspicious timestamp' };
      }

      return { valid: true, error: null };
    }

    // ═══════════════════════════════════════════════════════════════════
    // REPLAY PROTECTION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Checks if invite signature has been seen (replay protection)
     * @param {string} signature - Invite signature
     * @returns {boolean} True if this is a replay
     */
    isReplayedInvite(signature) {
      // Check cache first
      if (this._seenInvites.has(signature)) {
        const timestamp = this._seenInvites.get(signature);
        if (Date.now() - timestamp < REPLAY_CACHE_MAX_AGE) {
          return true; // Recent replay
        }
        // Old entry, clean up
        this._seenInvites.delete(signature);
      }
      return false;
    }

    /**
     * Records an invite signature
     * @param {string} signature - Invite signature
     */
    recordInviteSignature(signature) {
      // Clean old entries periodically
      if (this._seenInvites.size > 1000) {
        this._cleanupReplayCache();
      }

      this._seenInvites.set(signature, Date.now());
    }

    /**
     * Cleans up expired entries from replay cache
     * @private
     */
    _cleanupReplayCache() {
      const now = Date.now();
      for (const [signature, timestamp] of this._seenInvites) {
        if (now - timestamp > REPLAY_CACHE_MAX_AGE) {
          this._seenInvites.delete(signature);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // REVOKED KEY MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Marks a workspace key as revoked
     * @param {string} workspaceId - Workspace ID
     * @param {string} keyId - Key identifier
     */
    markKeyRevoked(workspaceId, keyId) {
      const key = `${workspaceId}:${keyId}`;
      this._revokedKeys.set(key, Date.now());
    }

    /**
     * Checks if a workspace key has been revoked
     * @param {string} workspaceId - Workspace ID
     * @param {string} keyId - Key identifier
     * @returns {boolean} True if revoked
     */
    isKeyRevoked(workspaceId, keyId) {
      const key = `${workspaceId}:${keyId}`;

      if (!this._revokedKeys.has(key)) {
        return false;
      }

      const revokedAt = this._revokedKeys.get(key);

      // Check if still valid (revocation expires after REVOKED_KEY_MAX_AGE)
      if (Date.now() - revokedAt > REVOKED_KEY_MAX_AGE) {
        this._revokedKeys.delete(key);
        return false;
      }

      return true;
    }

    /**
     * Clears all revoked keys
     */
    clearRevokedKeys() {
      this._revokedKeys.clear();
    }

    // ═══════════════════════════════════════════════════════════════════
    // STORAGE VALIDATION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Validates storage quota
     * @returns {{valid: boolean, usedBytes: number, error: ?string}}
     */
    validateStorageQuota() {
      try {
        let totalSize = 0;

        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) {
            const value = localStorage.getItem(key);
            if (value) {
              totalSize += key.length + value.length;
            }
          }
        }

        if (totalSize > MAX_STORAGE_SIZE) {
          return {
            valid: false,
            usedBytes: totalSize,
            error: `Storage quota exceeded (${totalSize} / ${MAX_STORAGE_SIZE})`
          };
        }

        return { valid: true, usedBytes: totalSize, error: null };

      } catch (e) {
        return { valid: false, usedBytes: 0, error: 'Storage access failed' };
      }
    }

    /**
     * Safely parses JSON with error handling
     * @param {string} json - JSON string to parse
     * @returns {{success: boolean, data: ?Object, error: ?string}}
     */
    safeParseJSON(json) {
      try {
        const data = JSON.parse(json);
        return { success: true, data: data, error: null };
      } catch (e) {
        return { success: false, data: null, error: e.message };
      }
    }

    /**
     * Validates license storage structure
     * @param {Object} license - License object to validate
     * @returns {{valid: boolean, error: ?string}}
     */
    validateLicenseStorage(license) {
      if (!license || typeof license !== 'object') {
        return { valid: false, error: 'License must be an object' };
      }

      const required = ['key', 'tier', 'activatedAt', 'expiresAt', 'fingerprint'];
      for (const field of required) {
        if (!(field in license)) {
          return { valid: false, error: `Missing field: ${field}` };
        }
      }

      // Type checks
      if (typeof license.key !== 'string') {
        return { valid: false, error: 'Invalid key type' };
      }

      if (typeof license.tier !== 'string') {
        return { valid: false, error: 'Invalid tier type' };
      }

      if (typeof license.activatedAt !== 'number' || typeof license.expiresAt !== 'number') {
        return { valid: false, error: 'Invalid timestamp types' };
      }

      // Sanity checks
      if (license.activatedAt > Date.now() + 60000) {
        return { valid: false, error: 'Activation time in future' };
      }

      if (license.expiresAt < 0) {
        return { valid: false, error: 'Negative expiry time' };
      }

      return { valid: true, error: null };
    }

    // ═══════════════════════════════════════════════════════════════════
    // MEMORY MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Registers a cleanup handler for an object
     * @param {Object} obj - Object to track
     * @param {Function} cleanup - Cleanup function
     */
    registerCleanup(obj, cleanup) {
      if (obj && typeof cleanup === 'function') {
        this._cleanupHandlers.set(obj, cleanup);
      }
    }

    /**
     * Cleans up an object
     * @param {Object} obj - Object to cleanup
     */
    cleanup(obj) {
      if (this._cleanupHandlers.has(obj)) {
        const cleanup = this._cleanupHandlers.get(obj);
        try {
          cleanup();
        } catch (e) {
          // Ignore cleanup errors
        }
        this._cleanupHandlers.delete(obj);
      }
    }

    /**
     * Creates a bounded cache with automatic cleanup
     * @param {number} maxSize - Maximum cache size
     * @returns {Object} Bounded cache object
     */
    createBoundedCache(maxSize = 100) {
      const cache = new Map();
      let size = 0;

      return {
        get(key) {
          return cache.get(key);
        },
        set(key, value) {
          if (cache.has(key)) {
            cache.set(key, value);
            return;
          }

          if (size >= maxSize) {
            // Remove oldest entry
            const firstKey = cache.keys().next().value;
            cache.delete(firstKey);
            size--;
          }

          cache.set(key, value);
          size++;
        },
        has(key) {
          return cache.has(key);
        },
        delete(key) {
          if (cache.delete(key)) {
            size--;
            return true;
          }
          return false;
        },
        clear() {
          cache.clear();
          size = 0;
        },
        get size() {
          return size;
        }
      };
    }

    /**
     * Creates a debounced function
     * @param {Function} fn - Function to debounce
     * @param {number} delay - Delay in ms
     * @returns {Function} Debounced function
     */
    debounce(fn, delay) {
      let timeoutId = null;

      const debounced = (...args) => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }

        timeoutId = setTimeout(() => {
          fn(...args);
          timeoutId = null;
        }, delay);
      };

      debounced.cancel = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      return debounced;
    }

    /**
     * Creates a throttled function
     * @param {Function} fn - Function to throttle
     * @param {number} limit - Minimum time between calls in ms
     * @returns {Function} Throttled function
     */
    throttle(fn, limit) {
      let lastCall = 0;
      let timeoutId = null;

      const throttled = (...args) => {
        const now = Date.now();

        if (now - lastCall >= limit) {
          lastCall = now;
          fn(...args);
        } else {
          // Schedule trailing call
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          timeoutId = setTimeout(() => {
            lastCall = Date.now();
            fn(...args);
            timeoutId = null;
          }, limit - (now - lastCall));
        }
      };

      throttled.cancel = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      return throttled;
    }

    // ═══════════════════════════════════════════════════════════════════
    // DESTRUCTION
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Destroys the SecurityHardening instance
     */
    destroy() {
      this._destroyed = true;
      this._seenInvites.clear();
      this._revokedKeys.clear();
      this._cleanupHandlers = new WeakMap();
    }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.SecurityHardening = SecurityHardening;

})(typeof globalThis !== 'undefined' ? globalThis : this);