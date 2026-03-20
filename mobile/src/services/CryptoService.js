/**
 * GhostLink Mobile — Crypto Service
 *
 * Provides all cryptographic operations needed for GhostLink on React Native.
 *
 * React Native does NOT expose the Web Crypto API. This module uses
 * `react-native-quick-crypto` (an OpenSSL-backed, synchronous crypto library)
 * as the primary provider. If unavailable, it falls back to `expo-crypto`
 * for hashing and `react-native-get-random-values` for secure random bytes.
 *
 * Install peer dependencies:
 *   npm install react-native-quick-crypto
 *   # OR for Expo managed workflow:
 *   npx expo install expo-crypto
 *
 * @module CryptoService
 */

// ─── Crypto Backend ─────────────────────────────────────────────────────────
//
// react-native-quick-crypto provides a Node-compatible `crypto` interface
// backed by native OpenSSL, giving us ECDH, AES-GCM, PBKDF2, and SHA-256
// without shipping a JS-only polyfill.
//
// Import it at app entry point to polyfill global.crypto:
//   import 'react-native-quick-crypto';
//
// If you are on Expo managed workflow without native modules, swap the
// implementations below for expo-crypto equivalents (noted in comments).

let QuickCrypto;
try {
  QuickCrypto = require('react-native-quick-crypto');
} catch (_) {
  console.warn(
    '[GhostLink:Crypto] react-native-quick-crypto not found. ' +
      'Falling back to JS shims — install it for production use.',
  );
  // Fallback: use Node-style crypto if bundled via metro polyfill
  QuickCrypto = require('crypto');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert an ArrayBuffer / Uint8Array to a hex string.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string}
 */
function bufToHex(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Convert a hex string to a Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Generate cryptographically secure random bytes.
 * @param {number} length
 * @returns {Uint8Array}
 */
function randomBytes(length) {
  return new Uint8Array(QuickCrypto.randomBytes(length));
}

// ─── CryptoService ──────────────────────────────────────────────────────────

const CryptoService = {
  /**
   * Generate an ECDH P-256 key pair.
   *
   * Returns the public key as a hex-encoded uncompressed point and the
   * private key as a hex-encoded 32-byte scalar, matching the format the
   * web client exchanges over signaling.
   *
   * @returns {{ publicKey: string, privateKey: string }}
   */
  generateKeyPair() {
    const ecdh = QuickCrypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return {
      publicKey: ecdh.getPublicKey('hex'),
      privateKey: ecdh.getPrivateKey('hex'),
    };
  },

  /**
   * Compute a shared secret from our private key and a peer's public key.
   * The result is a raw 32-byte hex string suitable as an AES-256 key.
   *
   * @param {string} privateKeyHex Our ECDH private key (hex).
   * @param {string} peerPublicKeyHex Peer's ECDH public key (hex).
   * @returns {string} 32-byte shared secret (hex).
   */
  deriveSharedSecret(privateKeyHex, peerPublicKeyHex) {
    const ecdh = QuickCrypto.createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(privateKeyHex, 'hex'));
    const shared = ecdh.computeSecret(Buffer.from(peerPublicKeyHex, 'hex'));
    return shared.toString('hex');
  },

  /**
   * SHA-256 hash of arbitrary data.
   *
   * @param {string|Uint8Array} data UTF-8 string or raw bytes.
   * @returns {string} Hex-encoded hash.
   */
  sha256(data) {
    const hash = QuickCrypto.createHash('sha256');
    if (typeof data === 'string') {
      hash.update(data, 'utf8');
    } else {
      hash.update(Buffer.from(data));
    }
    return hash.digest('hex');
  },

  /**
   * Encrypt plaintext with AES-256-GCM.
   *
   * @param {string} text Plaintext to encrypt.
   * @param {string} keyHex 32-byte key as hex (64 hex chars).
   * @returns {{ iv: string, ciphertext: string, tag: string }}
   *   All fields are hex-encoded.
   */
  encrypt(text, keyHex) {
    const iv = randomBytes(12); // 96-bit IV for GCM
    const key = Buffer.from(keyHex, 'hex');
    const cipher = QuickCrypto.createCipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv),
    );

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');

    return {
      iv: bufToHex(iv),
      ciphertext: encrypted,
      tag,
    };
  },

  /**
   * Decrypt AES-256-GCM ciphertext.
   *
   * @param {{ iv: string, ciphertext: string, tag: string }} encrypted
   *   All fields hex-encoded.
   * @param {string} keyHex 32-byte key as hex.
   * @returns {string} Decrypted plaintext.
   * @throws {Error} If authentication tag verification fails.
   */
  decrypt(encrypted, keyHex) {
    const { iv, ciphertext, tag } = encrypted;
    const key = Buffer.from(keyHex, 'hex');
    const decipher = QuickCrypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(hexToBuf(iv)),
    );
    decipher.setAuthTag(Buffer.from(hexToBuf(tag)));

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  },

  /**
   * Derive a 256-bit key from a seed phrase using PBKDF2.
   *
   * @param {string} words Space-separated seed words (e.g. BIP-39 mnemonic).
   * @param {string} [salt='ghostlink-seed'] Optional salt.
   * @returns {Promise<string>} Hex-encoded 32-byte derived key.
   */
  deriveKeyFromSeed(words, salt = 'ghostlink-seed') {
    return new Promise((resolve, reject) => {
      QuickCrypto.pbkdf2(
        words,
        salt,
        100000, // 100k iterations
        32, // 256-bit key
        'sha256',
        (err, derivedKey) => {
          if (err) return reject(err);
          resolve(Buffer.from(derivedKey).toString('hex'));
        },
      );
    });
  },

  /**
   * Wrap (encrypt) an ECDH private key with a wrapping key using AES-256-GCM.
   *
   * @param {string} privateKeyHex ECDH private key to wrap (hex).
   * @param {string} wrappingKeyHex 32-byte wrapping key (hex).
   * @returns {{ iv: string, ciphertext: string, tag: string }}
   */
  wrapPrivKey(privateKeyHex, wrappingKeyHex) {
    return CryptoService.encrypt(privateKeyHex, wrappingKeyHex);
  },

  /**
   * Unwrap (decrypt) an ECDH private key.
   *
   * @param {{ iv: string, ciphertext: string, tag: string }} wrapped
   * @param {string} wrappingKeyHex 32-byte wrapping key (hex).
   * @returns {string} Recovered ECDH private key (hex).
   */
  unwrapPrivKey(wrapped, wrappingKeyHex) {
    return CryptoService.decrypt(wrapped, wrappingKeyHex);
  },

  /**
   * Generate a GhostLink invite code in the format GL-XXXX-XXXX-XXXX-XXXX.
   * Uses crypto-random bytes mapped to uppercase alphanumeric characters.
   *
   * @returns {string} e.g. "GL-A3F7-K9B2-M4X1-Q8Z5"
   */
  genInvite() {
    const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = randomBytes(16);
    const groups = [];

    for (let g = 0; g < 4; g++) {
      let segment = '';
      for (let i = 0; i < 4; i++) {
        segment += CHARSET[bytes[g * 4 + i] % CHARSET.length];
      }
      groups.push(segment);
    }

    return `GL-${groups.join('-')}`;
  },

  /**
   * Generate secure random bytes (exposed for external use).
   * @param {number} length
   * @returns {Uint8Array}
   */
  randomBytes,
};

export default CryptoService;
