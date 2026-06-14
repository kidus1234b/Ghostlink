// ProThemesManager — Gated Pro themes (Stealth, Carbon) for GhostLink
// Themes locked with upgrade prompt on click
(function(exports) {
  'use strict';

  /**
   * Pro theme definitions
   * Stealth: Ultra-dark with subtle blue accents
   * Carbon: Dark gray with orange accents
   */
  const PRO_THEMES = {
    stealth: {
      name: 'Stealth',
      locked: true,
      accent: '#4a9eff',
      accent2: '#2d5a87',
      accent3: '#1a3a5c',
      bg: '#050508',
      bgSecondary: '#0a0a10',
      bgTertiary: '#101018',
      accentDim: 'rgba(74,158,255,0.12)',
      text: '#d0d0d8',
      textSecondary: '#707080',
      textMuted: '#404050',
      border: 'rgba(255,255,255,0.04)',
      danger: '#ff4466',
      success: '#4aff9f',
      warning: '#ffaa00',
    },
    carbon: {
      name: 'Carbon',
      locked: true,
      accent: '#ff6b35',
      accent2: '#8b4513',
      accent3: '#5c3a21',
      bg: '#0c0c0c',
      bgSecondary: '#181818',
      bgTertiary: '#242424',
      accentDim: 'rgba(255,107,53,0.12)',
      text: '#e0e0e0',
      textSecondary: '#8a8a8a',
      textMuted: '#5a5a5a',
      border: 'rgba(255,255,255,0.05)',
      danger: '#ff4466',
      success: '#4aff9f',
      warning: '#ffaa00',
    }
  };

  /**
   * ProThemesManager — Manages gated Pro themes
   * @class
   */
  class ProThemesManager {
    /**
     * Creates a new ProThemesManager
     * @param {Object} [options={}] - Configuration options
     * @param {Object} [options.featureGate] - FeatureGateManager instance
     * @param {Function} [options.onUpgradeRequest] - Callback when upgrade is requested
     */
    constructor(options = {}) {
      /** @type {Object} FeatureGateManager instance */
      this._featureGate = options.featureGate || null;
      /** @type {Function} Upgrade request callback */
      this._onUpgradeRequest = options.onUpgradeRequest || null;
      /** @type {Object} Locked themes cache */
      this._lockedThemes = new Map();
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
     * Sets upgrade request callback
     * @param {Function} cb - Callback function
     */
    setOnUpgradeRequest(cb) {
      this._onUpgradeRequest = cb;
    }

    /**
     * Gets all available themes (including locked Pro themes)
     * @returns {Object} All themes with locked status
     */
    getAllThemes() {
      const allThemes = {};

      // Base themes (always available)
      allThemes.phantom = { name: 'Phantom', locked: false };
      allThemes.neon = { name: 'Neon', locked: false };
      allThemes.blood = { name: 'Blood', locked: false };
      allThemes.ocean = { name: 'Ocean', locked: false };
      allThemes.cyber = { name: 'Cyber', locked: false };

      // Pro themes (initially locked)
      allThemes.stealth = { ...PRO_THEMES.stealth, locked: true };
      allThemes.carbon = { ...PRO_THEMES.carbon, locked: true };

      return allThemes;
    }

    /**
     * Checks if a theme is available (unlocked)
     * @param {string} themeName - Theme name
     * @returns {Promise<boolean>} True if available
     */
    async isThemeAvailable(themeName) {
      if (this._destroyed) return false;

      // Base themes always available
      const baseThemes = ['phantom', 'neon', 'blood', 'ocean', 'cyber'];
      if (baseThemes.includes(themeName)) return true;

      // Pro themes require feature gate
      if (PRO_THEMES[themeName]) {
        if (!this._featureGate) return false;
        return await this._featureGate.can('pro_themes');
      }

      return false;
    }

    /**
     * Gets theme data with locked state
     * @param {string} themeName - Theme name
     * @returns {Promise<Object|null>} Theme data or null
     */
    async getTheme(themeName) {
      const isAvailable = await this.isThemeAvailable(themeName);

      // Base themes
      const baseThemes = {
        phantom: { name: 'Phantom', locked: false, ...this._getPhantomTheme() },
        neon: { name: 'Neon', locked: false, ...this._getNeonTheme() },
        blood: { name: 'Blood', locked: false, ...this._getBloodTheme() },
        ocean: { name: 'Ocean', locked: false, ...this._getOceanTheme() },
        cyber: { name: 'Cyber', locked: false, ...this._getCyberTheme() }
      };

      if (baseThemes[themeName]) {
        return baseThemes[themeName];
      }

      // Pro themes
      if (PRO_THEMES[themeName]) {
        return {
          ...PRO_THEMES[themeName],
          locked: !isAvailable
        };
      }

      return null;
    }

    /**
     * Attempts to select a theme, showing upgrade if locked
     * @param {string} themeName - Theme name
     * @returns {Promise<{success: boolean, theme: ?Object, upgradeRequired: boolean}>}
     */
    async selectTheme(themeName) {
      const isAvailable = await this.isThemeAvailable(themeName);

      if (isAvailable) {
        return { success: true, theme: await this.getTheme(themeName), upgradeRequired: false };
      }

      // Check if it's a valid pro theme
      if (PRO_THEMES[themeName]) {
        // Trigger upgrade flow
        if (this._onUpgradeRequest) {
          this._onUpgradeRequest('pro_themes');
        }
        return { success: false, theme: null, upgradeRequired: true };
      }

      return { success: false, theme: null, upgradeRequired: false };
    }

    /**
     * Gets the lock overlay data for a theme
     * @param {string} themeName - Theme name
     * @returns {Object} Lock overlay configuration
     */
    getLockOverlay(themeName) {
      return {
        visible: true,
        icon: '🔒',
        message: 'Pro Theme',
        subMessage: 'Upgrade to unlock'
      };
    }

    // Theme color getters for base themes
    _getPhantomTheme() {
      return {
        accent: '#00ffa3',
        accent2: '#b347ff',
        accent3: '#00d4ff',
        bg: '#0a0a0f',
        bgSecondary: '#12121a',
        bgTertiary: '#1a1a25',
        accentDim: 'rgba(0,255,163,0.15)',
        text: '#e0e0e0',
        textSecondary: '#8a8a9a',
        textMuted: '#5a5a6a',
        border: 'rgba(255,255,255,0.06)',
        danger: '#ff4466',
        success: '#00ffa3',
        warning: '#ffaa00',
      };
    }

    _getNeonTheme() {
      return {
        accent: '#ff00ff',
        accent2: '#00ffff',
        accent3: '#ffff00',
        bg: '#0a000a',
        bgSecondary: '#14001a',
        bgTertiary: '#1e0028',
        accentDim: 'rgba(255,0,255,0.15)',
        text: '#e0e0e0',
        textSecondary: '#8a8a9a',
        textMuted: '#5a5a6a',
        border: 'rgba(255,255,255,0.06)',
        danger: '#ff4466',
        success: '#00ff87',
        warning: '#ffaa00',
      };
    }

    _getBloodTheme() {
      return {
        accent: '#ff2244',
        accent2: '#ff6600',
        accent3: '#ff0088',
        bg: '#0f0a0a',
        bgSecondary: '#1a1212',
        bgTertiary: '#251a1a',
        accentDim: 'rgba(255,34,68,0.15)',
        text: '#e0e0e0',
        textSecondary: '#8a8a9a',
        textMuted: '#5a5a6a',
        border: 'rgba(255,255,255,0.06)',
        danger: '#ff2244',
        success: '#00ffa3',
        warning: '#ff6600',
      };
    }

    _getOceanTheme() {
      return {
        accent: '#00b4d8',
        accent2: '#0077b6',
        accent3: '#90e0ef',
        bg: '#0a0d12',
        bgSecondary: '#121820',
        bgTertiary: '#1a222e',
        accentDim: 'rgba(0,180,216,0.15)',
        text: '#e0e0e0',
        textSecondary: '#8a8a9a',
        textMuted: '#5a5a6a',
        border: 'rgba(255,255,255,0.06)',
        danger: '#ff4466',
        success: '#00ffa3',
        warning: '#ffaa00',
      };
    }

    _getCyberTheme() {
      return {
        accent: '#f5d300',
        accent2: '#ff6b35',
        accent3: '#00ff87',
        bg: '#0d0d00',
        bgSecondary: '#1a1a0d',
        bgTertiary: '#26261a',
        accentDim: 'rgba(245,211,0,0.15)',
        text: '#e0e0e0',
        textSecondary: '#8a8a9a',
        textMuted: '#5a5a6a',
        border: 'rgba(255,255,255,0.06)',
        danger: '#ff4466',
        success: '#00ff87',
        warning: '#f5d300',
      };
    }

    /**
     * Destroys the ProThemesManager
     */
    destroy() {
      this._destroyed = true;
      this._featureGate = null;
      this._onUpgradeRequest = null;
    }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.ProThemesManager = ProThemesManager;
  exports.GhostLink.PRO_THEMES = PRO_THEMES;

})(typeof globalThis !== 'undefined' ? globalThis : this);