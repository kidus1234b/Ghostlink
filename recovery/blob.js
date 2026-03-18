/**
 * recovery/blob.js
 * Identity blob — serialize, encrypt, decrypt, deserialize.
 *
 * "Identity-only" scope (v1):
 *   name, publicKeyHex, fingerprint, contacts, settings
 *
 * Intentionally excluded (future blob types):
 *   message chain, file metadata, call logs
 *
 * Depends on: ./seed.js  (for key derivation)
 * No other deps — AES-256-GCM via Web Crypto.
 *
 * Public API:
 *   BlobEngine.pack(payload, seedBytes)    → EncryptedBlob
 *   BlobEngine.unpack(blob, seedBytes)     → IdentityPayload
 *   BlobEngine.validate(payload)           → { ok, errors[] }
 *
 * Encrypted blob wire format (stored on disk / sent to peers as JSON):
 * {
 *   version:    "gl-v1",
 *   type:       "identity",
 *   tag:        hex[64]     — SHA256(publicKeyHex), peers index by this, can't read content
 *   iv:         hex[24]     — 12-byte random AES-GCM IV
 *   ciphertext: hex         — AES-256-GCM(payload_json, encryption_key, iv)
 *                             GCM auth tag is appended by Web Crypto (last 16 bytes of ct)
 *   exportedAt: number      — unix ms timestamp of this backup
 * }
 *
 * The plaintext (inside the ciphertext) is JSON of IdentityPayload.
 * Nothing sensitive appears in the outer wrapper — only the tag (pubkey hash)
 * and the ciphertext. The tag is intentionally public: peers need it to
 * answer "do I hold a fragment for this person?" without decrypting anything.
 */

import SeedEngine from "./seed.js";

// ─── schema ───────────────────────────────────────────────────────────────────

/**
 * The shape of what gets encrypted inside the blob.
 * Keep this minimal — only what's needed to restore identity on a new device.
 *
 * @typedef {Object} Contact
 * @property {number}  id
 * @property {string}  name
 * @property {string}  pubKey     — hex public key
 * @property {string}  avatar     — 2-char initials
 * @property {string}  color      — hex color for avatar background
 * @property {string}  status     — "online" | "offline" | "group"
 * @property {string}  lastSeen
 * @property {boolean} [isGroup]
 *
 * @typedef {Object} IdentitySettings
 * @property {string}  theme
 * @property {number}  fontSize
 * @property {boolean} notifications
 * @property {boolean} sounds
 * @property {boolean} readReceipts
 * @property {string}  encLevel
 * @property {string}  p2pRelay
 *
 * @typedef {Object} IdentityPayload
 * @property {string}           version      — "gl-v1"
 * @property {string}           type         — "identity"
 * @property {string}           name         — display name
 * @property {string}           publicKeyHex — ECDH public key (hex)
 * @property {string}           fingerprint  — 16-char hex (from SeedEngine.fingerprintOf)
 * @property {Contact[]}        contacts
 * @property {IdentitySettings} settings
 * @property {number}           createdAt    — original account creation timestamp
 * @property {number}           exportedAt   — timestamp of this specific backup
 */

// Required top-level fields for a valid IdentityPayload
const REQUIRED_FIELDS = ["version", "type", "name", "publicKeyHex", "fingerprint", "contacts", "settings", "createdAt"];

// Required fields per contact entry
const REQUIRED_CONTACT_FIELDS = ["id", "name", "pubKey", "avatar", "color", "status", "lastSeen"];

// ─── internal helpers ─────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Uint8Array → lowercase hex string */
function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Hex string → Uint8Array */
function fromHex(hex) {
  if (hex.length % 2 !== 0) throw new TypeError("hex string must have even length");
  return new Uint8Array(hex.match(/.{2}/g).map(h => parseInt(h, 16)));
}

/** SHA-256 a string → hex */
async function sha256hex(str) {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return toHex(new Uint8Array(hash));
}

/**
 * Derive the AES-256-GCM CryptoKey used for blob encryption.
 * Purpose is fixed — "encryption" — so seed.js HKDF gives a stable key
 * that is different from the Shamir fragment-auth key.
 */
async function deriveEncKey(seedBytes) {
  const raw = await SeedEngine.deriveRawKey(seedBytes, "encryption");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * AES-256-GCM encrypt.
 * Web Crypto appends the 16-byte auth tag to the end of the ciphertext automatically.
 * Returns { iv: hex, ciphertext: hex }.
 */
async function aesgcmEncrypt(plaintext, cryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    enc.encode(plaintext)
  );
  return {
    iv: toHex(iv),
    ciphertext: toHex(new Uint8Array(ct)),
  };
}

/**
 * AES-256-GCM decrypt.
 * Throws DOMException if the auth tag doesn't match (tampered or wrong key).
 * We let that propagate — callers treat any throw as "decryption failed".
 */
async function aesgcmDecrypt(ivHex, ciphertextHex, cryptoKey) {
  const iv         = fromHex(ivHex);
  const ciphertext = fromHex(ciphertextHex);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    ciphertext
  );
  return dec.decode(plain);
}

// ─── public API ───────────────────────────────────────────────────────────────

const BlobEngine = {

  /**
   * Validate an IdentityPayload before encrypting.
   * Returns { ok: true } or { ok: false, errors: string[] }.
   * Lenient on settings fields — we don't break on unknown theme names etc.
   */
  validate(payload) {
    const errors = [];

    // Top-level required fields
    for (const field of REQUIRED_FIELDS) {
      if (payload[field] === undefined || payload[field] === null) {
        errors.push(`missing required field: ${field}`);
      }
    }

    if (errors.length) return { ok: false, errors };

    if (payload.version !== "gl-v1") {
      errors.push(`unknown version: ${payload.version}`);
    }
    if (payload.type !== "identity") {
      errors.push(`expected type "identity", got "${payload.type}"`);
    }
    if (typeof payload.name !== "string" || !payload.name.trim()) {
      errors.push("name must be a non-empty string");
    }
    if (typeof payload.publicKeyHex !== "string" || payload.publicKeyHex.length < 10) {
      errors.push("publicKeyHex looks invalid");
    }
    if (typeof payload.fingerprint !== "string" || payload.fingerprint.length !== 16) {
      errors.push("fingerprint must be 16 hex chars");
    }
    if (!Array.isArray(payload.contacts)) {
      errors.push("contacts must be an array");
    } else {
      payload.contacts.forEach((c, i) => {
        for (const f of REQUIRED_CONTACT_FIELDS) {
          if (c[f] === undefined) errors.push(`contacts[${i}] missing field: ${f}`);
        }
      });
    }
    if (typeof payload.settings !== "object" || Array.isArray(payload.settings)) {
      errors.push("settings must be an object");
    }
    if (typeof payload.createdAt !== "number") {
      errors.push("createdAt must be a number (unix ms)");
    }

    return { ok: errors.length === 0, errors };
  },

  /**
   * Build and encrypt an identity blob.
   *
   * payload: IdentityPayload (without exportedAt — we set it here)
   * seedBytes: Uint8Array[64] from SeedEngine.toSeedBytes()
   *
   * Returns an EncryptedBlob object (safe to JSON.stringify and send to peers).
   */
  async pack(payload, seedBytes) {
    if (!(seedBytes instanceof Uint8Array) || seedBytes.length !== 64) {
      throw new TypeError("seedBytes must be Uint8Array[64] from SeedEngine.toSeedBytes()");
    }

    // Stamp export time
    const fullPayload = {
      ...payload,
      exportedAt: Date.now(),
    };

    // Validate before touching crypto
    const { ok, errors } = this.validate(fullPayload);
    if (!ok) throw new Error(`Invalid payload: ${errors.join("; ")}`);

    // Derive encryption key
    const cryptoKey = await deriveEncKey(seedBytes);

    // Serialize → encrypt
    const plaintext = JSON.stringify(fullPayload);
    const { iv, ciphertext } = await aesgcmEncrypt(plaintext, cryptoKey);

    // Tag = SHA256(publicKeyHex) — public identifier, no content leaked
    const tag = await sha256hex(payload.publicKeyHex);

    return {
      version:    "gl-v1",
      type:       "identity",
      tag,
      iv,
      ciphertext,
      exportedAt: fullPayload.exportedAt,
    };
  },

  /**
   * Decrypt and parse an identity blob.
   *
   * blob: EncryptedBlob (from pack() or received from a peer)
   * seedBytes: Uint8Array[64] — must match the seed used during pack()
   *
   * Throws if:
   *   - seedBytes are wrong (GCM auth tag mismatch → DOMException)
   *   - blob was tampered (same)
   *   - decrypted JSON is malformed
   *   - payload fails schema validation
   *
   * Returns IdentityPayload on success.
   */
  async unpack(blob, seedBytes) {
    if (!blob || typeof blob !== "object") {
      throw new TypeError("blob must be an object");
    }
    if (blob.version !== "gl-v1") {
      throw new RangeError(`unknown blob version: ${blob.version}`);
    }
    if (blob.type !== "identity") {
      throw new RangeError(`expected identity blob, got type: ${blob.type}`);
    }
    if (!(seedBytes instanceof Uint8Array) || seedBytes.length !== 64) {
      throw new TypeError("seedBytes must be Uint8Array[64]");
    }

    const cryptoKey = await deriveEncKey(seedBytes);

    // This throws on wrong key or tampered ciphertext — let it propagate
    let plaintext;
    try {
      plaintext = await aesgcmDecrypt(blob.iv, blob.ciphertext, cryptoKey);
    } catch {
      throw new Error("Decryption failed — wrong seed phrase or blob was tampered with");
    }

    let payload;
    try {
      payload = JSON.parse(plaintext);
    } catch {
      throw new Error("Decrypted content is not valid JSON — blob may be corrupt");
    }

    const { ok, errors } = this.validate(payload);
    if (!ok) throw new Error(`Decrypted payload failed validation: ${errors.join("; ")}`);

    return payload;
  },

  /**
   * Compute the tag for a given publicKeyHex.
   * Used by distributor.js to query peers: "do you hold a fragment tagged X?"
   */
  async tagFor(publicKeyHex) {
    return sha256hex(publicKeyHex);
  },

  /**
   * Estimate the size of a packed blob in bytes (before base64/hex expansion).
   * Useful for deciding whether to split across multiple Shamir fragments.
   * Returns the raw JSON byte count of the payload + ~28 bytes GCM overhead.
   */
  estimateSize(payload) {
    return enc.encode(JSON.stringify(payload)).length + 28;
  },

};

export default BlobEngine;
