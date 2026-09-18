import { EventEmitter } from 'events';
import { verifySignature, hexToBytes, stringToBytes } from './identity.js';
import type { KeyRotationPayload } from './types.js';
import config from './config.js';
import logger from './logger.js';

function toHex(nodeId: string | Uint8Array | Buffer | unknown): string {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId as Buffer | Uint8Array).toString('hex');
  }
  return String(nodeId);
}

interface GMPNodeLike {
  identity: { nodeIdHex: string } | null;
  connections: Map<string, GMPLinkLike>;
  peerCache: PeerCacheLike;
  routingTable: RoutingTableLike;
  emit(event: string, ...args: unknown[]): boolean;
}

interface GMPLinkLike {
  state: string;
  remoteNodeId: string | null;
  isVirtual?: boolean;
  sendKeyRotation(cert: unknown, sequenceNumber: number, ttl: number): void;
  _penalizeUntrusted?(reason: string): void;
}

interface PeerCacheLike {
  cache: CachedPeer[];
  // PeerCache.replaceNodeId takes a hex string; this said Uint8Array.
  replaceNodeId(oldNodeId: string, newNodeId: string, newPublicKey: string): void;
}

interface CachedPeer {
  nodeId: string;
  signingPubKey?: string;
}

interface RoutingTableLike {
  removeRoutesVia(nodeId: string): void;
  routes: Map<string, Map<string, unknown>>;
  removeRoute(destinationNodeId: string, nextHopNodeId: string): void;
}

interface RotationMessage {
  cert: KeyRotationPayload;
  sequenceNumber: number;
  ttl: number;
}

export class KeyRotationManager extends EventEmitter {
  private node: GMPNodeLike;
  private seenSequenceNumbers: Set<string>;
  private sequenceNumber: number;

  constructor(node: GMPNodeLike) {
    super();
    this.node = node;
    this.seenSequenceNumbers = new Set();
    this.sequenceNumber = 0;
  }

  floodRotation(cert: KeyRotationPayload): void {
    this.sequenceNumber++;
    const rotationMsg: RotationMessage = {
      cert,
      sequenceNumber: this.sequenceNumber,
      ttl: config.GMP_TOPOLOGY_TTL || 16
    };
    const cacheKey = `${cert.oldNodeId}:${this.sequenceNumber}`;
    this.seenSequenceNumbers.add(cacheKey);

    this.flood(rotationMsg);
  }

  flood(rotationMsg: RotationMessage, excludePeerHex: string | null = null): void {
    const excludeHex = excludePeerHex ? toHex(excludePeerHex) : null;
    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
        const peerHex = toHex(link.remoteNodeId);
        if (peerHex !== excludeHex) {
          try {
            link.sendKeyRotation(rotationMsg.cert, rotationMsg.sequenceNumber, rotationMsg.ttl);
          } catch (e: unknown) {
            const err = e as Error;
            logger.error('key-rotation', 'flood-failed', `Failed to flood key rotation to peer ${peerHex}: ${err.message}`, {
              peerNodeId: peerHex,
              err: err.message
            });
          }
        }
      }
    }
  }

  handleReceivedRotation(msg: RotationMessage, incomingLink: GMPLinkLike | null): void {
    const { cert, sequenceNumber, ttl } = msg;
    if (!cert || ttl <= 0) return;

    const oldNodeIdHex = toHex(cert.oldNodeId);
    const cacheKey = `${oldNodeIdHex}:${sequenceNumber}`;
    if (this.seenSequenceNumbers.has(cacheKey)) {
      return;
    }
    this.seenSequenceNumbers.add(cacheKey);

    const cachedPeer = this.node.peerCache.cache.find(p => p.nodeId === oldNodeIdHex);
    if (!cachedPeer || !cachedPeer.signingPubKey) {
      logger.warn('key-rotation', 'unknown-old-node', `Unknown or untrusted old NodeID: ${oldNodeIdHex}`, {
        oldNodeId: oldNodeIdHex
      });
      return;
    }

    const msgToVerify = cert.oldNodeId + cert.newPublicKey + cert.rotationTimestamp;
    const oldSigningPubKeyBytes = hexToBytes(cachedPeer.signingPubKey);
    const isValid = verifySignature(
      oldSigningPubKeyBytes,
      stringToBytes(msgToVerify),
      hexToBytes(cert.signature)
    );

    if (!isValid) {
      logger.warn('key-rotation', 'invalid-signature', `Invalid signature on rotation certificate for old NodeID: ${oldNodeIdHex}`, {
        oldNodeId: oldNodeIdHex
      });
      if (incomingLink && typeof incomingLink._penalizeUntrusted === 'function') {
        incomingLink._penalizeUntrusted('Invalid key rotation signature');
      }
      return;
    }

    const newNodeIdHex = toHex(cert.newNodeId);
    this.node.peerCache.replaceNodeId(oldNodeIdHex, newNodeIdHex, cert.newPublicKey);

    this.node.routingTable.removeRoutesVia(oldNodeIdHex);
    if (this.node.routingTable.routes.has(oldNodeIdHex)) {
      const nextHops = Array.from(this.node.routingTable.routes.get(oldNodeIdHex)!.keys());
      for (const nextHop of nextHops) {
        this.node.routingTable.removeRoute(oldNodeIdHex, nextHop);
      }
    }

    const incomingPeerHex = incomingLink && incomingLink.remoteNodeId ? toHex(incomingLink.remoteNodeId) : null;
    const newMsg: RotationMessage = {
      cert,
      sequenceNumber,
      ttl: ttl - 1
    };
    this.flood(newMsg, incomingPeerHex);

    this.emit('key-rotated', { oldNodeId: oldNodeIdHex, newNodeId: newNodeIdHex });
    this.node.emit('key-rotated', { oldNodeId: oldNodeIdHex, newNodeId: newNodeIdHex });
  }

  close(): void {
    this.seenSequenceNumbers.clear();
  }
}