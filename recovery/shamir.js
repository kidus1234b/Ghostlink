/**
 * recovery/shamir.js
 * Shamir's Secret Sharing over GF(2^8)
 * Written from scratch — no dependencies.
 *
 * Why GF(2^8)?
 *   We work byte-by-byte. Each byte is an element of GF(256).
 *   Addition = XOR (no carry in characteristic-2 fields).
 *   Multiplication = polynomial multiplication mod the irreducible polynomial.
 *   We use the same irreducible polynomial as AES: x^8+x^4+x^3+x+1 = 0x11B.
 *   This field is extremely well-studied. No surprises.
 *
 * Public API:
 *   Shamir.split(secret, n, k)   → Share[]
 *   Shamir.reconstruct(shares)   → Uint8Array
 *   Shamir.encode(share)         → hex string  (for transmission)
 *   Shamir.decode(hex)           → Share
 *
 * Share format: { x: uint8, y: Uint8Array, n, k, tag, version }
 *   x   — x-coordinate of this share (1..n), never 0 (0 is the secret itself)
 *   y   — one byte per secret byte: f(x) for each coefficient polynomial
 *   n   — total shares generated (context only, not used in math)
 *   k   — threshold required to reconstruct
 *   tag — hex fingerprint of owner's public key (peers store but can't read)
 *   version — "gl-v1" (for future migration)
 *
 * Constraints:
 *   2 ≤ k ≤ n ≤ 255
 *   secret.length ≥ 1
 */

// ─── GF(2^8) field tables ────────────────────────────────────────────────────
// We precompute EXP and LOG tables using generator g=3.
// EXP[i] = g^i mod p,  LOG[x] = i such that g^i = x.
// This turns multiplication into: a*b = EXP[(LOG[a]+LOG[b]) % 255]
// which is O(1) with no branching (important: no timing side-channels on table lookups).

const GF_EXP = new Uint8Array(512); // doubled for safe modular arithmetic
const GF_LOG = new Uint8Array(256);

(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    // Multiply by generator g=3 in GF(2^8): x*3 = (x<<1) XOR x
    // Then reduce mod 0x11B if degree overflows
    x ^= (x << 1) ^ (x & 0x80 ? 0x1B : 0);
    x &= 0xFF;
  }
  // Fill the second half of EXP so we can index without % in inner loops
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
  GF_LOG[0] = 0; // log(0) is undefined — callers must guard against 0
})();

// GF(2^8) operations

/** Add two field elements. In GF(2^8), addition is XOR — no overflow. */
function gfAdd(a, b) {
  return a ^ b;
}

/** Multiply two field elements using precomputed log/exp tables. */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]; // index into doubled EXP avoids % 255
}

/** Divide a by b in GF(2^8). Throws on division by zero. */
function gfDiv(a, b) {
  if (b === 0) throw new RangeError("GF division by zero");
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255];
}

// ─── polynomial helpers ───────────────────────────────────────────────────────

/**
 * Evaluate polynomial at x using Horner's method.
 * coeffs[0] = constant term (the secret byte), coeffs[k-1] = highest degree.
 *
 * f(x) = c0 + c1*x + c2*x^2 + ... + c(k-1)*x^(k-1)
 * Horner: f(x) = c0 + x*(c1 + x*(c2 + ... + x*c(k-1)))
 *
 * O(k) multiplications, no intermediate exponentiations.
 */
function polyEval(coeffs, x) {
  let result = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    result = gfAdd(gfMul(result, x), coeffs[i]);
  }
  return result;
}

/**
 * Lagrange interpolation at x=0 over GF(2^8).
 * Given k points (xs[i], ys[i]), recovers f(0) — which is the secret byte.
 *
 * f(0) = Σ y_i * Π_{j≠i} (0 - x_j) / (x_i - x_j)
 *
 * In GF(2^8): (0 - x_j) = x_j  and  (x_i - x_j) = x_i XOR x_j
 * So: basis_i = Π_{j≠i} x_j / (x_i XOR x_j)
 */
function lagrangeAt0(xs, ys) {
  let secret = 0;
  const k = xs.length;

  for (let i = 0; i < k; i++) {
    let num = 1; // numerator of basis polynomial
    let den = 1; // denominator of basis polynomial

    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      num = gfMul(num, xs[j]);              // product of x_j
      den = gfMul(den, gfAdd(xs[i], xs[j])); // product of (x_i XOR x_j)
    }

    secret = gfAdd(secret, gfMul(ys[i], gfDiv(num, den)));
  }

  return secret;
}

// ─── input validation ────────────────────────────────────────────────────────

function validateParams(secret, n, k) {
  if (!(secret instanceof Uint8Array) || secret.length === 0) {
    throw new TypeError("secret must be a non-empty Uint8Array");
  }
  if (!Number.isInteger(k) || k < 2) {
    throw new RangeError(`k must be an integer ≥ 2, got ${k}`);
  }
  if (!Number.isInteger(n) || n < k) {
    throw new RangeError(`n must be an integer ≥ k (${k}), got ${n}`);
  }
  if (n > 255) {
    throw new RangeError(`n cannot exceed 255 (GF(2^8) limit), got ${n}`);
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

const Shamir = {

  /**
   * Split a secret (Uint8Array) into n shares, requiring k to reconstruct.
   *
   * For each byte of the secret:
   *   - Build a random degree-(k-1) polynomial where f(0) = secret_byte
   *   - Evaluate at x = 1, 2, ..., n → those are the share y-values
   *
   * tag: hex string identifying the owner (e.g. SHA256 of their pubkey).
   *      Peers store this to know "whose fragment" they're holding —
   *      but they cannot derive the secret from the tag.
   *
   * Returns an array of n Share objects.
   */
  split(secret, n, k, tag = "") {
    validateParams(secret, n, k);

    // Allocate share y-vectors
    const shares = Array.from({ length: n }, (_, i) => ({
      version: "gl-v1",
      x: i + 1,           // x-coordinates: 1..n (never 0)
      y: new Uint8Array(secret.length),
      n,
      k,
      tag,
    }));

    // Build and evaluate one polynomial per secret byte
    const coeffs = new Uint8Array(k);

    for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
      // f(0) = secret byte (constant term)
      coeffs[0] = secret[byteIdx];

      // Random coefficients for degrees 1 .. k-1
      crypto.getRandomValues(coeffs.subarray(1));

      // Evaluate f(x) for each share's x-coordinate
      for (const share of shares) {
        share.y[byteIdx] = polyEval(coeffs, share.x);
      }
    }

    // Wipe coefficients from memory (they contain the secret)
    coeffs.fill(0);

    return shares;
  },

  /**
   * Reconstruct the secret from any k (or more) shares.
   *
   * Applies Lagrange interpolation at x=0 independently for each byte position.
   * Extra shares beyond k are silently ignored (more shares = same result,
   * just extra redundancy verification you could add).
   *
   * Throws if shares have mismatched lengths or x-coordinates are not unique.
   */
  reconstruct(shares) {
    if (!Array.isArray(shares) || shares.length < 2) {
      throw new TypeError("reconstruct() requires an array of at least 2 shares");
    }

    const len = shares[0].y.length;
    if (shares.some(s => s.y.length !== len)) {
      throw new RangeError("All shares must have the same y-vector length");
    }

    const xs = shares.map(s => s.x);
    if (new Set(xs).size !== xs.length) {
      throw new RangeError("Share x-coordinates must be unique");
    }

    const secret = new Uint8Array(len);
    const ysSlice = new Uint8Array(shares.length);

    for (let byteIdx = 0; byteIdx < len; byteIdx++) {
      for (let i = 0; i < shares.length; i++) {
        ysSlice[i] = shares[i].y[byteIdx];
      }
      secret[byteIdx] = lagrangeAt0(xs, ysSlice);
    }

    return secret;
  },

  /**
   * Encode a share to a compact hex string for transmission or storage.
   *
   * Wire format (all hex):
   *   [1 byte: version=0x01]
   *   [1 byte: x]
   *   [1 byte: n]
   *   [1 byte: k]
   *   [2 bytes: y-length big-endian]
   *   [y-length bytes: y]
   *   [1 byte: tag-length in chars / 2 (bytes)]
   *   [tag bytes]
   */
  encode(share) {
    const tagBytes = share.tag
      ? new Uint8Array(share.tag.match(/.{2}/g).map(h => parseInt(h, 16)))
      : new Uint8Array(0);

    const yLen = share.y.length;
    const buf = new Uint8Array(1 + 1 + 1 + 1 + 2 + yLen + 1 + tagBytes.length);
    let offset = 0;

    buf[offset++] = 0x01;               // version
    buf[offset++] = share.x;
    buf[offset++] = share.n;
    buf[offset++] = share.k;
    buf[offset++] = (yLen >> 8) & 0xFF; // y-length hi
    buf[offset++] = yLen & 0xFF;        // y-length lo
    buf.set(share.y, offset); offset += yLen;
    buf[offset++] = tagBytes.length;
    buf.set(tagBytes, offset);

    return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
  },

  /**
   * Decode a hex-encoded share back to a Share object.
   * Throws if the format is invalid.
   */
  decode(hex) {
    if (typeof hex !== "string" || hex.length % 2 !== 0) {
      throw new TypeError("decode() expects a hex string");
    }

    const buf = new Uint8Array(hex.match(/.{2}/g).map(h => parseInt(h, 16)));
    let offset = 0;

    const version = buf[offset++];
    if (version !== 0x01) throw new RangeError(`Unknown share version: 0x${version.toString(16)}`);

    const x    = buf[offset++];
    const n    = buf[offset++];
    const k    = buf[offset++];
    const yLen = (buf[offset++] << 8) | buf[offset++];

    const y = buf.slice(offset, offset + yLen); offset += yLen;
    const tagLen = buf[offset++];
    const tagBytes = buf.slice(offset, offset + tagLen);
    const tag = Array.from(tagBytes).map(b => b.toString(16).padStart(2, "0")).join("");

    return { version: "gl-v1", x, n, k, y, tag };
  },

};

export default Shamir;
export { gfAdd, gfMul, gfDiv, GF_EXP, GF_LOG }; // exported for testing only
