/**
 * blob.test.js — tests for blob.js
 *
 * Requires: seed.js (for generating real seedBytes), blob.js
 * Run as ES module in browser or test page.
 */

import SeedEngine from "./seed.js";
import BlobEngine from "./blob.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

const SAMPLE_SETTINGS = {
  theme: "phantom",
  fontSize: 13,
  notifications: true,
  sounds: true,
  readReceipts: false,
  encLevel: "AES-256-GCM",
  p2pRelay: "WebRTC",
};

const SAMPLE_CONTACTS = [
  { id: 1, name: "Alex Chen",  pubKey: "04a1b2c3", avatar: "AC", color: "#1a3a2a", status: "online",  lastSeen: "now"   },
  { id: 2, name: "Sarah Kim",  pubKey: "04d4e5f6", avatar: "SK", color: "#2a1a3a", status: "online",  lastSeen: "now"   },
  { id: 3, name: "Dev Team",   pubKey: "multi-sig", avatar: "DT", color: "#1a2a3a", status: "group",   lastSeen: "now", isGroup: true },
];

function makePayload(overrides = {}) {
  return {
    version:      "gl-v1",
    type:         "identity",
    name:         "Kidus",
    publicKeyHex: "04aabbccddee112233445566778899aabbccddee112233445566778899aabbccddee",
    fingerprint:  "3F7A2C1B44DD89EF",
    contacts:     SAMPLE_CONTACTS,
    settings:     SAMPLE_SETTINGS,
    createdAt:    1700000000000,
    ...overrides,
  };
}

// ─── test runner ─────────────────────────────────────────────────────────────

async function run() {
  let passed = 0;
  let failed = 0;

  function ok(label, condition) {
    if (condition) { console.log(`  ✓ ${label}`); passed++; }
    else           { console.error(`  ✗ ${label}`); failed++; }
  }

  async function rejects(label, fn) {
    try {
      await fn();
      console.error(`  ✗ ${label} (expected rejection, got none)`);
      failed++;
    } catch {
      console.log(`  ✓ ${label}`);
      passed++;
    }
  }

  // Generate a real seed once — reused across tests
  const phrase   = await SeedEngine.generate();
  const seedBytes = await SeedEngine.toSeedBytes(phrase);

  // A second unrelated seed for "wrong key" tests
  const phrase2    = await SeedEngine.generate();
  const seedBytes2 = await SeedEngine.toSeedBytes(phrase2);

  const payload = makePayload();

  // ── validate() ──────────────────────────────────────────────────────────
  console.group("validate: valid payload");
  const v1 = BlobEngine.validate(payload);
  ok("ok = true",       v1.ok === true);
  ok("no errors",       v1.errors.length === 0);
  console.groupEnd();

  console.group("validate: missing required fields");
  const missingName = BlobEngine.validate(makePayload({ name: undefined }));
  ok("missing name → ok = false",    missingName.ok === false);
  ok("error mentions 'name'",        missingName.errors.some(e => e.includes("name")));

  const missingContacts = BlobEngine.validate(makePayload({ contacts: undefined }));
  ok("missing contacts → ok = false", missingContacts.ok === false);

  const wrongType = BlobEngine.validate(makePayload({ type: "history" }));
  ok("wrong type → ok = false",      wrongType.ok === false);

  const badFP = BlobEngine.validate(makePayload({ fingerprint: "tooshort" }));
  ok("bad fingerprint → ok = false", badFP.ok === false);
  console.groupEnd();

  console.group("validate: contact fields");
  const missingContactField = BlobEngine.validate(makePayload({
    contacts: [{ id: 1, name: "Alice" }], // missing pubKey, avatar, etc.
  }));
  ok("incomplete contact → ok = false",   missingContactField.ok === false);
  ok("error mentions contact index",       missingContactField.errors.some(e => e.includes("contacts[0]")));
  console.groupEnd();

  // ── pack() ───────────────────────────────────────────────────────────────
  console.group("pack: output shape");
  const blob = await BlobEngine.pack(payload, seedBytes);
  ok("returns object",          typeof blob === "object");
  ok("version = gl-v1",         blob.version === "gl-v1");
  ok("type = identity",         blob.type === "identity");
  ok("has iv (24 hex chars)",   typeof blob.iv === "string" && blob.iv.length === 24);
  ok("has ciphertext (string)", typeof blob.ciphertext === "string" && blob.ciphertext.length > 0);
  ok("has tag (64 hex chars)",  typeof blob.tag === "string" && blob.tag.length === 64);
  ok("has exportedAt",          typeof blob.exportedAt === "number");
  ok("ciphertext is hex",       /^[0-9a-f]+$/.test(blob.ciphertext));
  console.groupEnd();

  console.group("pack: ciphertext hides content");
  // The plaintext name "Kidus" must not appear in the outer blob fields
  const blobStr = JSON.stringify(blob);
  ok("name not in ciphertext string", !blobStr.includes("Kidus"));
  ok("pubKeyHex not in ciphertext string", !blobStr.includes("04aabbccddee"));
  console.groupEnd();

  console.group("pack: tag derivation");
  const expectedTag = await BlobEngine.tagFor(payload.publicKeyHex);
  ok("tag = SHA256(publicKeyHex)", blob.tag === expectedTag);
  // Two packs of same payload produce same tag (it's deterministic)
  const blob2 = await BlobEngine.pack(payload, seedBytes);
  ok("tag is stable across packs", blob.tag === blob2.tag);
  console.groupEnd();

  console.group("pack: each call produces different iv + ciphertext");
  ok("iv differs",         blob.iv !== blob2.iv);
  ok("ciphertext differs", blob.ciphertext !== blob2.ciphertext);
  console.groupEnd();

  console.group("pack: rejects invalid payload");
  await rejects("missing name",    () => BlobEngine.pack(makePayload({ name: "" }),        seedBytes));
  await rejects("wrong type",      () => BlobEngine.pack(makePayload({ type: "history" }), seedBytes));
  await rejects("bad seedBytes",   () => BlobEngine.pack(payload, new Uint8Array(32)));
  await rejects("non-Uint8Array",  () => BlobEngine.pack(payload, "not bytes"));
  console.groupEnd();

  // ── unpack() ─────────────────────────────────────────────────────────────
  console.group("unpack: roundtrip");
  const unpacked = await BlobEngine.unpack(blob, seedBytes);
  ok("returns object",         typeof unpacked === "object");
  ok("name restored",          unpacked.name === payload.name);
  ok("publicKeyHex restored",  unpacked.publicKeyHex === payload.publicKeyHex);
  ok("fingerprint restored",   unpacked.fingerprint === payload.fingerprint);
  ok("createdAt restored",     unpacked.createdAt === payload.createdAt);
  ok("contacts count",         unpacked.contacts.length === payload.contacts.length);
  ok("contacts[0].name",       unpacked.contacts[0].name === "Alex Chen");
  ok("contacts[2].isGroup",    unpacked.contacts[2].isGroup === true);
  ok("settings.theme",         unpacked.settings.theme === "phantom");
  ok("settings.fontSize",      unpacked.settings.fontSize === 13);
  ok("exportedAt is present",  typeof unpacked.exportedAt === "number");
  console.groupEnd();

  console.group("unpack: wrong seed → decryption fails");
  await rejects("wrong seed rejects", () => BlobEngine.unpack(blob, seedBytes2));
  console.groupEnd();

  console.group("unpack: tampered ciphertext → rejects");
  const tampered = {
    ...blob,
    ciphertext: blob.ciphertext.slice(0, -4) + "dead", // flip last 2 bytes
  };
  await rejects("tampered ciphertext rejects", () => BlobEngine.unpack(tampered, seedBytes));
  console.groupEnd();

  console.group("unpack: tampered iv → rejects");
  const tamperedIV = {
    ...blob,
    iv: "000000000000000000000000", // wrong iv → wrong decryption
  };
  await rejects("wrong iv rejects", () => BlobEngine.unpack(tamperedIV, seedBytes));
  console.groupEnd();

  console.group("unpack: bad blob shape");
  await rejects("null blob",         () => BlobEngine.unpack(null, seedBytes));
  await rejects("unknown version",   () => BlobEngine.unpack({ ...blob, version: "gl-v0" }, seedBytes));
  await rejects("wrong type",        () => BlobEngine.unpack({ ...blob, type: "history"  }, seedBytes));
  await rejects("bad seedBytes",     () => BlobEngine.unpack(blob, new Uint8Array(32)));
  console.groupEnd();

  // ── tagFor() ─────────────────────────────────────────────────────────────
  console.group("tagFor");
  const tag1 = await BlobEngine.tagFor("04aabbccddee");
  const tag2 = await BlobEngine.tagFor("04aabbccddee");
  const tag3 = await BlobEngine.tagFor("04ffeeddccbb");
  ok("returns 64-char hex",         tag1.length === 64 && /^[0-9a-f]+$/.test(tag1));
  ok("deterministic",               tag1 === tag2);
  ok("different keys → different tags", tag1 !== tag3);
  console.groupEnd();

  // ── estimateSize() ───────────────────────────────────────────────────────
  console.group("estimateSize");
  const size = BlobEngine.estimateSize(payload);
  ok("returns a number",            typeof size === "number");
  ok("reasonable range (>100 bytes)", size > 100);
  ok("reasonable range (<10KB)",    size < 10000);
  console.groupEnd();

  // ── seed independence: different seeds → same tag but different ciphertext
  console.group("cross-seed isolation");
  const blobSeed2 = await BlobEngine.pack(payload, seedBytes2);
  ok("same payload, different seed → different ciphertext",
    blob.ciphertext !== blobSeed2.ciphertext);
  ok("same payload, different seed → same tag (tag depends on pubkey, not seed)",
    blob.tag === blobSeed2.tag);
  console.groupEnd();

  // ── summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log("✓ All tests passed");
  else console.error(`✗ ${failed} test(s) failed`);
}

run().catch(console.error);
