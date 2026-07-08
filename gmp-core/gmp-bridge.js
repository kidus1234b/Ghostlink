import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import net from 'net';
import http from 'http';
import https from 'https';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { GMPNodeManager } from './gmp-node-manager.js';
import config from './config.js';
import logger from './logger.js';

const DEFAULT_BRIDGE_PORT = config.GMP_BRIDGE_PORT || 3002;
const DEFAULT_BRIDGE_HOST = config.GMP_BRIDGE_HOST || '127.0.0.1';

const isLocalIP = (ip) => {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
};

// RFC1918 private LAN ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.
// Only consulted in opt-in LAN mode (GMP_BRIDGE_HOST=0.0.0.0). These are
// non-routable local addresses; the bridge still refuses public IPs.
const isPrivateLANIP = (ip) => {
  if (!ip) return false;
  // Normalize IPv4-mapped IPv6 (e.g. ::ffff:192.168.1.5)
  const v4 = ip.replace(/^::ffff:/i, '');
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
};

export async function startBridge(managerInstance = null, bridgePort = DEFAULT_BRIDGE_PORT, bridgeHost = DEFAULT_BRIDGE_HOST) {
  let manager = managerInstance;
  const clients = new Set();

  // Opt-in LAN mode: when bound to all interfaces, additionally permit
  // connections/origins from RFC1918 private ranges (LAN only, never public).
  const lanMode = bridgeHost === '0.0.0.0';
  const isAllowedIP = (ip) => isLocalIP(ip) || (lanMode && isPrivateLANIP(ip));

  if (lanMode) {
    logger.warn('bridge', 'lan-mode-enabled', 'Bridge bound to all interfaces — only use on trusted LAN, never expose to internet', { bridgeHost });
  }

  // --- Dual ws:// + wss:// on a single port -------------------------------
  // The browser WebSocket client picks ws:// when the page is served over http
  // and wss:// when it's served over https. The bridge can't know the page's
  // scheme at bind time, so rather than commit to one scheme (and break the
  // other), we front the port with a raw TCP server that sniffs the first byte
  // of each connection: a TLS ClientHello always starts with 0x16, so TLS
  // connections are routed to an HTTPS listener (serves wss) and everything else
  // to a plain HTTP listener (serves ws). Net effect: an http page automatically
  // gets plain ws, an https page automatically gets wss — no config, no mismatch.
  let tlsAvailable = false;
  let certPathUsed = null;
  let httpsServer;
  try {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const certPath = process.env.GMP_BRIDGE_CERT || resolve(projectRoot, 'cert.pem');
    const keyPath  = process.env.GMP_BRIDGE_KEY  || resolve(projectRoot, 'key.pem');
    const cert = readFileSync(certPath);
    const key  = readFileSync(keyPath);
    httpsServer = https.createServer({ cert, key });
    tlsAvailable = true;
    certPathUsed = certPath;
    logger.info('bridge', 'tls-enabled', `Bridge TLS available for wss:// (cert: ${certPath})`);
  } catch (e) {
    logger.warn('bridge', 'tls-unavailable',
      'cert.pem / key.pem not found — bridge serves plain ws:// only. ' +
      'https:// frontends cannot connect until certs exist. ' +
      'Generate with: mkcert -cert-file cert.pem -key-file key.pem <LAN-IP> localhost',
      { error: e.message });
  }

  const wss = new WebSocketServer({ noServer: true });

  // Reject an upgrade with an HTTP error before the WebSocket handshake completes.
  const rejectUpgrade = (socket, status, message) => {
    try { socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`); } catch (e) {}
    try { socket.destroy(); } catch (e) {}
  };

  // IP-allowlist + origin checks (replaces the old verifyClient, which the ws
  // library only invokes when it owns the http server — not in noServer mode).
  const upgradeAllowed = (req, socket) => {
    const remoteAddr = req.socket.remoteAddress;
    if (!isAllowedIP(remoteAddr)) {
      logger.warn('bridge', 'client-rejected-ip', `WebSocket connection from unauthorized IP: ${remoteAddr}`, { remoteAddr });
      rejectUpgrade(socket, 401, lanMode
        ? 'Unauthorized: Only localhost and private LAN (RFC1918) connections are allowed'
        : 'Unauthorized: Only localhost connections are allowed');
      return false;
    }
    const origin = req.headers.origin;
    if (origin && origin !== 'file://' && origin !== 'null') {
      try {
        const url = new URL(origin);
        if (!(url.hostname === 'localhost' || url.hostname === '127.0.0.1' || (lanMode && isPrivateLANIP(url.hostname)))) {
          logger.warn('bridge', 'client-rejected-origin', `WebSocket connection from unauthorized origin: ${origin}`, { origin });
          rejectUpgrade(socket, 403, 'Forbidden: Origin not allowed');
          return false;
        }
      } catch (e) {
        rejectUpgrade(socket, 400, 'Bad Request: Invalid Origin');
        return false;
      }
    }
    return true;
  };

  const handleUpgrade = (req, socket, head) => {
    if (!upgradeAllowed(req, socket)) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };

  // Minimal response for non-upgrade requests so that opening the bridge in a
  // browser (e.g. to accept a self-signed cert for wss) shows a page rather than
  // hanging.
  const handleRequest = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('GhostLink GMP bridge — WebSocket endpoint.\n');
  };

  const httpServer = http.createServer(handleRequest);
  httpServer.on('upgrade', handleUpgrade);
  if (httpsServer) {
    httpsServer.on('request', handleRequest);
    httpsServer.on('upgrade', handleUpgrade);
  }

  // Raw TCP front door: sniff first byte, route TLS (0x16) -> https, else -> http.
  const listener = net.createServer((socket) => {
    socket.on('error', () => { try { socket.destroy(); } catch (e) {} });
    socket.once('data', (chunk) => {
      socket.pause();
      socket.unshift(chunk);
      const isTls = chunk && chunk.length > 0 && chunk[0] === 0x16;
      const target = (isTls && httpsServer) ? httpsServer : httpServer;
      target.emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });

  await new Promise((res, rej) => {
    listener.once('error', rej);
    listener.listen(bridgePort, bridgeHost, res);
  });

  const broadcast = (eventObj) => {
    const dataStr = JSON.stringify(eventObj);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(dataStr);
        } catch (e) {
          logger.error('bridge', 'client-broadcast-failed', `Failed to send message to client: ${e.message}`, { err: e });
        }
      }
    }
  };

  const setupManagerEvents = (m) => {
    m.on('peer-connected', ({ nodeId, address, port }) => {
      broadcast({ type: 'peer-connected', nodeId, address, port });
    });

    m.on('peer-disconnected', ({ nodeId }) => {
      broadcast({ type: 'peer-disconnected', nodeId });
    });

    m.on('message', ({ fromNodeId, payload }) => {
      const payloadStr = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
      broadcast({ type: 'message', fromNodeId, payload: payloadStr });
    });

    m.on('bootstrap-complete', ({ peersConnected }) => {
      broadcast({ type: 'bootstrap-complete', peersConnected });
    });

    m.on('bootstrap-failed', ({ peersConnected }) => {
      broadcast({ type: 'bootstrap-failed', peersConnected });
    });

    m.on('routing-degraded', (data) => {
      broadcast({ type: 'routing-degraded', ...data });
    });
  };

  // If manager is passed in (e.g. from Electron), set up events immediately
  if (manager) {
    setupManagerEvents(manager);
  }

  wss.on('connection', (ws) => {
    clients.add(ws);

    // If manager is already started, send started event to the newly connected client
    if (manager && manager.node) {
      try {
        ws.send(JSON.stringify({
          type: 'started',
          nodeId: manager.node.identity.nodeIdHex,
          address: '127.0.0.1'
        }));
      } catch (e) {}
    }

    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch (e) {
        try {
          ws.send(JSON.stringify({ type: 'error', code: 'INVALID_JSON', message: 'Failed to parse JSON' }));
        } catch (err) {}
        return;
      }

      switch (msg.type) {
        case 'start': {
          const { seedPhrase, port } = msg;
          if (!manager) {
            // GMPNodeManager reads its listen port from config.GMP_PORT, so map the
            // per-connection `port` from the start message onto GMP_PORT (falling back
            // to the configured default when the client omits or sends an invalid port).
            const nodePort = Number(port) || config.GMP_PORT;
            manager = new GMPNodeManager({ seedPhrase, port: nodePort, GMP_PORT: nodePort });
            setupManagerEvents(manager);
          }

          if (manager.node) {
            // Already started
            try {
              ws.send(JSON.stringify({
                type: 'started',
                nodeId: manager.node.identity.nodeIdHex,
                address: '127.0.0.1'
              }));
            } catch (e) {}
            return;
          }

          try {
            const startResult = await manager.start();
            broadcast({
              type: 'started',
              nodeId: startResult.nodeId,
              address: startResult.address
            });
          } catch (err) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'START_FAILED', message: err.message }));
            } catch (e) {}
          }
          break;
        }

        case 'connect': {
          const { address, port } = msg;
          if (!manager || !manager.node) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'NOT_STARTED', message: 'GMPNodeManager is not started' }));
            } catch (e) {}
            return;
          }

          const res = await manager.connectToPeer(address, port);
          try {
            ws.send(JSON.stringify({ type: 'connect-result', ...res }));
          } catch (e) {}
          break;
        }

        case 'send': {
          const { destinationNodeId, payload } = msg;
          if (!manager || !manager.node) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'NOT_STARTED', message: 'GMPNodeManager is not started' }));
            } catch (e) {}
            return;
          }

          try {
            await manager.sendMessage(destinationNodeId, payload);
          } catch (err) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: err.name || 'SEND_FAILED', message: err.message }));
            } catch (e) {}
          }
          break;
        }

        case 'sendDirect': {
          const { destinationNodeId, payload } = msg;
          if (!manager || !manager.node) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'NOT_STARTED', message: 'GMPNodeManager is not started' }));
            } catch (e) {}
            return;
          }

          try {
            await manager.sendDirect(destinationNodeId, payload);
          } catch (err) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: err.name || 'SEND_FAILED', message: err.message }));
            } catch (e) {}
          }
          break;
        }

        case 'getStatus': {
          if (!manager) {
            try {
              ws.send(JSON.stringify({ type: 'status', status: 'offline', peers: [] }));
            } catch (e) {}
            return;
          }

          try {
            const status = manager.getStatus();
            ws.send(JSON.stringify({ type: 'status', ...status }));
          } catch (err) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'STATUS_FAILED', message: err.message }));
            } catch (e) {}
          }
          break;
        }

        default: {
          try {
            ws.send(JSON.stringify({ type: 'error', code: 'UNKNOWN_COMMAND', message: `Unknown command type: ${msg.type}` }));
          } catch (e) {}
        }
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  const schemes = tlsAvailable ? 'ws:// and wss://' : 'ws:// only';
  logger.info('bridge', 'server-started',
    `GMP bridge listening on ${bridgeHost}:${bridgePort} (${schemes}, scheme auto-detected per connection)`,
    { tls: tlsAvailable, certPath: certPathUsed });
  return { wss, manager };
}

// Standalone execution entry point
const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === process.argv[1] ||
  process.argv[1].endsWith('gmp-bridge.js')
);

if (isMain) {
  const port = process.env.GMP_BRIDGE_PORT ? parseInt(process.env.GMP_BRIDGE_PORT) : DEFAULT_BRIDGE_PORT;
  const host = process.env.GMP_BRIDGE_HOST || DEFAULT_BRIDGE_HOST;
  startBridge(null, port, host);
}
