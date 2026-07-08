/**
 * GMP Peer Cache Test Suite — Phase 4
 */

import { PeerCache } from '../peer-cache.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const tempCachePath = path.join(__dirname, 'data', 'temp-peer-cache-file.json');

function cleanTempCache() {
  if (fs.existsSync(tempCachePath)) {
    try {
      fs.unlinkSync(tempCachePath);
    } catch (e) {}
  }
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 4 — Peer Cache Tests                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    cleanTempCache();

    testSuccessUpsert();
    testFailureTracking();
    testReliabilityScore();
    testCacheSizeLimit();
    testPruning();

    cleanTempCache();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nTest suite error:', err);
    cleanTempCache();
    process.exit(1);
  }
}

function testSuccessUpsert() {
  console.log('\n=== Test 1: Success Upsert Behavior ===');

  const cache = new PeerCache({ filePath: tempCachePath });
  const nodeId = '1'.repeat(128);

  cache.recordSuccess(nodeId, '127.0.0.1', 5001);
  
  assertEqual(cache.cache.length, 1, "Cache has one entry");
  const entry = cache.cache[0];
  assertEqual(entry.nodeId, nodeId, "NodeID matches");
  assertEqual(entry.address, '127.0.0.1', "Address matches");
  assertEqual(entry.port, 5001, "Port matches");
  assertEqual(entry.connectionCount, 1, "connectionCount is 1");
  assertEqual(entry.failureCount, 0, "failureCount is 0");
  assert(entry.lastSeen !== null, "lastSeen is recorded");

  // Record success again to verify upsert
  cache.recordSuccess(nodeId, '127.0.0.1', 5002);
  assertEqual(cache.cache.length, 1, "Cache still has one entry");
  assertEqual(cache.cache[0].port, 5002, "Port is updated");
  assertEqual(cache.cache[0].connectionCount, 2, "connectionCount is incremented");

  cache.close();
}

function testFailureTracking() {
  console.log('\n=== Test 2: Failure Tracking Behavior ===');

  const cache = new PeerCache({ filePath: tempCachePath });
  const nodeId = '1'.repeat(128);

  // Setup entry
  cache.recordSuccess(nodeId, '127.0.0.1', 5001);

  // Record failure
  cache.recordFailure(nodeId);
  const entry = cache.cache[0];
  assertEqual(entry.failureCount, 1, "failureCount incremented");
  assert(entry.lastFailedAt !== null, "lastFailedAt timestamp set");

  cache.close();
}

function testReliabilityScore() {
  console.log('\n=== Test 3: Reliability Score Logic ===');

  const cache = new PeerCache({ filePath: tempCachePath });
  const entryRecent = {
    nodeId: 'a',
    connectionCount: 10,
    failureCount: 0,
    lastSeen: Date.now() - 10 * 60 * 1000 // 10 mins ago (<1h)
  };
  const entry24h = {
    nodeId: 'b',
    connectionCount: 10,
    failureCount: 0,
    lastSeen: Date.now() - 5 * 60 * 60 * 1000 // 5 hours ago (<24h)
  };
  const entryOld = {
    nodeId: 'c',
    connectionCount: 10,
    failureCount: 0,
    lastSeen: Date.now() - 3 * 24 * 60 * 60 * 1000 // 3 days ago (<7d)
  };

  const scoreRecent = cache.getScore(entryRecent);
  const score24h = cache.getScore(entry24h);
  const scoreOld = cache.getScore(entryOld);

  assert(scoreRecent > score24h, `Recent score (${scoreRecent}) is higher than 24h score (${score24h})`);
  assert(score24h > scoreOld, `24h score (${score24h}) is higher than old score (${scoreOld})`);

  cache.close();
}

function testCacheSizeLimit() {
  console.log('\n=== Test 4: Cache Size Limit Enforcement ===');

  const cache = new PeerCache({ filePath: tempCachePath });

  // Fill cache with 500 entries
  for (let i = 0; i < 500; i++) {
    const id = i.toString(16).padStart(128, '0');
    cache.recordSuccess(id, '127.0.0.1', 5000);
  }
  assertEqual(cache.cache.length, 500, "Cache contains 500 entries");

  // Make the first entry less reliable
  const id0 = '0'.padStart(128, '0');
  const entry0 = cache.cache.find(e => e.nodeId === id0);
  entry0.failureCount = 10;
  entry0.lastSeen = Date.now() - 20 * 24 * 60 * 60 * 1000; // 20 days ago

  // Add 501st entry
  const idNew = 'f'.repeat(128);
  cache.recordSuccess(idNew, '127.0.0.1', 6000);

  assertEqual(cache.cache.length, 500, "Cache is still capped at 500 entries");
  assert(cache.cache.find(e => e.nodeId === idNew) !== undefined, "New entry was added");
  assert(cache.cache.find(e => e.nodeId === id0) === undefined, "Lowest-scored entry (entry0) was pruned");

  cache.close();
}

function testPruning() {
  console.log('\n=== Test 5: Expiry and Pruning ===');

  const cache = new PeerCache({ filePath: tempCachePath });
  const now = Date.now();

  cache.cache = [
    { nodeId: '1'.repeat(128), address: '127.0.0.1', port: 5001, firstSeen: now, lastSeen: now, connectionCount: 5, lastFailedAt: null, failureCount: 0 },
    { nodeId: '2'.repeat(128), address: '127.0.0.1', port: 5002, firstSeen: now, lastSeen: now - 35 * 24 * 60 * 60 * 1000, connectionCount: 1, lastFailedAt: now - 35 * 24 * 60 * 60 * 1000, failureCount: 11 } // dead peer
  ];

  assertEqual(cache.cache.length, 2, "Starts with 2 entries");
  
  cache.prune();
  
  assertEqual(cache.cache.length, 1, "Dead peer was pruned");
  assertEqual(cache.cache[0].nodeId, '1'.repeat(128), "Only reliable peer remains");

  cache.close();
}

runTests();
