// DataExportManager — Handles data export (free: 500 blocks, pro: full)
// Export format: encrypted JSON archive with integrity hashes and metadata
(function(exports) {
  'use strict';

  /**
   * Export format version
   * @type {number}
   */
  const EXPORT_VERSION = 1;

  /**
   * Free tier export limit
   * @type {number}
   */
  const FREE_EXPORT_LIMIT = 500;

  /**
   * Export file extension
   * @type {string}
   */
  const EXPORT_EXTENSION = '.ghostlink';

  /**
   * DataExportManager — Manages data export for GhostLink
   * @class
   */
  class DataExportManager {
    /**
     * Creates a new DataExportManager
     * @param {Object} [options={}] - Configuration options
     * @param {Object} [options.featureGate] - FeatureGateManager instance
     * @param {Object} [options.chainProvider] - Provider of chain data
     * @param {Object} [options.workspaceManager] - WorkspaceManager instance
     */
    constructor(options = {}) {
      /** @type {Object} FeatureGateManager instance */
      this._featureGate = options.featureGate || null;
      /** @type {Object} Chain data provider */
      this._chainProvider = options.chainProvider || null;
      /** @type {Object} WorkspaceManager instance */
      this._workspaceManager = options.workspaceManager || null;
      /** @type {boolean} Is destroyed */
      this._destroyed = false;
    }

    /**
     * Sets the feature gate manager
     * @param {Object} fg - FeatureGateManager instance
     */
    setFeatureGate(fg) {
      this._featureGate = fg;
    }

    /**
     * Sets the chain provider
     * @param {Object} provider - Chain data provider
     */
    setChainProvider(provider) {
      this._chainProvider = provider;
    }

    /**
     * Sets the workspace manager
     * @param {Object} wm - WorkspaceManager instance
     */
    setWorkspaceManager(wm) {
      this._workspaceManager = wm;
    }

    /**
     * Gets the export limit for current tier
     * @returns {Promise<number>} Export block limit
     */
    async getExportLimit() {
      if (!this._featureGate) return FREE_EXPORT_LIMIT;

      const canFullExport = await this._featureGate.can('full_export');
      return canFullExport ? Infinity : FREE_EXPORT_LIMIT;
    }

    /**
     * Checks if full export is available
     * @returns {Promise<boolean>} True if full export available
     */
    async canFullExport() {
      if (!this._featureGate) return false;
      return await this._featureGate.can('full_export');
    }

    /**
     * Exports chain data
     * @param {Object} [options={}] - Export options
     * @param {string} [options.workspaceId] - Specific workspace to export (optional)
     * @returns {Promise<{success: boolean, data: ?Object, error: ?string}>}
     */
    async exportChain(options = {}) {
      if (this._destroyed) {
        return { success: false, data: null, error: 'DataExportManager destroyed' };
      }

      const workspaceId = options.workspaceId || null;

      // Get export limit
      const limit = await this.getExportLimit();
      const isFullExport = limit === Infinity;

      try {
        // Gather export data
        const exportData = {
          version: EXPORT_VERSION,
          exportedAt: Date.now(),
          exportType: isFullExport ? 'full' : 'limited',
          limit: limit,
          metadata: this._createMetadata(),
          chain: [],
          workspaces: []
        };

        // Get chain data
        if (this._chainProvider) {
          const chainData = await this._getChainData(limit, workspaceId);
          exportData.chain = chainData;
        }

        // Get workspace data
        if (this._workspaceManager) {
          const workspaces = await this._getWorkspaceData(workspaceId);
          exportData.workspaces = workspaces;
        }

        // Calculate integrity hash
        exportData.integrityHash = await this._calculateIntegrityHash(exportData);

        // Encrypt export data
        const encrypted = await this._encryptExport(exportData);

        return {
          success: true,
          data: {
            ...encrypted,
            metadata: exportData.metadata,
            integrityHash: exportData.integrityHash
          },
          error: null
        };

      } catch (e) {
        return { success: false, data: null, error: e.message };
      }
    }

    /**
     * Creates export metadata
     * @returns {Object} Metadata object
     * @private
     */
    _createMetadata() {
      return {
        app: 'GhostLink',
        version: '1.0.0',
        platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
        exportVersion: EXPORT_VERSION,
        createdAt: Date.now()
      };
    }

    /**
     * Gets chain data with limit applied
     * @param {number} limit - Block limit
     * @param {string} [workspaceId] - Specific workspace (optional)
     * @returns {Promise<Array>} Chain blocks
     * @private
     */
    async _getChainData(limit, workspaceId) {
      if (!this._chainProvider) return [];

      let chain = [];

      if (workspaceId && this._workspaceManager) {
        // Get specific workspace chain
        const workspace = this._workspaceManager.getWorkspace(workspaceId);
        if (workspace) {
          chain = workspace.chain || [];
        }
      } else if (this._chainProvider.getChain) {
        // Get main chain
        chain = await this._chainProvider.getChain();
      }

      // Apply limit (last N blocks for free tier)
      if (limit !== Infinity && chain.length > limit) {
        return chain.slice(-limit);
      }

      return chain;
    }

    /**
     * Gets workspace data for export
     * @param {string} [workspaceId] - Specific workspace (optional)
     * @returns {Promise<Array>} Workspace data
     * @private
     */
    async _getWorkspaceData(workspaceId) {
      if (!this._workspaceManager) return [];

      const workspaces = workspaceId
        ? [this._workspaceManager.getWorkspace(workspaceId)].filter(Boolean)
        : this._workspaceManager.getWorkspaces();

      // Strip sensitive data from workspaces
      return workspaces.map(ws => ({
        id: ws.id,
        name: ws.name,
        createdAt: ws.createdAt,
        memberCount: ws.members ? ws.members.length : 0,
        // Don't include workspaceKey or sensitive member data
        // In production, would encrypt member list separately
        chainLength: ws.chain ? ws.chain.length : 0
      }));
    }

    /**
     * Calculates integrity hash for export data
     * @param {Object} data - Data to hash
     * @returns {Promise<string>} SHA-256 hash
     * @private
     */
    async _calculateIntegrityHash(data) {
      // Create a copy without the hash itself for calculation
      const { integrityHash, ...dataWithoutHash } = data;

      const encoded = new TextEncoder().encode(JSON.stringify(dataWithoutHash));
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
      return this._arrayBufferToHex(hashBuffer);
    }

    /**
     * Encrypts export data
     * @param {Object} data - Data to encrypt
     * @returns {Promise<Object>} Encrypted data with iv
     * @private
     */
    async _encryptExport(data) {
      const jsonString = JSON.stringify(data);
      const encoded = new TextEncoder().encode(jsonString);

      // Generate key from password or random
      const key = await this._generateExportKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));

      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encoded
      );

      return {
        iv: this._arrayBufferToBase64(iv.buffer),
        data: this._arrayBufferToBase64(encrypted)
      };
    }

    /**
     * Generates encryption key for export
     * @returns {Promise<CryptoKey>} AES-GCM key
     * @private
     */
    async _generateExportKey() {
      // In production, could derive from user password
      // For now, generate a random key
      return crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
    }

    /**
     * Imports and decrypts export data
     * @param {Object} importData - Encrypted export data
     * @param {CryptoKey} key - Decryption key
     * @returns {Promise<{success: boolean, data: ?Object, error: ?string}>}
     */
    async importExport(importData, key) {
      try {
        const iv = this._hexToArrayBuffer(importData.iv);
        const encrypted = this._hexToArrayBuffer(importData.data);

        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: iv },
          key,
          encrypted
        );

        const jsonString = new TextDecoder().decode(decrypted);
        const data = JSON.parse(jsonString);

        // Verify integrity
        if (data.integrityHash) {
          const calculatedHash = await this._calculateIntegrityHash(data);
          if (calculatedHash !== data.integrityHash) {
            return { success: false, data: null, error: 'Integrity check failed' };
          }
        }

        return { success: true, data: data, error: null };

      } catch (e) {
        return { success: false, data: null, error: e.message };
      }
    }

    /**
     * Generates export filename
     * @returns {string} Filename
     */
    generateFilename() {
      const date = new Date().toISOString().split('T')[0];
      return `ghostlink-export-${date}${EXPORT_EXTENSION}`;
    }

    /**
     * Converts ArrayBuffer to hex string
     * @param {ArrayBuffer} buffer - Buffer to convert
     * @returns {string} Hex string
     * @private
     */
    _arrayBufferToHex(buffer) {
      return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }

    /**
     * Converts ArrayBuffer to Base64 string
     * @param {ArrayBuffer} buffer - Buffer to convert
     * @returns {string} Base64 string
     * @private
     */
    _arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }

    /**
     * Converts hex string to ArrayBuffer
     * @param {string} hex - Hex string
     * @returns {ArrayBuffer} ArrayBuffer
     * @private
     */
    _hexToArrayBuffer(hex) {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
      }
      return bytes.buffer;
    }

    /**
     * Destroys the DataExportManager
     */
    destroy() {
      this._destroyed = true;
      this._featureGate = null;
      this._chainProvider = null;
      this._workspaceManager = null;
    }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.DataExportManager = DataExportManager;
  exports.GhostLink.EXPORT_VERSION = EXPORT_VERSION;
  exports.GhostLink.FREE_EXPORT_LIMIT = FREE_EXPORT_LIMIT;

})(typeof globalThis !== 'undefined' ? globalThis : this);