/**
 * GMP Claim Log Tests
 *
 * Claims live in an append-only log so that a handshake costs one index lookup
 * and one small append, instead of rewriting every claim ever made. These cover
 * the properties that makes possible — flat latency, a partial tail being
 * ordinary, a corrupt record being fatal to everything after it — and the
 * migration out of the old in-JSON claims map.
 */

import { NonceStore } from '../dist/nonce-store.js';
import config from '../dist/config.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const SEED = 'claim log seed';
let testsRun = 0, testsPassed = 0, testsFailed = 0;
function assert(condition, message) {
  testsRun++;
  if (condition) { testsPassed++; console.log(`  ✓ ${message}`); }
  else { testsFailed++; console.error(`  ✗ ${message}`); }
}
function assertEqual(actual, expected, message) {
  testsRun++;
  if (actual === expected) { testsPassed++; console.log(`  ✓ ${message}`); }
  else { testsFailed++; console.error(`  ✗ ${message} (expected ${expected}, got ${actual})`); }
}

let dir;
const freshFile = () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-log-'));
  return path.join(dir, 'nonce-state.json');
};
const dropDir = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } };
const claimsOf = (stateFile) => `${stateFile}.claims.log`;
const peer = Buffer.alloc(64, 5);
const fp = (i) => crypto.createHash('sha256').update(`fp-${i}`).digest('hex').slice(0, 32);

/**
 * The whole point: claim latency must not grow with the number of claims held.
 * Under the old in-JSON scheme every claim rewrote the accumulated set, so the
 * 100,000th claim cost about 500ms against the 100th's 0.1ms.
 */
function testLatencyIsFlat() {
  console.log('\n=== Test 1: Claim latency is flat, not linear ===');
  const stateFile = freshFile();
  const store = new NonceStore({ stateFile, seedPhrase: SEED });

  const timeOne = (i) => {
    const started = process.hrtime.bigint();
    store.claimSessionKey(peer, fp(i));
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  const early = [];
  for (let i = 0; i < 100; i++) early.push(timeOne(i));
  const earlyMean = early.slice(50).reduce((a, b) => a + b, 0) / 50;

  for (let i = 100; i < 100_000; i++) store.claimSessionKey(peer, fp(i));

  const late = [];
  for (let i = 100_000; i < 100_050; i++) late.push(timeOne(i));
  const lateMean = late.reduce((a, b) => a + b, 0) / late.length;

  assertEqual(store.claimCount, 100_050, '100,050 claims are held');
  console.log(`      100th claim: ${earlyMean.toFixed(3)} ms   100,000th claim: ${lateMean.toFixed(3)} ms`);
  assert(
    lateMean < earlyMean * 5 + 1,
    `The 100,000th claim costs about the same as the 100th (${earlyMean.toFixed(3)}ms -> ${lateMean.toFixed(3)}ms)`
  );

  // And a repeat claim is refused without touching the disk at all.
  const sizeBefore = fs.statSync(claimsOf(stateFile)).size;
  assertEqual(store.claimSessionKey(peer, fp(42)).valid, false, 'An already-claimed fingerprint is refused');
  assertEqual(fs.statSync(claimsOf(stateFile)).size, sizeBefore, 'A refused claim writes nothing');

  store.close();
  dropDir();
}

/** A crash mid-append leaves a partial record. That is ordinary, not corruption. */
function testPartialTailIsDiscarded() {
  console.log('\n=== Test 2: A partial final record is discarded, prior claims intact ===');
  const stateFile = freshFile();
  const claims = claimsOf(stateFile);

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  for (let i = 0; i < 5; i++) a.claimSessionKey(peer, fp(i));
  a.close();

  // Simulate a process killed partway through writing record six.
  const whole = fs.readFileSync(claims);
  const sealed = Buffer.concat([whole, whole.subarray(0, 20)]);
  fs.writeFileSync(claims, sealed);

  const seen = [];
  const realErr = console.error;
  console.error = (...x) => { seen.push(x.join(' ')); };
  let b;
  try {
    b = new NonceStore({ stateFile, seedPhrase: SEED });
    b.load();
  } finally { console.error = realErr; }

  assertEqual(b.claimCount, 5, 'All five completed claims are present');
  assert(!seen.some(l => l.includes('state-claim-log-corrupt')), 'No corruption is reported for a partial tail');
  for (let i = 0; i < 5; i++) {
    if (b.claimSessionKey(peer, fp(i)).valid) { assert(false, `Claim ${i} survived`); break; }
  }
  assert(true, 'Every prior claim is still refused');
  b.close();
  dropDir();
}

/** A damaged record in the middle invalidates everything after it, loudly. */
function testMidFileCorruption() {
  console.log('\n=== Test 3: A corrupt record stops the read and is loud ===');
  const stateFile = freshFile();
  const claims = claimsOf(stateFile);

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  for (let i = 0; i < 10; i++) a.claimSessionKey(peer, fp(i));
  a.close();

  // Flip a byte inside the ciphertext of roughly the fifth record.
  const bytes = fs.readFileSync(claims);
  const target = Math.floor(bytes.length / 2);
  bytes[target] ^= 0xff;
  fs.writeFileSync(claims, bytes);

  const seen = [];
  const realErr = console.error;
  console.error = (...x) => { seen.push(x.join(' ')); };
  const previousStrict = config.GMP_STRICT_STATE;
  let recovered = 0;
  try {
    config.GMP_STRICT_STATE = false;
    const b = new NonceStore({ stateFile, seedPhrase: SEED });
    b.load();
    recovered = b.claimCount;
    b.close();
  } finally { console.error = realErr; }

  assert(seen.some(l => l.includes('state-claim-log-corrupt')), 'An ERROR naming state-claim-log-corrupt is logged');
  assert(recovered > 0, `Records before the damage survive (${recovered} recovered)`);
  assert(recovered < 10, 'Records after the damage are not trusted');

  let threw = null;
  try {
    config.GMP_STRICT_STATE = true;
    new NonceStore({ stateFile, seedPhrase: SEED }).load();
  } catch (e) { threw = e; } finally { config.GMP_STRICT_STATE = previousStrict; }
  assertEqual(threw && threw.name, 'StateAuthenticationError', 'Strict mode refuses to start');
  dropDir();
}

/** Migration out of a version 2 state file that still carries a claims map. */
function testMigrationFromJson() {
  console.log('\n=== Test 4: Claims migrate out of the state JSON into the log ===');
  const stateFile = freshFile();
  const key = crypto.pbkdf2Sync(SEED, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');
  const peerHex = Buffer.from(peer).toString('hex');

  const v2 = {
    version: 2,
    entries: { [`${peerHex}:${fp(99)}`]: { highWaterMark: 7, lastActivity: Date.now() } },
    claims: {
      [fp(1)]: { peerNodeId: peerHex, claimedAt: Date.now() - 1000 },
      [fp(2)]: { peerNodeId: peerHex, claimedAt: Date.now() - 500 },
      [fp(3)]: { peerNodeId: peerHex, claimedAt: Date.now() },
    },
  };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(v2), 'utf8'), c.final()]);
  fs.writeFileSync(stateFile, JSON.stringify({
    iv: iv.toString('hex'),
    ciphertext: Buffer.concat([c.getAuthTag(), ct]).toString('hex'),
    version: 1,
  }, null, 2));

  const store = new NonceStore({ stateFile, seedPhrase: SEED });
  store.load();

  assert(fs.existsSync(claimsOf(stateFile)), 'The claim log was created');
  assertEqual(store.claimCount, 3, 'All three claims came across');
  for (const i of [1, 2, 3]) {
    assertEqual(store.claimSessionKey(peer, fp(i)).valid, false, `Claim ${i} is honoured after migration`);
  }
  store.close();

  // The rewritten state file must no longer carry claims.
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const blob = Buffer.from(raw.ciphertext, 'hex');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'hex'));
  d.setAuthTag(blob.subarray(0, 16));
  const plain = JSON.parse(Buffer.concat([d.update(blob.subarray(16)), d.final()]).toString('utf8'));
  assertEqual(plain.version, 3, 'The state file is now version 3');
  assertEqual(plain.claims, undefined, 'The state JSON no longer carries a claims map');
  assert(Object.keys(plain.entries).length === 1, 'Counter entries are untouched');

  // Reloading must not re-append the same claims.
  const again = new NonceStore({ stateFile, seedPhrase: SEED });
  again.load();
  assertEqual(again.claimCount, 3, 'A second load does not duplicate the migrated claims');
  again.close();
  dropDir();
}

/** Durability: a claim is on disk before claimSessionKey returns. */
function testClaimDurableBeforeReturn() {
  console.log('\n=== Test 5: A claim is durable before it returns ===');
  const stateFile = freshFile();

  const a = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(a.claimSessionKey(peer, fp(7)).valid, true, 'Claim succeeds');
  // No close(): stand in for SIGKILL immediately afterwards.

  const b = new NonceStore({ stateFile, seedPhrase: SEED });
  assertEqual(b.claimSessionKey(peer, fp(7)).valid, false, 'A new process already sees it');
  b.close();
  dropDir();
}

function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP — Claim Log Tests                                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  try {
    testLatencyIsFlat();
    testPartialTailIsDiscarded();
    testMidFileCorruption();
    testMigrationFromJson();
    testClaimDurableBeforeReturn();
  } catch (err) {
    console.error('\nTest suite error:', err);
    dropDir();
    process.exit(1);
  }
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  process.exit(testsFailed > 0 ? 1 : 0);
}

run();
