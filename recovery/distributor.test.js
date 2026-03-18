/**
 * distributor.test.js
 *
 * Tests the full distribute → recover cycle using MockNetwork.
 * No real WebRTC — all peers live in the same JS process.
 */

import Distributor, { FragmentStore, MockNetwork } from "./distributor.js";
import SeedEngine from "./seed.js";
import BlobEngine from "./blob.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

function makePeers(ids) {
  return ids.map(id => ({ id, name: id }));
}

async function makeBlob(seedBytes, name = "Kidus") {
  return BlobEngine.pack({
    version:      "gl-v1",
    type:         "identity",
    name,
    publicKeyHex: "04aabbccddee112233445566778899aabbccddee112233445566778899aabbccddee",
    fingerprint:  "3F7A2C1B44DD89EF",
    contacts:     [],
    settings:     { theme: "phantom", fontSize: 13, notifications: true, sounds: true, readReceipts: false, encLevel: "AES-256-GCM", p2pRelay: "WebRTC" },
    createdAt:    Date.now(),
  }, seedBytes);
}

/**
 * Build a MockNetwork of n peers, each running their own Distributor instance.
 * Returns { net, distributors, transports, peers }.
 */
function buildNetwork(peerIds) {
  const net = new MockNetwork();
  const distributors = {};
  const transports   = {};

  for (const id of peerIds) {
    const d = Object.create(Distributor); // fresh instance per peer
    d._store = new FragmentStore();
    d._transport = null;
    const t = net.join(id);
    t.onMessage((fromId, msg) => d._handleIncoming(fromId, msg));
    d._transport = t;
    distributors[id] = d;
    transports[id]   = t;
  }

  return { net, distributors, transports, peers: makePeers(peerIds) };
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
    try   { await fn(); console.error(`  ✗ ${label} (expected rejection)`); failed++; }
    catch { console.log(`  ✓ ${label}`); passed++; }
  }

  // Shared seed + blob
  const phrase    = await SeedEngine.generate();
  const seedBytes = await SeedEngine.toSeedBytes(phrase);

  // ── FragmentStore ────────────────────────────────────────────────────────
  console.group("FragmentStore");
  const store = new FragmentStore();

  // Make a real Shamir fragment to store
  const dummySecret = crypto.getRandomValues(new Uint8Array(32));
  const frags = await (async () => {
    const { default: Shamir } = await import("./shamir.js");
    return Shamir.split(dummySecret, 3, 2, "deadbeef");
  })();
  const { default: Shamir } = await import("./shamir.js");
  const encoded = Shamir.encode(frags[0]);

  store.store("deadbeef", encoded);
  ok("has() returns true after store",    store.has("deadbeef"));
  ok("has() returns false for other tag", !store.has("cafebabe"));

  const fetched = store.fetchAll("deadbeef");
  ok("fetchAll returns array",            Array.isArray(fetched));
  ok("fetchAll returns 1 entry",          fetched.length === 1);
  ok("fetched entry matches stored",      fetched[0] === encoded);

  const deleted = store.revoke("deadbeef");
  ok("revoke returns count",              deleted === 1);
  ok("has() false after revoke",          !store.has("deadbeef"));
  ok("fetchAll empty after revoke",       store.fetchAll("deadbeef").length === 0);
  console.groupEnd();

  // ── MockNetwork: basic connectivity ─────────────────────────────────────
  console.group("MockNetwork: connectivity");
  const { net, distributors, transports, peers } = buildNetwork(["p1","p2","p3","p4","p5"]);
  const clientTransport = net.join("client");
  const client = Object.create(Distributor);
  client._store = new FragmentStore();
  client._transport = clientTransport;
  clientTransport.onMessage((from, msg) => client._handleIncoming(from, msg));

  // Probe — no fragments stored yet
  const probeEmpty = await client.probe("sometag", peers, { timeout: 2000 });
  ok("probe returns array",                probeEmpty.length === 5);
  ok("all peers reachable",               probeEmpty.every(r => r.reachable));
  ok("none have fragment (fresh)",        probeEmpty.every(r => !r.hasFragment));
  console.groupEnd();

  // ── distribute() ────────────────────────────────────────────────────────
  console.group("distribute: 5-of-5 peers, k=3");
  const blob = await makeBlob(seedBytes);
  const result = await client.distribute(blob, peers, { n: 5, k: 3, timeout: 3000 });

  ok("ok = true",              result.ok === true);
  ok("stored = 5",             result.stored === 5);
  ok("needed = 3",             result.needed === 3);
  ok("no failures",            result.failed.length === 0);

  // Each peer's store should now hold 1 fragment
  for (const id of ["p1","p2","p3","p4","p5"]) {
    ok(`${id} holds a fragment`, distributors[id]._store.has(blob.tag));
  }
  console.groupEnd();

  // ── probe() after distribute ─────────────────────────────────────────────
  console.group("probe: after distribute");
  const probeAfter = await client.probe(blob.tag, peers, { timeout: 2000 });
  ok("all reachable",           probeAfter.every(r => r.reachable));
  ok("all have fragment",       probeAfter.every(r => r.hasFragment));
  ok("latency reported",        probeAfter.every(r => typeof r.latencyMs === "number"));
  console.groupEnd();

  // ── recover() — full set ─────────────────────────────────────────────────
  console.group("recover: all 5 peers online");
  const recovered = await client.recover(blob.tag, peers, { k: 3, timeout: 3000 });
  ok("returns an object",       typeof recovered === "object");
  ok("version matches",         recovered.version === blob.version);
  ok("tag matches",             recovered.tag === blob.tag);
  ok("ciphertext matches",      recovered.ciphertext === blob.ciphertext);

  // Decrypt and verify content
  const unpacked = await BlobEngine.unpack(recovered, seedBytes);
  ok("name survives full cycle", unpacked.name === "Kidus");
  console.groupEnd();

  // ── recover() — exactly k peers ─────────────────────────────────────────
  console.group("recover: exactly k=3 peers (minimum)");
  const minPeers = peers.slice(0, 3);
  const minRecovered = await client.recover(blob.tag, minPeers, { k: 3, timeout: 3000 });
  const minUnpacked = await BlobEngine.unpack(minRecovered, seedBytes);
  ok("k=3 peers sufficient",    minUnpacked.name === "Kidus");
  console.groupEnd();

  // ── recover() — some peers offline ──────────────────────────────────────
  console.group("recover: 2 peers offline, 3 remaining (k=3)");
  transports["p1"].goOffline();
  transports["p2"].goOffline();

  const onlinePeers = peers; // client still tries all 5
  const offlineRecovered = await client.recover(blob.tag, onlinePeers, { k: 3, timeout: 2000 });
  const offlineUnpacked = await BlobEngine.unpack(offlineRecovered, seedBytes);
  ok("2 offline peers, still recovers", offlineUnpacked.name === "Kidus");

  transports["p1"].goOnline();
  transports["p2"].goOnline();
  console.groupEnd();

  // ── recover() — too many offline (below threshold) ──────────────────────
  console.group("recover: 3 peers offline → below threshold");
  transports["p1"].goOffline();
  transports["p2"].goOffline();
  transports["p3"].goOffline();

  await rejects("recovery fails below k", () =>
    client.recover(blob.tag, peers, { k: 3, timeout: 1500 })
  );

  transports["p1"].goOnline();
  transports["p2"].goOnline();
  transports["p3"].goOnline();
  console.groupEnd();

  // ── revoke() ────────────────────────────────────────────────────────────
  console.group("revoke");
  const revokeResult = await client.revoke(blob.tag, peers, { timeout: 3000 });
  ok("revoked = 5",              revokeResult.revoked === 5);
  ok("total = 5",                revokeResult.total   === 5);
  ok("no failures",              revokeResult.failed.length === 0);

  // Peers should no longer hold fragments
  for (const id of ["p1","p2","p3","p4","p5"]) {
    ok(`${id} fragment deleted`, !distributors[id]._store.has(blob.tag));
  }

  // Recovery now fails
  await rejects("recover fails after revoke", () =>
    client.recover(blob.tag, peers, { k: 3, timeout: 1500 })
  );
  console.groupEnd();

  // ── distribute: n > peers available ─────────────────────────────────────
  console.group("distribute: error paths");
  await rejects("n > peers.length throws", () =>
    client.distribute(blob, peers.slice(0, 2), { n: 5, k: 3 })
  );
  await rejects("k > n throws", () =>
    client.distribute(blob, peers, { n: 3, k: 5 })
  );
  await rejects("no transport throws", () => {
    const bare = Object.create(Distributor);
    bare._transport = null;
    return bare.distribute(blob, peers);
  });
  console.groupEnd();

  // ── MockTransport: offline / latency ───────────────────────────────────
  console.group("MockTransport: network simulation");
  const { net: net2, peers: peers2, distributors: d2, transports: t2 } = buildNetwork(["q1","q2","q3"]);
  const clientT2 = net2.join("client2");
  const client2 = Object.create(Distributor);
  client2._store = new FragmentStore();
  client2._transport = clientT2;
  clientT2.onMessage((from, msg) => client2._handleIncoming(from, msg));

  // Add latency to one peer
  t2["q2"].setLatency(50);
  const blob2 = await makeBlob(seedBytes, "Ghost");
  const r2 = await client2.distribute(blob2, peers2, { n: 3, k: 2, timeout: 3000 });
  ok("distributes with latency",   r2.ok);
  const rec2 = await client2.recover(blob2.tag, peers2, { k: 2, timeout: 3000 });
  const up2  = await BlobEngine.unpack(rec2, seedBytes);
  ok("recovers with latency",      up2.name === "Ghost");

  // Offline at distribute time → partial success
  t2["q3"].goOffline();
  const blob3 = await makeBlob(seedBytes, "Partial");
  const r3 = await client2.distribute(blob3, peers2, { n: 3, k: 2, timeout: 1500 });
  ok("partial distribute: ok (2≥k=2)",    r3.ok === true);
  ok("partial distribute: stored=2",      r3.stored === 2);
  ok("partial distribute: 1 failure",     r3.failed.length === 1);
  console.groupEnd();

  // ── summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log("✓ All tests passed");
  else console.error(`✗ ${failed} test(s) failed`);
}

run().catch(console.error);
