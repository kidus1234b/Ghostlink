/**
 * GhostLink Signal Protocol Implementation
 * ==========================================
 * Full Double Ratchet + X3DH + Sender Keys for group messaging.
 * Uses only the browser WebCrypto API (SubtleCrypto).
 *
 * Exports: X3DH, DoubleRatchet, SessionManager, GroupKeyAgreement
 *
 * Usage:
 *   import { X3DH, DoubleRatchet, SessionManager, GroupKeyAgreement }
 *     from './src/crypto/signal-protocol.js';
 *
 * Or via script tag:
 *   <script type="module" src="src/crypto/signal-protocol.js"></script>
 */

const crypto = globalThis.crypto;
const subtle = crypto?.subtle;
if (!subtle) {
  console.warn('GhostLink Signal Protocol: WebCrypto not available');
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Convert ArrayBuffer to hex string */
function bufToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Convert hex string to ArrayBuffer */
function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes.buffer;
}

/** Encode string to Uint8Array */
function encode(str) {
  return new TextEncoder().encode(str);
}

/** Decode Uint8Array to string */
function decode(buf) {
  return new TextDecoder().decode(buf);
}

/** Concatenate ArrayBuffers */
function concat(...buffers) {
  const total = buffers.reduce((s, b) => s + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return out.buffer;
}

/** Export a CryptoKey (ECDH/ECDSA public) to raw bytes */
async function exportPublicKey(key) {
  return subtle.exportKey('raw', key);
}

/** Export a CryptoKey (ECDH/ECDSA private) to PKCS8 bytes */
async function exportPrivateKey(key) {
  return subtle.exportKey('pkcs8', key);
}

/** Import raw bytes as ECDH public key */
async function importECDHPublicKey(raw) {
  return subtle.importKey(
    'raw',
    raw instanceof ArrayBuffer ? raw : raw.buffer || raw,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

/** Import PKCS8 bytes as ECDH private key */
async function importECDHPrivateKey(pkcs8) {
  return subtle.importKey(
    'pkcs8',
    pkcs8 instanceof ArrayBuffer ? pkcs8 : pkcs8.buffer || pkcs8,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
}

/** Import raw bytes as ECDSA public key */
async function importECDSAPublicKey(raw) {
  return subtle.importKey(
    'raw',
    raw instanceof ArrayBuffer ? raw : raw.buffer || raw,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
}

/** Import PKCS8 bytes as ECDSA private key */
async function importECDSAPrivateKey(pkcs8) {
  return subtle.importKey(
    'pkcs8',
    pkcs8 instanceof ArrayBuffer ? pkcs8 : pkcs8.buffer || pkcs8,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  );
}

/** Generate an ECDH P-256 key pair */
async function generateECDH() {
  return subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
}

/** Generate an ECDSA P-256 key pair */
async function generateECDSA() {
  return subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
}

/** Perform ECDH and return the raw shared secret bytes */
async function ecdh(privateKey, publicKey) {
  return subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  );
}

/**
 * HKDF-SHA-256: derive `length` bytes from input keying material.
 * @param {ArrayBuffer} ikm - input keying material
 * @param {ArrayBuffer|Uint8Array} salt - salt (or empty for zero-salt)
 * @param {ArrayBuffer|Uint8Array} info - context/info string
 * @param {number} length - output length in bits
 * @returns {Promise<ArrayBuffer>}
 */
async function hkdf(ikm, salt, info, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt || new Uint8Array(32),
      info: info || new Uint8Array(0),
    },
    key,
    length
  );
}

/**
 * KDF_RK — Root key KDF. Takes root key + DH output, returns (new root key, chain key).
 * Uses HKDF with the root key as salt and the DH output as IKM.
 * Output: 64 bytes — first 32 = new root key, second 32 = new chain key.
 */
async function KDF_RK(rootKey, dhOutput) {
  const derived = await hkdf(dhOutput, rootKey, encode('GhostLinkRatchet'), 512);
  return {
    rootKey: derived.slice(0, 32),
    chainKey: derived.slice(32, 64),
  };
}

/**
 * KDF_CK — Chain key KDF. Advances the chain, producing a message key and the next chain key.
 * CK_next = HMAC-SHA-256(CK, 0x02)
 * MK      = HMAC-SHA-256(CK, 0x01)
 */
async function KDF_CK(chainKeyBuf) {
  const ck = await subtle.importKey('raw', chainKeyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [mkBuf, ckBuf] = await Promise.all([
    subtle.sign('HMAC', ck, new Uint8Array([0x01])),
    subtle.sign('HMAC', ck, new Uint8Array([0x02])),
  ]);
  return { messageKey: mkBuf, chainKey: ckBuf };
}

/** Derive an AES-256-GCM CryptoKey from raw message key bytes via HKDF */
async function deriveMessageEncryptionKey(mkBuf) {
  const derived = await hkdf(mkBuf, new Uint8Array(32), encode('GhostLinkMsg'), 256);
  return subtle.importKey('raw', derived, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** AES-256-GCM encrypt */
async function aesEncrypt(key, plaintext, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad || new Uint8Array(0) },
    key,
    plaintext
  );
  return { ciphertext: ct, nonce: iv.buffer };
}

/** AES-256-GCM decrypt */
async function aesDecrypt(key, ciphertext, nonce, aad) {
  return subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(nonce), additionalData: aad || new Uint8Array(0) },
    key,
    ciphertext
  );
}

/** Sign data with ECDSA P-256 */
async function ecdsaSign(privateKey, data) {
  return subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
}

/** Verify ECDSA P-256 signature */
async function ecdsaVerify(publicKey, signature, data) {
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, data);
}

/** Build a lookup key for skipped message keys: "hexPubKey:messageNumber" */
function skippedKeyId(pubKeyHex, n) {
  return `${pubKeyHex}:${n}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// X3DH — Extended Triple Diffie-Hellman Key Agreement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * X3DH key agreement protocol.
 * Generates identity keys, signed pre-keys, one-time pre-keys,
 * and computes shared secrets for session establishment.
 */
class X3DH {
  constructor() {
    /** @type {CryptoKeyPair|null} ECDH identity key pair */
    this.identityKey = null;
    /** @type {CryptoKeyPair|null} ECDSA signing key derived alongside identity */
    this.identitySigningKey = null;
    /** @type {{keyPair: CryptoKeyPair, id: number, signature: ArrayBuffer}|null} */
    this.signedPreKey = null;
    /** @type {Array<{keyPair: CryptoKeyPair, id: number}>} */
    this.oneTimePreKeys = [];
    /** Counter for pre-key IDs */
    this._preKeyIdCounter = 0;
  }

  /**
   * Generate a long-term identity key pair (ECDH P-256).
   * Also generates a companion ECDSA key for signing pre-keys.
   * @returns {Promise<{identityKey: CryptoKeyPair, signingKey: CryptoKeyPair}>}
   */
  async generateIdentityKey() {
    this.identityKey = await generateECDH();
    this.identitySigningKey = await generateECDSA();
    return { identityKey: this.identityKey, signingKey: this.identitySigningKey };
  }

  /**
   * Generate a signed pre-key (medium-term, rotate weekly).
   * Signs the public key with the identity signing key.
   * @param {CryptoKeyPair} [identitySigningKey] - ECDSA signing key (defaults to this.identitySigningKey)
   * @returns {Promise<{keyPair: CryptoKeyPair, id: number, signature: ArrayBuffer}>}
   */
  async generateSignedPreKey(identitySigningKey) {
    const signingKey = identitySigningKey || this.identitySigningKey;
    if (!signingKey) throw new Error('No identity signing key available');

    const keyPair = await generateECDH();
    const pubRaw = await exportPublicKey(keyPair.publicKey);
    const signer = signingKey.privateKey || signingKey;
    const signature = await ecdsaSign(signer, pubRaw);
    const id = ++this._preKeyIdCounter;

    this.signedPreKey = { keyPair, id, signature };
    return this.signedPreKey;
  }

  /**
   * Generate a batch of one-time pre-keys (ephemeral, one-use).
   * @param {number} [count=100]
   * @returns {Promise<Array<{keyPair: CryptoKeyPair, id: number}>>}
   */
  async generateOneTimePreKeys(count = 100) {
    const keys = [];
    for (let i = 0; i < count; i++) {
      const keyPair = await generateECDH();
      const id = ++this._preKeyIdCounter;
      keys.push({ keyPair, id });
    }
    this.oneTimePreKeys = this.oneTimePreKeys.concat(keys);
    return keys;
  }

  /**
   * Build a pre-key bundle for publishing to the server / signaling channel.
   * @returns {Promise<Object>} serialised bundle with hex-encoded public keys
   */
  async getPreKeyBundle() {
    if (!this.identityKey || !this.signedPreKey) {
      throw new Error('Generate identity key and signed pre-key first');
    }

    const ikPub = await exportPublicKey(this.identityKey.publicKey);
    const sigKeyPub = await exportPublicKey(this.identitySigningKey.publicKey);
    const spkPub = await exportPublicKey(this.signedPreKey.keyPair.publicKey);

    const bundle = {
      identityKey: bufToHex(ikPub),
      signingKey: bufToHex(sigKeyPub),
      signedPreKey: {
        id: this.signedPreKey.id,
        publicKey: bufToHex(spkPub),
        signature: bufToHex(this.signedPreKey.signature),
      },
      oneTimePreKeys: [],
    };

    for (const otpk of this.oneTimePreKeys) {
      const pub = await exportPublicKey(otpk.keyPair.publicKey);
      bundle.oneTimePreKeys.push({ id: otpk.id, publicKey: bufToHex(pub) });
    }

    return bundle;
  }

  /**
   * Initiate a session (Alice side).
   * Computes the X3DH shared secret from Bob's pre-key bundle.
   *
   * DH1 = DH(IK_A, SPK_B)
   * DH2 = DH(EK_A, IK_B)
   * DH3 = DH(EK_A, SPK_B)
   * DH4 = DH(EK_A, OPK_B)  [optional]
   *
   * @param {Object} theirBundle - Bob's pre-key bundle (hex-encoded)
   * @returns {Promise<{sharedSecret: ArrayBuffer, ephemeralKey: ArrayBuffer, usedOneTimePreKeyId: number|null, identityKey: ArrayBuffer}>}
   */
  async initiateSession(theirBundle) {
    if (!this.identityKey) throw new Error('Generate identity key first');

    // Import Bob's keys
    const ikB = await importECDHPublicKey(hexToBuf(theirBundle.identityKey));
    const spkB = await importECDHPublicKey(hexToBuf(theirBundle.signedPreKey.publicKey));

    // Verify signed pre-key signature
    const sigKeyB = await importECDSAPublicKey(hexToBuf(theirBundle.signingKey));
    const spkRaw = hexToBuf(theirBundle.signedPreKey.publicKey);
    const sigValid = await ecdsaVerify(
      sigKeyB,
      hexToBuf(theirBundle.signedPreKey.signature),
      spkRaw
    );
    if (!sigValid) throw new Error('Signed pre-key signature verification failed');

    // Generate ephemeral key
    const ephemeral = await generateECDH();

    // Compute DH values
    const dh1 = await ecdh(this.identityKey.privateKey, spkB);   // DH(IK_A, SPK_B)
    const dh2 = await ecdh(ephemeral.privateKey, ikB);            // DH(EK_A, IK_B)
    const dh3 = await ecdh(ephemeral.privateKey, spkB);           // DH(EK_A, SPK_B)

    let ikm;
    let usedOneTimePreKeyId = null;

    // DH4 if one-time pre-key available
    if (theirBundle.oneTimePreKeys && theirBundle.oneTimePreKeys.length > 0) {
      const otpk = theirBundle.oneTimePreKeys[0];
      usedOneTimePreKeyId = otpk.id;
      const opkB = await importECDHPublicKey(hexToBuf(otpk.publicKey));
      const dh4 = await ecdh(ephemeral.privateKey, opkB);         // DH(EK_A, OPK_B)
      // F || DH1 || DH2 || DH3 || DH4   (F = 32 bytes of 0xFF per Signal spec)
      const ff = new Uint8Array(32).fill(0xff);
      ikm = concat(ff.buffer, dh1, dh2, dh3, dh4);
    } else {
      const ff = new Uint8Array(32).fill(0xff);
      ikm = concat(ff.buffer, dh1, dh2, dh3);
    }

    // Derive shared secret via HKDF
    const sharedSecret = await hkdf(ikm, new Uint8Array(32), encode('GhostLinkX3DH'), 256);

    const ephPub = await exportPublicKey(ephemeral.publicKey);
    const ikAPub = await exportPublicKey(this.identityKey.publicKey);

    return {
      sharedSecret,
      ephemeralKey: ephPub,
      usedOneTimePreKeyId,
      identityKey: ikAPub,
    };
  }

  /**
   * Respond to session initiation (Bob side).
   * Computes the same shared secret from Alice's initial message parameters.
   *
   * @param {Object} message - { identityKey (hex), ephemeralKey (hex), usedOneTimePreKeyId }
   * @param {CryptoKeyPair} identityKey - Bob's ECDH identity key pair
   * @param {{keyPair: CryptoKeyPair}} signedPreKey - Bob's signed pre-key
   * @param {{keyPair: CryptoKeyPair}|null} oneTimePreKey - The consumed one-time pre-key (if used)
   * @returns {Promise<{sharedSecret: ArrayBuffer}>}
   */
  async respondToSession(message, identityKey, signedPreKey, oneTimePreKey) {
    const ikA = await importECDHPublicKey(hexToBuf(message.identityKey));
    const ekA = await importECDHPublicKey(hexToBuf(message.ephemeralKey));

    // Mirror the DH computations
    const dh1 = await ecdh(signedPreKey.keyPair.privateKey, ikA);  // DH(SPK_B, IK_A)
    const dh2 = await ecdh(identityKey.privateKey, ekA);           // DH(IK_B, EK_A)
    const dh3 = await ecdh(signedPreKey.keyPair.privateKey, ekA);  // DH(SPK_B, EK_A)

    let ikm;
    const ff = new Uint8Array(32).fill(0xff);

    if (oneTimePreKey) {
      const dh4 = await ecdh(oneTimePreKey.keyPair.privateKey, ekA); // DH(OPK_B, EK_A)
      ikm = concat(ff.buffer, dh1, dh2, dh3, dh4);
    } else {
      ikm = concat(ff.buffer, dh1, dh2, dh3);
    }

    const sharedSecret = await hkdf(ikm, new Uint8Array(32), encode('GhostLinkX3DH'), 256);
    return { sharedSecret };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Double Ratchet
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of skipped message keys to store */
const MAX_SKIP = 1000;

/**
 * Double Ratchet session state.
 * Provides forward secrecy and future secrecy (post-compromise security).
 */
class DoubleRatchet {
  /**
   * @param {ArrayBuffer} sharedSecret - 32-byte shared secret from X3DH
   * @param {boolean} isInitiator - true for Alice (who sends first)
   */
  constructor(sharedSecret, isInitiator) {
    /** Root key (32 bytes) */
    this.rootKey = sharedSecret;
    /** Our current DH ratchet key pair */
    this.dhKeyPair = null;
    /** Their current DH ratchet public key */
    this.dhRemotePublic = null;
    /** Sending chain key */
    this.sendChainKey = null;
    /** Receiving chain key */
    this.recvChainKey = null;
    /** Number of messages sent in current sending chain */
    this.sendN = 0;
    /** Number of messages received in current receiving chain */
    this.recvN = 0;
    /** Previous sending chain length (for header) */
    this.prevSendN = 0;
    /** Whether we are the initiator (Alice) */
    this.isInitiator = isInitiator;
    /** Skipped message keys: Map<"hexPub:n", ArrayBuffer> */
    this.skippedKeys = new Map();
    /** Initialised flag */
    this._initialised = false;
    /** Async mutex locks to prevent concurrent encrypt/decrypt race conditions */
    this._encryptLock = Promise.resolve();
    this._decryptLock = Promise.resolve();
  }

  /**
   * Initialise the ratchet. Must be called before encrypt/decrypt.
   * The initiator (Alice) generates the first DH ratchet key pair.
   * @param {CryptoKey} [theirPublicKey] - Bob's initial ratchet public key (required for initiator)
   * @returns {Promise<void>}
   */
  async init(theirPublicKey) {
    this.dhKeyPair = await generateECDH();

    if (this.isInitiator && theirPublicKey) {
      // Alice performs the first DH ratchet step
      this.dhRemotePublic = theirPublicKey;
      const dhOut = await ecdh(this.dhKeyPair.privateKey, this.dhRemotePublic);
      const { rootKey, chainKey } = await KDF_RK(this.rootKey, dhOut);
      this.rootKey = rootKey;
      this.sendChainKey = chainKey;
    }
    // Bob waits until receiving Alice's first message to complete the ratchet
    this._initialised = true;
  }

  /**
   * Get our current ratchet public key (for message headers).
   * @returns {Promise<ArrayBuffer>}
   */
  async getPublicKey() {
    return exportPublicKey(this.dhKeyPair.publicKey);
  }

  /**
   * KDF Ratchet step — derive next chain key and message key from the current chain key.
   * @param {ArrayBuffer} chainKey
   * @returns {Promise<{messageKey: ArrayBuffer, chainKey: ArrayBuffer}>}
   */
  async ratchetStep(chainKey) {
    return KDF_CK(chainKey);
  }

  /**
   * DH Ratchet — triggered when we receive a new ratchet public key from the peer.
   * Advances the root ratchet twice: once for the receiving chain, once for the sending chain.
   * @param {CryptoKey} theirPublicKey
   * @returns {Promise<void>}
   */
  async dhRatchet(theirPublicKey) {
    this.prevSendN = this.sendN;
    this.sendN = 0;
    this.recvN = 0;
    this.dhRemotePublic = theirPublicKey;

    // Advance root key -> receiving chain key
    const dhRecv = await ecdh(this.dhKeyPair.privateKey, this.dhRemotePublic);
    const recvKdf = await KDF_RK(this.rootKey, dhRecv);
    this.rootKey = recvKdf.rootKey;
    this.recvChainKey = recvKdf.chainKey;

    // Generate new DH key pair
    this.dhKeyPair = await generateECDH();

    // Advance root key -> sending chain key
    const dhSend = await ecdh(this.dhKeyPair.privateKey, this.dhRemotePublic);
    const sendKdf = await KDF_RK(this.rootKey, dhSend);
    this.rootKey = sendKdf.rootKey;
    this.sendChainKey = sendKdf.chainKey;
  }

  /**
   * Encrypt a plaintext message.
   * @param {string} plaintext
   * @returns {Promise<{header: {dh: string, pn: number, n: number}, ciphertext: ArrayBuffer, nonce: ArrayBuffer}>}
   */
  async encrypt(plaintext) {
    let resolve;
    const prev = this._encryptLock;
    this._encryptLock = new Promise(r => { resolve = r; });
    await prev;
    try {
      if (!this._initialised) throw new Error('Ratchet not initialised — call init() first');
      if (!this.sendChainKey) throw new Error('No sending chain key — ratchet not ready');

      // Advance sending chain
      const { messageKey, chainKey } = await this.ratchetStep(this.sendChainKey);
      this.sendChainKey = chainKey;

      const dhPub = await this.getPublicKey();
      const header = {
        dh: bufToHex(dhPub),
        pn: this.prevSendN,
        n: this.sendN,
      };

      // Use header as AAD for AEAD
      const aad = encode(JSON.stringify(header));
      const encKey = await deriveMessageEncryptionKey(messageKey);
      const { ciphertext, nonce } = await aesEncrypt(encKey, encode(plaintext), aad);

      this.sendN++;

      return { header, ciphertext, nonce };
    } finally {
      resolve();
    }
  }

  /**
   * Decrypt a received message.
   * Handles DH ratchet advancement and out-of-order messages.
   * @param {{dh: string, pn: number, n: number}} header
   * @param {ArrayBuffer} ciphertext
   * @param {ArrayBuffer} nonce
   * @returns {Promise<string>} decrypted plaintext
   */
  async decrypt(header, ciphertext, nonce) {
    let resolve;
    const prev = this._decryptLock;
    this._decryptLock = new Promise(r => { resolve = r; });
    await prev;
    try {
      if (!this._initialised) throw new Error('Ratchet not initialised — call init() first');

      // 1. Try skipped message keys
      const skId = skippedKeyId(header.dh, header.n);
      if (this.skippedKeys.has(skId)) {
        const mk = this.skippedKeys.get(skId);
        this.skippedKeys.delete(skId); // forward secrecy: delete after use
        return this._decryptWithKey(mk, header, ciphertext, nonce);
      }

      // 2. Check if header.dh is a new ratchet key
      const theirPubHex = header.dh;
      let currentRemoteHex = null;
      if (this.dhRemotePublic) {
        const remotePub = await exportPublicKey(this.dhRemotePublic);
        currentRemoteHex = bufToHex(remotePub);
      }

      if (currentRemoteHex !== theirPubHex) {
        // New ratchet key — skip any remaining messages from the old chain
        if (this.recvChainKey) {
          await this._skipMessages(currentRemoteHex, header.pn);
        }
        // Perform DH ratchet
        const theirPub = await importECDHPublicKey(hexToBuf(theirPubHex));
        await this.dhRatchet(theirPub);
      }

      // 3. Skip ahead in the current receiving chain if needed
      await this._skipMessages(theirPubHex, header.n);

      // 4. Advance receiving chain one step
      const { messageKey, chainKey } = await this.ratchetStep(this.recvChainKey);
      this.recvChainKey = chainKey;
      this.recvN++;

      return this._decryptWithKey(messageKey, header, ciphertext, nonce);
    } finally {
      resolve();
    }
  }

  /**
   * Skip messages in the current receiving chain up to `until`, storing their keys.
   * @private
   */
  async _skipMessages(pubHex, until) {
    if (!this.recvChainKey) return;
    if (this.recvN + MAX_SKIP < until) {
      throw new Error('Too many skipped messages');
    }
    while (this.recvN < until) {
      const { messageKey, chainKey } = await this.ratchetStep(this.recvChainKey);
      this.recvChainKey = chainKey;
      const id = skippedKeyId(pubHex, this.recvN);
      this.skippedKeys.set(id, messageKey);
      this.recvN++;
      // Prune if we exceed max
      if (this.skippedKeys.size > MAX_SKIP) {
        const oldest = this.skippedKeys.keys().next().value;
        this.skippedKeys.delete(oldest);
      }
    }
  }

  /**
   * Decrypt ciphertext with a given message key.
   * @private
   */
  async _decryptWithKey(mk, header, ciphertext, nonce) {
    const aad = encode(JSON.stringify(header));
    const encKey = await deriveMessageEncryptionKey(mk);
    const pt = await aesDecrypt(encKey, ciphertext, nonce, aad);
    return decode(pt);
  }

  /**
   * Export the ratchet state for serialisation/backup.
   * @returns {Promise<Object>}
   */
  async exportState() {
    const state = {
      rootKey: bufToHex(this.rootKey),
      sendChainKey: this.sendChainKey ? bufToHex(this.sendChainKey) : null,
      recvChainKey: this.recvChainKey ? bufToHex(this.recvChainKey) : null,
      sendN: this.sendN,
      recvN: this.recvN,
      prevSendN: this.prevSendN,
      isInitiator: this.isInitiator,
    };

    if (this.dhKeyPair) {
      state.dhPublic = bufToHex(await exportPublicKey(this.dhKeyPair.publicKey));
      state.dhPrivate = bufToHex(await exportPrivateKey(this.dhKeyPair.privateKey));
    }
    if (this.dhRemotePublic) {
      state.dhRemotePublic = bufToHex(await exportPublicKey(this.dhRemotePublic));
    }

    // Serialise skipped keys
    state.skippedKeys = {};
    for (const [id, mk] of this.skippedKeys) {
      state.skippedKeys[id] = bufToHex(mk);
    }

    return state;
  }

  /**
   * Restore ratchet state from a previously exported object.
   * @param {Object} state
   * @returns {Promise<void>}
   */
  async importState(state) {
    this.rootKey = hexToBuf(state.rootKey);
    this.sendChainKey = state.sendChainKey ? hexToBuf(state.sendChainKey) : null;
    this.recvChainKey = state.recvChainKey ? hexToBuf(state.recvChainKey) : null;
    this.sendN = state.sendN;
    this.recvN = state.recvN;
    this.prevSendN = state.prevSendN;
    this.isInitiator = state.isInitiator;

    if (state.dhPublic && state.dhPrivate) {
      const pub = await importECDHPublicKey(hexToBuf(state.dhPublic));
      const priv = await importECDHPrivateKey(hexToBuf(state.dhPrivate));
      this.dhKeyPair = { publicKey: pub, privateKey: priv };
    }
    if (state.dhRemotePublic) {
      this.dhRemotePublic = await importECDHPublicKey(hexToBuf(state.dhRemotePublic));
    }

    this.skippedKeys = new Map();
    if (state.skippedKeys) {
      for (const [id, hex] of Object.entries(state.skippedKeys)) {
        this.skippedKeys.set(id, hexToBuf(hex));
      }
    }

    this._initialised = true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Manager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages X3DH handshakes and Double Ratchet sessions for multiple peers.
 */
class SessionManager {
  constructor() {
    /** @type {X3DH} our X3DH instance */
    this.x3dh = new X3DH();
    /** @type {Map<string, DoubleRatchet>} peerId -> DoubleRatchet */
    this.sessions = new Map();
    /** Whether our keys have been generated */
    this._keysReady = false;
  }

  /**
   * Initialise local keys (identity, signed pre-key, one-time pre-keys).
   * @param {number} [otpkCount=100]
   * @returns {Promise<Object>} our pre-key bundle
   */
  async init(otpkCount = 100) {
    await this.x3dh.generateIdentityKey();
    await this.x3dh.generateSignedPreKey();
    await this.x3dh.generateOneTimePreKeys(otpkCount);
    this._keysReady = true;
    return this.x3dh.getPreKeyBundle();
  }

  /**
   * Create a new session with a peer using their pre-key bundle (we are the initiator).
   * @param {string} peerId
   * @param {Object} theirPreKeyBundle - hex-encoded pre-key bundle
   * @returns {Promise<{initialMessage: Object}>} the initial message to send to the peer
   */
  async createSession(peerId, theirPreKeyBundle) {
    if (!this._keysReady) throw new Error('Call init() first');

    const { sharedSecret, ephemeralKey, usedOneTimePreKeyId, identityKey } =
      await this.x3dh.initiateSession(theirPreKeyBundle);

    const ratchet = new DoubleRatchet(sharedSecret, true);

    // Use their signed pre-key as the initial ratchet public key
    const theirSpk = await importECDHPublicKey(
      hexToBuf(theirPreKeyBundle.signedPreKey.publicKey)
    );
    await ratchet.init(theirSpk);

    this.sessions.set(peerId, ratchet);

    return {
      initialMessage: {
        identityKey: bufToHex(identityKey),
        ephemeralKey: bufToHex(ephemeralKey),
        usedOneTimePreKeyId,
        // Include our ratchet public key so Bob can init his side
        ratchetKey: bufToHex(await ratchet.getPublicKey()),
      },
    };
  }

  /**
   * Accept a session from a peer who initiated with us.
   * @param {string} peerId
   * @param {Object} initialMessage - the peer's initial message
   * @returns {Promise<void>}
   */
  async acceptSession(peerId, initialMessage) {
    if (!this._keysReady) throw new Error('Call init() first');

    // Find the consumed one-time pre-key
    let otpk = null;
    if (initialMessage.usedOneTimePreKeyId != null) {
      const idx = this.x3dh.oneTimePreKeys.findIndex(
        k => k.id === initialMessage.usedOneTimePreKeyId
      );
      if (idx !== -1) {
        otpk = this.x3dh.oneTimePreKeys[idx];
        this.x3dh.oneTimePreKeys.splice(idx, 1); // consume it
      }
    }

    const { sharedSecret } = await this.x3dh.respondToSession(
      initialMessage,
      this.x3dh.identityKey,
      this.x3dh.signedPreKey,
      otpk
    );

    const ratchet = new DoubleRatchet(sharedSecret, false);
    // Bob sets Alice's ratchet key and inits
    const aliceRatchetKey = await importECDHPublicKey(hexToBuf(initialMessage.ratchetKey));
    ratchet.dhRemotePublic = aliceRatchetKey;
    await ratchet.init(null);

    this.sessions.set(peerId, ratchet);
  }

  /**
   * Get an existing session for a peer.
   * @param {string} peerId
   * @returns {DoubleRatchet|undefined}
   */
  getSession(peerId) {
    return this.sessions.get(peerId);
  }

  /**
   * Encrypt a message for a peer.
   * @param {string} peerId
   * @param {string} plaintext
   * @returns {Promise<{header: Object, ciphertext: ArrayBuffer, nonce: ArrayBuffer}>}
   */
  async encryptMessage(peerId, plaintext) {
    const session = this.sessions.get(peerId);
    if (!session) throw new Error(`No session for peer: ${peerId}`);
    return session.encrypt(plaintext);
  }

  /**
   * Decrypt a message from a peer.
   * @param {string} peerId
   * @param {Object} envelope - { header, ciphertext, nonce }
   * @returns {Promise<string>}
   */
  async decryptMessage(peerId, envelope) {
    const session = this.sessions.get(peerId);
    if (!session) throw new Error(`No session for peer: ${peerId}`);
    return session.decrypt(envelope.header, envelope.ciphertext, envelope.nonce);
  }

  /**
   * Export all session states for backup/persistence.
   * @returns {Promise<Object>}
   */
  async exportSessions() {
    const data = {};
    for (const [peerId, ratchet] of this.sessions) {
      data[peerId] = await ratchet.exportState();
    }
    // Also export our identity info
    const bundle = await this.x3dh.getPreKeyBundle();
    return {
      sessions: data,
      preKeyBundle: bundle,
      identityPrivate: bufToHex(
        await exportPrivateKey(this.x3dh.identityKey.privateKey)
      ),
      signingPrivate: bufToHex(
        await exportPrivateKey(this.x3dh.identitySigningKey.privateKey)
      ),
      signedPreKey: this.x3dh.signedPreKey ? {
        id: this.x3dh.signedPreKey.id,
        publicKey: bufToHex(await crypto.subtle.exportKey('raw', this.x3dh.signedPreKey.keyPair.publicKey)),
        privateKey: bufToHex(await crypto.subtle.exportKey('pkcs8', this.x3dh.signedPreKey.keyPair.privateKey)),
        signature: bufToHex(this.x3dh.signedPreKey.signature),
      } : null,
      oneTimePreKeys: await Promise.all((this.x3dh.oneTimePreKeys || []).map(async opk => ({
        id: opk.id,
        publicKey: bufToHex(await crypto.subtle.exportKey('raw', opk.keyPair.publicKey)),
        privateKey: bufToHex(await crypto.subtle.exportKey('pkcs8', opk.keyPair.privateKey)),
      }))),
      preKeyIdCounter: this.x3dh._preKeyIdCounter,
    };
  }

  /**
   * Import previously exported session states.
   * @param {Object} data
   * @returns {Promise<void>}
   */
  async importSessions(data) {
    // Restore identity keys
    if (data.identityPrivate && data.preKeyBundle) {
      const idPriv = await importECDHPrivateKey(hexToBuf(data.identityPrivate));
      const idPub = await importECDHPublicKey(hexToBuf(data.preKeyBundle.identityKey));
      this.x3dh.identityKey = { publicKey: idPub, privateKey: idPriv };

      const sigPriv = await importECDSAPrivateKey(hexToBuf(data.signingPrivate));
      const sigPub = await importECDSAPublicKey(hexToBuf(data.preKeyBundle.signingKey));
      this.x3dh.identitySigningKey = { publicKey: sigPub, privateKey: sigPriv };

      this._keysReady = true;
    }

    // Restore signed pre-key
    if (data.signedPreKey) {
      const spkPub = await importECDHPublicKey(hexToBuf(data.signedPreKey.publicKey));
      const spkPriv = await importECDHPrivateKey(hexToBuf(data.signedPreKey.privateKey));
      this.x3dh.signedPreKey = {
        id: data.signedPreKey.id,
        keyPair: { publicKey: spkPub, privateKey: spkPriv },
        signature: hexToBuf(data.signedPreKey.signature),
      };
    }
    // Restore one-time pre-keys
    if (data.oneTimePreKeys) {
      this.x3dh.oneTimePreKeys = await Promise.all(data.oneTimePreKeys.map(async opk => ({
        id: opk.id,
        keyPair: {
          publicKey: await importECDHPublicKey(hexToBuf(opk.publicKey)),
          privateKey: await importECDHPrivateKey(hexToBuf(opk.privateKey)),
        }
      })));
    }
    if (data.preKeyIdCounter) this.x3dh._preKeyIdCounter = data.preKeyIdCounter;

    // Restore sessions
    if (data.sessions) {
      for (const [peerId, state] of Object.entries(data.sessions)) {
        const ratchet = new DoubleRatchet(null, state.isInitiator);
        await ratchet.importState(state);
        this.sessions.set(peerId, ratchet);
      }
    }
  }

  /**
   * Rotate pre-keys. Generates a new signed pre-key and batch of one-time pre-keys.
   * @param {number} [otpkCount=100]
   * @returns {Promise<Object>} updated pre-key bundle
   */
  async rotatePreKeys(otpkCount = 100) {
    if (!this._keysReady) throw new Error('Call init() first');
    await this.x3dh.generateSignedPreKey();
    this.x3dh.oneTimePreKeys = []; // discard old unused OTPKs
    await this.x3dh.generateOneTimePreKeys(otpkCount);
    return this.x3dh.getPreKeyBundle();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Group Key Agreement — Sender Keys Protocol
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sender Keys protocol for group messaging (like Signal groups).
 * Each member maintains a sender key chain. When they send to the group,
 * they ratchet their own chain. Other members use the distributed sender key
 * to derive the same message key.
 */
class GroupKeyAgreement {
  /**
   * @param {SessionManager} sessionManager - for per-member encryption when distributing sender keys
   */
  constructor(sessionManager) {
    /** @type {SessionManager} */
    this.sessionManager = sessionManager;
    /**
     * Groups: Map<groupId, {
     *   members: Set<string>,
     *   ownSenderKey: { chainKey: ArrayBuffer, signingKey: CryptoKeyPair, iteration: number },
     *   memberSenderKeys: Map<memberId, { chainKey: ArrayBuffer, signingPublicKey: CryptoKey, iteration: number }>
     * }>
     */
    this.groups = new Map();
    /** Per-group async mutex locks to prevent concurrent encrypt race conditions */
    this._groupLocks = new Map();
  }

  /**
   * Create a new group.
   * @param {string} groupId
   * @param {string[]} memberIds - peer IDs of all members (excluding self)
   * @returns {Promise<void>}
   */
  async createGroup(groupId, memberIds) {
    this.groups.set(groupId, {
      members: new Set(memberIds),
      ownSenderKey: null,
      memberSenderKeys: new Map(),
    });
    await this.generateSenderKey(groupId);
  }

  /**
   * Generate (or regenerate) our sender key for a group.
   * @param {string} groupId
   * @returns {Promise<{chainKey: string, signingPublicKey: string, iteration: number}>}
   */
  async generateSenderKey(groupId) {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Unknown group: ${groupId}`);

    const chainKeyBuf = crypto.getRandomValues(new Uint8Array(32)).buffer;
    const signingKey = await generateECDSA();

    group.ownSenderKey = {
      chainKey: chainKeyBuf,
      signingKey,
      iteration: 0,
    };

    const sigPub = await exportPublicKey(signingKey.publicKey);
    return {
      chainKey: bufToHex(chainKeyBuf),
      signingPublicKey: bufToHex(sigPub),
      iteration: 0,
    };
  }

  /**
   * Distribute our sender key to all group members.
   * Each member receives the sender key encrypted via their pairwise Double Ratchet session.
   * @param {string} groupId
   * @param {Object} [memberPreKeyBundles] - Map of memberId -> preKeyBundle (for new sessions)
   * @returns {Promise<Map<string, Object>>} Map of memberId -> encrypted sender key envelope
   */
  async distributeSenderKey(groupId, memberPreKeyBundles) {
    const group = this.groups.get(groupId);
    if (!group || !group.ownSenderKey) {
      throw new Error('Generate sender key first');
    }

    const sk = group.ownSenderKey;
    const sigPub = await exportPublicKey(sk.signingKey.publicKey);
    const senderKeyPayload = JSON.stringify({
      chainKey: bufToHex(sk.chainKey),
      signingPublicKey: bufToHex(sigPub),
      iteration: sk.iteration,
    });

    const envelopes = new Map();

    for (const memberId of group.members) {
      // Ensure we have a session (create one if pre-key bundle provided)
      if (!this.sessionManager.getSession(memberId) && memberPreKeyBundles && memberPreKeyBundles[memberId]) {
        await this.sessionManager.createSession(memberId, memberPreKeyBundles[memberId]);
      }

      if (this.sessionManager.getSession(memberId)) {
        const envelope = await this.sessionManager.encryptMessage(memberId, senderKeyPayload);
        envelopes.set(memberId, envelope);
      }
    }

    return envelopes;
  }

  /**
   * Process a received sender key from a group member.
   * @param {string} groupId
   * @param {string} senderId
   * @param {Object} encryptedSenderKey - envelope from distributeSenderKey
   * @returns {Promise<void>}
   */
  async receiveSenderKey(groupId, senderId, encryptedSenderKey) {
    let group = this.groups.get(groupId);
    if (!group) {
      // Auto-create group entry if we don't have it yet
      group = {
        members: new Set([senderId]),
        ownSenderKey: null,
        memberSenderKeys: new Map(),
      };
      this.groups.set(groupId, group);
    }

    const json = await this.sessionManager.decryptMessage(senderId, encryptedSenderKey);
    const data = JSON.parse(json);

    const sigPub = await importECDSAPublicKey(hexToBuf(data.signingPublicKey));

    group.memberSenderKeys.set(senderId, {
      chainKey: hexToBuf(data.chainKey),
      signingPublicKey: sigPub,
      iteration: data.iteration,
    });

    group.members.add(senderId);
  }

  /**
   * Encrypt a message for the group using our sender key chain.
   * Ratchets our chain forward so each message uses a unique key.
   * @param {string} groupId
   * @param {string} plaintext
   * @returns {Promise<{iteration: number, ciphertext: ArrayBuffer, nonce: ArrayBuffer, signature: ArrayBuffer}>}
   */
  async encryptGroupMessage(groupId, plaintext) {
    if (!this._groupLocks.has(groupId)) this._groupLocks.set(groupId, Promise.resolve());
    let resolve;
    const prev = this._groupLocks.get(groupId);
    this._groupLocks.set(groupId, new Promise(r => { resolve = r; }));
    await prev;
    try {
      const group = this.groups.get(groupId);
      if (!group || !group.ownSenderKey) {
        throw new Error('No sender key for group');
      }

      const sk = group.ownSenderKey;

      // Derive message key from current chain key
      const { messageKey, chainKey } = await KDF_CK(sk.chainKey);
      const iteration = sk.iteration;

      // Advance chain
      sk.chainKey = chainKey;
      sk.iteration++;

      // Encrypt
      const encKey = await deriveMessageEncryptionKey(messageKey);
      const { ciphertext, nonce } = await aesEncrypt(encKey, encode(plaintext));

      // Sign the ciphertext for authentication
      const signature = await ecdsaSign(sk.signingKey.privateKey, ciphertext);

      return { iteration, ciphertext, nonce, signature };
    } finally {
      resolve();
    }
  }

  /**
   * Decrypt a message from a group member using their sender key.
   * @param {string} groupId
   * @param {string} senderId
   * @param {Object} message - { iteration, ciphertext, nonce, signature }
   * @returns {Promise<string>}
   */
  async decryptGroupMessage(groupId, senderId, message) {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Unknown group: ${groupId}`);

    const sk = group.memberSenderKeys.get(senderId);
    if (!sk) throw new Error(`No sender key for member: ${senderId}`);

    // Verify signature
    const valid = await ecdsaVerify(sk.signingPublicKey, message.signature, message.ciphertext);
    if (!valid) throw new Error('Sender key signature verification failed');

    // Fast-forward the chain to the correct iteration
    let currentChainKey = sk.chainKey;
    let currentIteration = sk.iteration;

    if (message.iteration < currentIteration) {
      // Check if we stored a skipped key for this iteration
      const skippedKeyId = `${groupId}:${senderId}:${message.iteration}`;
      const skippedKey = this._skippedGroupKeys?.get(skippedKeyId);
      if (!skippedKey) throw new Error('Message too old or already decrypted (possible replay)');
      this._skippedGroupKeys.delete(skippedKeyId);
      // Decrypt with the skipped key
      const encKey = await deriveMessageEncryptionKey(skippedKey);
      const pt = await aesDecrypt(encKey, message.ciphertext, message.nonce);
      return decode(pt);
    }

    // Advance the chain to reach the message's iteration, storing skipped keys
    if (!this._skippedGroupKeys) this._skippedGroupKeys = new Map();
    let messageKey;
    while (currentIteration < message.iteration) {
      const { chainKey: nextChain, messageKey: mk } = await KDF_CK(currentChainKey);
      const keyId = `${groupId}:${senderId}:${currentIteration}`;
      this._skippedGroupKeys.set(keyId, mk);
      currentChainKey = nextChain;
      currentIteration++;
      // Limit stored keys
      if (this._skippedGroupKeys.size > 500) {
        const oldest = this._skippedGroupKeys.keys().next().value;
        this._skippedGroupKeys.delete(oldest);
      }
    }

    // Derive the message key for the target iteration
    const result = await KDF_CK(currentChainKey);
    messageKey = result.messageKey;
    currentChainKey = result.chainKey;
    currentIteration++;

    // Update stored state
    sk.chainKey = currentChainKey;
    sk.iteration = currentIteration;

    // Decrypt
    const encKey = await deriveMessageEncryptionKey(messageKey);
    const pt = await aesDecrypt(encKey, message.ciphertext, message.nonce);
    return decode(pt);
  }

  /**
   * Add a member to the group. Re-generates our sender key and distributes to all.
   * @param {string} groupId
   * @param {string} memberId
   * @param {Object} preKeyBundle - new member's pre-key bundle
   * @returns {Promise<Map<string, Object>>} encrypted sender key envelopes for all members
   */
  async addMember(groupId, memberId, preKeyBundle) {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Unknown group: ${groupId}`);

    group.members.add(memberId);

    // Ensure session with new member
    if (!this.sessionManager.getSession(memberId)) {
      await this.sessionManager.createSession(memberId, preKeyBundle);
    }

    // Re-key: generate fresh sender key so the new member can't read history
    await this.generateSenderKey(groupId);

    // Distribute new sender key to ALL members (including the new one)
    return this.distributeSenderKey(groupId);
  }

  /**
   * Remove a member from the group. Re-generates our sender key and distributes to remaining members.
   * The removed member will not receive the new sender key.
   * @param {string} groupId
   * @param {string} memberId
   * @returns {Promise<Map<string, Object>>} encrypted sender key envelopes for remaining members
   */
  async removeMember(groupId, memberId) {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Unknown group: ${groupId}`);

    group.members.delete(memberId);
    group.memberSenderKeys.delete(memberId);

    // Re-key: generate fresh sender key so removed member can't read future messages
    await this.generateSenderKey(groupId);

    // Distribute to remaining members only
    return this.distributeSenderKey(groupId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

// (globalThis assignment below handles non-module usage)

// Also attach to globalThis for non-module usage (e.g., text/babel script tags)
if (typeof globalThis !== 'undefined') {
  globalThis.GhostLinkSignal = { X3DH, DoubleRatchet, SessionManager, GroupKeyAgreement };
}
