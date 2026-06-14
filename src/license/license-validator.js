// LicenseValidator — Validates GhostLink Pro / Enterprise licenses
(function(exports) {
  'use strict';

  const Core = () => exports.GhostLink?.LicenseCore;

  class LicenseValidator {
    constructor(options = {}) {
      this._deviceFP = options.deviceFingerprint || null;
      this._tamperCache = new Map();
    }

    setDeviceFingerprint(fp) {
      this._deviceFP = fp;
    }

    async validate(licenseKey, options = {}) {
      const skipDeviceCheck = options.skipDeviceCheck || false;
      const core = Core();
      if (!core) {
        return { valid: false, error: 'core_missing', license: null };
      }

      try {
        const result = await core.decodeAndVerifyLicenseKey(licenseKey);
        if (!result.valid) {
          return result;
        }

        const license = { ...result.license };

        if (!skipDeviceCheck && license.tier === 'pro' && this._deviceFP) {
          const fingerprint = await this._deviceFP.getFingerprint();
          const bound = await core.verifyDeviceBinding(license, fingerprint);
          if (!bound) {
            return {
              valid: false,
              error: core.VALIDATION_ERROR.DEVICE_MISMATCH,
              license: null,
            };
          }
          license.deviceFingerprint = fingerprint;
        }

        if (options.activatedAt && license.durationMonths) {
          license.activatedAt = options.activatedAt;
          license.expiresAt = core.computeExpiryTimestamp(
            options.activatedAt,
            license.durationMonths
          );
          if (core.isExpired(license.expiresAt)) {
            return {
              valid: false,
              error: core.VALIDATION_ERROR.EXPIRED,
              license: null,
            };
          }
        }

        return { valid: true, error: null, license };
      } catch (err) {
        this._recordTamperEvent('exception');
        const coreErr = Core()?.VALIDATION_ERROR?.TAMPERING_DETECTED || 'tampering_detected';
        return { valid: false, error: coreErr, license: null };
      }
    }

    _recordTamperEvent(event) {
      const key = 'tamper_' + event;
      this._tamperCache.set(key, (this._tamperCache.get(key) || 0) + 1);
    }

    getTamperCount(event) {
      return this._tamperCache.get('tamper_' + event) || 0;
    }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.LicenseValidator = LicenseValidator;

})(typeof globalThis !== 'undefined' ? globalThis : this);
