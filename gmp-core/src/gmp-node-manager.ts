import { EventEmitter } from 'events';
import { GMPNode } from './link.js';
import config from './config.js';
import metrics from './metrics.js';
import logger from './logger.js';
import { ghostAddressFromNodeId, normalizeGhostAddress, findNodeIdsForAddress } from './ghost-address.js';
import type {
  GMPConfig,
  GMPNodeManagerOptions,
  GMPNodeConstructorOptions,
  GMPLinkLike,
} from './types.js';
import type { BootstrapDiagnosis } from './bootstrap.js';
import { loadPublicPeers, queryPublicAddress } from './public-peer-list.js';

function toHex(nodeId: string | Buffer | Uint8Array): string {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId).toString('hex');
  }
  return String(nodeId);
}

export class GMPNodeManager extends EventEmitter {
  private config: GMPConfig & GMPNodeManagerOptions;
  /**
   * The live node. Private so only this class can swap it in and out; the
   * bridge and the CLI read it through the `node` getter below, which is
   * read-only. Both of them null-check it on every use, because it is null
   * before start() and again after stop().
   */
  private _node: GMPNode | null;
  private connToNodeId: Map<string, string>;
  private externalAddress: { address: string; port: number } | null;
  private discoveringExternal: boolean;

  constructor(options: GMPNodeManagerOptions = {}) {
    super();
    this.config = { ...config, ...options } as GMPConfig & GMPNodeManagerOptions;
    this._node = null;
    this.connToNodeId = new Map();
    this.externalAddress = null;
    this.discoveringExternal = false;
  }

  /** Read-only access to the live node for the bridge and CLI. */
  get node(): GMPNode | null {
    return this._node;
  }

  /**
   * Ask a public peer what address this node appears to come from, over
   * BINDING_REQUEST. Nothing called queryPublicAddress before, so the node
   * never learned its own external address and every status reply said
   * 127.0.0.1 — fine on a LAN, useless for anyone dialling in from outside.
   * Runs once per peer-connected until it succeeds; a peer that is up but
   * refuses the query should not wedge the node into retrying forever.
   */
  private async discoverExternalAddress(): Promise<void> {
    if (!this._node || this.externalAddress || this.discoveringExternal) return;
    const peers = loadPublicPeers();
    if (peers.length === 0) return;

    this.discoveringExternal = true;
    try {
      const found = await queryPublicAddress(this._node as never, peers, 5000);
      this.externalAddress = found;
      logger.info('gmp-node-manager', 'external-address', `External address is ${found.address}:${found.port}`, found);
      this.emit('external-address', found);
    } catch (e) {
      const err = e as Error;
      logger.warn('gmp-node-manager', 'external-address-failed', `Could not determine external address: ${err.message}`, { err: err.message });
    } finally {
      this.discoveringExternal = false;
    }
  }

  async start(): Promise<{ nodeId: string; address: string; port: number }> {
    if (this._node) {
      throw new Error('GMPNodeManager already started');
    }

    const seedPhrase = this.config.GMP_SEED_PHRASE || this.config.seedPhrase;

    const nodeOptions: GMPNodeConstructorOptions = {
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
    };

    this._node = new GMPNode(nodeOptions);

    this._node.on('connection', ({ connId, link, peerNodeId }: { connId: string; link: GMPLinkLike; peerNodeId: Uint8Array }) => {
      const nodeIdHex = toHex(peerNodeId);
      this.connToNodeId.set(connId, nodeIdHex);

      const address = link.socket ? link.socket.remoteAddress : null;
      const port = link.socket ? link.socket.remotePort : null;

      metrics.increment('peers.totalConnected');
      this.emit('peer-connected', { nodeId: nodeIdHex, address, port });
      void this.discoverExternalAddress();
    });

    this._node.on('close', ({ connId }: { connId: string }) => {
      const nodeIdHex = this.connToNodeId.get(connId);
      if (nodeIdHex) {
        this.connToNodeId.delete(connId);
        metrics.increment('peers.totalDisconnected');
        this.emit('peer-disconnected', { nodeId: nodeIdHex });
      }
    });

    this._node.on('message', ({ connId, msg }: { connId: string; msg: Uint8Array }) => {
      const nodeIdHex = this.connToNodeId.get(connId);
      let fromHex = nodeIdHex;
      if (!fromHex && this._node) {
        const link = this._node.links.get(connId);
        if (link && link.remoteNodeId) {
          fromHex = toHex(link.remoteNodeId);
        }
      }

      if (fromHex) {
        try {
          const msgStr = Buffer.from(msg).toString('utf8');
          const parsed = JSON.parse(msgStr);
          if (parsed && parsed.type === 'virtual-ping') {
            this.sendMessage(fromHex, JSON.stringify({ type: 'virtual-pong', timestamp: parsed.timestamp }))
              .catch(() => {});
            return;
          }
        } catch { }
      }

      if (fromHex) {
        this.emit('message', { fromNodeId: fromHex, payload: Buffer.from(msg).toString('utf8') });
      }
    });

    this._node.on('bootstrap-complete', (peersConnected: number) => {
      this.emit('bootstrap-complete', { peersConnected });
    });

    this._node.on('bootstrap-failed', (peersConnected: number, diagnosis?: BootstrapDiagnosis) => {
      this.emit('bootstrap-failed', { peersConnected, diagnosis: diagnosis ?? null });
    });

    this._node.on('routing-degraded', (data: unknown) => {
      this.emit('routing-degraded', data);
    });

    try {
      await this._node.loadIdentity(seedPhrase);

      metrics.registerNode(this._node, this);
      metrics.startServer(this.config.GMP_METRICS_PORT);

      await this._node.listen();
    } catch (err) {
      // Leave no half-started node behind. _node used to stay set after a
      // failure here (port in use, bad seed), so every later start() threw
      // "already started" and the bridge reported a node with no identity.
      metrics.stopServer();
      try { this._node.close(); } catch { }
      this._node = null;
      this.connToNodeId.clear();
      throw err;
    }

    return {
      nodeId: this._node.identity.nodeIdHex,
      address: '127.0.0.1',
      port: this._node.port
    };
  }

  async stop(): Promise<void> {
    if (!this._node) return;

    metrics.stopServer();

    if (this._node.topologyManager) {
      for (const link of this._node.connections.values()) {
        if (link.state === 'connected' && link.remoteNodeId && !link.isVirtual) {
          try {
            this._node.topologyManager.handleLinkClosed(link.remoteNodeId);
          } catch { }
        }
      }
    }

    await new Promise(r => setTimeout(r, 100));

    if (this._node.peerCache) {
      try {
        this._node.peerCache.save();
      } catch { }
    }

    this._node.close();
    this._node = null;
    this.connToNodeId.clear();
  }

  async connectToPeer(address: string, port: number, options: { tls?: boolean } = {}): Promise<{ nodeId: string | null; connected: boolean }> {
    if (!this._node) throw new Error('GMPNodeManager not started');
    try {
      const result = await this._node.dial(address, port, { tls: options.tls === true || port === 443 });
      const nodeIdHex = toHex(result.peerNodeId);
      return { nodeId: nodeIdHex, connected: true };
    } catch {
      return { nodeId: null, connected: false };
    }
  }

  private async _getOrConnect(destinationNodeId: string | Uint8Array): Promise<GMPLinkLike> {
    const destHex = toHex(destinationNodeId);

    if (!this._node) throw new Error('GMPNodeManager not started');

    let link = this._node.getLinkByNodeId(destHex);
    if (link && link.state === 'connected') {
      return link;
    }

    const prefix = destHex.slice(0, 64);
    link = this._node.virtualConnections.get(prefix);
    if (link && link.state === 'connected') {
      return link;
    }

    const route = this._node.routingTable.getBestRoute(destHex);
    if (!route) {
      const err = new Error('No route to destination');
      err.name = 'NoRouteError';
      throw err;
    }

    try {
      const result = await this._node.dialVirtual(Buffer.from(destHex, 'hex'));
      return result.link;
    } catch (e) {
      const err = new Error(`Failed to route message: ${(e as Error).message}`);
      err.name = 'NoRouteError';
      throw err;
    }
  }

  async sendMessage(destinationNodeId: string | Uint8Array, encryptedPayload: string): Promise<void> {
    if (!this._node) throw new Error('GMPNodeManager not started');
    const link = await this._getOrConnect(destinationNodeId);
    await link.send(encryptedPayload);
  }

  async sendDirect(destinationNodeId: string | Uint8Array, encryptedPayload: string): Promise<void> {
    if (!this._node) throw new Error('GMPNodeManager not started');
    const destHex = toHex(destinationNodeId);
    const link = this._node.getLinkByNodeId(destHex);
    if (!link || link.state !== 'connected') {
      const err = new Error('No direct connection to peer');
      err.name = 'NoPeerError';
      throw err;
    }
    await link.send(encryptedPayload);
  }

  getNodeId(): string {
    if (!this._node) throw new Error('GMPNodeManager not started');
    return this._node.identity.nodeIdHex;
  }

  getGhostAddress(): string {
    return ghostAddressFromNodeId(this.getNodeId());
  }

  resolveGhostAddress(address: string): { reason: string; nodeId?: string } {
    const normalized = normalizeGhostAddress(address);
    if (!normalized) return { reason: 'invalid-address' };
    if (!this._node) return { reason: 'not-found' };
    const knownNodeIds: string[] = [];
    // Direct connections
    for (const link of this._node.connections.values()) {
      if (link.remoteNodeId) knownNodeIds.push(toHex(link.remoteNodeId));
    }
    // Virtual connections
    for (const link of this._node.virtualConnections.values()) {
      if (link.remoteNodeId) knownNodeIds.push(toHex(link.remoteNodeId));
    }
    // Routing table entries (topology-announced peers)
    if (this._node.routingTable) {
      const allRoutes = this._node.routingTable.getAllRoutes();
      if (Array.isArray(allRoutes)) {
        for (const route of allRoutes) {
          const dest = route.destinationNodeId;
          if (dest && !knownNodeIds.includes(dest)) knownNodeIds.push(dest);
        }
      }
    }
    const matches = findNodeIdsForAddress(knownNodeIds, normalized);
    if (matches.length === 0) return { reason: 'not-found' };
    if (matches.length > 1) return { reason: 'ambiguous', nodeId: matches[0] };
    return { reason: 'ok', nodeId: matches[0] };
  }

  async connectByGhostAddress(address: string): Promise<{ connected: boolean; transport: string }> {
    const result = this.resolveGhostAddress(address);
    if (result.reason !== 'ok' || !result.nodeId) {
      return { connected: false, transport: 'failed' };
    }
    return this.connectByNodeId(result.nodeId);
  }

  async connectByNodeId(nodeId: string): Promise<{ connected: boolean; transport: string }> {
    if (!this._node) throw new Error('GMPNodeManager not started');
    if (nodeId === this.getNodeId()) return { connected: false, transport: 'self' };
    // Check direct connections
    const existing = this._node.getLinkByNodeId(nodeId);
    if (existing && existing.state === 'connected') {
      return { connected: true, transport: existing.isVirtual ? 'virtual' : 'direct' };
    }
    // Check virtual connections (keyed by prefix of nodeId)
    const prefix = nodeId.slice(0, 64);
    const vLink = this._node.virtualConnections.get(prefix);
    if (vLink && vLink.state === 'connected') {
      return { connected: true, transport: 'virtual' };
    }
    try {
      await this._node.dialVirtual(Buffer.from(nodeId, 'hex'));
      return { connected: true, transport: 'virtual' };
    } catch {
      return { connected: false, transport: 'failed' };
    }
  }

  getStatus(): {
    status: string;
    externalAddress: { address: string; port: number } | null;
    peers: Array<{ nodeId: string; address: string | null; port: number | null; isVirtual: boolean }>;
  } {
    if (!this._node) {
      return { status: 'offline', externalAddress: null, peers: [] };
    }

    const health = this._node.getHealthReport();

    const peers: Array<{ nodeId: string; address: string | null; port: number | null; isVirtual: boolean }> = [];
    for (const link of this._node.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId) {
        peers.push({
          nodeId: toHex(link.remoteNodeId),
          address: link.socket ? link.socket.remoteAddress : null,
          port: link.socket ? link.socket.remotePort : null,
          isVirtual: false
        });
      }
    }
    for (const link of this._node.virtualConnections.values()) {
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
      ...(health ?? {}),
      // getHealthReport() returns null when the node has no health monitor, so
      // the status has to be defaulted here. The previous version read
      // healthMonitor.status - a property that does not exist - and placed it
      // before the spread, so it was either undefined or immediately
      // overwritten. Taking it from the report keeps the real value when there
      // is one and falls back only when there is genuinely no monitor.
      status: health?.status ?? 'healthy',
      externalAddress: this.externalAddress,
      peers
    };
  }
}

