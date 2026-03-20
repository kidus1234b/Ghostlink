'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3001', 10);
const HEARTBEAT_INTERVAL_MS = 30000;
const HANDSHAKE_TIMEOUT_MS = 15000;
const MAX_MSG_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 200;
const MAX_ROOM_SIZE = 100;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : null; // null = allow all

// ─── State ───────────────────────────────────────────────────────────────────

/** @type {Map<string, WebSocket>} peerId -> ws */
const peers = new Map();

/** @type {Map<string, Set<string>>} roomId -> Set<peerId> */
const rooms = new Map();

/** @type {Map<string, string>} peerId -> roomId (current room) */
const peerRoom = new Map();

/** @type {Map<string, string>} peerId -> publicKey */
const peerKeys = new Map();

/** @type {WeakMap<WebSocket, string>} ws -> peerId (reverse lookup) */
const wsPeer = new WeakMap();

/** @type {WeakMap<WebSocket, { count: number, resetAt: number }>} */
const rateBuckets = new WeakMap();

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(level, msg, data) {
  const entry = { ts: new Date().toISOString(), level, msg };
  if (data) entry.data = data;
  const out = JSON.stringify(entry);
  if (level === 'error') console.error(out);
  else console.log(out);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendToPeer(peerId, data) {
  const ws = peers.get(peerId);
  if (ws) send(ws, data);
}

function broadcastToRoom(roomId, data, excludePeerId) {
  const members = rooms.get(roomId);
  if (!members) return;
  for (const pid of members) {
    if (pid !== excludePeerId) {
      sendToPeer(pid, data);
    }
  }
}

function getPeerList(roomId) {
  const members = rooms.get(roomId);
  if (!members) return [];
  const list = [];
  for (const pid of members) {
    list.push({ peerId: pid, publicKey: peerKeys.get(pid) || null });
  }
  return list;
}

function checkRateLimit(ws) {
  const now = Date.now();
  let bucket = rateBuckets.get(ws);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ws, bucket);
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT_MAX;
}

function removePeerFromRoom(peerId) {
  const roomId = peerRoom.get(peerId);
  if (!roomId) return;

  const members = rooms.get(roomId);
  if (members) {
    members.delete(peerId);

    // Notify remaining peers
    broadcastToRoom(roomId, { type: 'peer-left', peerId });

    log('info', 'peer left room', { peerId, room: roomId, remaining: members.size });

    // Clean up empty room
    if (members.size === 0) {
      rooms.delete(roomId);
      log('info', 'room destroyed (empty)', { room: roomId });
    }
  }

  peerRoom.delete(peerId);
}

function cleanupPeer(peerId) {
  removePeerFromRoom(peerId);
  peers.delete(peerId);
  peerKeys.delete(peerId);
}

// ─── HTTP Server (health endpoint + WebSocket upgrade) ───────────────────────

const httpServer = http.createServer((req, res) => {
  // CORS headers for any HTTP request
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health' && req.method === 'GET') {
    let peerCount = 0;
    for (const members of rooms.values()) peerCount += members.size;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      rooms: rooms.size,
      peers: peerCount,
      connectedSockets: peers.size,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── WebSocket Signaling Server ──────────────────────────────────────────────

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: MAX_MSG_BYTES,
  verifyClient: (info, done) => {
    if (!ALLOWED_ORIGINS) return done(true);
    const origin = info.origin || info.req.headers.origin || '';
    if (ALLOWED_ORIGINS.includes(origin)) return done(true);
    log('warn', 'rejected connection from unauthorized origin', { origin });
    done(false, 403, 'Origin not allowed');
  },
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  let peerId = null;
  let joined = false;

  // The client must send a `join` message within HANDSHAKE_TIMEOUT_MS
  const handshakeTimer = setTimeout(() => {
    if (!joined) {
      log('warn', 'handshake timeout — no join received');
      ws.close(4001, 'Handshake timeout');
    }
  }, HANDSHAKE_TIMEOUT_MS);

  // Pong handler for heartbeat
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    // Rate limiting
    if (!checkRateLimit(ws)) {
      send(ws, { type: 'error', message: 'Rate limit exceeded' });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (!msg || typeof msg.type !== 'string') {
      send(ws, { type: 'error', message: 'Missing message type' });
      return;
    }

    switch (msg.type) {
      case 'join':
        handleJoin(ws, msg, handshakeTimer);
        break;
      case 'join-room':
        handleJoinRoom(ws, msg);
        break;
      case 'leave-room':
        handleLeaveRoom(ws, msg);
        break;
      case 'peer-list':
        handlePeerList(ws, msg);
        break;
      case 'offer':
      case 'answer':
      case 'ice-candidate':
        handleSignaling(ws, msg);
        break;
      case 'relay':
        handleRelay(ws, msg);
        break;
      default:
        send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    clearTimeout(handshakeTimer);
    if (peerId) {
      log('info', 'peer disconnected', { peerId });
      cleanupPeer(peerId);
      wsPeer.delete(ws);
    }
  });

  ws.on('error', (err) => {
    log('error', 'WebSocket error', { peerId, error: err.message });
  });

  // ── Message Handlers ─────────────────────────────────────────────────────

  /**
   * join — Register a peer with their ID.
   * Client sends: { type: 'join', peerId: string }
   */
  function handleJoin(_ws, msg, timer) {
    const pid = msg.peerId;
    if (!pid || typeof pid !== 'string') {
      send(ws, { type: 'error', message: 'Missing or invalid peerId' });
      return;
    }

    // If this peerId is already connected, close the old socket
    const existing = peers.get(pid);
    if (existing && existing !== ws) {
      log('info', 'duplicate peer — closing old connection', { peerId: pid });
      existing.close(4002, 'Duplicate connection');
      cleanupPeer(pid);
    }

    clearTimeout(timer);
    joined = true;
    peerId = pid;

    peers.set(peerId, ws);
    wsPeer.set(ws, peerId);

    log('info', 'peer joined', { peerId });
    send(ws, { type: 'joined', peerId });
  }

  /**
   * join-room — Join a named room.
   * Client sends: { type: 'join-room', room: string, peerId: string, publicKey: string }
   */
  function handleJoinRoom(_ws, msg) {
    if (!joined) {
      send(ws, { type: 'error', message: 'Must join (register peerId) first' });
      return;
    }

    const { room, publicKey } = msg;
    if (!room || typeof room !== 'string') {
      send(ws, { type: 'error', message: 'Missing or invalid room' });
      return;
    }

    // Leave current room first if in one
    const currentRoomId = peerRoom.get(peerId);
    if (currentRoomId) {
      removePeerFromRoom(peerId);
    }

    // Create room if needed
    if (!rooms.has(room)) {
      rooms.set(room, new Set());
      log('info', 'room created', { room });
    }

    const members = rooms.get(room);

    // Room size check
    if (members.size >= MAX_ROOM_SIZE) {
      send(ws, { type: 'error', message: 'Room is full' });
      return;
    }

    // Store public key
    if (publicKey) {
      peerKeys.set(peerId, publicKey);
    }

    // Add peer to room
    members.add(peerId);
    peerRoom.set(peerId, room);

    log('info', 'peer joined room', { peerId, room, members: members.size });

    // Send current peer list to the joiner (excluding self)
    const peerList = getPeerList(room).filter(p => p.peerId !== peerId);
    send(ws, { type: 'peer-list', room, peers: peerList });

    // Broadcast peer-joined to other members
    broadcastToRoom(room, {
      type: 'peer-joined',
      peerId,
      publicKey: publicKey || null,
    }, peerId);
  }

  /**
   * leave-room — Leave a room.
   * Client sends: { type: 'leave-room', room: string, peerId: string }
   */
  function handleLeaveRoom(_ws, msg) {
    if (!joined) return;

    removePeerFromRoom(peerId);
    log('info', 'peer left room (explicit)', { peerId, room: msg.room });
  }

  /**
   * peer-list — Request the list of peers in a room.
   * Client sends: { type: 'peer-list', room: string }
   */
  function handlePeerList(_ws, msg) {
    if (!joined) {
      send(ws, { type: 'error', message: 'Must join first' });
      return;
    }

    const room = msg.room || peerRoom.get(peerId);
    if (!room) {
      send(ws, { type: 'error', message: 'Not in a room' });
      return;
    }

    const peerList = getPeerList(room).filter(p => p.peerId !== peerId);
    send(ws, { type: 'peer-list', room, peers: peerList });
  }

  /**
   * offer / answer / ice-candidate — Relay WebRTC signaling to a target peer.
   *
   * Client sends:
   *   offer:         { type: 'offer',         to, from, sdp, publicKey }
   *   answer:        { type: 'answer',        to, from, sdp, publicKey }
   *   ice-candidate: { type: 'ice-candidate', to, from, candidate }
   *
   * Server relays to the target peer with `to` removed (target knows it's for them).
   */
  function handleSignaling(_ws, msg) {
    if (!joined) {
      send(ws, { type: 'error', message: 'Must join first' });
      return;
    }

    // Prevent impersonation — enforce the sender is who they say they are
    if (msg.from && msg.from !== peerId) {
      send(ws, { type: 'error', message: 'Peer ID mismatch' });
      return;
    }

    const { to } = msg;
    if (!to || typeof to !== 'string') {
      send(ws, { type: 'error', message: 'Missing target peerId (to)' });
      return;
    }

    const targetWs = peers.get(to);
    if (!targetWs || targetWs.readyState !== targetWs.OPEN) {
      send(ws, { type: 'error', message: 'Target peer not connected' });
      return;
    }

    // Build relay message: include everything the client sent, ensure `from` is set
    const relay = { ...msg, from: peerId };
    // Remove `to` — the recipient knows the message is for them
    delete relay.to;

    send(targetWs, relay);
  }

  /**
   * relay — Relay an encrypted payload through the signaling server (P2P fallback).
   * Client sends: { type: 'relay', to, from, payload }
   */
  function handleRelay(_ws, msg) {
    if (!joined) {
      send(ws, { type: 'error', message: 'Must join first' });
      return;
    }

    if (msg.from && msg.from !== peerId) {
      send(ws, { type: 'error', message: 'Peer ID mismatch' });
      return;
    }

    const { to, payload } = msg;
    if (!to || typeof to !== 'string') {
      send(ws, { type: 'error', message: 'Missing target peerId (to)' });
      return;
    }

    const targetWs = peers.get(to);
    if (!targetWs || targetWs.readyState !== targetWs.OPEN) {
      send(ws, { type: 'error', message: 'Target peer not connected' });
      return;
    }

    send(targetWs, { type: 'relay', from: peerId, payload });
  }
});

// ─── Heartbeat — Ping/Pong Dead Connection Detection ────────────────────────

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      const pid = wsPeer.get(ws);
      log('info', 'terminating dead connection', { peerId: pid || 'unknown' });
      if (pid) cleanupPeer(pid);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// ─── Start ───────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  log('info', `GhostLink signaling server listening on port ${PORT}`, {
    port: PORT,
    heartbeatInterval: HEARTBEAT_INTERVAL_MS,
    maxPayload: MAX_MSG_BYTES,
    maxRoomSize: MAX_ROOM_SIZE,
  });
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function shutdown(signal) {
  log('info', `Received ${signal}, shutting down...`);

  clearInterval(heartbeatInterval);

  // Close all client connections
  wss.clients.forEach((client) => {
    client.close(1001, 'Server shutting down');
  });

  wss.close(() => {
    log('info', 'WebSocket server closed');
    httpServer.close(() => {
      log('info', 'HTTP server closed');
      process.exit(0);
    });
  });

  // Force exit after 10s
  setTimeout(() => {
    log('error', 'Forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection', { reason: String(reason) });
});

module.exports = { httpServer, wss };
