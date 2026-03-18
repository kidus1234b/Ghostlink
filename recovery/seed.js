/**
 * recovery/seed.js
 * BIP39 mnemonic generation + PBKDF2/HKDF master key derivation
 *
 * Depends on: ./wordlist.js  (BIP39 English, 2048 words — run: node fetch-wordlist.js)
 * No external crypto deps — uses Web Crypto API throughout.
 *
 * Public API:
 *   SeedEngine.generate()                        → "word1 word2 ... word12"
 *   SeedEngine.validate(phrase)                  → { valid, error }
 *   SeedEngine.toSeedBytes(phrase, passphrase?)  → Uint8Array[64]
 *   SeedEngine.deriveRawKey(seedBytes, purpose)  → Uint8Array[32]
 *   SeedEngine.fingerprintOf(seedBytes)          → hex string (8 chars, display only)
 */

import WORDLIST from "./wordlist.js";

// ─── sanity check at load time ───────────────────────────────────────────────
if (WORDLIST.length !== 2048) {
  throw new Error(`[seed.js] wordlist must have exactly 2048 entries, got ${WORDLIST.length}`);
}

// ─── internal helpers ────────────────────────────────────────────────────────

/** Convert a Uint8Array to a flat array of bits (MSB first). */
function toBits(bytes) {
  return Array.from(bytes).flatMap(byte =>
    Array.from({ length: 8 }, (_, i) => (byte >> (7 - i)) & 1)
  );
}

/** Pack an array of bits (MSB first) into a Uint8Array. Length must be multiple of 8. */
function fromBits(bits) {
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = bits.slice(i * 8, i * 8 + 8).reduce((acc, b) => (acc << 1) | b, 0);
  }
  return bytes;
}

/** SHA-256 a Uint8Array → Uint8Array. */
async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

// ─── public API ──────────────────────────────────────────────────────────────

const SeedEngine = {

  /**
   * Generate a cryptographically secure 12-word BIP39 mnemonic.
   *
   * Algorithm (BIP39 spec):
   *   1. 128 bits of entropy   (crypto.getRandomValues)
   *   2. checksum = SHA256(entropy)[0..3]  (first 4 bits, since 128/32 = 4)
   *   3. combined = entropy_bits + checksum_bits  (132 bits total)
   *   4. split into 12 × 11-bit chunks → index into wordlist
   */
  async generate() {
    const entropy = crypto.getRandomValues(new Uint8Array(16)); // 128 bits

    const hash = await sha256(entropy);
    const checksumBits = toBits(hash).slice(0, 4); // first 4 bits of SHA256

    const combined = [...toBits(entropy), ...checksumBits]; // 132 bits

    const words = Array.from({ length: 12 }, (_, i) => {
      const chunk = combined.slice(i * 11, i * 11 + 11);
      const index = chunk.reduce((acc, b) => (acc << 1) | b, 0);
      return WORDLIST[index];
    });

    return words.join(" ");
  },

  /**
   * Validate a mnemonic phrase.
   * Returns { valid: true } or { valid: false, error: string }.
   *
   * Checks:
   *   - Exactly 12 words
   *   - Every word exists in the BIP39 wordlist
   *   - Checksum is correct (detects typos that change word meaning)
   */
  async validate(phrase) {
    const words = phrase.trim().toLowerCase().split(/\s+/);

    if (words.length !== 12) {
      return { valid: false, error: `Expected 12 words, got ${words.length}` };
    }

    const indices = words.map(w => WORDLIST.indexOf(w));
    const unknown = words.filter((_, i) => indices[i] === -1);
    if (unknown.length > 0) {
      return { valid: false, error: `Unknown word(s): ${unknown.join(", ")}` };
    }

    // Reconstruct 132 bits from word indices
    const bits = indices.flatMap(idx =>
      Array.from({ length: 11 }, (_, i) => (idx >> (10 - i)) & 1)
    );

    const entropyBits  = bits.slice(0, 128);
    const checksumBits = bits.slice(128);       // last 4 bits

    const entropy = fromBits(entropyBits);
    const hash = await sha256(entropy);
    const expectedChecksum = toBits(hash).slice(0, 4);

    const valid = checksumBits.every((b, i) => b === expectedChecksum[i]);
    return {
      valid,
      error: valid ? null : "Checksum failed — one or more words may be wrong or out of order",
    };
  },

  /**
   * Derive a 512-bit master seed from a mnemonic using PBKDF2-HMAC-SHA512.
   * This is the standard BIP39 seed derivation.
   *
   * passphrase: optional extra secret (empty string = standard BIP39 behavior).
   * Returns Uint8Array[64].
   *
   * NOTE: This is intentionally slow (2048 iterations) — that's the spec.
   * Do NOT call this on every keystroke; call once after the user confirms their phrase.
   */
  async toSeedBytes(phrase, passphrase = "") {
    const enc = new TextEncoder();

    const baseKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(phrase.trim().toLowerCase()),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: enc.encode("mnemonic" + passphrase), // BIP39 spec salt format
        iterations: 2048,
        hash: "SHA-512",
      },
      baseKey,
      512
    );

    return new Uint8Array(bits); // 64 bytes
  },

  /**
   * Derive a named 32-byte key from the master seed using HKDF-SHA256.
   *
   * Each purpose string produces a deterministically different key.
   * Defined purposes:
   *   "encryption"    — AES-256-GCM key for encrypting the backup blob
   *   "fragment-auth" — key for authenticating Shamir fragment requests
   *   "identity"      — key for signing peer discovery messages
   *
   * Returns raw Uint8Array[32] so shamir.js and blob.js can use it directly.
   */
  async deriveRawKey(seedBytes, purpose = "encryption") {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      seedBytes,
      "HKDF",
      false,
      ["deriveKey"]
    );

    const derivedKey = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode("ghostlink-v1"),
        info: new TextEncoder().encode(purpose),
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      true,  // extractable — shamir.js needs raw bytes to split
      ["encrypt", "decrypt"]
    );

    return new Uint8Array(await crypto.subtle.exportKey("raw", derivedKey));
  },

  /**
   * Generate a short hex fingerprint from seed bytes for display only.
   * Used in the UI as "Your identity: 3F7A2C..." — NOT used for any crypto.
   *
   * Returns first 8 hex chars of SHA256(seedBytes).
   */
  async fingerprintOf(seedBytes) {
    const hash = await sha256(seedBytes);
    return Array.from(hash.slice(0, 4))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  },

};

export default SeedEngine;
