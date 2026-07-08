import http from 'http';
import fs from 'fs';
import path from 'path';
import config from './config.js';
import logger from './logger.js';

class MetricsTracker {
  constructor() {
    this.startTime = Date.now();
    this.registry = {
      'peers.current': 0,
      'peers.peak': 0,
      'peers.totalConnected': 0,
      'peers.totalDisconnected': 0,
      
      'routing.tableSize': 0,
      'routing.messagesForwarded': 0,
      'routing.droppedNoRoute': 0,
      'routing.droppedTTL': 0,
      'routing.announcements': 0,
      
      'network.bytesSent': 0,
      'network.bytesReceived': 0,
      'network.messagesReceived': 0,
      'network.messagesSent': 0,
      
      'security.rateLimitHits': 0,
      'security.handshakeFailures': 0,
      'security.reputationBans': 0,
      'security.keyRotations': 0,
      
      'bootstrap.attempts': 0,
      'bootstrap.lastAttemptAt': null,
      'bootstrap.status': 'healthy',
    };
    this.server = null;
    this.nodeInstance = null;
    this.nodeManagerInstance = null;
  }

  increment(key, count = 1) {
    if (this.registry[key] !== undefined) {
      this.registry[key] += count;
    }
  }

  set(key, value) {
    if (this.registry[key] !== undefined) {
      this.registry[key] = value;
    }
  }

  registerNode(node, manager = null) {
    this.nodeInstance = node;
    if (manager) this.nodeManagerInstance = manager;
  }

  startServer(port) {
    if (this.server) return;
    const metricsPort = port || config.GMP_METRICS_PORT || 9090;

    this.server = http.createServer((req, res) => {
      const remoteAddr = req.socket.remoteAddress;
      const isLocal = remoteAddr === '127.0.0.1' || 
                      remoteAddr === '::1' || 
                      remoteAddr === '::ffff:127.0.0.1' ||
                      remoteAddr === 'localhost';

      if (!isLocal) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access forbidden: localhost only' }));
        return;
      }

      if (req.method === 'GET' && req.url === '/metrics') {
        const payload = this.getMetricsJSON();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload, null, 2));
      } else if (req.method === 'GET' && req.url === '/health') {
        const payload = this.getHealthJSON();
        res.writeHead(payload.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload, null, 2));
      } else if (req.method === 'GET' && req.url === '/peers') {
        const payload = this.getPeersJSON();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload, null, 2));
      } else if (req.method === 'POST' && req.url === '/rotate-key') {
        this.handleRotateKey(req, res);
      } else if (req.method === 'POST' && req.url === '/ping') {
        this.handlePing(req, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    this.server.on('error', (err) => {
      logger.error('metrics', 'server-error', `Metrics server error: ${err.message}`, { err });
    });

    this.server.listen(metricsPort, '127.0.0.1', () => {
      logger.info('metrics', 'server-started', `Metrics server listening on http://127.0.0.1:${metricsPort}/metrics`);
    });
  }

  stopServer() {
    if (this.server) {
      try {
        this.server.close();
        logger.info('metrics', 'server-stopped', 'Metrics server stopped');
      } catch (e) {
        // Ignore close error
      }
      this.server = null;
    }
  }

  getMetricsJSON() {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    let nodeId = 'unknown';
    let version = '1.0.0';
    let currentPeers = this.registry['peers.current'];
    let routingTableSize = this.registry['routing.tableSize'];
    let bootstrapStatus = 'healthy';
    
    if (this.nodeInstance) {
      if (this.nodeInstance.identity && this.nodeInstance.identity.nodeIdHex) {
        nodeId = this.nodeInstance.identity.nodeIdHex.slice(0, 16);
      }
      currentPeers = Array.from(this.nodeInstance.connections.values())
        .filter(link => link.state === 'connected' && !link.isVirtual).length;
      if (currentPeers > this.registry['peers.peak']) {
        this.registry['peers.peak'] = currentPeers;
      }
      if (this.nodeInstance.routingTable && this.nodeInstance.routingTable.table) {
        routingTableSize = this.nodeInstance.routingTable.table.size;
      }
      if (this.nodeInstance.bootstrap) {
        bootstrapStatus = this.nodeInstance.bootstrap.stage === 'failed' ? 'degraded' : 'healthy';
      }
    }

    return {
      timestamp: new Date().toISOString(),
      node: {
        nodeId,
        uptimeSeconds,
        version
      },
      peers: {
        current: currentPeers,
        peak: this.registry['peers.peak'],
        totalConnected: this.registry['peers.totalConnected'],
        totalDisconnected: this.registry['peers.totalDisconnected']
      },
      routing: {
        tableSize: routingTableSize,
        messagesForwarded: this.registry['routing.messagesForwarded'],
        droppedNoRoute: this.registry['routing.droppedNoRoute'],
        droppedTTL: this.registry['routing.droppedTTL'],
        announcements: this.registry['routing.announcements']
      },
      network: {
        bytesSent: this.registry['network.bytesSent'],
        bytesReceived: this.registry['network.bytesReceived'],
        messagesReceived: this.registry['network.messagesReceived'],
        messagesSent: this.registry['network.messagesSent']
      },
      security: {
        rateLimitHits: this.registry['security.rateLimitHits'],
        handshakeFailures: this.registry['security.handshakeFailures'],
        reputationBans: this.registry['security.reputationBans'],
        keyRotations: this.registry['security.keyRotations']
      },
      bootstrap: {
        attempts: this.registry['bootstrap.attempts'],
        lastAttemptAt: this.registry['bootstrap.lastAttemptAt'],
        status: bootstrapStatus
      }
    };
  }

  getHealthJSON() {
    let status = 'ok';
    let reason = '';
    
    if (this.nodeInstance) {
      const currentPeers = Array.from(this.nodeInstance.connections.values())
        .filter(link => link.state === 'connected' && !link.isVirtual).length;
      
      if (this.nodeInstance.bootstrap && !this.nodeInstance.bootstrap.disableBootstrap && currentPeers === 0) {
        status = 'degraded';
        reason = 'No active peer connections';
      }
    }
    
    const res = { status };
    if (reason) res.reason = reason;
    return res;
  }

  getPeersJSON() {
    const peers = [];
    if (this.nodeInstance) {
      for (const link of this.nodeInstance.connections.values()) {
        if (link.state === 'connected' && link.remoteNodeId) {
          peers.push({
            nodeId: Buffer.from(link.remoteNodeId).toString('hex'),
            address: link.socket ? link.socket.remoteAddress : 'unknown',
            port: link.socket ? link.socket.remotePort : 0,
            type: link.isInitiator ? 'outgoing' : 'incoming',
            isVirtual: false
          });
        }
      }
      for (const link of this.nodeInstance.virtualConnections.values()) {
        if (link.state === 'connected' && link.remoteNodeId) {
          peers.push({
            nodeId: Buffer.from(link.remoteNodeId).toString('hex'),
            address: 'virtual',
            port: 0,
            type: link.isInitiator ? 'outgoing' : 'incoming',
            isVirtual: true
          });
        }
      }
    }
    return peers;
  }

  handleRotateKey(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { newSeedPhrase } = JSON.parse(body);
        if (!newSeedPhrase) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing newSeedPhrase' }));
          return;
        }

        if (!this.nodeInstance) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Node not running' }));
          return;
        }

        const { deriveIdentityFromSeedPhrase } = await import('./identity.js');
        const newIdentity = await deriveIdentityFromSeedPhrase(newSeedPhrase);
        const cert = this.nodeInstance.rotateKey(newIdentity);

        // Update stored seed phrase in config.json
        try {
          const configPath = path.join(process.cwd(), 'gmp-core', 'data', 'config.json');
          let fileConfig = {};
          if (fs.existsSync(configPath)) {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          }
          fileConfig.GMP_SEED_PHRASE = newSeedPhrase;
          fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf8');
        } catch (e) {
          logger.warn('metrics', 'rotate-config-failed', `Could not update config.json: ${e.message}`);
        }

        this.increment('security.keyRotations');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, newNodeId: newIdentity.nodeIdHex, cert }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  handlePing(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { targetNodeId } = JSON.parse(body);
        if (!targetNodeId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing targetNodeId' }));
          return;
        }

        if (!this.nodeManagerInstance || !this.nodeInstance) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Node not running' }));
          return;
        }

        const targetHex = targetNodeId.trim();
        const start = Date.now();

        // Get routing hop count
        let hops = 1;
        const route = this.nodeInstance.routingTable.getBestRoute(targetHex);
        if (route) {
          hops = route.hops;
        }

        // We register a temporary handler on nodeManagerInstance for virtual-pong
        const onMessage = (data) => {
          if (data.fromNodeId === targetHex) {
            try {
              const payload = JSON.parse(data.payload);
              if (payload.type === 'virtual-pong') {
                const rtt = Date.now() - start;
                cleanup();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, rtt, hops }));
              }
            } catch (e) {}
          }
        };

        const cleanup = () => {
          this.nodeManagerInstance.off('message', onMessage);
          clearTimeout(timeout);
        };

        const timeout = setTimeout(() => {
          cleanup();
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Ping timeout' }));
        }, 10000);

        this.nodeManagerInstance.on('message', onMessage);

        // Send virtual ping
        await this.nodeManagerInstance.sendMessage(
          targetHex,
          JSON.stringify({ type: 'virtual-ping', timestamp: start })
        );
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }
}

const metrics = new MetricsTracker();
export default metrics;
