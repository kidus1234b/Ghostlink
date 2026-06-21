// license-core.js — Shared license encode/decode/sign/verify for GhostLink
// Used by the client validator and the standalone license generator app.
(function (exports) {
  'use strict';

  const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const LICENSE_VERSION = 2;
  const VALID_DURATIONS = [0, 1, 3, 6, 8, 12, 120];

  const TIER = {
    PRO: 1,
    TEAM: 2,
    ENTERPRISE: 3,
  };

  const TIER_NAME = {
    1: 'pro',
    2: 'team',
    3: 'enterprise',
  };

  const VALIDATION_ERROR = {
    INVALID_FORMAT: 'invalid_format',
    INVALID_CHECKSUM: 'invalid_checksum',
    INVALID_SIGNATURE: 'invalid_signature',
    EXPIRED: 'expired',
    DEVICE_MISMATCH: 'device_mismatch',
    MALFORMED_PAYLOAD: 'malformed_payload',
    UNSUPPORTED_VERSION: 'unsupported_version',
    INVALID_DURATION: 'invalid_duration',
    TAMPERING_DETECTED: 'tampering_detected',
  };

  const _FRAG_A = [0x47, 0x48, 0x4F, 0x53, 0x54, 0x4C, 0x49, 0x4E];
  const _FRAG_B = [0x4B, 0x5F, 0x50, 0x52, 0x4F, 0x5F, 0x53, 0x45, 0x43, 0x55, 0x52, 0x45];
  const _FRAG_C = [0x32, 0x35, 0x36, 0x62, 0x69, 0x74];

  function reconstructSecret() {
    const combined = new Uint8Array(_FRAG_A.length + _FRAG_B.length + _FRAG_C.length);
    let offset = 0;
    combined.set(_FRAG_A, offset); offset += _FRAG_A.length;
    combined.set(_FRAG_B, offset); offset += _FRAG_B.length;
    combined.set(_FRAG_C, offset);
    const mixed = new Uint8Array(combined.length);
    for (let i = 0; i < combined.length; i++) {
      mixed[i] = combined[i] ^ ((i * 7 + 3) & 0xFF);
    }
    return mixed;
  }

  function computeChecksum(data) {
    let crc = 0xFFFFFFFF;
    const polynomial = 0xEDB88320;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc & 1) ? ((crc >>> 1) ^ polynomial) : (crc >>> 1);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function base32Encode(bytes) {
    let result = '';
    let buffer = 0;
    let bitsLeft = 0;
    for (const byte of bytes) {
      buffer = (buffer << 8) | byte;
      bitsLeft += 8;
      while (bitsLeft >= 5) {
        bitsLeft -= 5;
        result += BASE32[(buffer >> bitsLeft) & 0x1F];
      }
    }
    if (bitsLeft > 0) {
      result += BASE32[(buffer << (5 - bitsLeft)) & 0x1F];
    }
    return result;
  }

  function base32Decode(input) {
    const cleaned = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
    const bytes = [];
    let buffer = 0;
    let bitsLeft = 0;
    for (const char of cleaned) {
      const val = BASE32.indexOf(char);
      if (val === -1) continue;
      buffer = (buffer << 5) | val;
      bitsLeft += 5;
      if (bitsLeft >= 8) {
        bitsLeft -= 8;
        bytes.push((buffer >> bitsLeft) & 0xFF);
      }
    }
    return new Uint8Array(bytes);
  }

  function generateDynamicSalt(partialKey) {
    const keyBytes = new TextEncoder().encode(String(partialKey).replace(/-/g, ''));
    const saltBase = new TextEncoder().encode('GhostLinkLicenseV1');
    const mixed = new Uint8Array(saltBase.length);
    for (let i = 0; i < mixed.length; i++) {
      mixed[i] = (keyBytes[i % keyBytes.length] ^ saltBase[i]) + i;
    }
    return mixed;
  }

  async function sha256Hex(input) {
    const encoded = new TextEncoder().encode(String(input).trim().toLowerCase());
    const hash = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async function sha256Bytes(input) {
    const encoded = new TextEncoder().encode(String(input).trim().toLowerCase());
    return new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  }

  function bindBytesFromDeviceId(deviceId) {
    return sha256Bytes(deviceId).then(hash => new Uint8Array([hash[0], hash[1]]));
  }

  function bindBytesFromEnterprise(maxUsers, companyName) {
    return sha256Bytes(`${companyName}|${maxUsers}`).then(hash => {
      const users = Math.max(1, Math.min(65535, Number(maxUsers) || 1));
      return new Uint8Array([users & 0xFF, hash[0]]);
    });
  }

  function buildPayload({ tier, durationMonths, bindByte0, bindByte1 }) {
    if (!VALID_DURATIONS.includes(durationMonths)) {
      throw new Error(`Invalid duration. Use: ${VALID_DURATIONS.join(', ')} months`);
    }
    let tierByte;
    if (tier === 'enterprise') {
      tierByte = TIER.ENTERPRISE;
    } else if (tier === 'team') {
      tierByte = TIER.TEAM;
    } else {
      tierByte = TIER.PRO;
    }
    return new Uint8Array([
      LICENSE_VERSION,
      tierByte,
      durationMonths,
      bindByte0 & 0xFF,
      bindByte1 & 0xFF,
    ]);
  }

  function decodePayloadObject(bytes) {
    if (!bytes || bytes.length < 5) {
      throw new Error('Payload too short');
    }
    const version = bytes[0];
    if (version !== LICENSE_VERSION) {
      throw new Error('unsupported_version');
    }
    const tierByte = bytes[1];
    const tier = TIER_NAME[tierByte];
    if (!tier) {
      throw new Error('invalid_tier');
    }
    const durationMonths = bytes[2];
    if (!VALID_DURATIONS.includes(durationMonths)) {
      throw new Error('invalid_duration');
    }
    return {
      version,
      tier,
      tierByte,
      durationMonths,
      bindByte0: bytes[3],
      bindByte1: bytes[4],
      maxUsers: tier === 'enterprise' ? bytes[3] : null,
      companyHashByte: tier === 'enterprise' ? bytes[4] : null,
    };
  }

  function formatLicenseKey(payloadEncoded, checksumEncoded, signatureEncoded) {
    const sig = signatureEncoded.padEnd(8, 'A').substring(0, 8);
    return `GHOST-${payloadEncoded.substring(0, 4)}-${payloadEncoded.substring(4, 8)}-${checksumEncoded}-${sig.substring(0, 4)}-${sig.substring(4, 8)}`;
  }

  function parseLicenseKey(key) {
    if (typeof key !== 'string') return null;
    const clean = key.trim().toUpperCase();
    const match = clean.match(/^GHOST-([A-Z2-7]{4})-([A-Z2-7]{4})-([A-Z2-7]{4})-([A-Z2-7]{4})-([A-Z2-7]{4})$/);
    if (!match) return null;
    return {
      payloadEncoded: match[1] + match[2],
      checksumEncoded: match[3],
      signatureEncoded: match[4] + match[5],
      partialKeyForSalt: `GHOST-${match[1]}-${match[2]}-${match[3]}-XXXX-XXXX`,
      fullKey: clean,
    };
  }

  function verifyChecksum(payloadBytes, checksumEncoded) {
    const computed = computeChecksum(payloadBytes);
    const decoded = base32Decode(checksumEncoded);
    if (decoded.length < 2) return false;
    const stored = (decoded[0] << 8) | decoded[1];
    return (computed & 0xFFFF) === stored;
  }

  async function signPayload(payloadBytes, partialKeyForSalt) {
    const secret = reconstructSecret();
    const salt = generateDynamicSalt(partialKeyForSalt);
    const signedData = new Uint8Array(salt.length + payloadBytes.length);
    signedData.set(salt);
    signedData.set(payloadBytes, salt.length);
    const cryptoKey = await crypto.subtle.importKey(
      'raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, signedData);
    return base32Encode(new Uint8Array(sig).slice(0, 5));
  }

  async function verifySignature(payloadBytes, signatureEncoded, partialKeyForSalt) {
    const signatureBytes = base32Decode(signatureEncoded);
    if (signatureBytes.length < 5) return false;
    const secret = reconstructSecret();
    const salt = generateDynamicSalt(partialKeyForSalt);
    const signedData = new Uint8Array(salt.length + payloadBytes.length);
    signedData.set(salt);
    signedData.set(payloadBytes, salt.length);
    const cryptoKey = await crypto.subtle.importKey(
      'raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, signedData);
    const hmacBytes = new Uint8Array(sig);
    for (let i = 0; i < 5; i++) {
      if (hmacBytes[i] !== signatureBytes[i]) return false;
    }
    return true;
  }

  async function generateLicenseKey(options) {
    const {
      tier = 'pro',
      durationMonths = 1,
      deviceId = '',
      companyName = '',
      maxUsers = 10,
    } = options;

    if (tier === 'pro' || tier === 'team') {
      if (!deviceId || String(deviceId).trim().length < 8) {
        throw new Error(`${tier.charAt(0).toUpperCase() + tier.slice(1)} license requires the customer Device ID`);
      }
    } else if (tier === 'enterprise') {
      if (!companyName || String(companyName).trim().length < 2) {
        throw new Error('Enterprise license requires a company name');
      }
      if (!maxUsers || Number(maxUsers) < 1) {
        throw new Error('Enterprise license requires number of users');
      }
    } else {
      throw new Error('Tier must be pro, team, or enterprise');
    }

    let bindBytes;
    if (tier === 'pro' || tier === 'team') {
      bindBytes = await bindBytesFromDeviceId(deviceId);
    } else {
      bindBytes = await bindBytesFromEnterprise(maxUsers, companyName);
    }

    const payloadBytes = buildPayload({
      tier,
      durationMonths,
      bindByte0: bindBytes[0],
      bindByte1: bindBytes[1],
    });

    const payloadEncoded = base32Encode(payloadBytes);
    const checksumEncoded = base32Encode(new Uint8Array([
      (computeChecksum(payloadBytes) >> 8) & 0xFF,
      computeChecksum(payloadBytes) & 0xFF,
    ]));
    const partialKeyForSalt = `GHOST-${payloadEncoded.substring(0, 4)}-${payloadEncoded.substring(4, 8)}-${checksumEncoded}-XXXX-XXXX`;
    const signatureEncoded = await signPayload(payloadBytes, partialKeyForSalt);
    const key = formatLicenseKey(payloadEncoded, checksumEncoded, signatureEncoded);
    const decoded = decodePayloadObject(payloadBytes);

    return {
      key,
      tier: decoded.tier,
      durationMonths: decoded.durationMonths,
      deviceId: (tier === 'pro' || tier === 'team') ? String(deviceId).trim() : null,
      companyName: tier === 'enterprise' ? String(companyName).trim() : null,
      maxUsers: tier === 'enterprise' ? Math.min(255, Number(maxUsers)) : null,
    };
  }

  async function decodeAndVerifyLicenseKey(licenseKey) {
    const parsed = parseLicenseKey(licenseKey);
    if (!parsed) {
      return { valid: false, error: VALIDATION_ERROR.INVALID_FORMAT, license: null };
    }

    try {
      const payloadBytes = base32Decode(parsed.payloadEncoded);
      if (payloadBytes.length < 5) {
        return { valid: false, error: VALIDATION_ERROR.MALFORMED_PAYLOAD, license: null };
      }

      if (!verifyChecksum(payloadBytes, parsed.checksumEncoded)) {
        return { valid: false, error: VALIDATION_ERROR.INVALID_CHECKSUM, license: null };
      }

      const signatureOk = await verifySignature(
        payloadBytes,
        parsed.signatureEncoded,
        parsed.partialKeyForSalt
      );
      if (!signatureOk) {
        return { valid: false, error: VALIDATION_ERROR.INVALID_SIGNATURE, license: null };
      }

      const data = decodePayloadObject(payloadBytes);
      const license = {
        version: data.version,
        tier: data.tier,
        durationMonths: data.durationMonths,
        bindByte0: data.bindByte0,
        bindByte1: data.bindByte1,
        maxUsers: data.maxUsers,
        companyHashByte: data.companyHashByte,
        expiresAt: null,
        issuedAt: null,
      };

      return { valid: true, error: null, license };
    } catch (err) {
      if (err.message === 'unsupported_version') {
        return { valid: false, error: VALIDATION_ERROR.UNSUPPORTED_VERSION, license: null };
      }
      if (err.message === 'invalid_duration') {
        return { valid: false, error: VALIDATION_ERROR.INVALID_DURATION, license: null };
      }
      return { valid: false, error: VALIDATION_ERROR.TAMPERING_DETECTED, license: null };
    }
  }

  async function verifyDeviceBinding(license, deviceFingerprint) {
    if (!license || (license.tier !== 'pro' && license.tier !== 'team')) return true;
    const hash = await sha256Bytes(deviceFingerprint);
    return hash[0] === license.bindByte0 && hash[1] === license.bindByte1;
  }

  function computeExpiryTimestamp(activatedAt, durationMonths) {
    const expiry = new Date(activatedAt);
    expiry.setMonth(expiry.getMonth() + durationMonths);
    return expiry.getTime();
  }

  function isExpired(expiresAt) {
    if (!expiresAt || expiresAt <= 0) return false;
    return Date.now() > expiresAt;
  }

  const LicenseCore = {
    LICENSE_VERSION,
    VALID_DURATIONS,
    TIER,
    TIER_NAME,
    VALIDATION_ERROR,
    reconstructSecret,
    computeChecksum,
    base32Encode,
    base32Decode,
    generateDynamicSalt,
    sha256Hex,
    sha256Bytes,
    bindBytesFromDeviceId,
    bindBytesFromEnterprise,
    buildPayload,
    decodePayloadObject,
    formatLicenseKey,
    parseLicenseKey,
    verifyChecksum,
    signPayload,
    verifySignature,
    generateLicenseKey,
    decodeAndVerifyLicenseKey,
    verifyDeviceBinding,
    computeExpiryTimestamp,
    isExpired,
  };

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.LicenseCore = LicenseCore;
  exports.GhostLink.VALIDATION_ERROR = VALIDATION_ERROR;

})(typeof globalThis !== 'undefined' ? globalThis : this);
