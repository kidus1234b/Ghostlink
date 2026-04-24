/**
 * shamir.test.js — tests for shamir.js
 *
 * Covers:
 *   - GF(2^8) field axioms (sanity-check the math foundation)
 *   - Split/reconstruct correctness
 *   - Threshold enforcement (k-1 shares → wrong result)
 *   - Encode/decode roundtrip
 *   - Edge cases and error paths
 */

import Shamir, { gfAdd, gfMul, gfDiv, GF_EXP, GF_LOG } from "./shamir.js";

async function run() {
  let passed = 0;
  let failed = 0;

  function ok(label, condition) {
    if (condition) { console.log(`  ✓ ${label}`); passed++; }
    else           { console.error(`  ✗ ${label}`); failed++; }
  }

  function throws(label, fn) {
    try { fn(); console.error(`  ✗ ${label} (expected throw, got none)`); failed++; }
    catch { console.log(`  ✓ ${label}`); passed++; }
  }

  function bytesEqual(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  // ── GF(2^8) field axioms ─────────────────────────────────────────────────
  console.group("GF(2^8): addition");
  ok("identity:   a + 0 = a",       gfAdd(0xAB, 0x00) === 0xAB);
  ok("self-inverse: a + a = 0",     gfAdd(0xAB, 0xAB) === 0x00);
  ok("commutative: a+b = b+a",      gfAdd(0x53, 0xCA) === gfAdd(0xCA, 0x53));
  ok("associative: (a+b)+c = a+(b+c)", gfAdd(gfAdd(0x10, 0x20), 0x30) === gfAdd(0x10, gfAdd(0x20, 0x30)));
  console.groupEnd();

  console.group("GF(2^8): multiplication");
  ok("zero: a * 0 = 0",             gfMul(0xAB, 0) === 0);
  ok("identity: a * 1 = a",         gfMul(0xAB, 1) === 0xAB);
  ok("commutative: a*b = b*a",      gfMul(0x53, 0xCA) === gfMul(0xCA, 0x53));
  ok("associative: (a*b)*c = a*(b*c)", gfMul(gfMul(0x02, 0x03), 0x04) === gfMul(0x02, gfMul(0x03, 0x04)));
  ok("distributive: a*(b+c) = a*b+a*c",
    gfMul(0x05, gfAdd(0x07, 0x0B)) === gfAdd(gfMul(0x05, 0x07), gfMul(0x05, 0x0B)));
  // Known AES test vector: 0x53 * 0xCA = 0x01 (they are inverses in GF(2^8))
  ok("AES test vector: 0x53 * 0xCA = 0x01", gfMul(0x53, 0xCA) === 0x01);
  console.groupEnd();

  console.group("GF(2^8): division");
  ok("a / 1 = a",                   gfDiv(0xAB, 1) === 0xAB);
  ok("0 / a = 0",                   gfDiv(0, 0xAB) === 0);
  ok("a / a = 1",                   gfDiv(0xAB, 0xAB) === 1);
  ok("(a*b) / b = a",               gfDiv(gfMul(0x53, 0xCA), 0xCA) === 0x53);
  throws("a / 0 throws",            () => gfDiv(1, 0));
  console.groupEnd();

  console.group("GF(2^8): exp/log tables");
  ok("EXP table length = 512",      GF_EXP.length === 512);
  ok("LOG table length = 256",      GF_LOG.length === 256);
  ok("EXP[0] = 1 (g^0 = 1)",       GF_EXP[0] === 1);
  // g^255 = 1 (order of multiplicative group)
  ok("EXP[255] = EXP[0]",          GF_EXP[255] === GF_EXP[0]);
  // All 255 non-zero elements appear in EXP[0..254] (generator property)
  const expSet = new Set(Array.from(GF_EXP.subarray(0, 255)));
  ok("EXP[0..254] covers all 255 non-zero elements", expSet.size === 255 && !expSet.has(0));
  console.groupEnd();

  // ── split() basic properties ─────────────────────────────────────────────
  console.group("split: basic");
  const secret = crypto.getRandomValues(new Uint8Array(32)); // 32-byte key
  const shares = Shamir.split(secret, 5, 3);

  ok("returns 5 shares",            shares.length === 5);
  ok("each share has correct x",    shares.every((s, i) => s.x === i + 1));
  ok("each y-vector is 32 bytes",   shares.every(s => s.y.length === 32));
  ok("n stored correctly",          shares.every(s => s.n === 5));
  ok("k stored correctly",          shares.every(s => s.k === 3));
  ok("all x-coords unique",         new Set(shares.map(s => s.x)).size === 5);
  ok("no share y equals secret",    shares.every(s => !bytesEqual(s.y, secret)));
  console.groupEnd();

  // ── reconstruct: all combinations of k shares ────────────────────────────
  console.group("reconstruct: any 3-of-5 combination");
  const combos = [
    [0,1,2], [0,1,3], [0,1,4],
    [0,2,3], [0,2,4], [0,3,4],
    [1,2,3], [1,2,4], [1,3,4],
    [2,3,4],
  ];
  for (const combo of combos) {
    const subset = combo.map(i => shares[i]);
    const recovered = Shamir.reconstruct(subset);
    ok(`shares [${combo}] reconstruct correctly`, bytesEqual(recovered, secret));
  }
  console.groupEnd();

  // ── reconstruct: all 5 shares also works ────────────────────────────────
  console.group("reconstruct: all shares (k > threshold)");
  const recoveredAll = Shamir.reconstruct(shares);
  ok("all 5 shares reconstruct correctly", bytesEqual(recoveredAll, secret));
  console.groupEnd();

  // ── threshold enforcement ────────────────────────────────────────────────
  console.group("threshold: k-1 shares produce wrong result");
  // With only k-1=2 shares, Lagrange interpolation returns a random-looking value
  // It is cryptographically guaranteed to be uniformly distributed over all
  // possible secrets — i.e., no information is leaked.
  // We verify: reconstruction with 2 shares gives a DIFFERENT result (with overwhelming probability).
  const twoShareResults = [];
  for (let trial = 0; trial < 5; trial++) {
    const sub = [shares[trial % 5], shares[(trial + 1) % 5]];
    const wrong = Shamir.reconstruct(sub);
    twoShareResults.push(bytesEqual(wrong, secret));
  }
  ok("2 shares (k-1) do not recover secret (5 trials)",
    twoShareResults.every(r => r === false));
  console.groupEnd();

  // ── determinism: same secret + different random coeffs → different shares ─
  console.group("randomness: split is non-deterministic");
  const shares2 = Shamir.split(secret, 5, 3);
  ok("two splits produce different shares",
    !bytesEqual(shares[0].y, shares2[0].y));
  // But both should reconstruct the same secret
  const r2 = Shamir.reconstruct([shares2[0], shares2[1], shares2[2]]);
  ok("second split still reconstructs correctly", bytesEqual(r2, secret));
  console.groupEnd();

  // ── edge cases ────────────────────────────────────────────────────────────
  console.group("edge cases");

  // All-zero secret
  const zeros = new Uint8Array(32);
  const zShares = Shamir.split(zeros, 3, 2);
  ok("splits all-zero secret", zShares.length === 3);
  const zRecovered = Shamir.reconstruct([zShares[0], zShares[1]]);
  ok("recovers all-zero secret", bytesEqual(zRecovered, zeros));

  // All-0xFF secret
  const maxSecret = new Uint8Array(32).fill(0xFF);
  const mShares = Shamir.split(maxSecret, 3, 2);
  const mRecovered = Shamir.reconstruct([mShares[1], mShares[2]]);
  ok("recovers all-0xFF secret", bytesEqual(mRecovered, maxSecret));

  // 1-byte secret
  const tinySecret = new Uint8Array([0x42]);
  const tinyShares = Shamir.split(tinySecret, 3, 2);
  const tinyRecovered = Shamir.reconstruct([tinyShares[0], tinyShares[2]]);
  ok("recovers 1-byte secret", bytesEqual(tinyRecovered, tinySecret));

  // n=k (every share required)
  const exactShares = Shamir.split(secret, 3, 3);
  const exactRecovered = Shamir.reconstruct(exactShares);
  ok("n=k=3: all 3 required, reconstructs correctly", bytesEqual(exactRecovered, secret));

  // n=2, k=2 (minimum possible split)
  const minShares = Shamir.split(secret, 2, 2);
  const minRecovered = Shamir.reconstruct(minShares);
  ok("n=2, k=2: minimum split reconstructs", bytesEqual(minRecovered, secret));

  console.groupEnd();

  // ── encode / decode roundtrip ────────────────────────────────────────────
  console.group("encode/decode");
  const tag = "deadbeef01234567"; // hex fingerprint
  const taggedShares = Shamir.split(secret, 5, 3, tag);
  const encoded = taggedShares.map(s => Shamir.encode(s));

  ok("encode returns strings",       encoded.every(e => typeof e === "string"));
  ok("encode returns even-length hex", encoded.every(e => e.length % 2 === 0));
  ok("encoded strings differ",       new Set(encoded).size === 5);

  const decoded = encoded.map(e => Shamir.decode(e));
  ok("decode restores x",            decoded.every((d, i) => d.x === taggedShares[i].x));
  ok("decode restores n",            decoded.every(d => d.n === 5));
  ok("decode restores k",            decoded.every(d => d.k === 3));
  ok("decode restores tag",          decoded.every(d => d.tag === tag));
  ok("decode restores y-vectors",    decoded.every((d, i) => bytesEqual(d.y, taggedShares[i].y)));

  // Decoded shares can reconstruct
  const decodedRecovered = Shamir.reconstruct([decoded[0], decoded[2], decoded[4]]);
  ok("decoded shares reconstruct correctly", bytesEqual(decodedRecovered, secret));
  console.groupEnd();

  // ── error paths ──────────────────────────────────────────────────────────
  console.group("error paths");
  throws("split: empty secret",           () => Shamir.split(new Uint8Array(0), 3, 2));
  throws("split: non-Uint8Array",         () => Shamir.split([1, 2, 3], 3, 2));
  throws("split: k < 2",                  () => Shamir.split(secret, 3, 1));
  throws("split: n < k",                  () => Shamir.split(secret, 2, 3));
  throws("split: n > 255",               () => Shamir.split(secret, 256, 2));
  throws("reconstruct: fewer than 2",    () => Shamir.reconstruct([shares[0]]));
  throws("reconstruct: duplicate x",     () => Shamir.reconstruct([shares[0], shares[0]]));
  throws("decode: odd-length hex",       () => Shamir.decode("abc"));
  throws("decode: unknown version",      () => Shamir.decode("02" + "01020304" + "00"));
  console.groupEnd();

  // ── summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log("✓ All tests passed");
  else console.error(`✗ ${failed} test(s) failed`);
}

run().catch(console.error);
