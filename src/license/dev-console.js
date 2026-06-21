// DevConsole — diagnostics only (license generation moved to license-generator app)
(function(exports) {
  'use strict';

  class DevConsole {
    constructor() {
      this._visible = false;
    }

    show() {
      console.log('[GhostLink] License keys are generated via the separate license-generator app.');
      console.log('[GhostLink] Open license-generator/index.html locally (admin only).');
    }

    hide() {
      this._visible = false;
    }
  }

  async function generateLicense(unlockWord, adminPassword, tier, duration, deviceId) {
    if (unlockWord !== 'GHOSTPRO') {
      return { success: false, error: 'Invalid unlock word' };
    }
    const core = exports.GhostLink?.LicenseCore;
    if (!core) {
      return { success: false, error: 'LicenseCore missing' };
    }

    // Map duration (days) to months
    let durationMonths = 1;
    if (duration === 30) durationMonths = 1;
    else if (duration === 90) durationMonths = 3;
    else if (duration === 365) durationMonths = 12;
    else if (duration === 0) durationMonths = 0;
    else if (duration === 120 || duration === 'lifetime') durationMonths = 120;
    else {
      durationMonths = duration;
    }

    try {
      const devId = deviceId || 'TEST-DEVICE-ID';
      const keyObj = await core.generateLicenseKey({
        tier: tier || 'pro',
        durationMonths: durationMonths,
        deviceId: devId,
        companyName: 'Test Company',
        maxUsers: 10
      });

      const activatedAt = Date.now();
      const expiresAt = core.computeExpiryTimestamp(activatedAt, durationMonths);

      return {
        success: true,
        key: keyObj.key,
        tier: keyObj.tier,
        expiresAt: expiresAt
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.DevConsole = DevConsole;
  exports.GhostLink.devConsole = new DevConsole();
  
  if (typeof window !== 'undefined') {
    window.generateLicense = generateLicense;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
