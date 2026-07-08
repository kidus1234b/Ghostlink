import { EventEmitter } from 'events';
import { GMPNode } from './link.js';
import config from './config.js';
import metrics from './metrics.js';

function toHex(nodeId) {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId).toString('hex');
  }
  return nodeId;
}

export class GMPNodeManager extends EventEmitter {
  constructor(options = {}) {
    super();
    // Parse input options and load global config
    this.config = { ...config, ...options };
    this.node = null;
    this.connToNodeId = new Map();
  }

  async start() {
    if (this.node) {
      throw new Error('GMPNodeManager already started');
    }

    const { seedPhrase } = this.config;

    // Build options matching configuration names or parameter names
    this.node = new GMPNode({
      port: this.config.GMP_PORT,
      minPeers: this.config.GMP_MIN_PEERS,
      maxPeers: this.config.GMP_MAX_PEERS,
      maxConnections: this.config.GMP_MAX_CONNECTIONS,
      helloTimeoutMs: this.config.GMP_HELLO_TIMEOUT_MS,
      handshakeTimeoutMs: this.config.GMP_HANDSHAKE_TIMEOUT_MS,
      pingIntervalMs: this.config.GMP_PING_INTERVAL_MS,
      pongTimeoutMs: this.config.GMP_PING_TIMEOUT_MS,
      timestampWindowMs: this.config.GMP_TIMESTAMP_WINDOW_MS,
      stage1TimeoutMs: this.config.GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS,
      stage2TimeoutMs: this.config.GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS,
      rebootstrapBackoffInitialMs: this.config.GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS,
      rateLimitWindowMs: this.config.GMP_RATE_LIMIT_WINDOW_MS,
      rateLimitMaxPerIp: this.config.GMP_RATE_LIMIT_MAX_PER_IP,
      rateLimitMaxGlobal: this.config.GMP_RATE_LIMIT_MAX_GLOBAL,
      forwardRateLimitPerSource: this.config.GMP_FORWARD_RATE_LIMIT_PER_SOURCE,
      peerRequestRateLimitIntervalMs: this.config.GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS,
      sessionKeyLruSize: this.config.GMP_SESSION_KEY_LRU_SIZE,
      sequenceNumLruSize: this.config.GMP_SEQUENCE_NUM_LRU_SIZE,
      noncePruneAgeMs: this.config.GMP_NONCE_PRUNE_AGE_MS,
      routeExpiryMs: this.config.GMP_ROUTE_EXPIRY_MS,
      topologyTtl: this.config.GMP_TOPOLOGY_TTL,
      messageHopLimit: this.config.GMP_MESSAGE_HOP_LIMIT,
      reannounceIntervalMs: this.config.GMP_REANNOUNCE_INTERVAL_MS,
      peerCacheMaxSize: this.config.GMP_PEER_CACHE_MAX_SIZE,
      peerCachePruneFailureThreshold: this.config.GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD,
      peerCachePruneAgeDays: this.config.GMP_PEER_CACHE_PRUNE_AGE_DAYS,
      seedPhrase
    });

    // Wire events
    this.node.on('connection', ({ connId, link, peerNodeId }) => {
      const nodeIdHex = toHex(peerNodeId);
      this.connToNodeId.set(connId, nodeIdHex);

      const address = link.socket ? link.socket.remoteAddress : null;
      const port = link.socket ? link.socket.remotePort : null;
      
      metrics.increment('peers.totalConnected');
      this.emit('peer-connected', { nodeId: nodeIdHex, address, port });
    });

    this.node.on('close', ({ connId }) => {
      const nodeIdHex = this.connToNodeId.get(connId);
      if (nodeIdHex) {
        this.connToNodeId.delete(connId);
        metrics.increment('peers.totalDisconnected');
        this.emit('peer-disconnected', { nodeId: nodeIdHex });
      }
    });

    this.node.on('message', ({ connId, msg }) => {
      const nodeIdHex = this.connToNodeId.get(connId);
      let fromHex = nodeIdHex;
      if (!fromHex) {
        const link = this.node.links.get(connId);
        if (link && link.remoteNodeId) {
          fromHex = toHex(link.remoteNodeId);
        }
      }

      // Auto-reply to virtual-ping
      if (fromHex) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed && parsed.type === 'virtual-ping') {
            this.sendMessage(fromHex, JSON.stringify({ type: 'virtual-pong', timestamp: parsed.timestamp }))
              .catch(() => {});
            return; // Intercept and do not forward to application
          }
        } catch (e) {}
      }

      if (fromHex) {
        this.emit('message', { fromNodeId: fromHex, payload: msg });
      }
    });

    this.node.on('bootstrap-complete', (peersConnected) => {
      this.emit('bootstrap-complete', { peersConnected });
    });

    this.node.on('bootstrap-failed', (peersConnected) => {
      this.emit('bootstrap-failed', { peersConnected });
    });

    this.node.on('routing-degraded', (data) => {
      this.emit('routing-degraded', data);
    });

    // Load identity (derive keys from seedPhrase)
    await this.node.loadIdentity(seedPhrase);

    // Register node for metrics and start metrics server
    metrics.registerNode(this.node, this);
    metrics.startServer(this.config.GMP_METRICS_PORT);

    // Start TCP listener
    await this.node.listen();

    return {
      nodeId: this.node.identity.nodeIdHex,
      address: '127.0.0.1',
      port: this.node.port
    };
  }

  async stop() {
    if (!this.node) return;

    // Stop metrics HTTP server
    metrics.stopServer();

    // Graceful shutdown: flood withdrawal announcements
    if (this.node.topologyManager) {
      for (const link of this.node.connections.values()) {
        if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
          try {
            this.node.topologyManager.handleLinkClosed(link.remoteNodeId);
          } catch (e) {}
        }
      }
    }

    // Give a brief delay for withdrawal packets to flush to sockets
    await new Promise(r => setTimeout(r, 100));

    // Flush peer cache to disk
    if (this.node.peerCache) {
      try {
        this.node.peerCache.save();
      } catch (e) {}
    }

    // Close GMPNode (closes links, listener, etc.)
    this.node.close();
    this.node = null;
    this.connToNodeId.clear();
  }

  async connectToPeer(address, port, options = {}) {
    if (!this.node) throw new Error('GMPNodeManager not started');
    try {
      const result = await this.node.dial(address, port, { tls: options.tls === true || port === 443 });
      const nodeIdHex = toHex(result.peerNodeId);
      return { nodeId: nodeIdHex, connected: true };
    } catch (e) {
      return { nodeId: null, connected: false };
    }
  }

  async _getOrConnect(destinationNodeId) {
    const destHex = toHex(destinationNodeId);

    // 1. Check direct connection
    let link = this.node.getLinkByNodeId(destHex);
    if (link && link.state === 'connected') {
      return link;
    }

    // 2. Check existing virtual connection
    const prefix = destHex.slice(0, 64);
    link = this.node.virtualConnections.get(prefix);
    if (link && link.state === 'connected') {
      return link;
    }

    // 3. Check routing table
    const route = this.node.routingTable.getBestRoute(destHex);
    if (!route) {
      const err = new Error('No route to destination');
      err.name = 'NoRouteError';
      throw err;
    }

    // 4. Dial virtual connection
    try {
      const result = await this.node.dialVirtual(Buffer.from(destHex, 'hex'));
      return result.link;
    } catch (e) {
      const err = new Error(`Failed to route message: ${e.message}`);
      err.name = 'NoRouteError';
      throw err;
    }
  }

  async sendMessage(destinationNodeId, encryptedPayload) {
    if (!this.node) throw new Error('GMPNodeManager not started');
    const link = await this._getOrConnect(destinationNodeId);
    await link.send(encryptedPayload);
  }

  async sendDirect(destinationNodeId, encryptedPayload) {
    if (!this.node) throw new Error('GMPNodeManager not started');
    const destHex = toHex(destinationNodeId);
    const link = this.node.getLinkByNodeId(destHex);
    if (!link || link.state !== 'connected') {
      const err = new Error('No direct connection to peer');
      err.name = 'NoPeerError';
      throw err;
    }
    await link.send(encryptedPayload);
  }

  getStatus() {
    if (!this.node) {
      return { status: 'offline', peers: [] };
    }

    const health = this.node.getHealthReport() || {};

    const peers = [];
    for (const link of this.node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId) {
        peers.push({
          nodeId: toHex(link.remoteNodeId),
          address: link.socket ? link.socket.remoteAddress : null,
          port: link.socket ? link.socket.remotePort : null,
          isVirtual: false
        });
      }
    }
    for (const link of this.node.virtualConnections.values()) {
      if (link.state === 'connected' && link.remoteNodeId) {
        peers.push({
          nodeId: toHex(link.remoteNodeId),
          address: 'virtual',
          port: 0,
          isVirtual: true
        });
      }
    }

    return {
      status: this.node.healthMonitor ? this.node.healthMonitor.status : 'healthy',
      ...health,
      peers
    };
  }
}
