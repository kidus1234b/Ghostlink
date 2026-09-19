import { EventEmitter } from 'events';
import type {
  TopologyAnnouncePayload,
  RouteEntry,
  GMPNodeLike,
  GMPLinkLike,
  RoutingTableLike,
} from './types.js';
import config from './config.js';
import metrics from './metrics.js';

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

    this.flood(announce, peerHex);
    this.updateLSDB(announce);

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
              targetLink.sendTopologyAnnounce(otherAnnounce);
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

    this.flood(announce, peerHex);
    this.updateLSDB(announce);
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
        this.flood(announce, null);
        this.updateLSDB(announce);
      }
    }
  }

  handleReceivedAnnounce(announce: AnnouncementEntry, incomingLink: GMPLinkLike | null): void {
    metrics.increment('routing.announcements');

    if (announce.ttl <= 0) return;

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