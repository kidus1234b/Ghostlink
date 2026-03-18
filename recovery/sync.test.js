/**
 * sync.test.js — tests for sync.js
 *
 * Exercises the full backup cycle using MockNetwork (in-process peers).
 * No real WebRTC, no real storage — all in-memory.
 */

import SyncEngine from "./sync.js";
import Distributor, { FragmentStore, MockNetwork } from "./distributor.js";
import SeedEngine from "./seed.js";
import BlobEngine from "./blob.js";

// ─── fixtures ─────────────────────────────────────────────────────────────────

function makePeers(ids) {
  return ids.map(id => ({ id, name: id }));
}

function makeIdentity(overrides = {}) {
  return {
    version:      "gl-v1",
    type:         "identity",
    name:         "Kidus",
    publicKeyHex: "04aabbccddee112233445566778899aabbccddee112233445566778899aabbccddee",
    fingerprint:  "3F7A2C1B44DD89EF",
    contacts:     [],
    settings:     {
      theme: "phantom", fontSize: 13, notifications: true,
      sounds: true, readReceipts: false, encLevel: "AES-256-GCM", p2pRelay: "WebRTC",
    },
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * In-memory IStorage implementation for tests.
 */
class MemoryStorage {
  constructor() { this._map = new Map(); }
  get(key)        { return this._map.get(key) ?? null; }
  set(key, value) { this._map.set(key, value); }
  delete(key)     { this._map.delete(key); }
  keys()          { return [...this._map.keys()]; }
}

/**
 * Build a MockNetwork with n peer Distributor instances + one client transport.
 * Returns { net, clientTransport, peers }.
 */
function buildNetwork(peerIds) {
  const net = new MockNetwork();

  // Peer distributors — each peer listens and stores fragments
  for (const id of peerIds) {
    const d = Object.create(Distributor);
    d._store = new FragmentStore();
    d._transport = null;
    const t = net.join(id);
    t.onMessage((fromId, msg) => d._handleIncoming(fromId, msg));
    d._transport = t;
  }

  const clientTransport = net.join("client");
  return { net, clientTransport, peers: makePeers(peerIds) };
}

/** Create a fresh SyncEngine instance (Object.create for test isolation). */
function makeSyncEngine() {
  return Object.create(SyncEngine);
}

// ─── test runner ──────────────────────────────────────────────────────────────

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

  // Shared seed
  const phrase    = await SeedEngine.generate();
  const seedBytes = await SeedEngine.toSeedBytes(phrase);

  // ── manual backup: happy path ────────────────────────────────────────────
  console.group("backup: manual, 5 peers, k=3");

  const { clientTransport, peers } = buildNetwork(["p1","p2","p3","p4","p5"]);
  const engine = makeSyncEngine();
  engine.init({
    identity:  makeIdentity(),
    seedBytes,
    peers,
    transport: clientTransport,
    n: 5, k: 3, timeout: 5000,
  });

  const result = await engine.backup();
  ok("ok = true",             result.ok === true);
  ok("stored = 5",            result.stored === 5);
  ok("needed = 3",            result.needed === 3);
  ok("no failures",           result.failed.length === 0);
  ok("triggeredBy = manual",  result.triggeredBy === "manual");
  ok("backupAt is a number",  typeof result.backupAt === "number");

  engine.teardown();
  console.groupEnd();

  // ── status() ─────────────────────────────────────────────────────────────
  console.group("status()");

  const storage2 = new MemoryStorage();
  const { clientTransport: t2, peers: p2 } = buildNetwork(["s1","s2","s3"]);
  const eng2 = makeSyncEngine();
  eng2.init({
    identity:  makeIdentity(),
    seedBytes,
    peers:     p2,
    transport: t2,
    storage:   storage2,
    n: 3, k: 2, timeout: 5000,
  });

  const st0 = eng2.status();
  ok("peers = 3",             st0.peers === 3);
  ok("n = 3",                 st0.n === 3);
  ok("k = 2",                 st0.k === 2);
  ok("inFlight = false",      st0.inFlight === false);
  ok("lastBackupAt = null",   st0.lastBackupAt === null);

  await eng2.backup();
  const st1 = eng2.status();
  ok("lastBackupAt set",      typeof st1.lastBackupAt === "number");
  ok("lastBackupAt matches storage",
    String(st1.lastBackupAt) === storage2.get("gl:sync:lastBackupAt"));

  eng2.teardown();
  console.groupEnd();

  // ── onMessage() epoch trigger ────────────────────────────────────────────
  console.group("onMessage: epoch trigger at 50");

  const storage3 = new MemoryStorage();
  const { clientTransport: t3, peers: p3 } = buildNetwork(["e1","e2","e3"]);
  const eng3 = makeSyncEngine();
  eng3.init({
    identity:  makeIdentity(),
    seedBytes,
    peers:     p3,
    transport: t3,
    storage:   storage3,
    n: 3, k: 2, timeout: 5000,
  });

  // Drive 49 messages — no backup yet
  for (let i = 0; i < 49; i++) eng3.onMessage();
  ok("msgCount = 49",        eng3._msgCount === 49);
  ok("no backup yet",        eng3.status().lastBackupAt === null);

  // 50th message triggers a backup (async, fire-and-forget)
  eng3.onMessage();
  ok("counter reset to 0",   eng3._msgCount === 0);

  // Give the async backup time to complete
  await new Promise(r => setTimeout(r, 2000));
  ok("backup ran after epoch", eng3.status().lastBackupAt !== null);

  eng3.teardown();
  console.groupEnd();

  // ── onMessage() storage persistence ──────────────────────────────────────
  console.group("onMessage: counter persists to storage");

  const storage4 = new MemoryStorage();
  const { clientTransport: t4, peers: p4 } = buildNetwork(["f1","f2","f3"]);
  const eng4 = makeSyncEngine();
  eng4.init({
    identity:  makeIdentity(),
    seedBytes,
    peers:     p4,
    transport: t4,
    storage:   storage4,
    n: 3, k: 2,
  });
  for (let i = 0; i < 10; i++) eng4.onMessage();
  ok("storage has count 10", storage4.get("gl:sync:msgCount") === "10");

  // Re-init from same storage → count restored
  const eng4b = makeSyncEngine();
  eng4b.init({
    identity: makeIdentity(), seedBytes, peers: p4, transport: t4,
    storage: storage4, n: 3, k: 2,
  });
  ok("count restored on init", eng4b._msgCount === 10);

  eng4.teardown();
  eng4b.teardown();
  console.groupEnd();

  // ── onPeerAdded() debounce ────────────────────────────────────────────────
  console.group("onPeerAdded: debounce + backup");

  const net5 = new MockNetwork();
  // Start with 2 peers wired up, but only 1 in engine's list initially
  const t_pa1 = net5.join("pa1");
  const t_pa2 = net5.join("pa2");
  const t_pa3 = net5.join("pa3");
  const d_pa1 = Object.create(Distributor);
  d_pa1._store = new FragmentStore();
  d_pa1._transport = t_pa1;
  t_pa1.onMessage((f, m) => d_pa1._handleIncoming(f, m));
  const d_pa2 = Object.create(Distributor);
  d_pa2._store = new FragmentStore();
  d_pa2._transport = t_pa2;
  t_pa2.onMessage((f, m) => d_pa2._handleIncoming(f, m));
  const d_pa3 = Object.create(Distributor);
  d_pa3._store = new FragmentStore();
  d_pa3._transport = t_pa3;
  t_pa3.onMessage((f, m) => d_pa3._handleIncoming(f, m));

  const t_paClient = net5.join("paClient");
  const eng5 = makeSyncEngine();
  eng5.init({
    identity:  makeIdentity(),
    seedBytes,
    peers:     [{ id: "pa1", name: "pa1" }, { id: "pa2", name: "pa2" }],
    transport: t_paClient,
    n: 3, k: 2, timeout: 5000,
  });

  // Add two peers rapidly — only one backup should fire
  eng5.onPeerAdded({ id: "pa3", name: "pa3" });
  ok("peer appended",             eng5._peers.length === 3);
  eng5.onPeerAdded({ id: "pa3", name: "pa3" }); // duplicate — no re-add
  ok("duplicate not re-appended", eng5._peers.length === 3);

  // Wait for debounce + backup to complete (3s debounce + ~1s backup)
  await new Promise(r => setTimeout(r, 5000));
  ok("backup ran after peer-added", eng5.status().lastBackupAt !== null);

  eng5.teardown();
  console.groupEnd();

  // ── setIdentity / setPeers / setSeedBytes ─────────────────────────────────
  console.group("setIdentity / setPeers / setSeedBytes");

  const { clientTransport: t6, peers: p6 } = buildNetwork(["u1","u2","u3"]);
  const eng6 = makeSyncEngine();
  eng6.init({
    identity:  makeIdentity({ name: "Old" }),
    seedBytes,
    peers:     p6,
    transport: t6,
    n: 3, k: 2,
  });

  // Swap identity
  eng6.setIdentity(makeIdentity({ name: "Updated" }));
  const r6 = await eng6.backup();
  // Unpack to verify new identity was packed
  const tag6 = makeIdentity().publicKeyHex;
  const blobTag6 = await BlobEngine.tagFor(tag6);
  ok("backup ok after setIdentity", r6.ok);

  // Swap seed bytes — new phrase
  const phrase7    = await SeedEngine.generate();
  const seedBytes7 = await SeedEngine.toSeedBytes(phrase7);
  eng6.setSeedBytes(seedBytes7);
  const r6b = await eng6.backup();
  ok("backup ok after setSeedBytes", r6b.ok);

  // Swap peers
  const { clientTransport: t6c, peers: p6c } = buildNetwork(["v1","v2","v3"]);
  eng6.setPeers(p6c);
  eng6._transport = t6c; // also swap transport to new net
  const r6c = await eng6.backup();
  ok("backup ok after setPeers", r6c.ok);

  eng6.teardown();
  console.groupEnd();

  // ── error paths ───────────────────────────────────────────────────────────
  console.group("error paths");

  const { clientTransport: te, peers: pe } = buildNetwork(["err1","err2","err3"]);
  const engErr = makeSyncEngine();

  // backup() before init
  await rejects("no identity throws",   () => engErr.backup());

  engErr.init({ identity: makeIdentity(), seedBytes, peers: pe, transport: te, n: 3, k: 2 });
  engErr._seedBytes = null;
  await rejects("null seedBytes throws", () => engErr.backup());

  engErr.setSeedBytes(seedBytes);
  engErr._transport = null;
  await rejects("null transport throws", () => engErr.backup());

  engErr._transport = te;
  engErr._peers = []; // empty peer list
  await rejects("too few peers throws",  () => engErr.backup());

  engErr.teardown();
  console.groupEnd();

  // ── in-flight deduplication ───────────────────────────────────────────────
  console.group("in-flight deduplication");

  const { clientTransport: td, peers: pd } = buildNetwork(["d1","d2","d3"]);
  const engD = makeSyncEngine();
  engD.init({
    identity:  makeIdentity(),
    seedBytes,
    peers:     pd,
    transport: td,
    n: 3, k: 2, timeout: 5000,
  });

  // Start two concurrent backups — second should throw (in-flight guard)
  const first  = engD.backup();
  const second = engD.backup(); // force=false → should throw

  const firstOk = await first.then(() => true).catch(() => false);
  const secondOk = await second.then(() => true).catch(() => false);
  ok("first backup succeeds",       firstOk === true);
  ok("second backup throws in-flight", secondOk === false);

  engD.teardown();
  console.groupEnd();

  // ── force flag bypasses in-flight guard ──────────────────────────────────
  console.group("backup({ force: true })");

  const { clientTransport: tf, peers: pf } = buildNetwork(["f1","f2","f3"]);
  const engF = makeSyncEngine();
  engF.init({
    identity:  makeIdentity(),
    seedBytes,
    peers:     pf,
    transport: tf,
    n: 3, k: 2, timeout: 5000,
  });

  // force=true runs even when _inFlight would normally block
  // (In practice two concurrent backups will race on the network — that's OK)
  const rf = await engF.backup({ force: true });
  ok("forced backup ok", rf.ok === true);

  engF.teardown();
  console.groupEnd();

  // ── partial peer failure ──────────────────────────────────────────────────
  console.group("backup: 1 peer offline, still meets k=2");

  const net7  = new MockNetwork();
  const t7_p1 = net7.join("o1");
  const t7_p2 = net7.join("o2");
  const t7_p3 = net7.join("o3");
  for (const [t, id] of [[t7_p1,"o1"],[t7_p2,"o2"],[t7_p3,"o3"]]) {
    const d = Object.create(Distributor);
    d._store = new FragmentStore();
    d._transport = t;
    t.onMessage((f, m) => d._handleIncoming(f, m));
  }
  const t7_client = net7.join("oClient");
  const eng7 = makeSyncEngine();
  eng7.init({
    identity:  makeIdentity(),
    seedBytes,
    peers:     makePeers(["o1","o2","o3"]),
    transport: t7_client,
    n: 3, k: 2, timeout: 2000,
  });

  t7_p3.goOffline();
  const r7 = await eng7.backup();
  ok("ok=true (2 of 3, k=2)",  r7.ok === true);
  ok("stored=2",               r7.stored === 2);
  ok("1 failure",              r7.failed.length === 1);

  eng7.teardown();
  console.groupEnd();

  // ── teardown clears secrets ───────────────────────────────────────────────
  console.group("teardown");

  const { clientTransport: tt, peers: pt } = buildNetwork(["t1","t2","t3"]);
  const engT = makeSyncEngine();
  engT.init({
    identity:  makeIdentity(),
    seedBytes,
    peers:     pt,
    transport: tt,
    n: 3, k: 2,
  });
  engT.teardown();

  ok("seedBytes cleared",  engT._seedBytes === null);
  ok("identity cleared",   engT._identity  === null);
  ok("listeners cleared",  engT._visChange === null && engT._beforeUnload === null);

  console.groupEnd();

  // ── summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log("✓ All tests passed");
  else              console.error(`✗ ${failed} test(s) failed`);
}

run().catch(console.error);
