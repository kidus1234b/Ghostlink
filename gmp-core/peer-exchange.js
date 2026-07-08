import { EventEmitter } from 'events';
import config from './config.js';

function toHex(nodeId) {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId).toString('hex');
  }
  return nodeId;
}

export class PeerExchangeManager extends EventEmitter {
  constructor(node) {
    super();
    this.node = node;
    
    // Map: remoteNodeId (hex) -> timestamp of last received PEER_REQUEST
    this.lastRequestTimes = new Map();
    
    // Map: nodeId (hex) -> { nodeId, address, port, lastSeen }
    this.candidatePool = new Map();
    
    // Set to track pending connection timers to clear on close
    this.pendingRequestTimers = new Set();

    // Listen for direct connections to schedule automatic PEER_REQUEST
    this.connectionListener = ({ link, peerNodeId }) => {
      if (link && !link.isVirtual && peerNodeId) {
        const timer = setTimeout(() => {
          this.pendingRequestTimers.delete(timer);
          if (link.state === 'connected') {
            try {
              link.sendPeerRequest(20); // Ask for max 20 peers
            } catch (err) {
              // Link might have disconnected
            }
          }
        }, 500);
        this.pendingRequestTimers.add(timer);
        if (timer.unref) {
          timer.unref();
        }
      }
    };

    this.node.on('connection', this.connectionListener);
  }

  handlePeerRequest(link, msg) {
    if (!link.remoteNodeId) return;
    const requesterHex = toHex(link.remoteNodeId);
    
    // Rate limiting: max 1 PEER_REQUEST per peer per 60 seconds
    const now = Date.now();
    const lastTime = this.lastRequestTimes.get(requesterHex) || 0;
    const intervalMs = config.GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS || 60000;
    if (now - lastTime < intervalMs) {
      // Rate limit triggered, ignore request silently
      return;
    }
    this.lastRequestTimes.set(requesterHex, now);

    // Get direct verified peers connected in the last 24h
    const maxPeers = Math.min(msg.maxPeers || 20, 20);
    const cachedPeers = this.node.peerCache.getDirectPeers24h() || [];
    
    // Filter out the requesting node itself and map to payload format
    const peersToSend = cachedPeers
      .filter(p => p.nodeId !== requesterHex)
      .slice(0, maxPeers)
      .map(p => ({
        nodeId: p.nodeId,
        address: p.address,
        port: p.port,
        lastSeen: p.lastSeen
      }));

    try {
      link.sendPeerResponse(peersToSend);
    } catch (err) {
      // Link failed
    }
  }

  handlePeerResponse(link, msg) {
    if (!msg || !Array.isArray(msg.peers)) return;

    let addedCount = 0;
    for (const peer of msg.peers) {
      const nodeIdHex = toHex(peer.nodeId);
      
      // Skip ourselves
      if (this.node.identity && nodeIdHex === this.node.identity.nodeIdHex) {
        continue;
      }
      
      // Check if already connected
      if (this.node.getLinkByNodeId(nodeIdHex)) {
        continue;
      }

      // Add to candidate pool
      this.candidatePool.set(nodeIdHex, {
        nodeId: nodeIdHex,
        address: peer.address,
        port: peer.port,
        lastSeen: peer.lastSeen
      });
      addedCount++;
    }

    if (addedCount > 0) {
      this.emit('candidates-added', addedCount);
      if (this.node.bootstrap && this.node.bootstrap.isBootstrapping) {
        this.node.bootstrap.attemptCandidates();
      }
    }
  }

  close() {
    this.node.off('connection', this.connectionListener);
    for (const timer of this.pendingRequestTimers) {
      clearTimeout(timer);
    }
    this.pendingRequestTimers.clear();
    this.lastRequestTimes.clear();
    this.candidatePool.clear();
  }
}
