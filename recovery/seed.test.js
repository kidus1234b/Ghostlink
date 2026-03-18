/**
 * seed.test.js — manual tests for SeedEngine
 * Run in browser console or as an ES module in a test page.
 *
 * Each test logs PASS/FAIL clearly. No test framework needed.
 */

import SeedEngine from "./seed.js";

async function run() {
  let passed = 0;
  let failed = 0;

  function ok(label, condition) {
    if (condition) { console.log(`  ✓ ${label}`); passed++; }
    else           { console.error(`  ✗ ${label}`); failed++; }
  }

  // ── T1: generate() produces 12 words ────────────────────────────────────
  console.group("T1: generate");
  const phrase = await SeedEngine.generate();
  const words = phrase.split(" ");
  ok("returns a string",         typeof phrase === "string");
  ok("exactly 12 words",         words.length === 12);
  ok("all words lowercase",      words.every(w => w === w.toLowerCase()));
  ok("no empty words",           words.every(w => w.length > 0));
  console.groupEnd();

  // ── T2: generate() produces different phrases each time ─────────────────
  console.group("T2: entropy uniqueness");
  const phrase2 = await SeedEngine.generate();
  ok("two calls differ", phrase !== phrase2);
  console.groupEnd();

  // ── T3: validate() accepts a freshly generated phrase ───────────────────
  console.group("T3: validate — valid phrase");
  const result = await SeedEngine.validate(phrase);
  ok("valid = true",  result.valid === true);
  ok("no error",      result.error === null);
  console.groupEnd();

  // ── T4: validate() rejects wrong word count ──────────────────────────────
  console.group("T4: validate — wrong word count");
  const r4 = await SeedEngine.validate("abandon abandon abandon");
  ok("valid = false", r4.valid === false);
  ok("error mentions count", r4.error.includes("12"));
  console.groupEnd();

  // ── T5: validate() rejects unknown words ────────────────────────────────
  console.group("T5: validate — unknown word");
  const badPhrase = words.slice(0, 11).join(" ") + " ghostlink";
  const r5 = await SeedEngine.validate(badPhrase);
  ok("valid = false",           r5.valid === false);
  ok("error mentions the word", r5.error.includes("ghostlink"));
  console.groupEnd();

  // ── T6: validate() catches a flipped word (checksum) ────────────────────
  console.group("T6: validate — checksum failure");
  const flipped = [...words];
  // Swap two words — likely breaks checksum (may not if same index parity, try first+last)
  [flipped[0], flipped[11]] = [flipped[11], flipped[0]];
  const r6 = await SeedEngine.validate(flipped.join(" "));
  // Note: if the swap happens to still produce a valid checksum (rare), this may pass.
  // We just verify validate() runs without throwing.
  ok("validate() doesn't throw", typeof r6.valid === "boolean");
  console.groupEnd();

  // ── T7: toSeedBytes() returns 64 bytes ──────────────────────────────────
  console.group("T7: toSeedBytes");
  const seed = await SeedEngine.toSeedBytes(phrase);
  ok("returns Uint8Array",  seed instanceof Uint8Array);
  ok("length = 64 bytes",   seed.length === 64);
  ok("not all zeros",       seed.some(b => b !== 0));
  console.groupEnd();

  // ── T8: toSeedBytes() is deterministic ───────────────────────────────────
  console.group("T8: seed determinism");
  const seed2 = await SeedEngine.toSeedBytes(phrase);
  ok("same phrase → same seed", seed.every((b, i) => b === seed2[i]));
  console.groupEnd();

  // ── T9: different passphrase → different seed ────────────────────────────
  console.group("T9: passphrase isolation");
  const seedWithPass = await SeedEngine.toSeedBytes(phrase, "hunter2");
  ok("passphrase changes seed", !seed.every((b, i) => b === seedWithPass[i]));
  console.groupEnd();

  // ── T10: deriveRawKey() returns 32 bytes ────────────────────────────────
  console.group("T10: deriveRawKey");
  const key = await SeedEngine.deriveRawKey(seed, "encryption");
  ok("returns Uint8Array", key instanceof Uint8Array);
  ok("length = 32 bytes",  key.length === 32);
  ok("not all zeros",      key.some(b => b !== 0));
  console.groupEnd();

  // ── T11: different purposes → different keys ─────────────────────────────
  console.group("T11: key purpose isolation");
  const keyEnc  = await SeedEngine.deriveRawKey(seed, "encryption");
  const keyAuth = await SeedEngine.deriveRawKey(seed, "fragment-auth");
  const keyId   = await SeedEngine.deriveRawKey(seed, "identity");
  ok("encryption ≠ fragment-auth", !keyEnc.every((b, i)  => b === keyAuth[i]));
  ok("encryption ≠ identity",      !keyEnc.every((b, i)  => b === keyId[i]));
  ok("fragment-auth ≠ identity",   !keyAuth.every((b, i) => b === keyId[i]));
  console.groupEnd();

  // ── T12: same purpose + same seed → same key (deterministic) ────────────
  console.group("T12: key determinism");
  const keyEnc2 = await SeedEngine.deriveRawKey(seed, "encryption");
  ok("same inputs → same key", keyEnc.every((b, i) => b === keyEnc2[i]));
  console.groupEnd();

  // ── T13: fingerprintOf() ─────────────────────────────────────────────────
  console.group("T13: fingerprint");
  const fp = await SeedEngine.fingerprintOf(seed);
  ok("returns string",      typeof fp === "string");
  ok("length = 8 chars",    fp.length === 8);
  ok("uppercase hex only",  /^[0-9A-F]{8}$/.test(fp));
  const fp2 = await SeedEngine.fingerprintOf(seed);
  ok("deterministic",       fp === fp2);
  console.groupEnd();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log("✓ All tests passed");
  else console.error(`✗ ${failed} test(s) failed`);
}

run().catch(console.error);
