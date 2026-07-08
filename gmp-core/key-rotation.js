import { EventEmitter } from 'events';
import { verifySignature, hexToBytes, stringToBytes, bytesToHex, sha512, signMessage } from './identity.js';
import config from './config.js';
import logger from './logger.js';

function toHex(nodeId) {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId).toString('hex');
  }
  return nodeId;
}

export class KeyRotationManager extends EventEmitter {
  constructor(node) {
    super();
    this.node = node;
    this.seenSequenceNumbers = new Set();
    this.sequenceNumber = 0;
  }

  floodRotation(cert) {
    this.sequenceNumber++;
    const rotationMsg = {
      cert,
      sequenceNumber: this.sequenceNumber,
      ttl: config.GMP_TOPOLOGY_TTL || 16
    };
    const cacheKey = `${cert.oldNodeId}:${this.sequenceNumber}`;
    this.seenSequenceNumbers.add(cacheKey);

    this.flood(rotationMsg);
  }

  flood(rotationMsg, excludePeerHex = null) {
    const excludeHex = excludePeerHex ? toHex(excludePeerHex) : null;
    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
        const peerHex = toHex(link.remoteNodeId);
        if (peerHex !== excludeHex) {
          try {
            link.sendKeyRotation(rotationMsg.cert, rotationMsg.sequenceNumber, rotationMsg.ttl);
          } catch (e) {
            logger.error('key-rotation', 'flood-failed', `Failed to flood key rotation to peer ${peerHex}: ${e.message}`, {
              peerNodeId: peerHex,
              err: e.message
            });
          }
        }
      }
    }
  }

  handleReceivedRotation(msg, incomingLink) {
    const { cert, sequenceNumber, ttl } = msg;
    if (!cert || ttl <= 0) return;

    // Loop prevention: check sequence number cache
    const oldNodeIdHex = toHex(cert.oldNodeId);
    const cacheKey = `${oldNodeIdHex}:${sequenceNumber}`;
    if (this.seenSequenceNumbers.has(cacheKey)) {
      return;
    }
    this.seenSequenceNumbers.add(cacheKey);

    // Verify oldNodeId is in peer cache (do not accept rotation from unknown peers)
    const cachedPeer = this.node.peerCache.cache.find(p => p.nodeId === oldNodeIdHex);
    if (!cachedPeer || !cachedPeer.signingPubKey) {
      logger.warn('key-rotation', 'unknown-old-node', `Unknown or untrusted old NodeID: ${oldNodeIdHex}`, {
        oldNodeId: oldNodeIdHex
      });
      return;
    }

    // Verify signature using the oldNodeId's signing public key
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

    // Replace old NodeID with new NodeID in peer cache
    const newNodeIdHex = toHex(cert.newNodeId);
    this.node.peerCache.replaceNodeId(oldNodeIdHex, newNodeIdHex, cert.newPublicKey);

    // Update routing table - remove old NodeID routes
    this.node.routingTable.removeRoutesVia(oldNodeIdHex);
    if (this.node.routingTable.routes.has(oldNodeIdHex)) {
      const nextHops = Array.from(this.node.routingTable.routes.get(oldNodeIdHex).keys());
      for (const nextHop of nextHops) {
        this.node.routingTable.removeRoute(oldNodeIdHex, nextHop);
      }
    }

    // Re-flood to other peers (split-horizon)
    const incomingPeerHex = incomingLink && incomingLink.remoteNodeId ? toHex(incomingLink.remoteNodeId) : null;
    const newMsg = {
      cert,
      sequenceNumber,
      ttl: ttl - 1
    };
    this.flood(newMsg, incomingPeerHex);

    this.emit('key-rotated', { oldNodeId: oldNodeIdHex, newNodeId: newNodeIdHex });
    this.node.emit('key-rotated', { oldNodeId: oldNodeIdHex, newNodeId: newNodeIdHex });
  }

  close() {
    this.seenSequenceNumbers.clear();
  }
}
