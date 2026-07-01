/**
 * GMP Nonce Persistence Test — Phase 2a
 *
 * Tests the nonce store's persistence and restart simulation:
 * 1. Create a nonce store, add some entries
 * 2. Simulate process restart by creating a new instance pointing at same file
 * 3. Confirm entries are loaded correctly
 * 4. Test pruning of old entries
 * 5. Test session key uniqueness check behavior
 *
 * Run: node test/nonce-persistence-test.js
 */

import { NonceStore } from '../nonce-store.js';
import fs from 'fs';
import path from 'path';

const TEST_STATE_FILE = '/tmp/gmp-nonce-test-state.json';
const TEST_SEED = 'test seed for nonce persistence';

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  testsRun++;
  if (condition) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  testsRun++;
  if (actual === expected) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message} (expected ${expected}, got ${actual})`);
  }
}

function assertContains(haystack, needle, message) {
  testsRun++;
  if (haystack.includes(needle)) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message}`);
  }
}

async function cleanup() {
  try {
    if (fs.existsSync(TEST_STATE_FILE)) {
      fs.unlinkSync(TEST_STATE_FILE);
    }
  } catch (e) {}
}

async function testBasicPersistence() {
  console.log('\n=== Test 1: Basic Persistence ===');

  await cleanup();

  const store1 = new NonceStore({ stateFile: TEST_STATE_FILE });
  await store1.load();

  const fakePeerId = new Uint8Array(64);
  fakePeerId.fill(0x41);
  const fakeSessionKey = new Uint8Array(32);
  fakeSessionKey.fill(0x42);

  const result1 = store1.checkAndUpdate(fakePeerId, fakeSessionKey, 5, 10);
  assertEqual(result1.allowed, true, 'First connection allowed');

  store1.close();

  const store2 = new NonceStore({ stateFile: TEST_STATE_FILE });
  await store2.load();

  const entry = store2.getEntry(fakePeerId, fakeSessionKey);
  assert(entry !== null, 'Entry persisted across restart');
  assertEqual(entry.sendHighWater, 5, 'Send high water persisted');
  assertEqual(entry.recvHighWater, 10, 'Recv high water persisted');

  store2.close();
  await cleanup();
}

async function testNonceOverlapRejection() {
  console.log('\n=== Test 2: Nonce Overlap Rejection ===');

  await cleanup();

  const store = new NonceStore({ stateFile: TEST_STATE_FILE });
  await store.load();

  const fakePeerId = new Uint8Array(64);
  fakePeerId.fill(0x51);
  const fakeSessionKey = new Uint8Array(32);
  fakeSessionKey.fill(0x52);

  const result1 = store.checkAndUpdate(fakePeerId, fakeSessionKey, 100, 200);
  assertEqual(result1.allowed, true, 'First connection with nonces 100/200 allowed');

  const result2 = store.checkAndUpdate(fakePeerId, fakeSessionKey, 50, 150);
  assertEqual(result2.allowed, false, 'Second connection with overlapping nonces rejected');
  assertContains(result2.reason, 'send nonce', 'Rejection reason mentions send nonce');

  const result3 = store.checkAndUpdate(fakePeerId, fakeSessionKey, 100, 150);
  assertEqual(result3.allowed, false, 'Second connection with equal send nonce rejected');

  const result4 = store.checkAndUpdate(fakePeerId, fakeSessionKey, 50, 200);
  assertEqual(result4.allowed, false, 'Second connection with equal recv nonce rejected');

  const result5 = store.checkAndUpdate(fakePeerId, fakeSessionKey, 150, 300);
  assertEqual(result5.allowed, true, 'Connection with higher nonces (150/300) allowed');

  store.close();
  await cleanup();
}

async function testPruning() {
  console.log('\n=== Test 3: Old Entry Pruning ===');

  await cleanup();

  const store = new NonceStore({ stateFile: TEST_STATE_FILE });
  await store.load();

  const fakePeerId = new Uint8Array(64);
  fakePeerId.fill(0x61);
  const fakeSessionKey = new Uint8Array(32);
  fakeSessionKey.fill(0x62);

  store.checkAndUpdate(fakePeerId, fakeSessionKey, 1, 1);

  const entry = store.state.entries[Object.keys(store.state.entries)[0]];
  const oldTimestamp = Date.now() - (31 * 24 * 60 * 60 * 1000);
  entry.lastActivity = oldTimestamp;
  entry.firstSeen = oldTimestamp;

  store.close();

  const store2 = new NonceStore({ stateFile: TEST_STATE_FILE });
  await store2.load();

  const entryAfterPrune = store2.getEntry(fakePeerId, fakeSessionKey);
  assert(entryAfterPrune === null, 'Old entries (>30 days) are pruned on load');

  store2.close();
  await cleanup();
}

async function testMultiplePeers() {
  console.log('\n=== Test 4: Multiple Peer Entries ===');

  await cleanup();

  const store = new NonceStore({ stateFile: TEST_STATE_FILE });
  await store.load();

  const peer1Id = new Uint8Array(64);
  peer1Id.fill(0x71);
  const peer1Key = new Uint8Array(32);
  peer1Key.fill(0x72);

  const peer2Id = new Uint8Array(64);
  peer2Id.fill(0x81);
  const peer2Key = new Uint8Array(32);
  peer2Key.fill(0x82);

  const peer3Id = new Uint8Array(64);
  peer3Id.fill(0x91);
  const peer3Key = new Uint8Array(32);
  peer3Key.fill(0x92);

  store.checkAndUpdate(peer1Id, peer1Key, 10, 20);
  store.checkAndUpdate(peer2Id, peer2Key, 30, 40);
  store.checkAndUpdate(peer3Id, peer3Key, 50, 60);

  store.close();

  const store2 = new NonceStore({ stateFile: TEST_STATE_FILE });
  await store2.load();

  const keys = Object.keys(store2.state.entries);
  assertEqual(keys.length, 3, 'All three peer entries persisted');

  const entry1 = store2.getEntry(peer1Id, peer1Key);
  assertEqual(entry1.sendHighWater, 10, 'Peer 1 send high water correct');
  assertEqual(entry1.recvHighWater, 20, 'Peer 1 recv high water correct');

  const entry2 = store2.getEntry(peer2Id, peer2Key);
  assertEqual(entry2.sendHighWater, 30, 'Peer 2 send high water correct');
  assertEqual(entry2.recvHighWater, 40, 'Peer 2 recv high water correct');

  const entry3 = store2.getEntry(peer3Id, peer3Key);
  assertEqual(entry3.sendHighWater, 50, 'Peer 3 send high water correct');
  assertEqual(entry3.recvHighWater, 60, 'Peer 3 recv high water correct');

  store2.close();
  await cleanup();
}

async function testUpdateCounters() {
  console.log('\n=== Test 5: Update Counters ===');

  await cleanup();

  const store = new NonceStore({ stateFile: TEST_STATE_FILE });
  await store.load();

  const fakePeerId = new Uint8Array(64);
  fakePeerId.fill(0xA1);
  const fakeSessionKey = new Uint8Array(32);
  fakeSessionKey.fill(0xA2);

  store.updateCounters(fakePeerId, fakeSessionKey, 5, 10);
  store.updateCounters(fakePeerId, fakeSessionKey, 8, 12);
  store.updateCounters(fakePeerId, fakeSessionKey, 3, 7);

  const entry = store.getEntry(fakePeerId, fakeSessionKey);
  assertEqual(entry.sendHighWater, 8, 'Send high water updated correctly (max 8)');
  assertEqual(entry.recvHighWater, 12, 'Recv high water updated correctly (max 12)');

  store.close();
  await cleanup();
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 2a — Nonce Persistence Test                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    await testBasicPersistence();
    await testNonceOverlapRejection();
    await testPruning();
    await testMultiplePeers();
    await testUpdateCounters();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');

  } catch (err) {
    console.error('\nTest suite error:', err);
    console.error(err.stack);
  }

  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests();