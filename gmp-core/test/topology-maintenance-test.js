/**
 * GMP Topology Maintenance Test Suite — Phase 3
 */

import { GMPNode } from '../link.js';
import { RoutingTable } from '../routing-table.js';

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

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  GMP Phase 3 — Topology Maintenance Tests                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    await testPeriodicReannouncement();
    await testWithdrawalUpdatesRemoteTables();
    await testExpiredRoutesPruned();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total       ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nTest suite error:', err);
    process.exit(1);
  }
}

async function testPeriodicReannouncement() {
  console.log('\n=== Test 1: Periodic Re-announcement Fires on Schedule ===');

  const nodeA = new GMPNode({ port: 49900, announceIntervalMs: 200 });
  const nodeB = new GMPNode({ port: 49901, announceIntervalMs: 200 });

  await nodeA.loadIdentity('periodic A');
  await nodeB.loadIdentity('periodic B');

  await nodeA.listen();
  await nodeB.listen();

  let linkA_B = null;
  nodeA.on('connection', ({ link }) => {
    linkA_B = link;
  });

  await nodeB.dial('127.0.0.1', 49900);
  await delay(100);

  assert(linkA_B !== null, "Link established");

  let announceCount = 0;
  if (linkA_B) {
    const originalSend = linkA_B.sendTopologyAnnounce;
    linkA_B.sendTopologyAnnounce = function(announce) {
      announceCount++;
      return originalSend.apply(this, arguments);
    };
  }

  await delay(650);

  assert(announceCount >= 2, `Periodic re-announcements fired on schedule (got ${announceCount})`);

  nodeA.close();
  nodeB.close();
}

async function testWithdrawalUpdatesRemoteTables() {
  console.log('\n=== Test 2: Withdrawal on Link Close Updates Remote Tables ===');

  const nodeA = new GMPNode({ port: 49910 });
  const nodeB = new GMPNode({ port: 49911 });
  const nodeC = new GMPNode({ port: 49912 });

  await nodeA.loadIdentity('maintenance withdraw A');
  await nodeB.loadIdentity('maintenance withdraw B');
  await nodeC.loadIdentity('maintenance withdraw C');

  await nodeA.listen();
  await nodeB.listen();
  await nodeC.listen();

  await nodeA.dial('127.0.0.1', 49911); // A-B
  await nodeB.dial('127.0.0.1', 49912); // B-C

  await delay(600);

  assert(nodeA.routingTable.getBestRoute(nodeC.identity.nodeIdHex) !== null, "C is initially reachable from A");

  nodeC.close();
  await delay(600);

  assertEqual(nodeA.routingTable.getBestRoute(nodeC.identity.nodeIdHex), null, "Withdrawal updated A's routing table (C is no longer reachable)");

  nodeA.close();
  nodeB.close();
}

async function testExpiredRoutesPruned() {
  console.log('\n=== Test 3: Expired Routes are Pruned from Routing Table ===');

  const table = new RoutingTable({
    expiryTimeoutMs: 200,
    pruneIntervalMs: 50
  });

  const destNodeId = 'dest_node_id_hex_string_64_bytes_long_placeholder_1234567890123456';
  const nextHopNodeId = 'next_hop_node_id_hex_string_64_bytes_long_placeholder_12345678901234';

  let routeExpiredEmitted = false;
  table.on('route-expired', () => {
    routeExpiredEmitted = true;
  });

  table.addRoute(destNodeId, nextHopNodeId, 2);

  assert(table.getBestRoute(destNodeId) !== null, "Route successfully added to table");

  await delay(300);

  assertEqual(table.getBestRoute(destNodeId), null, "Expired route is pruned from table");
  assertEqual(routeExpiredEmitted, true, "'route-expired' event was emitted");

  table.close();
}

runTests();
