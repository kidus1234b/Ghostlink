import { EventEmitter } from 'events';
import type {
  TopologyAnnouncePayload,
  GMPNodeLike,
  GMPLinkLike,
} from './types.js';
import config from './config.js';
import metrics from './metrics.js';
import { signMessage, verifySignature, sha512, bytesToHex, hexToBytes, stringToBytes } from './identity.js';
import logger from './logger.js';

function toHex(nodeId: string | Uint8Array | Buffer | unknown): string {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId as Buffer | Uint8Array).toString('hex');
  }
  return String(nodeId);
}

class LRUSet<T extends string = string> {
  private maxSize: number;
  private set: Set<T>;
  private list: T[];

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
    this.set = new Set<T>();
    this.list = [];
  }

  has(key: T): boolean {
    return this.set.has(key);
  }

  add(key: T): void {
    if (this.set.has(key)) return;
    if (this.list.length >= this.maxSize) {
      const oldest = this.list.shift();
      if (oldest !== undefined) {
        this.set.delete(oldest);
      }
    }
    this.set.add(key);
    this.list.push(key);
  }
}

interface AnnouncementEntry extends TopologyAnnouncePayload {
  announcerNodeId: string;
  connectedToNodeId: string;
  sequenceNumber: number;
  timestamp: number;
  withdrawn: boolean;
  ttl: number;
  // Origin authentication. A topology announce is flooded across the whole
  // mesh, so the session key on the last hop only proves who relayed it, not
  // who originated it. Without these, any peer that completes a handshake can
  // inject an announce claiming any announcerNodeId and poison every node's
  // routing table (redirect, blackhole, or partition arbitrary nodes). These
  // make the announce self-authenticating, exactly as HELLO already is: the
  // pubkeys are carried, bound to announcerNodeId by hash, and the fields are
  // signed. Added to the JSON body, which is extensible.
  announcerStaticPubKey?: string;
  announcerSigningPubKey?: string;
  signature?: string;
}

/**
 * The exact bytes covered by an announce signature: every semantically
 * meaningful field except ttl (which every hop decrements) and the signature
 * itself. Both signer and verifier must build this identically.
 */
function announceSigningBytes(a: AnnouncementEntry): Uint8Array {
  return stringToBytes(
    'ghost-mesh-topology-announce-v1' +
    a.announcerNodeId + '|' +
    a.connectedToNodeId + '|' +
    a.sequenceNumber + '|' +
    a.timestamp + '|' +
    (a.withdrawn ? '1' : '0')
  );
}

export class TopologyManager extends EventEmitter {
  private node: GMPNodeLike;
  private sequenceNumber: number;
  private seenSequenceNumbers: LRUSet;
  private lsdb: Map<string, Map<string, AnnouncementEntry>>;
  private announceInterval: ReturnType<typeof setInterval> | null;

  constructor(node: GMPNodeLike, options: { announceIntervalMs?: number } = {}) {
    super();
    this.node = node;
    this.sequenceNumber = 0;

    const lruSize = config.GMP_SEQUENCE_NUM_LRU_SIZE || 1000;
    this.seenSequenceNumbers = new LRUSet(lruSize);

    this.lsdb = new Map();

    const announceIntervalMs = options.announceIntervalMs || config.GMP_REANNOUNCE_INTERVAL_MS || 60000;
    this.announceInterval = setInterval(() => {
      this.announceAllDirectLinks();
    }, announceIntervalMs);

    if (this.announceInterval && this.announceInterval.unref) {
      this.announceInterval.unref();
    }
  }

  handleLinkEstablished(peerNodeIdHex: string): void {
    const peerHex = toHex(peerNodeIdHex);
    this.sequenceNumber++;

    const ttl = config.GMP_TOPOLOGY_TTL || 16;
    const announce: AnnouncementEntry = {
      announcerNodeId: this.node.identity!.nodeIdHex,
      connectedToNodeId: peerHex,
      sequenceNumber: this.sequenceNumber,
      timestamp: Date.now(),
      withdrawn: false,
      ttl
    };

    const signedAnnounce = this.signOwnAnnounce(announce);
    this.flood(signedAnnounce, peerHex);
    this.updateLSDB(signedAnnounce);

    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
        const otherPeerHex = toHex(link.remoteNodeId);
        if (otherPeerHex !== peerHex) {
          this.sequenceNumber++;
          const otherAnnounce: AnnouncementEntry = {
            announcerNodeId: this.node.identity!.nodeIdHex,
            connectedToNodeId: otherPeerHex,
            sequenceNumber: this.sequenceNumber,
            timestamp: Date.now(),
            withdrawn: false,
            ttl
          };
          const targetLink = this.node.getLinkByNodeId(peerHex);
          if (targetLink && targetLink.state === 'connected') {
            try {
              targetLink.sendTopologyAnnounce(this.signOwnAnnounce(otherAnnounce));
            } catch (e) {
              // Ignore
            }
          }
        }
      }
    }
  }

  handleLinkClosed(peerNodeIdHex: string): void {
    const peerHex = toHex(peerNodeIdHex);
    this.sequenceNumber++;

    const ttl = config.GMP_TOPOLOGY_TTL || 16;
    const announce: AnnouncementEntry = {
      announcerNodeId: this.node.identity!.nodeIdHex,
      connectedToNodeId: peerHex,
      sequenceNumber: this.sequenceNumber,
      timestamp: Date.now(),
      withdrawn: true,
      ttl
    };

    const signedAnnounce = this.signOwnAnnounce(announce);
    this.flood(signedAnnounce, peerHex);
    this.updateLSDB(signedAnnounce);
  }

  flood(announce: AnnouncementEntry, excludePeerHex: string | null): void {
    const excludeHex = excludePeerHex ? toHex(excludePeerHex) : null;
    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId) {
        const peerHex = toHex(link.remoteNodeId);
        if (peerHex !== excludeHex && !link.isVirtual) {
          try {
            link.sendTopologyAnnounce(announce);
          } catch (e) {
            // Ignore socket writing errors during flood
          }
        }
      }
    }
  }

  announceAllDirectLinks(): void {
    if (!this.node.identity) return;

    const ttl = config.GMP_TOPOLOGY_TTL || 16;
    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
        const peerHex = toHex(link.remoteNodeId);
        this.sequenceNumber++;
        const announce: AnnouncementEntry = {
          announcerNodeId: this.node.identity.nodeIdHex,
          connectedToNodeId: peerHex,
          sequenceNumber: this.sequenceNumber,
          timestamp: Date.now(),
          withdrawn: false,
          ttl
        };
        // null, not a peer: these announcements originate here, so there is no
        // sender to split-horizon against and every peer should receive them.
        // The argument was simply missing, which passed undefined and behaved
        // the same way; this states it.
        const signedAnnounce = this.signOwnAnnounce(announce);
        this.flood(signedAnnounce, null);
        this.updateLSDB(signedAnnounce);
      }
    }
  }

  /**
   * Attach this node's identity keys and a signature to an announce it
   * originates. Called on every announce we create before it is flooded.
   */
  private signOwnAnnounce(announce: AnnouncementEntry): AnnouncementEntry {
    const id = this.node.identity;
    if (!id || !id.signingPrivKey || !id.signingPubKey || !id.staticPubKey) {
      // Without keys we cannot sign; leave it unsigned and let verifiers drop
      // it rather than silently flooding a forgeable announce.
      return announce;
    }
    const withKeys: AnnouncementEntry = {
      ...announce,
      announcerStaticPubKey: bytesToHex(id.staticPubKey),
      announcerSigningPubKey: bytesToHex(id.signingPubKey),
    };
    const sig = signMessage(id.signingPrivKey, announceSigningBytes(withKeys));
    withKeys.signature = bytesToHex(sig);
    return withKeys;
  }

  /**
   * Whether an announce genuinely came from the node it names.
   *
   * Mirrors the HELLO handshake's binding: the carried pubkeys must hash to
   * announcerNodeId (so the keys cannot be swapped for another identity's),
   * and the Ed25519 signature must verify under the carried signing key (so
   * the fields cannot be forged). An announce that fails either is a forgery
   * and must not touch the routing table or be re-flooded.
   */
  private isAnnounceAuthentic(a: AnnouncementEntry): boolean {
    if (!a.announcerStaticPubKey || !a.announcerSigningPubKey || !a.signature) {
      return false;
    }
    try {
      const staticPub = hexToBytes(a.announcerStaticPubKey);
      const signingPub = hexToBytes(a.announcerSigningPubKey);
      const nodeIdHex = String(a.announcerNodeId).toLowerCase();
      // Bind the keys to the claimed NodeID. Accept either hash, matching the
      // handshake's support for static- and signing-key-derived NodeIDs.
      const staticHashHex = bytesToHex(sha512(staticPub)).toLowerCase();
      const signingHashHex = bytesToHex(sha512(signingPub)).toLowerCase();
      if (nodeIdHex !== staticHashHex && nodeIdHex !== signingHashHex) {
        return false;
      }
      // The hash check above binds only ONE of the two carried keys to the
      // NodeID. For the usual NodeID = SHA-512(staticPubKey), the static key is
      // public (it travels in every HELLO and every announce), so on its own it
      // lets anyone attach their own signing key to another node's NodeID. When
      // the announcer is a direct neighbour we know its real signing key from
      // the authenticated handshake; an announce under any other key is forged.
      // Announcers we have never handshaken with remain covered only by the
      // hash check — closing that needs a static-key binding in the protocol.
      const neighbour = this.node.getLinkByNodeId(nodeIdHex);
      if (neighbour && neighbour.remoteSigningPubkey &&
          bytesToHex(neighbour.remoteSigningPubkey).toLowerCase() !== a.announcerSigningPubKey.toLowerCase()) {
        return false;
      }
      return verifySignature(signingPub, announceSigningBytes(a), hexToBytes(a.signature));
    } catch {
      return false;
    }
  }

  handleReceivedAnnounce(announce: AnnouncementEntry, incomingLink: GMPLinkLike | null): void {
    metrics.increment('routing.announcements');

    if (announce.ttl <= 0) return;

    // Origin authentication before anything else. The session key on the link
    // this arrived over only authenticates the relaying hop; a flooded announce
    // originates elsewhere, so its claimed announcer must prove itself.
    if (!this.isAnnounceAuthentic(announce)) {
      metrics.increment('routing.announcementsRejected');
      logger.warn('topology', 'unsigned-or-forged-announce',
        `Rejected topology announce for ${String(announce.announcerNodeId).slice(0, 16)}: missing or invalid signature`);
      if (incomingLink && typeof (incomingLink as { _penalizeUntrusted?: (r: string) => void })._penalizeUntrusted === 'function') {
        (incomingLink as { _penalizeUntrusted: (r: string) => void })._penalizeUntrusted('Forged topology announce');
      }
      return;
    }

    const cacheKey = `${announce.announcerNodeId}:${announce.sequenceNumber}`;
    if (this.seenSequenceNumbers.has(cacheKey)) {
      return;
    }
    this.seenSequenceNumbers.add(cacheKey);

    const newAnnounce: AnnouncementEntry = { ...announce, ttl: announce.ttl - 1 };

    this.updateLSDB(newAnnounce);

    const incomingPeerHex = incomingLink ? toHex(incomingLink.remoteNodeId) : null;
    this.flood(newAnnounce, incomingPeerHex);
  }

  updateLSDB(announce: AnnouncementEntry): void {
    const announcerHex = toHex(announce.announcerNodeId);
    const connectedHex = toHex(announce.connectedToNodeId);

    if (!this.lsdb.has(announcerHex)) {
      this.lsdb.set(announcerHex, new Map());
    }
    const announcerMap = this.lsdb.get(announcerHex)!;
    const existing = announcerMap.get(connectedHex);

    if (existing) {
      if (announce.sequenceNumber < existing.sequenceNumber) return;
      if (announce.sequenceNumber === existing.sequenceNumber && announce.timestamp <= existing.timestamp) return;
    }

    announcerMap.set(connectedHex, announce);

    this.rebuildRoutingTable();
  }

  rebuildRoutingTable(): void {
    if (!this.node.identity || !this.node.identity.nodeIdHex) return;
    const ourNodeIdHex = this.node.identity.nodeIdHex;

    interface QueueEntry {
      nodeIdHex: string;
      nextHopHex: string;
      hopCount: number;
    }

    const queue: QueueEntry[] = [];
    const visited = new Set<string>([ourNodeIdHex]);
    const newRoutes = new Map<string, { nextHopHex: string; hopCount: number }>();

    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
        const peerHex = toHex(link.remoteNodeId);
        visited.add(peerHex);
        newRoutes.set(peerHex, { nextHopHex: peerHex, hopCount: 1 });
        queue.push({ nodeIdHex: peerHex, nextHopHex: peerHex, hopCount: 1 });
      }
    }

    while (queue.length > 0) {
      const { nodeIdHex, nextHopHex, hopCount } = queue.shift()!;
      const neighbors = this.lsdb.get(nodeIdHex);
      if (neighbors) {
        for (const [nbrHex, edge] of neighbors.entries()) {
          if (edge.withdrawn) continue;
          if (!visited.has(nbrHex)) {
            visited.add(nbrHex);
            newRoutes.set(nbrHex, { nextHopHex, hopCount: hopCount + 1 });
            queue.push({ nodeIdHex: nbrHex, nextHopHex, hopCount: hopCount + 1 });
          }
        }
      }
    }

    const activeRoutes = this.node.routingTable.getAllRoutes();
    for (const route of activeRoutes) {
      const dest = route.destinationNodeId;
      const nextHop = route.nextHopNodeId;
      const newRoute = newRoutes.get(dest);
      if (!newRoute || newRoute.nextHopHex !== nextHop) {
        this.node.routingTable.removeRoute(dest, nextHop);
      }
    }
    for (const [dest, newRoute] of newRoutes.entries()) {
      this.node.routingTable.addRoute(dest, newRoute.nextHopHex, newRoute.hopCount);
    }
  }

  close(): void {
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
  }
}