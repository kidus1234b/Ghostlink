import { EventEmitter } from 'events';
import config from './config.js';
import type {
  PeerInfo,
  PeerRequestPayload,
  PeerResponsePayload,
  GMPNodeLike,
  GMPLinkLike,
} from './types.js';

function toHex(nodeId: string | Uint8Array | Buffer | unknown): string {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId as Buffer | Uint8Array).toString('hex');
  }
  return String(nodeId);
}

/** The most peers we request in a PEER_REQUEST, and so the most we accept back. */
const MAX_PEERS_PER_RESPONSE = 20;

export class PeerExchangeManager extends EventEmitter {
  private node: GMPNodeLike;
  private lastRequestTimes: Map<string, number>;
  private candidatePool: Map<string, PeerInfo>;
  private pendingRequestTimers: Set<ReturnType<typeof setTimeout>>;
  private connectionListener: (info: { link: GMPLinkLike; peerNodeId: string }) => void;

  constructor(node: GMPNodeLike) {
    super();
    this.node = node;

    this.lastRequestTimes = new Map();

    this.candidatePool = new Map();

    this.pendingRequestTimers = new Set();

    this.connectionListener = ({ link, peerNodeId }) => {
      if (link && !link.isVirtual && peerNodeId) {
        const timer = setTimeout(() => {
          this.pendingRequestTimers.delete(timer);
          if (link.state === 'connected') {
            try {
              link.sendPeerRequest(MAX_PEERS_PER_RESPONSE);
            } catch (err) {
              // Link might have disconnected
            }
          }
        }, 500);
        this.pendingRequestTimers.add(timer);
        if (timer.unref) {
          (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
        }
      }
    };

    this.node.on('connection', this.connectionListener as (info: { link: GMPLinkLike; peerNodeId: string }) => void);
  }

  handlePeerRequest(link: GMPLinkLike, msg: PeerRequestPayload): void {
    if (!link.remoteNodeId) return;
    const requesterHex = toHex(link.remoteNodeId);

    const now = Date.now();
    const lastTime = this.lastRequestTimes.get(requesterHex) || 0;
    const intervalMs = config.GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS || 60000;
    if (now - lastTime < intervalMs) {
      return;
    }
    this.lastRequestTimes.set(requesterHex, now);

    const maxPeers = Math.min(msg.maxPeers || 20, 20);
    const cachedPeers = this.node.peerCache.getDirectPeers24h() || [];

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

  handlePeerResponse(link: GMPLinkLike, msg: PeerResponsePayload): void {
    if (!msg || !Array.isArray(msg.peers)) return;

    // Bounded twice over. We only ever request 20 peers, but the response is
    // the remote's to shape: one peer could send tens of thousands of entries
    // per frame, repeatedly, and every one used to be kept here forever.
    const maxPool = config.GMP_PEER_CACHE_MAX_SIZE || 500;
    let addedCount = 0;
    for (const peer of msg.peers.slice(0, MAX_PEERS_PER_RESPONSE)) {
      const nodeIdHex = toHex(peer.nodeId);

      if (this.node.identity && nodeIdHex === this.node.identity.nodeIdHex) {
        continue;
      }

      if (this.node.getLinkByNodeId(nodeIdHex)) {
        continue;
      }

      this.candidatePool.set(nodeIdHex, {
        nodeId: nodeIdHex,
        address: peer.address,
        port: peer.port,
        lastSeen: peer.lastSeen
      });
      // Map iteration is insertion order, so the first key is the oldest.
      while (this.candidatePool.size > maxPool) {
        const oldest = this.candidatePool.keys().next().value;
        if (oldest === undefined) break;
        this.candidatePool.delete(oldest);
      }
      addedCount++;
    }

    if (addedCount > 0) {
      this.emit('candidates-added', addedCount);
      if (this.node.bootstrap && this.node.bootstrap.isBootstrapping) {
        this.node.bootstrap.attemptCandidates();
      }
    }
  }

  close(): void {
    this.node.off('connection', this.connectionListener as (info: { link: GMPLinkLike; peerNodeId: string }) => void);
    for (const timer of this.pendingRequestTimers) {
      clearTimeout(timer);
    }
    this.pendingRequestTimers.clear();
    this.lastRequestTimes.clear();
    this.candidatePool.clear();
  }
}