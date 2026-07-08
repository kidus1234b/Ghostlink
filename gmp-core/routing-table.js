import { EventEmitter } from 'events';
import config from './config.js';

function toHex(nodeId) {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId).toString('hex');
  }
  return nodeId;
}

export class RoutingTable extends EventEmitter {
  constructor(options = {}) {
    super();
    this.expiryTimeoutMs = options.expiryTimeoutMs || config.GMP_ROUTE_EXPIRY_MS || 300000;
    this.pruneIntervalMs = options.pruneIntervalMs || config.GMP_REANNOUNCE_INTERVAL_MS || 60000;
    
    // Map: destinationNodeId (hex) -> Map: nextHopNodeId (hex) -> RouteEntry
    this.routes = new Map();
    
    this.pruneTimer = setInterval(() => {
      this.pruneExpired();
    }, this.pruneIntervalMs);
    
    if (this.pruneTimer && this.pruneTimer.unref) {
      this.pruneTimer.unref();
    }
  }

  addRoute(dest, nextHop, hopCount) {
    const destHex = toHex(dest);
    const nextHopHex = toHex(nextHop);
    const now = Date.now();

    if (!this.routes.has(destHex)) {
      this.routes.set(destHex, new Map());
    }

    const destRoutes = this.routes.get(destHex);
    const existing = destRoutes.get(nextHopHex);

    const route = {
      destinationNodeId: destHex,
      nextHopNodeId: nextHopHex,
      hopCount,
      lastUpdated: now
    };

    destRoutes.set(nextHopHex, route);

    // Emit route-added if new or hopCount changed
    if (!existing || existing.hopCount !== hopCount) {
      this.emit('route-added', route);
    }
  }

  getBestRoute(dest) {
    const destHex = toHex(dest);
    
    let targetDestHex = null;
    if (destHex.length === 64) {
      // Scan for any matching prefix in the active routes map.
      for (const existingDestHex of this.routes.keys()) {
        if (existingDestHex.startsWith(destHex)) {
          targetDestHex = existingDestHex;
          break;
        }
      }
    } else {
      targetDestHex = destHex;
    }

    if (!targetDestHex || !this.routes.has(targetDestHex)) return null;

    const destRoutes = this.routes.get(targetDestHex);
    const now = Date.now();
    let bestRoute = null;

    for (const route of destRoutes.values()) {
      if (now - route.lastUpdated > this.expiryTimeoutMs) {
        continue;
      }
      if (!bestRoute || route.hopCount < bestRoute.hopCount) {
        bestRoute = route;
      }
    }

    if (!bestRoute) return null;

    return {
      nextHopNodeId: bestRoute.nextHopNodeId,
      hopCount: bestRoute.hopCount
    };
  }

  removeRoutesVia(deadNodeId) {
    const deadNodeHex = toHex(deadNodeId);
    for (const [destHex, destRoutes] of this.routes.entries()) {
      if (destRoutes.has(deadNodeHex)) {
        const route = destRoutes.get(deadNodeHex);
        destRoutes.delete(deadNodeHex);
        this.emit('route-removed', route);
      }
      if (destRoutes.size === 0) {
        this.routes.delete(destHex);
      }
    }
  }

  removeRoute(dest, nextHop) {
    const destHex = toHex(dest);
    const nextHopHex = toHex(nextHop);
    if (this.routes.has(destHex)) {
      const destRoutes = this.routes.get(destHex);
      if (destRoutes.has(nextHopHex)) {
        const route = destRoutes.get(nextHopHex);
        destRoutes.delete(nextHopHex);
        this.emit('route-removed', route);
      }
      if (destRoutes.size === 0) {
        this.routes.delete(destHex);
      }
    }
  }

  pruneExpired() {
    const now = Date.now();
    for (const [destHex, destRoutes] of this.routes.entries()) {
      for (const [nextHopHex, route] of destRoutes.entries()) {
        if (now - route.lastUpdated > this.expiryTimeoutMs) {
          destRoutes.delete(nextHopHex);
          this.emit('route-expired', route);
        }
      }
      if (destRoutes.size === 0) {
        this.routes.delete(destHex);
      }
    }
  }

  getAllRoutes() {
    const list = [];
    const now = Date.now();
    for (const [destHex, destRoutes] of this.routes.entries()) {
      for (const route of destRoutes.values()) {
        if (now - route.lastUpdated <= this.expiryTimeoutMs) {
          list.push(route);
        }
      }
    }
    return list;
  }

  close() {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }
}
