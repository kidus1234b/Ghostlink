import config from './config.js';
import logger from './logger.js';
import metrics from './metrics.js';

function toHex(nodeId) {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId).toString('hex');
  }
  return nodeId;
}

export class Forwarder {
  constructor(node) {
    this.node = node;
    // Map: sourceNodeId (hex) -> Array of timestamps of forwarded messages
    this.forwardTimestamps = new Map();
  }

  processIncoming(plaintext, incomingLink) {
    if (plaintext.length < 1) return false;
    const isRouted = plaintext[0];

    // If it's a direct message, it falls through to standard delivery (return false)
    if (isRouted !== 0x01) {
      return false;
    }

    if (plaintext.length < 66) {
      // Malformed routed message
      return false;
    }

    const sourceNodeId = plaintext.slice(1, 33);
    const finalDest = plaintext.slice(33, 65);
    const hopCount = plaintext[65];
    const payload = plaintext.slice(66);

    const ourNodeIdHex = this.node.identity.nodeIdHex;
    const finalDestHex = Buffer.from(finalDest).toString('hex');
    const sourceNodeIdHex = Buffer.from(sourceNodeId).toString('hex');

    if (this.node.reputation) {
      if (this.node.reputation.isBanned(sourceNodeIdHex) || this.node.reputation.isBanned(finalDestHex)) {
        logger.warn('forwarder', 'dropped-banned-packet', `Dropping packet between banned peers: ${sourceNodeIdHex.slice(0, 8)} -> ${finalDestHex.slice(0, 8)}`, {
          sourceNodeId: sourceNodeIdHex,
          destinationNodeId: finalDestHex
        });
        return { local: false, error: 'banned' };
      }
    }

    // Check if we are the final destination
    if (ourNodeIdHex.startsWith(finalDestHex)) {
      return {
        local: true,
        sourceNodeId,
        payload
      };
    }

    // We are a relay!

    // Routing loop detection: if the packet originated from us and came back, drop and penalize
    if (sourceNodeIdHex === ourNodeIdHex) {
      if (incomingLink) {
        incomingLink._penalizeBanned('Routing loop detected: received our own authored packet');
      }
      return { local: false, error: 'routing-loop' };
    }
    
    // Rate limit check
    if (!this.checkRateLimit(incomingLink ? incomingLink.remoteNodeId : null)) {
      if (incomingLink) {
        incomingLink._penalizeBanned('Forwarding rate limit exceeded');
      }
      this.node.emit('rate-limited', {
        sourceNodeId: incomingLink ? incomingLink.remoteNodeId : null,
        type: 'forward'
      });
      metrics.increment('security.rateLimitHits');
      return { local: false, error: 'rate-limited' };
    }

    // 1. Decrement hopCount
    const newHopCount = hopCount - 1;
    if (newHopCount <= 0) {
      this.node.emit('ttl-expired', {
        finalDestinationNodeId: finalDest,
        hopCount: hopCount
      });
      metrics.increment('routing.droppedTTL');
      return { local: false, error: 'ttl-expired' };
    }

    // 2. Look up destination in routing table
    const route = this.node.routingTable.getBestRoute(finalDest);
    if (!route) {
      this.node.emit('no-route', {
        finalDestinationNodeId: finalDest
      });
      metrics.increment('routing.droppedNoRoute');
      return { local: false, error: 'no-route' };
    }

    // 3. Find connection for next hop
    const nextHopLink = this.node.getLinkByNodeId(route.nextHopNodeId);
    if (!nextHopLink || nextHopLink.state !== 'connected') {
      this.node.emit('no-route', {
        finalDestinationNodeId: finalDest
      });
      metrics.increment('routing.droppedNoRoute');
      return { local: false, error: 'no-route' };
    }

    // 4. Forward the payload unchanged (using sourceNodeId from the packet)
    try {
      nextHopLink.sendRoutedDATA(finalDest, newHopCount, payload, sourceNodeId);
      metrics.increment('routing.messagesForwarded');
      this.node.emit('forwarded', {
        sourceNodeId,
        finalDestinationNodeId: finalDest,
        hopCount: newHopCount
      });
    } catch (e) {
      // Ignore socket writing errors during forward
    }

    return { local: false };
  }
  checkRateLimit(sourceNodeId) {
    if (!sourceNodeId) return true;
    const sourceHex = toHex(sourceNodeId);
    const now = Date.now();
    
    const windowMs = this.node.forwardRateLimitWindowMs !== undefined ? this.node.forwardRateLimitWindowMs : (config.GMP_RATE_LIMIT_WINDOW_MS || 60000);
    const maxForwards = this.node.forwardRateLimitMax !== undefined ? this.node.forwardRateLimitMax : (config.GMP_FORWARD_RATE_LIMIT_PER_SOURCE || 500);

    let timestamps = this.forwardTimestamps.get(sourceHex) || [];
    const cutoff = now - windowMs;
    timestamps = timestamps.filter(ts => ts > cutoff);

    if (timestamps.length >= maxForwards) {
      return false;
    }

    timestamps.push(now);
    this.forwardTimestamps.set(sourceHex, timestamps);
    return true;
  }
}
