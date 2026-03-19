'use strict';

const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT_HTTP = parseInt(process.env.PORT_HTTP || '3000', 10);
const PORT_WS = parseInt(process.env.PORT_WS || '3001', 10);
const TURN_SECRET = process.env.TURN_SECRET || 'ghostlink-turn-secret-change-me';
const TURN_SERVER_URL = process.env.TURN_SERVER_URL || '';
const TURN_TTL = parseInt(process.env.TURN_TTL || '86400', 10); // 24h
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['*'];
const MAX_ROOM_SIZE = 50;
const MAX_MSG_SIZE = 64 * 1024; // 64 KB
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 100;
const HANDSHAKE_TIMEOUT = 30 * 1000; // 30 seconds
const OFFLINE_QUEUE_MAX = 1000;
const OFFLINE_MSG_TTL = 24 * 60 * 60 * 1000; // 24 hours
const ROOM_CLEANUP_DELAY = 5 * 60 * 1000; // 5 minutes

const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];

// ─── State ───────────────────────────────────────────────────────────────────

// rooms: Map<roomId, Map<peerId, { ws, publicKey, name, status }>>
const rooms = new Map();
// peerToRoom: Map<peerId, roomId>
const peerToRoom = new Map();
// offlineQueue: Map<peerId, Array<{ from, encrypted, timestamp }>>
const offlineQueue = new Map();
// roomCleanupTimers: Map<roomId, timeout>
const roomCleanupTimers = new Map();
// rateLimiter: WeakMap<ws, { count, resetAt }>
const rateLimiter = new WeakMap();

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(level, msg, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(data && { data }),
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isValidRoomId(room) {
  return typeof room === 'string' && /^GL-[A-Za-z0-9]{8,}/.test(room);
}

function send(ws, data) {
  if (ws.readyState === 1) { // WebSocket.OPEN
    ws.send(JSON.stringify(data));
  }
}

function broadcastToRoom(roomId, msg, excludePeerId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [pid, peer] of room) {
    if (pid !== excludePeerId) {
      send(peer.ws, msg);
    }
  }
}

function getPeerList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.entries()).map(([peerId, p]) => ({
    peerId,
    publicKey: p.publicKey,
    name: p.name,
    status: p.status,
  }));
}

function checkRateLimit(ws) {
  const now = Date.now();
  let bucket = rateLimiter.get(ws);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimiter.set(ws, bucket);
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT_MAX;
}

function pruneOfflineQueue(peerId) {
  const queue = offlineQueue.get(peerId);
  if (!queue) return;
  const now = Date.now();
  const pruned = queue.filter(m => now - m.timestamp < OFFLINE_MSG_TTL);
  if (pruned.length === 0) {
    offlineQueue.delete(peerId);
  } else {
    offlineQueue.set(peerId, pruned);
  }
}

function enqueueOfflineMessage(toPeerId, fromPeerId, encrypted) {
  pruneOfflineQueue(toPeerId);
  let queue = offlineQueue.get(toPeerId);
  if (!queue) {
    queue = [];
    offlineQueue.set(toPeerId, queue);
  }
  if (queue.length >= OFFLINE_QUEUE_MAX) {
    queue.shift(); // drop oldest
  }
  queue.push({ from: fromPeerId, encrypted, timestamp: Date.now() });
}

function deliverOfflineMessages(peerId, ws) {
  pruneOfflineQueue(peerId);
  const queue = offlineQueue.get(peerId);
  if (!queue || queue.length === 0) return;
  log('info', 'delivering offline messages', { peerId, count: queue.length });
  for (const msg of queue) {
    send(ws, {
      type: 'relay-message',
      from: msg.from,
      encrypted: msg.encrypted,
      queued: true,
      timestamp: msg.timestamp,
    });
  }
  offlineQueue.delete(peerId);
}

function scheduleRoomCleanup(roomId) {
  if (roomCleanupTimers.has(roomId)) return;
  const timer = setTimeout(() => {
    roomCleanupTimers.delete(roomId);
    const room = rooms.get(roomId);
    if (room && room.size === 0) {
      rooms.delete(roomId);
      log('info', 'room cleaned up', { roomId });
    }
  }, ROOM_CLEANUP_DELAY);
  roomCleanupTimers.set(roomId, timer);
}

function cancelRoomCleanup(roomId) {
  const timer = roomCleanupTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    roomCleanupTimers.delete(roomId);
  }
}

function findPeerWs(peerId) {
  const roomId = peerToRoom.get(peerId);
  if (!roomId) return null;
  const room = rooms.get(roomId);
  if (!room) return null;
  const peer = room.get(peerId);
  return peer ? peer.ws : null;
}

// ─── TURN Credential Generation ─────────────────────────────────────────────

function generateTurnCredentials() {
  const timestamp = Math.floor(Date.now() / 1000) + TURN_TTL;
  const username = `${timestamp}:ghostlink-${uuidv4().slice(0, 8)}`;
  const hmac = crypto.createHmac('sha1', TURN_SECRET);
  hmac.update(username);
  const credential = hmac.digest('base64');

  const urls = [...STUN_SERVERS.map(s => s)];
  if (TURN_SERVER_URL) {
    urls.push(TURN_SERVER_URL);
    urls.push(TURN_SERVER_URL.replace(/^turn:/, 'turns:'));
  }

  return { urls, username, credential, ttl: TURN_TTL };
}

// ─── Express HTTP Server ─────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  const roomCount = rooms.size;
  let peerCount = 0;
  for (const room of rooms.values()) {
    peerCount += room.size;
  }
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: roomCount,
    peers: peerCount,
    timestamp: new Date().toISOString(),
  });
});

app.post('/turn-credentials', (_req, res) => {
  // Validate TURN secret exists before generating credentials
  if (!TURN_SECRET || TURN_SECRET === 'ghostlink-turn-secret-change-me') {
    log('error', 'TURN secret not configured');
    return res.status(503).json({ error: 'TURN credentials not configured' });
  }
  try {
    const credentials = generateTurnCredentials();
    res.json(credentials);
  } catch (err) {
    log('error', 'TURN credential generation failed', { error: err.message });
    res.status(500).json({ error: 'Failed to generate credentials' });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Express error-handling middleware
app.use((err, req, res, next) => {
  console.error('Express error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const httpServer = http.createServer(app);

// ─── WebSocket Signaling Server ──────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT_WS });

wss.on('listening', () => {
  log('info', `WebSocket signaling server listening on port ${PORT_WS}`);
});

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS[0] !== '*' && !ALLOWED_ORIGINS.includes(origin)) {
    log('warn', 'rejected connection from unauthorized origin', { origin });
    ws.close(4003, 'Origin not allowed');
    return;
  }

  let peerId = null;
  let currentRoom = null;
  let joined = false;

  // Handshake timeout — must join a room within 30s
  const handshakeTimer = setTimeout(() => {
    if (!joined) {
      log('warn', 'handshake timeout, closing connection');
      ws.close(4001, 'Handshake timeout');
    }
  }, HANDSHAKE_TIMEOUT);

  ws.on('message', (raw) => {
    // Size check
    if (raw.length > MAX_MSG_SIZE) {
      send(ws, { type: 'error', message: 'Message too large' });
      return;
    }

    // Rate limit
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
      case 'offer':
      case 'answer':
      case 'ice-candidate':
        handleSignaling(ws, msg);
        break;
      case 'presence':
        handlePresence(ws, msg);
        break;
      case 'relay-message':
        handleRelayMessage(ws, msg);
        break;
      default:
        send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    clearTimeout(handshakeTimer);
    handleDisconnect();
  });

  ws.on('error', (err) => {
    log('error', 'WebSocket error', { peerId, error: err.message });
    clearTimeout(handshakeTimer);
    handleDisconnect();
  });

  // ── Message Handlers ─────────────────────────────────────────────────────

  function handleJoin(_ws, msg, timer) {
    if (joined) {
      send(ws, { type: 'error', message: 'Already joined a room' });
      return;
    }

    const { room, peerId: pid, publicKey, name } = msg;

    if (!isValidRoomId(room)) {
      send(ws, { type: 'error', message: 'Invalid room ID format (expected GL-XXXXXXXX-...)' });
      return;
    }
    if (!pid || typeof pid !== 'string') {
      send(ws, { type: 'error', message: 'Missing or invalid peerId' });
      return;
    }
    if (!publicKey || typeof publicKey !== 'string') {
      send(ws, { type: 'error', message: 'Missing or invalid publicKey' });
      return;
    }

    // Check room size limit
    let room_ = rooms.get(room);
    if (room_ && room_.size >= MAX_ROOM_SIZE) {
      send(ws, { type: 'error', message: 'Room is full' });
      return;
    }

    clearTimeout(timer);
    joined = true;
    peerId = pid;
    currentRoom = room;

    // Create room if needed
    if (!room_) {
      room_ = new Map();
      rooms.set(room, room_);
    }
    cancelRoomCleanup(room);

    // If peer was already connected (duplicate), close old connection
    const existing = room_.get(peerId);
    if (existing && existing.ws !== ws) {
      existing.ws.close(4002, 'Duplicate connection');
    }

    // Register peer
    room_.set(peerId, {
      ws,
      publicKey,
      name: name || 'Anonymous',
      status: 'online',
    });
    peerToRoom.set(peerId, room);

    log('info', 'peer joined room', { peerId, room, name: name || 'Anonymous' });

    // Send current peer list to the joiner
    send(ws, {
      type: 'room-info',
      room,
      peers: getPeerList(room).filter(p => p.peerId !== peerId),
    });

    // Broadcast peer-joined to others
    broadcastToRoom(room, {
      type: 'peer-joined',
      peerId,
      publicKey,
      name: name || 'Anonymous',
    }, peerId);

    // Deliver any queued offline messages
    deliverOfflineMessages(peerId, ws);
  }

  function handleSignaling(_ws, msg) {
    if (!joined) {
      send(ws, { type: 'error', message: 'Must join a room first' });
      return;
    }

    // Peer ID validation — prevent impersonation
    if (msg.from && msg.from !== peerId) {
      send(ws, { type: 'error', message: 'Peer ID mismatch — impersonation rejected' });
      return;
    }

    const { to, type } = msg;
    if (!to || typeof to !== 'string') {
      send(ws, { type: 'error', message: 'Missing target peerId' });
      return;
    }

    // Room access control — target must be in the same room
    const targetRoom = peerToRoom.get(to);
    if (targetRoom !== currentRoom) {
      send(ws, { type: 'error', message: 'Target peer not in your room' });
      return;
    }

    const targetWs = findPeerWs(to);
    if (!targetWs) {
      send(ws, { type: 'error', message: 'Target peer not found' });
      return;
    }

    // Relay the message with sender info
    const relay = { ...msg, from: peerId };
    delete relay.to;
    send(targetWs, relay);
  }

  function handlePresence(_ws, msg) {
    if (!joined) return;

    const status = msg.status;
    if (!['online', 'offline', 'typing'].includes(status)) {
      send(ws, { type: 'error', message: 'Invalid presence status' });
      return;
    }

    const room = rooms.get(currentRoom);
    if (room) {
      const peer = room.get(peerId);
      if (peer) {
        peer.status = status;
      }
    }

    broadcastToRoom(currentRoom, {
      type: 'presence',
      peerId,
      status,
    }, peerId);
  }

  function handleRelayMessage(_ws, msg) {
    if (!joined) {
      send(ws, { type: 'error', message: 'Must join a room first' });
      return;
    }

    // Peer ID validation — prevent impersonation
    if (msg.from && msg.from !== peerId) {
      send(ws, { type: 'error', message: 'Peer ID mismatch — impersonation rejected' });
      return;
    }

    const { to, encrypted } = msg;
    if (!to || typeof to !== 'string') {
      send(ws, { type: 'error', message: 'Missing target peerId' });
      return;
    }
    if (!encrypted || typeof encrypted !== 'object') {
      send(ws, { type: 'error', message: 'Missing encrypted payload' });
      return;
    }

    // Room access control — only relay to peers in the same room (or queue for offline peers who were in the room)
    const targetRoom = peerToRoom.get(to);
    if (targetRoom && targetRoom !== currentRoom) {
      send(ws, { type: 'error', message: 'Target peer not in your room' });
      return;
    }

    const targetWs = findPeerWs(to);
    if (targetWs) {
      // Peer is online — relay directly
      send(targetWs, {
        type: 'relay-message',
        from: peerId,
        encrypted,
        timestamp: Date.now(),
      });
    } else {
      // Peer is offline — queue it
      enqueueOfflineMessage(to, peerId, encrypted);
      send(ws, { type: 'message-queued', to, timestamp: Date.now() });
    }
  }

  function handleDisconnect() {
    if (!joined || !peerId || !currentRoom) return;
    joined = false; // prevent double handling

    const room = rooms.get(currentRoom);
    if (room) {
      room.delete(peerId);

      // Broadcast departure
      broadcastToRoom(currentRoom, {
        type: 'peer-left',
        peerId,
      });

      log('info', 'peer left room', { peerId, room: currentRoom, remaining: room.size });

      // Schedule room cleanup if empty
      if (room.size === 0) {
        scheduleRoomCleanup(currentRoom);
      }
    }

    peerToRoom.delete(peerId);
  }
});

// ─── Periodic Cleanup ────────────────────────────────────────────────────────

// Prune expired offline messages every 10 minutes
setInterval(() => {
  let pruned = 0;
  for (const peerId of offlineQueue.keys()) {
    const before = (offlineQueue.get(peerId) || []).length;
    pruneOfflineQueue(peerId);
    const after = (offlineQueue.get(peerId) || []).length;
    pruned += before - after;
  }
  if (pruned > 0) {
    log('info', 'pruned expired offline messages', { count: pruned });
  }
}, 10 * 60 * 1000);

// ─── Start ───────────────────────────────────────────────────────────────────

httpServer.listen(PORT_HTTP, () => {
  log('info', `HTTP server listening on port ${PORT_HTTP}`);
  log('info', 'GhostLink signaling server started', {
    httpPort: PORT_HTTP,
    wsPort: PORT_WS,
    turnConfigured: !!TURN_SERVER_URL,
    allowedOrigins: ALLOWED_ORIGINS,
  });
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function shutdown(signal) {
  log('info', `Received ${signal}, shutting down gracefully...`);

  // Close all WebSocket connections
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

  // Force exit after 10 seconds
  setTimeout(() => {
    log('error', 'Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
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

module.exports = { app, wss, httpServer };
