// License System Index — GhostLink Pro Licensing and Team Workspaces
// Consolidates all license-related exports
(function(exports) {
  'use strict';

  // Re-export all license system components
  // These are loaded via individual module files

  /**
   * Initializes the complete license system
   * @param {Object} [options={}] - Configuration options
   * @returns {Promise<Object>} Initialized system components
   */
  async function initLicenseSystem(options = {}) {
    const {
      eventBus = null
    } = options;

    // Initialize DeviceFingerprintManager
    const deviceFP = new exports.GhostLink.DeviceFingerprintManager();

    // Initialize LicenseValidator
    const validator = new exports.GhostLink.LicenseValidator({
      deviceFingerprint: deviceFP
    });

    // Initialize LicenseManager
    const licenseManager = new exports.GhostLink.LicenseManager({
      validator: validator,
      deviceFingerprint: deviceFP
    });

    // Initialize FeatureGateManager
    const featureGate = new exports.GhostLink.FeatureGateManager({
      licenseManager: licenseManager,
      eventBus: eventBus
    });

    // Initialize WorkspaceManager
    const workspaceManager = new exports.GhostLink.WorkspaceManager({
      licenseManager: licenseManager,
      featureGate: featureGate
    });

    // Start managers
    await licenseManager.init();
    try {
      await workspaceManager.init();
    } catch (err) {
      console.warn('[GhostLink] WorkspaceManager init skipped:', err.message);
    }

    // Wire up dependencies
    featureGate.setLicenseManager(licenseManager);

    return {
      deviceFingerprint: deviceFP,
      validator: validator,
      licenseManager: licenseManager,
      featureGate: featureGate,
      workspaceManager: workspaceManager
    };
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.initLicenseSystem = initLicenseSystem;
  if (typeof window !== 'undefined') {
    window.GLLicenseAPI = exports.GhostLink;
  }

  // Re-export constants for convenience
  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.LICENSE_TIER = {
    FREE: 'free',
    PRO: 'pro',
    TEAM: 'team',
    ENTERPRISE: 'enterprise'
  };
  exports.GhostLink.FEATURE = {
    UNLIMITED_PEERS: 'unlimited_peers',
    LARGE_FILE_TRANSFER: 'large_file_transfer',
    FULL_EXPORT: 'full_export',
    TEAM_WORKSPACES: 'team_workspaces',
    PRO_THEMES: 'pro_themes'
  };
  exports.GhostLink.FREE_LIMITS = {
    maxPeers: 5,
    maxTransferBytes: 25 * 1024 * 1024,
    exportDepth: 500,
    maxWorkspaces: 0,
    themes: ['phantom', 'neon', 'blood', 'ocean', 'cyber']
  };
  exports.GhostLink.WORKSPACE_ROLE = {
    OWNER: 'owner',
    ADMIN: 'admin',
    MEMBER: 'member'
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);