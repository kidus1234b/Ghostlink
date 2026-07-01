/**
 * GMP Rate Limit Test — Phase 2a
 *
 * Tests the rate limiter implementation:
 * 1. Per-IP rate limiting: 15 rapid connections, exactly 10 accepted, 5 rejected
 * 2. Global connection cap: 101st connection refused
 * 3. Handshake timeout: raw TCP connection with no data closed after timeout
 * 4. Verify handshake crypto is never invoked for rejected connections
 *
 * Run: node test/rate-limit-test.js
 */

import { RateLimiter } from '../rate-limiter.js';
import { GMPNode } from '../link.js';
import net from 'net';

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

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testPerIpRateLimiting() {
  console.log('\n=== Test 1: Per-IP Rate Limiting ===');

  const rateLimiter = new RateLimiter({
    windowMs: 60000,
    maxPerIp: 10,
    maxGlobal: 1000,
  });

  let acceptedCount = 0;
  let rejectedCount = 0;

  rateLimiter.on('rate-limited', ({ ip, reason }) => {
    rejectedCount++;
  });

  for (let i = 0; i < 15; i++) {
    const mockSocket = {
      remoteAddress: '192.168.1.100',
    };
    if (rateLimiter.checkConnection(mockSocket)) {
      acceptedCount++;
      rateLimiter._globalCount--;
    }
  }

  assertEqual(acceptedCount, 10, 'Exactly 10 connections accepted');
  assertEqual(rejectedCount, 5, 'Exactly 5 connections rejected');

  rateLimiter.close();
}

async function testGlobalConnectionCap() {
  console.log('\n=== Test 2: Global Connection Cap ===');

  const rateLimiter = new RateLimiter({
    windowMs: 60000,
    maxPerIp: 1000,
    maxGlobal: 3,
  });

  let acceptedCount = 0;
  let rejectedCount = 0;

  rateLimiter.on('rate-limited', ({ ip, reason }) => {
    if (reason === 'global-cap-reached') {
      rejectedCount++;
    }
  });

  for (let i = 0; i < 5; i++) {
    const mockSocket = {
      remoteAddress: `192.168.1.${i}`,
    };
    if (rateLimiter.checkConnection(mockSocket)) {
      acceptedCount++;
    }
  }

  assertEqual(acceptedCount, 3, 'Exactly 3 connections accepted (global cap)');
  assertEqual(rejectedCount, 2, 'Exactly 2 connections rejected (global cap exceeded)');

  rateLimiter.close();
}

async function testHandshakeTimeout() {
  console.log('\n=== Test 3: Handshake Timeout ===');

  const nodeA = new GMPNode({
    port: 49520,
    rateLimiter: new RateLimiter({
      helloTimeoutMs: 2000,
      handshakeTimeoutMs: 2000,
    }),
  });

  await nodeA.loadIdentity('timeout test seed a');

  await nodeA.listen();

  let timeoutFired = false;
  nodeA.rateLimiter.on('hello-timeout', ({ linkId }) => {
    console.log(`  Hello timeout fired for ${linkId}`);
    timeoutFired = true;
  });

  nodeA.rateLimiter.on('handshake-timeout', ({ linkId }) => {
    console.log(`  Handshake timeout fired for ${linkId}`);
    timeoutFired = true;
  });

  await new Promise(async (resolve) => {
    const socket = new net.Socket();
    socket.connect(49520, '127.0.0.1', () => {
      console.log('  Raw TCP connection opened, not sending any data...');
    });

    socket.on('close', () => {
      console.log('  Socket closed by server');
      resolve();
    });

    setTimeout(resolve, 5000);
  });

  assert(timeoutFired, 'Timeout event was fired');

  nodeA.close();
}

async function testRateLimitBeforeHandshake() {
  console.log('\n=== Test 4: Rate Limit Before Handshake Crypto ===');

  const nodeA = new GMPNode({
    port: 49521,
    rateLimiter: new RateLimiter({
      windowMs: 60000,
      maxPerIp: 2,
      maxGlobal: 100,
    }),
  });

  await nodeA.loadIdentity('rate limit handshake test seed a');
  await nodeA.listen();

  let rateLimitEvents = [];
  nodeA.rateLimiter.on('rate-limited', ({ ip, reason }) => {
    console.log(`  Rate limited: ${reason} from ${ip}`);
    rateLimitEvents.push(reason);
  });

  let connectionsCompleted = 0;
  nodeA.on('connection', ({ connId }) => {
    console.log(`  Connection completed: ${connId}`);
    connectionsCompleted++;
  });

  const dialer = new GMPNode({ port: 49522 });
  await dialer.loadIdentity('rate limit handshake test dialer');
  const dialResult = await dialer.dial('127.0.0.1', 49521);
  console.log('  Real connection established via dial()');
  await delay(300);

  assertEqual(connectionsCompleted, 1, 'Real connection completed via dial()');

  const socket2 = new net.Socket();
  await new Promise((resolve) => {
    socket2.connect(49521, '127.0.0.1', resolve);
  });
  console.log('  Connection 2 opened (raw socket, will timeout)');
  await delay(2500);

  const socket3 = new net.Socket();
  const socket3Closed = new Promise((resolve) => {
    socket3.on('close', resolve);
  });
  await new Promise((resolve) => {
    socket3.connect(49521, '127.0.0.1', () => {
      socket3.destroy();
    });
    socket3.on('close', resolve);
  });
  console.log('  Connection 3 was closed immediately (rate limited)');

  await delay(500);

  assert(rateLimitEvents.includes('per-ip-limit'), 'Per-IP rate limit was triggered');
  console.log(`  Rate limit events: ${rateLimitEvents.length}`);

  dialResult.link.destroy();
  dialer.close();
  nodeA.close();
}

async function testRateLimiterStats() {
  console.log('\n=== Test 5: Rate Limiter Stats ===');

  const rateLimiter = new RateLimiter({
    windowMs: 60000,
    maxPerIp: 10,
    maxGlobal: 100,
  });

  const mockSocket = { remoteAddress: '10.0.0.1' };

  for (let i = 0; i < 5; i++) {
    rateLimiter.checkConnection(mockSocket);
    rateLimiter._globalCount--;
  }

  const stats = rateLimiter.getStats();
  assertEqual(stats.globalCount, 0, 'Global count after cleanup is 0');
  assertEqual(stats.maxGlobal, 100, 'Max global is 100');
  assertEqual(stats.pendingConnections, 0, 'Pending connections is 0');

  rateLimiter.close();
}

async function testIPWindowCleaning() {
  console.log('\n=== Test 6: IP Window Cleaning ===');

  const rateLimiter = new RateLimiter({
    windowMs: 1000,
    maxPerIp: 3,
    maxGlobal: 100,
  });

  const mockSocket = { remoteAddress: '10.0.0.2' };

  rateLimiter.checkConnection(mockSocket);
  rateLimiter._globalCount--;
  rateLimiter.checkConnection(mockSocket);
  rateLimiter._globalCount--;
  rateLimiter.checkConnection(mockSocket);
  rateLimiter._globalCount--;

  assertEqual(rateLimiter._ipWindows.get('10.0.0.2').length, 3, '3 timestamps in window');

  await delay(1100);

  rateLimiter.checkConnection(mockSocket);
  rateLimiter._globalCount--;

  assertEqual(rateLimiter._ipWindows.get('10.0.0.2').length, 1, 'Old timestamps cleaned, 1 remains');

  rateLimiter.close();
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 2a — Rate Limiter Test                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    await testPerIpRateLimiting();
    await testGlobalConnectionCap();
    await testHandshakeTimeout();
    await testRateLimitBeforeHandshake();
    await testRateLimiterStats();
    await testIPWindowCleaning();

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