// FeatureGateManager — Centralized feature gating for GhostLink Pro
// All feature limits enforced centrally - no scattered if(isPro) checks
(function(exports) {
  'use strict';

  /**
   * Feature names
   * @enum {string}
   */
  const FEATURE = {
    UNLIMITED_PEERS: 'unlimited_peers',
    LARGE_FILE_TRANSFER: 'large_file_transfer',
    FULL_EXPORT: 'full_export',
    TEAM_WORKSPACES: 'team_workspaces',
    PRO_THEMES: 'pro_themes'
  };

  /**
   * Tier definitions with feature access
   * @type {Object}
   */
  const TIER_FEATURES = {
    free: {
      [FEATURE.UNLIMITED_PEERS]: false,
      [FEATURE.LARGE_FILE_TRANSFER]: false,
      [FEATURE.FULL_EXPORT]: false,
      [FEATURE.TEAM_WORKSPACES]: false,
      [FEATURE.PRO_THEMES]: false
    },
    pro: {
      [FEATURE.UNLIMITED_PEERS]: true,
      [FEATURE.LARGE_FILE_TRANSFER]: true,
      [FEATURE.FULL_EXPORT]: true,
      [FEATURE.TEAM_WORKSPACES]: false,
      [FEATURE.PRO_THEMES]: true
    },
    team: {
      [FEATURE.UNLIMITED_PEERS]: true,
      [FEATURE.LARGE_FILE_TRANSFER]: true,
      [FEATURE.FULL_EXPORT]: true,
      [FEATURE.TEAM_WORKSPACES]: true,
      [FEATURE.PRO_THEMES]: true
    },
    enterprise: {
      [FEATURE.UNLIMITED_PEERS]: true,
      [FEATURE.LARGE_FILE_TRANSFER]: true,
      [FEATURE.FULL_EXPORT]: true,
      [FEATURE.TEAM_WORKSPACES]: true,
      [FEATURE.PRO_THEMES]: true
    }
  };

  /**
   * Free tier limits
   * @type {Object}
   */
  const FREE_LIMITS = {
    maxPeers: 5,
    maxTransferBytes: 25 * 1024 * 1024, // 25MB
    exportDepth: 500,
    maxWorkspaces: 0
  };

  /**
   * Event types for feature gate
   * @enum {string}
   */
  const GATE_EVENT = {
    ACCESS_CHANGED: 'gate:access_changed',
    LIMIT_REACHED: 'gate:limit_reached',
    UPGRADE_SHOWN: 'gate:upgrade_shown'
  };

  /**
   * FeatureGateManager — Centralized feature gating system
   * @class
   */
  class FeatureGateManager {
    /**
     * Creates a new FeatureGateManager
     * @param {Object} [options={}] - Configuration options
     * @param {Object} [options.licenseManager] - LicenseManager instance
     * @param {Object} [options.eventBus] - Event bus for notifications
     */
    constructor(options = {}) {
      /** @type {Object} LicenseManager instance */
      this._licenseManager = options.licenseManager || null;
      /** @type {Object} Event bus */
      this._eventBus = options.eventBus || null;
      /** @type {string} Current tier */
      this._currentTier = 'free';
      /** @type {Object} Feature access cache */
      this._accessCache = new Map();
      /** @type {number} Cache timestamp */
      this._cacheTime = 0;
      /** @type {number} Cache TTL in ms */
      this._cacheTTL = 5000;
      /** @type {boolean} Is destroyed */
      this._destroyed = false;

      // Bind methods
      this.can = this.can.bind(this);
      this.getLimits = this.getLimits.bind(this);
      this.checkLimit = this.checkLimit.bind(this);
    }

    /**
     * Sets the license manager
     * @param {Object} lm - LicenseManager instance
     */
    setLicenseManager(lm) {
      this._licenseManager = lm;
      this._clearCache();
    }

    /**
     * Sets the event bus
     * @param {Object} bus - Event bus instance
     */
    setEventBus(bus) {
      this._eventBus = bus;
    }

    /**
     * Clears the access cache
     * @private
     */
    _clearCache() {
      this._accessCache.clear();
      this._cacheTime = 0;
    }

    /**
     * Updates cached tier from license manager
     * @returns {Promise<void>}
     * @private
     */
    async _updateTier() {
      if (!this._licenseManager) {
        this._currentTier = 'free';
        return;
      }

      const now = Date.now();
      if (now - this._cacheTime < this._cacheTTL) {
        return;
      }

      try {
        const tier = await this._licenseManager.getTier();
        if (tier !== this._currentTier) {
          this._currentTier = tier;
          this._clearCache();
          this._emit(GATE_EVENT.ACCESS_CHANGED, { tier: tier });
        }
        this._cacheTime = now;
      } catch (e) {
        this._currentTier = 'free';
      }
    }

    /**
     * Checks if a feature is accessible
     * @param {string} featureName - Name of the feature
     * @returns {Promise<boolean>} True if feature is accessible
     */
    async can(featureName) {
      if (this._destroyed) return false;

      // Check cache first
      const cacheKey = 'can_' + featureName;
      const now = Date.now();
      if (this._accessCache.has(cacheKey) &&
          (now - this._cacheTime) < this._cacheTTL) {
        return this._accessCache.get(cacheKey);
      }

      // Update tier from license
      await this._updateTier();

      // Get feature access for tier
      const tierFeatures = TIER_FEATURES[this._currentTier] || TIER_FEATURES.free;
      const hasAccess = tierFeatures[featureName] || false;

      this._accessCache.set(cacheKey, hasAccess);
      return hasAccess;
    }

    /**
     * Checks if a feature is accessible (sync version, uses cache)
     * @param {string} featureName - Name of the feature
     * @returns {boolean} True if feature is accessible (cached value)
     */
    canSync(featureName) {
      if (this._destroyed) return false;

      const cacheKey = 'can_' + featureName;
      if (this._accessCache.has(cacheKey)) {
        return this._accessCache.get(cacheKey);
      }

      // Return sync version based on current tier
      const tierFeatures = TIER_FEATURES[this._currentTier] || TIER_FEATURES.free;
      return tierFeatures[featureName] || false;
    }

    /**
     * Gets the limits for current tier
     * @returns {Promise<Object>} Limits object
     */
    async getLimits() {
      await this._updateTier();

      const limits = { ...FREE_LIMITS };

      if (this._currentTier === 'free') {
        // Free tier limits already set
      } else if (this._currentTier === 'pro' || this._currentTier === 'team' || this._currentTier === 'enterprise') {
        limits.maxPeers = Infinity;
        limits.maxTransferBytes = Infinity;
        limits.exportDepth = Infinity;
        limits.maxWorkspaces = this._currentTier === 'team' || this._currentTier === 'enterprise' ? Infinity : 0;
      }

      return limits;
    }

    /**
     * Checks if a limit is reached
     * @param {string} limitType - Type of limit ('peers', 'transfer', 'export', 'workspace')
     * @param {number} currentValue - Current value
     * @returns {Promise<{reached: boolean, limit: number, upgradeRequired: boolean}>} Limit status
     */
    async checkLimit(limitType, currentValue) {
      const limits = await this.getLimits();

      switch (limitType) {
        case 'peers':
          return {
            reached: currentValue >= limits.maxPeers,
            limit: limits.maxPeers,
            upgradeRequired: limits.maxPeers !== Infinity
          };

        case 'transfer':
          return {
            reached: currentValue >= limits.maxTransferBytes,
            limit: limits.maxTransferBytes,
            upgradeRequired: limits.maxTransferBytes !== Infinity
          };

        case 'export':
          return {
            reached: currentValue >= limits.exportDepth,
            limit: limits.exportDepth,
            upgradeRequired: limits.exportDepth !== Infinity
          };

        case 'workspace':
          return {
            reached: currentValue >= limits.maxWorkspaces,
            limit: limits.maxWorkspaces,
            upgradeRequired: limits.maxWorkspaces !== Infinity
          };

        default:
          return { reached: false, limit: Infinity, upgradeRequired: false };
      }
    }

    /**
     * Triggers upgrade flow if limit reached
     * @param {string} limitType - Type of limit that was reached
     * @returns {Promise<void>}
     */
    async triggerUpgradeFlow(limitType) {
      this._emit(GATE_EVENT.LIMIT_REACHED, { limitType: limitType });
      this._emit(GATE_EVENT.UPGRADE_SHOWN, {
        limitType: limitType,
        tier: this._currentTier
      });
    }

    /**
     * Gets all available features
     * @returns {string[]} Array of feature names
     */
    getAvailableFeatures() {
      return Object.values(FEATURE);
    }

    /**
     * Gets features for current tier
     * @returns {Promise<Object>} Feature access map
     */
    async getFeaturesForCurrentTier() {
      await this._updateTier();
      const tierFeatures = TIER_FEATURES[this._currentTier] || TIER_FEATURES.free;

      const result = {};
      for (const [feature, access] of Object.entries(tierFeatures)) {
        result[feature] = access;
      }
      return result;
    }

    /**
     * Gets current tier name
     * @returns {Promise<string>} Tier name
     */
    async getTier() {
      await this._updateTier();
      return this._currentTier;
    }

    /**
     * Forces refresh of tier cache
     */
    async refresh() {
      this._clearCache();
      await this._updateTier();
    }

    /**
     * Emits an event
     * @param {string} event - Event name
     * @param {Object} data - Event data
     * @private
     */
    _emit(event, data) {
      if (!this._eventBus) return;

      if (typeof this._eventBus.emit === 'function') {
        this._eventBus.emit(event, data);
      }
    }

    /**
     * Destroys the FeatureGateManager
     */
    destroy() {
      this._destroyed = true;
      this._accessCache.clear();
      this._licenseManager = null;
      this._eventBus = null;
    }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.FeatureGateManager = FeatureGateManager;
  exports.GhostLink.FEATURE = FEATURE;
  exports.GhostLink.TIER_FEATURES = TIER_FEATURES;
  exports.GhostLink.FREE_LIMITS = FREE_LIMITS;
  exports.GhostLink.GATE_EVENT = GATE_EVENT;

})(typeof globalThis !== 'undefined' ? globalThis : this);