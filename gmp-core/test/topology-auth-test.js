/**
 * A topology announcement must prove it came from the node it names.
 *
 * Announces are flooded across the whole mesh. The session key on the link an
 * announce arrives over authenticates only the relaying hop, not the claimed
 * originator — so before this fix, any peer that completed a handshake could
 * inject an announce with `announcerNodeId` set to any victim, poisoning every
 * node's link-state database and routing table as it flooded: redirect a
 * target's traffic through the attacker (to blackhole it), or withdraw a
 * target's real edges to partition it off the mesh.
 *
 * The fix makes an announce self-authenticating, exactly as HELLO already is:
 * it carries the announcer's static and signing pubkeys, those are bound to
 * announcerNodeId by hash, and the fields are Ed25519-signed. This suite drives
 * the real TopologyManager and asserts a forged announce never reaches the
 * LSDB while a genuine one does.
 *
 * Run with: node test/topology-auth-test.js
 */
import { TopologyManager } from '../dist/topology-announce.js';
import {
  deriveIdentityFromSeedPhrase,
  signMessage, bytesToHex, hexToBytes, sha512, stringToBytes,
} from '../dist/identity.js';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };

// A fake node just rich enough for TopologyManager to run without a network.
function fakeNode(identity) {
  return {
    identity,
    connections: new Map(),          // no links: flood() is a no-op
    getLinkByNodeId: () => null,
    routingTable: {
      getBestRoute: () => null,
      getAllRoutes: () => [],
      addRoute: () => {},
      removeRoute: () => {},
    },
  };
}

// Rebuild the exact bytes the manager signs, so the test can forge correctly.
function signingBytes(a) {
  return stringToBytes(
    'ghost-mesh-topology-announce-v1' +
    a.announcerNodeId + '|' + a.connectedToNodeId + '|' +
    a.sequenceNumber + '|' + a.timestamp + '|' + (a.withdrawn ? '1' : '0'));
}

async function main() {
  const me = await deriveIdentityFromSeedPhrase('victim seed one two three four five six seven eight nine ten');
  const victim = await deriveIdentityFromSeedPhrase('another distant honest node seed alpha bravo charlie delta echo fox');
  const attacker = await deriveIdentityFromSeedPhrase('attacker seed nine eight seven six five four three two one zero');

  const mgr = new TopologyManager(fakeNode(me));
  clearInterval(mgr.announceInterval);

  const lsdbHas = (announcer, connectedTo) => {
    const m = mgr.lsdb.get(announcer.toLowerCase());
    return !!(m && m.get(connectedTo.toLowerCase()));
  };

  // ── forgery: attacker claims to be the victim, no valid signature ──────────
  {
    const forged = {
      announcerNodeId: victim.nodeIdHex,        // impersonated
      connectedToNodeId: attacker.nodeIdHex,    // "route victim's traffic via me"
      sequenceNumber: 999999,                   // beat any genuine announce
      timestamp: Date.now(), withdrawn: false, ttl: 16,
    };
    mgr.handleReceivedAnnounce(forged, {remoteNodeId: attacker.nodeIdHex, _penalizeUntrusted() {}});
    assert(!lsdbHas(victim.nodeIdHex, attacker.nodeIdHex),
      'an unsigned announce impersonating another node is rejected');
  }

  // ── forgery with attacker's own keys but victim's NodeID ───────────────────
  {
    const a = {
      announcerNodeId: victim.nodeIdHex,
      connectedToNodeId: attacker.nodeIdHex,
      sequenceNumber: 1000000, timestamp: Date.now(), withdrawn: false, ttl: 16,
      announcerStaticPubKey: bytesToHex(attacker.staticPubKey),
      announcerSigningPubKey: bytesToHex(attacker.signingPubKey),
    };
    a.signature = bytesToHex(signMessage(attacker.signingPrivKey, signingBytes(a)));
    mgr.handleReceivedAnnounce(a, {remoteNodeId: attacker.nodeIdHex, _penalizeUntrusted() {}});
    assert(!lsdbHas(victim.nodeIdHex, attacker.nodeIdHex),
      "attacker's own keys cannot be bound to the victim's NodeID (hash mismatch)");
  }

  // ── signature over different fields than claimed (tamper) ──────────────────
  {
    const base = {
      announcerNodeId: victim.nodeIdHex, connectedToNodeId: victim.nodeIdHex,
      sequenceNumber: 5, timestamp: Date.now(), withdrawn: false, ttl: 16,
      announcerStaticPubKey: bytesToHex(victim.staticPubKey),
      announcerSigningPubKey: bytesToHex(victim.signingPubKey),
    };
    // Sign the honest fields, then tamper connectedToNodeId after signing.
    base.signature = bytesToHex(signMessage(victim.signingPrivKey, signingBytes(base)));
    base.connectedToNodeId = attacker.nodeIdHex;
    mgr.handleReceivedAnnounce(base, {remoteNodeId: attacker.nodeIdHex, _penalizeUntrusted() {}});
    assert(!lsdbHas(victim.nodeIdHex, attacker.nodeIdHex),
      'a tampered announce (fields changed after signing) is rejected');
  }

  // ── genuine announce from the victim, correctly signed ─────────────────────
  {
    const good = {
      announcerNodeId: victim.nodeIdHex, connectedToNodeId: me.nodeIdHex,
      sequenceNumber: 7, timestamp: Date.now(), withdrawn: false, ttl: 16,
      announcerStaticPubKey: bytesToHex(victim.staticPubKey),
      announcerSigningPubKey: bytesToHex(victim.signingPubKey),
    };
    good.signature = bytesToHex(signMessage(victim.signingPrivKey, signingBytes(good)));
    mgr.handleReceivedAnnounce(good, {remoteNodeId: victim.nodeIdHex, _penalizeUntrusted() {}});
    assert(lsdbHas(victim.nodeIdHex, me.nodeIdHex),
      'a correctly signed announce from the real node is accepted');
  }

  // ── ttl decrement must not invalidate the signature (it is excluded) ───────
  {
    const good = {
      announcerNodeId: victim.nodeIdHex, connectedToNodeId: attacker.nodeIdHex,
      sequenceNumber: 8, timestamp: Date.now(), withdrawn: false, ttl: 16,
      announcerStaticPubKey: bytesToHex(victim.staticPubKey),
      announcerSigningPubKey: bytesToHex(victim.signingPubKey),
    };
    good.signature = bytesToHex(signMessage(victim.signingPrivKey, signingBytes(good)));
    const relayed = {...good, ttl: 4};   // a downstream hop decremented ttl
    mgr.handleReceivedAnnounce(relayed, {remoteNodeId: attacker.nodeIdHex, _penalizeUntrusted() {}});
    assert(lsdbHas(victim.nodeIdHex, attacker.nodeIdHex),
      'a genuine announce still verifies after ttl was decremented in transit');
  }

  // ── the node's own announces are signed and self-verify ────────────────────
  {
    const own = mgr.signOwnAnnounce({
      announcerNodeId: me.nodeIdHex, connectedToNodeId: victim.nodeIdHex,
      sequenceNumber: 1, timestamp: Date.now(), withdrawn: false, ttl: 16,
    });
    assert(!!own.signature && !!own.announcerSigningPubKey,
      'announces this node originates carry a signature and its signing key');
    assert(mgr.isAnnounceAuthentic(own),
      "this node's own signed announce verifies as authentic");
  }

  console.log(`\n  ${passed}/${run} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
