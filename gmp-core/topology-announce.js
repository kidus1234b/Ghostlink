import { EventEmitter } from 'events';
import config from './config.js';
import metrics from './metrics.js';

function toHex(nodeId) {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId).toString('hex');
  }
  return nodeId;
}

class LRUSet {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.set = new Set();
    this.list = [];
  }

  has(key) {
    return this.set.has(key);
  }

  add(key) {
    if (this.set.has(key)) return;
    if (this.list.length >= this.maxSize) {
      const oldest = this.list.shift();
      this.set.delete(oldest);
    }
    this.set.add(key);
    this.list.push(key);
  }
}

export class TopologyManager extends EventEmitter {
  constructor(node, options = {}) {
    super();
    this.node = node;
    this.sequenceNumber = 0;
    
    const lruSize = config.GMP_SEQUENCE_NUM_LRU_SIZE || 1000;
    this.seenSequenceNumbers = new LRUSet(lruSize);
    
    // Map: announcerNodeId (hex) -> Map: connectedToNodeId (hex) -> AnnouncementEntry
    this.lsdb = new Map();

    // Start periodic soft-state refresh
    const announceIntervalMs = options.announceIntervalMs || config.GMP_REANNOUNCE_INTERVAL_MS || 60000;
    this.announceInterval = setInterval(() => {
      this.announceAllDirectLinks();
    }, announceIntervalMs);
    
    if (this.announceInterval && this.announceInterval.unref) {
      this.announceInterval.unref();
    }
  }

  handleLinkEstablished(peerNodeIdHex) {
    const peerHex = toHex(peerNodeIdHex);
    this.sequenceNumber++;
    
    const ttl = config.GMP_TOPOLOGY_TTL || 16;
    const announce = {
      announcerNodeId: this.node.identity.nodeIdHex,
      connectedToNodeId: peerHex,
      sequenceNumber: this.sequenceNumber,
      timestamp: Date.now(),
      withdrawn: false,
      ttl
    };

    // Flood to all OTHER connections except the new peer
    this.flood(announce, peerHex);
    this.updateLSDB(announce);

    // Send our other active direct connections to the new peer peerHex
    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
        const otherPeerHex = toHex(link.remoteNodeId);
        if (otherPeerHex !== peerHex) {
          this.sequenceNumber++;
          const otherAnnounce = {
            announcerNodeId: this.node.identity.nodeIdHex,
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
            } catch (e) {}
          }
        }
      }
    }
  }

  handleLinkClosed(peerNodeIdHex) {
    const peerHex = toHex(peerNodeIdHex);
    this.sequenceNumber++;
    
    const ttl = config.GMP_TOPOLOGY_TTL || 16;
    const announce = {
      announcerNodeId: this.node.identity.nodeIdHex,
      connectedToNodeId: peerHex,
      sequenceNumber: this.sequenceNumber,
      timestamp: Date.now(),
      withdrawn: true,
      ttl
    };

    // Flood withdrawal to other connections
    this.flood(announce, peerHex);
    this.updateLSDB(announce);
  }

  flood(announce, excludePeerHex) {
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

  announceAllDirectLinks() {
    if (!this.node.identity) return;
    
    const ttl = config.GMP_TOPOLOGY_TTL || 16;
    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
        const peerHex = toHex(link.remoteNodeId);
        this.sequenceNumber++;
        const announce = {
          announcerNodeId: this.node.identity.nodeIdHex,
          connectedToNodeId: peerHex,
          sequenceNumber: this.sequenceNumber,
          timestamp: Date.now(),
          withdrawn: false,
          ttl
        };
        this.flood(announce);
        this.updateLSDB(announce);
      }
    }
  }

  handleReceivedAnnounce(announce, incomingLink) {
    metrics.increment('routing.announcements');

    // 1. Check TTL
    if (announce.ttl <= 0) return;

    // 2. Check sequence number cache
    const cacheKey = `${announce.announcerNodeId}:${announce.sequenceNumber}`;
    if (this.seenSequenceNumbers.has(cacheKey)) {
      return;
    }
    this.seenSequenceNumbers.add(cacheKey);

    // 3. Decrement TTL
    const newAnnounce = { ...announce, ttl: announce.ttl - 1 };

    // 4. Update LSDB & routing table
    this.updateLSDB(newAnnounce);

    // 5. Re-flood to all OTHER direct connections (split-horizon)
    const incomingPeerHex = incomingLink ? toHex(incomingLink.remoteNodeId) : null;
    this.flood(newAnnounce, incomingPeerHex);
  }

  updateLSDB(announce) {
    const announcerHex = toHex(announce.announcerNodeId);
    const connectedHex = toHex(announce.connectedToNodeId);

    if (!this.lsdb.has(announcerHex)) {
      this.lsdb.set(announcerHex, new Map());
    }
    const announcerMap = this.lsdb.get(announcerHex);
    const existing = announcerMap.get(connectedHex);

    if (existing) {
      if (announce.sequenceNumber < existing.sequenceNumber) return;
      if (announce.sequenceNumber === existing.sequenceNumber && announce.timestamp <= existing.timestamp) return;
    }

    announcerMap.set(connectedHex, announce);

    // Trigger shortest path calculation
    this.rebuildRoutingTable();
  }

  rebuildRoutingTable() {
    if (!this.node.identity || !this.node.identity.nodeIdHex) return;
    const ourNodeIdHex = this.node.identity.nodeIdHex;

    const queue = [];
    const visited = new Set([ourNodeIdHex]);
    const newRoutes = new Map(); // destHex -> { nextHopHex, hopCount }

    // Direct links are always hop 1
    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
        const peerHex = toHex(link.remoteNodeId);
        visited.add(peerHex);
        newRoutes.set(peerHex, { nextHopHex: peerHex, hopCount: 1 });
        queue.push({ nodeIdHex: peerHex, nextHopHex: peerHex, hopCount: 1 });
      }
    }

    // BFS through LSDB edges
    while (queue.length > 0) {
      const { nodeIdHex, nextHopHex, hopCount } = queue.shift();
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

    // Synchronize RoutingTable
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

  close() {
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
  }
}
