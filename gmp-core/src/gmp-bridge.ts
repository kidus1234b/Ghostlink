import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import net from 'net';
import http from 'http';
import https from 'https';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { GMPNodeManager } from './gmp-node-manager.js';
import config from './config.js';
import logger from './logger.js';
import { ghostAddressFromNodeId } from './ghost-address.js';
import type { BridgeMessage } from './types.js';
import type { BootstrapDiagnosis } from './bootstrap.js';
import { PACKAGE_ROOT } from './paths.js';

const DEFAULT_BRIDGE_PORT = config.GMP_BRIDGE_PORT || 3002;
const DEFAULT_BRIDGE_HOST = config.GMP_BRIDGE_HOST || '127.0.0.1';

function isLocalIP(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

function isPrivateLANIP(ip: string): boolean {
  if (!ip) return false;
  const v4 = ip.replace(/^::ffff:/i, '');
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

interface BridgeClient extends WebSocket {
  isAlive: boolean;
}

export async function startBridge(
  managerInstance: GMPNodeManager | null = null,
  bridgePort: number = DEFAULT_BRIDGE_PORT,
  bridgeHost: string = DEFAULT_BRIDGE_HOST
): Promise<{ wss: WebSocketServer; manager: GMPNodeManager | null }> {
  let manager = managerInstance;
  const clients = new Set<BridgeClient>();

  const lanMode = bridgeHost === '0.0.0.0';
  const isAllowedIP = (ip: string): boolean => isLocalIP(ip) || (lanMode && isPrivateLANIP(ip));

  if (lanMode) {
    logger.warn('bridge', 'lan-mode-enabled', 'Bridge bound to all interfaces — only use on trusted LAN, never expose to internet', { bridgeHost });
  }

  let tlsAvailable = false;
  let certPathUsed: string | null = null;
  let httpsServer: https.Server | undefined;
  try {
    // The certs live at the repo root, next to index.html — but this file is
    // compiled into dist/, so "one level up" lands in gmp-core/ and TLS was
    // silently unavailable even with certs sitting right there. Check the
    // package root and the repo root above it, in that order.
    const candidates = process.env.GMP_BRIDGE_CERT && process.env.GMP_BRIDGE_KEY
      ? [{ cert: resolve(process.env.GMP_BRIDGE_CERT), key: resolve(process.env.GMP_BRIDGE_KEY) }]
      : [
          { cert: resolve(PACKAGE_ROOT, 'cert.pem'), key: resolve(PACKAGE_ROOT, 'key.pem') },
          { cert: resolve(PACKAGE_ROOT, '..', 'cert.pem'), key: resolve(PACKAGE_ROOT, '..', 'key.pem') }
        ];

    let loaded: { cert: Buffer; key: Buffer; path: string } | null = null;
    let lastErr: Error | null = null;
    for (const c of candidates) {
      try {
        loaded = { cert: readFileSync(c.cert), key: readFileSync(c.key), path: c.cert };
        break;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    if (!loaded) throw lastErr || new Error('no cert/key pair found');

    httpsServer = https.createServer({ cert: loaded.cert, key: loaded.key });
    tlsAvailable = true;
    certPathUsed = loaded.path;
    logger.info('bridge', 'tls-enabled', `Bridge TLS available for wss:// (cert: ${loaded.path})`);
  } catch (e) {
    const err = e as Error;
    logger.warn('bridge', 'tls-unavailable',
      'cert.pem / key.pem not found — bridge serves plain ws:// only. ' +
      'https:// frontends cannot connect until certs exist. ' +
      'Generate with: mkcert -cert-file cert.pem -key-file key.pem <LAN-IP> localhost',
      { error: err.message });
  }

  const wss = new WebSocketServer({ noServer: true });

  const rejectUpgrade = (socket: net.Socket, status: number, message: string): void => {
    try { socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`); } catch (_e) {}
    try { socket.destroy(); } catch (_e) {}
  };

  const upgradeAllowed = (req: http.IncomingMessage, socket: net.Socket): boolean => {
    const remoteAddr = req.socket.remoteAddress;
    if (!remoteAddr || !isAllowedIP(remoteAddr)) {
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
      } catch (_e) {
        rejectUpgrade(socket, 400, 'Bad Request: Invalid Origin');
        return false;
      }
    }
    return true;
  };

  const handleUpgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer): void => {
    if (!upgradeAllowed(req, socket)) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('GhostLink GMP bridge — WebSocket endpoint.\n');
  };

  const httpServer = http.createServer(handleRequest);
  httpServer.on('upgrade', handleUpgrade);
  if (httpsServer) {
    httpsServer.on('request', handleRequest);
    httpsServer.on('upgrade', handleUpgrade);
  }

  const listener = net.createServer((socket: net.Socket) => {
    socket.on('error', () => { try { socket.destroy(); } catch (_e) {} });
    socket.once('data', (chunk: Buffer) => {
      socket.pause();
      socket.unshift(chunk);
      const isTls = chunk && chunk.length > 0 && chunk[0] === 0x16;
      const target = (isTls && httpsServer) ? httpsServer : httpServer;
      target.emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });

  await new Promise<void>((res, rej) => {
    listener.once('error', rej);
    listener.listen(bridgePort, bridgeHost, res);
  });

  const broadcast = (eventObj: BridgeMessage): void => {
    const dataStr = JSON.stringify(eventObj);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(dataStr);
        } catch (e) {
          const err = e as Error;
          logger.error('bridge', 'client-broadcast-failed', `Failed to send message to client: ${err.message}`, { err });
        }
      }
    }
  };

  const setupManagerEvents = (m: GMPNodeManager): void => {
    m.on('peer-connected', ({ nodeId, address, port }: { nodeId: string; address: string; port: number }) => {
      broadcast({ type: 'peer-connected', nodeId, address, port });
    });

    m.on('peer-disconnected', ({ nodeId }: { nodeId: string }) => {
      broadcast({ type: 'peer-disconnected', nodeId });
    });

    m.on('message', ({ fromNodeId, payload }: { fromNodeId: string; payload: Buffer | string }) => {
      const payloadStr = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
      broadcast({ type: 'message', fromNodeId, payload: payloadStr });
    });

    m.on('bootstrap-complete', ({ peersConnected }: { peersConnected: number }) => {
      broadcast({ type: 'bootstrap-complete', peersConnected });
    });

    m.on('bootstrap-failed', ({ peersConnected, diagnosis }: { peersConnected: number; diagnosis?: BootstrapDiagnosis | null }) => {
      // The reason travels with the event so the UI can say which of the three
      // failures this is, instead of guessing one message for all of them.
      broadcast({
        type: 'bootstrap-failed',
        peersConnected,
        reason: diagnosis ? diagnosis.reason : 'unknown',
        publicPeersConfigured: diagnosis ? diagnosis.publicPeersConfigured : 0,
        peersFile: diagnosis ? diagnosis.peersFile : null,
        attempts: diagnosis ? diagnosis.attempts : []
      });
    });

    m.on('external-address', ({ address, port }: { address: string; port: number }) => {
      broadcast({ type: 'external-address', address, port });
    });

    m.on('routing-degraded', (data: unknown) => {
      broadcast({ type: 'routing-degraded', ...(data as Record<string, unknown>) });
    });
  };

  if (manager) {
    setupManagerEvents(manager);
  }

  wss.on('connection', (ws: WebSocket) => {
    const client = ws as BridgeClient;
    client.isAlive = true;

    clients.add(client);

    if (manager && manager.node) {
      try {
        ws.send(JSON.stringify({
          type: 'started',
          nodeId: manager.node.identity.nodeIdHex,
          address: '127.0.0.1',
          ghostAddress: ghostAddressFromNodeId(manager.node.identity.nodeIdHex)
        }));
      } catch (_e) {}
    }

    ws.on('message', async (data: Buffer) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(data.toString('utf8')) as BridgeMessage;
      } catch (_e) {
        try {
          ws.send(JSON.stringify({ type: 'error', code: 'INVALID_JSON', message: 'Failed to parse JSON' }));
        } catch (_err) {}
        return;
      }

      switch (msg.type) {
        case 'start': {
          const { seedPhrase, port } = msg as BridgeMessage & { seedPhrase?: string; port?: number };
          if (!manager) {
            const nodePort = Number(port) || config.GMP_PORT;
            manager = new GMPNodeManager({ seedPhrase, port: nodePort, GMP_PORT: nodePort });
            setupManagerEvents(manager);
          }

          if (manager.node) {
            try {
              ws.send(JSON.stringify({
                type: 'started',
                nodeId: manager.node.identity.nodeIdHex,
                address: '127.0.0.1',
                ghostAddress: ghostAddressFromNodeId(manager.node.identity.nodeIdHex)
              }));
            } catch (_e) {}
            return;
          }

          try {
            const startResult = await manager.start();
            broadcast({
              type: 'started',
              nodeId: startResult.nodeId,
              address: startResult.address,
              ghostAddress: ghostAddressFromNodeId(startResult.nodeId)
            });
          } catch (err) {
            const error = err as Error;
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'START_FAILED', message: error.message }));
            } catch (_e) {}
          }
          break;
        }

        case 'connect': {
          const { address, port } = msg as BridgeMessage & { address: string; port: number };
          if (!manager || !manager.node) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'NOT_STARTED', message: 'GMPNodeManager is not started' }));
            } catch (_e) {}
            return;
          }

          const res = await manager.connectToPeer(address, port);
          try {
            ws.send(JSON.stringify({ type: 'connect-result', ...res }));
          } catch (_e) {}
          break;
        }

        case 'send': {
          const { destinationNodeId, payload } = msg as BridgeMessage & { destinationNodeId: string; payload: string };
          if (!manager || !manager.node) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'NOT_STARTED', message: 'GMPNodeManager is not started' }));
            } catch (_e) {}
            return;
          }

          try {
            await manager.sendMessage(destinationNodeId, payload);
          } catch (err) {
            const error = err as Error;
            try {
              ws.send(JSON.stringify({ type: 'error', code: error.name || 'SEND_FAILED', message: error.message }));
            } catch (_e) {}
          }
          break;
        }

        case 'sendDirect': {
          const { destinationNodeId, payload } = msg as BridgeMessage & { destinationNodeId: string; payload: string };
          if (!manager || !manager.node) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'NOT_STARTED', message: 'GMPNodeManager is not started' }));
            } catch (_e) {}
            return;
          }

          try {
            await manager.sendDirect(destinationNodeId, payload);
          } catch (err) {
            const error = err as Error;
            try {
              ws.send(JSON.stringify({ type: 'error', code: error.name || 'SEND_FAILED', message: error.message }));
            } catch (_e) {}
          }
          break;
        }

        case 'getStatus': {
          if (!manager) {
            try {
              ws.send(JSON.stringify({ type: 'status', status: 'offline', peers: [] }));
            } catch (_e) {}
            return;
          }

          try {
            const status = manager.getStatus();
            ws.send(JSON.stringify({ type: 'status', ...status }));
          } catch (err) {
            const error = err as Error;
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'STATUS_FAILED', message: error.message }));
            } catch (_e) {}
          }
          break;
        }

        case 'resolve': {
          const { address } = msg as BridgeMessage & { address: string };
          if (!manager || !manager.node) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'NOT_STARTED', message: 'GMPNodeManager is not started' }));
            } catch (_e) {}
            return;
          }
          try {
            const result = manager.resolveGhostAddress(address);
            ws.send(JSON.stringify({ type: 'resolve-result', requestId: (msg as any).requestId, ...result }));
          } catch (err) {
            const error = err as Error;
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'RESOLVE_FAILED', message: error.message }));
            } catch (_e) {}
          }
          break;
        }

        case 'connectNode': {
          const { nodeId, address } = msg as BridgeMessage & { nodeId?: string; address?: string };
          if (!manager || !manager.node) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'NOT_STARTED', message: 'GMPNodeManager is not started' }));
            } catch (_e) {}
            return;
          }
          try {
            let result;
            if (address) {
              result = await manager.connectByGhostAddress(address);
            } else if (nodeId) {
              result = await manager.connectByNodeId(nodeId);
            } else {
              result = { connected: false, transport: 'no-target' };
            }
            ws.send(JSON.stringify({ type: 'connect-result', requestId: (msg as any).requestId, ...result }));
          } catch (err) {
            const error = err as Error;
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'CONNECT_FAILED', message: error.message }));
            } catch (_e) {}
          }
          break;
        }

        default: {
          try {
            ws.send(JSON.stringify({ type: 'error', code: 'UNKNOWN_COMMAND', message: `Unknown command type: ${msg.type}` }));
          } catch (_e) {}
        }
      }
    });

    ws.on('close', () => {
      clients.delete(client);
    });

    ws.on('error', () => {
      clients.delete(client);
    });

    ws.on('pong', () => {
      client.isAlive = true;
    });
  });

  const schemes = tlsAvailable ? 'ws:// and wss://' : 'ws:// only';
  logger.info('bridge', 'server-started',
    `GMP bridge listening on ${bridgeHost}:${bridgePort} (${schemes}, scheme auto-detected per connection)`,
    { tls: tlsAvailable, certPath: certPathUsed });
  return { wss, manager };
}

const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === process.argv[1] ||
  process.argv[1].endsWith('gmp-bridge.js')
);

if (isMain) {
  const port = process.env.GMP_BRIDGE_PORT ? parseInt(process.env.GMP_BRIDGE_PORT) : DEFAULT_BRIDGE_PORT;
  const host = process.env.GMP_BRIDGE_HOST || DEFAULT_BRIDGE_HOST;
  startBridge(null, port, host);
}