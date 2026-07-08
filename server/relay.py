#!/usr/bin/env python3
import asyncio
import json
import logging
import os
import ssl
import sys
import time
from http import HTTPStatus
import websockets

# ── Configuration ──

# Configure basic logging to stdout. Default to INFO level.
# CRITICAL: We only log metadata, connection counts, and errors. We NEVER log message contents or SDPs.
logging.basicConfig(
    level=logging.INFO,
    format='{"ts": "%(asctime)s", "level": "%(levelname)s", "msg": "%(message)s"}',
    handlers=[logging.StreamHandler(sys.stdout)]
)

RELAY_PORT = int(os.environ.get("RELAY_PORT", 3001))
ALLOWED_ORIGINS_ENV = os.environ.get("ALLOWED_ORIGINS", "*")

# ── TLS ──
# When the app is served over HTTPS, browsers block plain ws:// / http:// to a
# LAN IP as mixed content, so the relay must speak wss:// (TLS). Point RELAY_CERT
# / RELAY_KEY at a cert whose SAN covers the address the client uses; by default
# we reuse the project's mkcert cert one directory up. If the files are absent
# the relay falls back to plain ws:// (fine for localhost-only use).
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RELAY_CERT = os.environ.get("RELAY_CERT", os.path.join(_SCRIPT_DIR, "..", "cert.pem"))
RELAY_KEY = os.environ.get("RELAY_KEY", os.path.join(_SCRIPT_DIR, "..", "key.pem"))

def build_ssl_context():
    if os.path.exists(RELAY_CERT) and os.path.exists(RELAY_KEY):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(RELAY_CERT, RELAY_KEY)
        return ctx
    return None

# Parse origins
ALLOWED_ORIGINS = [o.strip() for o in ALLOWED_ORIGINS_ENV.split(",") if o.strip()]

# Warn the operator if origins are completely open in a production-like scenario
if "*" in ALLOWED_ORIGINS:
    logging.warning("Origin check is set to '*' (wildcard). This is insecure for production! Restrict ALLOWED_ORIGINS.")

# ── Room Management ──

# Global state to keep track of active rooms.
# Format: { room_code: { "peers": [websocket1, websocket2], "last_active": timestamp } }
# Room codes are 6-character alphanumeric strings generated client-side.
# No persistent storage is used — all data resides in volatile RAM.
rooms = {}

# Keep track of active connection count
active_connection_count = 0

def check_origin(origin):
    """
    Verifies if the client origin is permitted to connect based on environment settings.
    """
    if "*" in ALLOWED_ORIGINS:
        return True
    if not origin:
        return False
    return origin in ALLOWED_ORIGINS

def cleanup_room_peer(websocket, room_code):
    """
    Removes a peer's websocket connection from the specified room and cleans up
    the room if it becomes empty.
    """
    if room_code in rooms:
        room = rooms[room_code]
        if websocket in room["peers"]:
            room["peers"].remove(websocket)
            logging.info(f"Peer disconnected from room {room_code}. Remaining peers: {len(room['peers'])}")
        
        # If no peers remain, destroy the room immediately
        if not room["peers"]:
            del rooms[room_code]
            logging.info(f"Room {room_code} destroyed: no peers remaining")

# ── Rate Limiting ──

# Rate Limit tracking: { websocket_connection: [message_timestamps] }
rate_limit_records = {}
MAX_MSG_PER_MINUTE = 60

def is_rate_limited(websocket):
    """
    Checks if a connection has sent more than 60 messages in the last minute.
    """
    now = time.time()
    if websocket not in rate_limit_records:
        rate_limit_records[websocket] = []
    
    timestamps = rate_limit_records[websocket]
    # Keep only timestamps within the last 60 seconds
    timestamps = [t for t in timestamps if now - t < 60]
    rate_limit_records[websocket] = timestamps

    if len(timestamps) >= MAX_MSG_PER_MINUTE:
        return True
    
    timestamps.append(now)
    return False

# ── Message Handlers ──

async def handle_join_room(websocket, data, current_room_state):
    """
    Processes the request of a client to join a specific room.
    """
    room_code = data.get("roomCode")
    if not room_code or not isinstance(room_code, str) or len(room_code) != 6 or not room_code.isalnum():
        await websocket.send(json.dumps({"type": "error", "message": "Invalid room code format (must be 6 alphanumeric chars)"}))
        return None

    # Leave current room if already in one
    if current_room_state["room_code"]:
        cleanup_room_peer(websocket, current_room_state["room_code"])

    # Locate or create the room
    if room_code not in rooms:
        rooms[room_code] = {
            "peers": [],
            "last_active": time.time()
        }
        logging.info(f"Room {room_code} created (current room count: {len(rooms)})")

    room = rooms[room_code]

    # Enforce maximum of 2 peers per room (1-to-1 communication)
    if len(room["peers"]) >= 2:
        await websocket.send(json.dumps({"type": "error", "message": "Room is full (max 2 peers)"}))
        return None

    room["peers"].append(websocket)
    room["last_active"] = time.time()
    current_room_state["room_code"] = room_code

    logging.info(f"Peer joined room {room_code}. Peers count: {len(room['peers'])}. Total rooms: {len(rooms)}")

    # Broadcast "peer-joined" to the other peer in the room
    for peer in room["peers"]:
        if peer != websocket:
            try:
                await peer.send(json.dumps({"type": "peer-joined", "roomCode": room_code}))
            except Exception as e:
                logging.error(f"Error broadcasting peer-joined: {e}")

    # Respond with current occupants (peer-list)
    occupants_count = len(room["peers"])
    await websocket.send(json.dumps({
        "type": "peer-list",
        "roomCode": room_code,
        "occupants": occupants_count
    }))

    return room_code

async def handle_leave_room(websocket, data, current_room_state):
    """
    Removes the client connection from their current room.
    """
    room_code = data.get("roomCode")
    if room_code and rooms.get(room_code):
        cleanup_room_peer(websocket, room_code)
    current_room_state["room_code"] = None
    await websocket.send(json.dumps({"type": "left-room", "roomCode": room_code}))

async def handle_relay_message(websocket, data, msg_type):
    """
    Relays WebRTC signals (offer, answer, ice-candidate) to the opposite peer in the room.
    This relay NEVER stores, inspects, or logs the contents of these signals.
    It simply forwards them directly as untrusted payloads.
    """
    room_code = data.get("roomCode")
    if not room_code or room_code not in rooms:
        await websocket.send(json.dumps({"type": "error", "message": "Not in an active room"}))
        return

    room = rooms[room_code]
    room["last_active"] = time.time()

    # Find the other peer in the 1-to-1 room
    target_peer = None
    for peer in room["peers"]:
        if peer != websocket:
            target_peer = peer
            break

    if not target_peer:
        # No other peer in room, drop message. 
        # (This is normal if the other peer disconnected during candidate gathering)
        return

    # Forward the message EXACTLY as it is to the target peer.
    # No logs contain data/SDP/fingerprints/candidate values.
    try:
        await target_peer.send(json.dumps(data))
    except Exception as e:
        logging.error(f"Failed to relay message of type {msg_type}: {e}")

async def handle_connection(websocket, path=None):
    """
    Main WebSocket connection lifetime handler.
    """
    global active_connection_count
    active_connection_count += 1
    logging.info(f"New connection established. Active connections: {active_connection_count}")

    # Origin checking
    headers = getattr(websocket, "request_headers", None)
    if headers is None:
        request = getattr(websocket, "request", None)
        if request is not None:
            headers = getattr(request, "headers", None)
            
    origin = headers.get("Origin") if headers else None
    if not check_origin(origin):
        logging.warning(f"Rejected connection from unauthorized origin: {origin}")
        await websocket.close(code=4003, reason="Origin not allowed")
        active_connection_count -= 1
        return

    # Connection tracking state
    current_room_state = {"room_code": None}
    joined_room = False

    try:
        # Handshake Timeout: Must join a room within 10 seconds of connecting, or connection is severed.
        try:
            raw_message = await asyncio.wait_for(websocket.recv(), timeout=10.0)
            data = json.loads(raw_message)
            if data.get("type") == "join-room":
                room_code = await handle_join_room(websocket, data, current_room_state)
                if room_code:
                    joined_room = True
                else:
                    await websocket.close(code=4001, reason="Failed to join room")
                    return
            else:
                await websocket.close(code=4001, reason="First message must be join-room")
                return
        except asyncio.TimeoutError:
            logging.warning("Connection timed out waiting for handshake (join-room)")
            await websocket.close(code=4001, reason="Handshake timeout")
            return
        except (json.JSONDecodeError, TypeError, KeyError) as e:
            logging.warning(f"Invalid handshake format: {e}")
            await websocket.close(code=4001, reason="Invalid handshake format")
            return

        # Main message loop
        async for raw_message in websocket:
            # Rate limiting check
            if is_rate_limited(websocket):
                await websocket.send(json.dumps({"type": "error", "message": "Rate limit exceeded (max 60 msgs/min)"}))
                logging.warning("Rate limit exceeded for connection")
                continue

            try:
                data = json.loads(raw_message)
            except json.JSONDecodeError:
                await websocket.send(json.dumps({"type": "error", "message": "Invalid JSON"}))
                continue

            msg_type = data.get("type")
            if not msg_type:
                await websocket.send(json.dumps({"type": "error", "message": "Missing type field"}))
                continue

            if msg_type == "join-room":
                await handle_join_room(websocket, data, current_room_state)
            elif msg_type == "leave-room":
                await handle_leave_room(websocket, data, current_room_state)
            elif msg_type == "peer-list":
                room_code = current_room_state["room_code"]
                if room_code and room_code in rooms:
                    await websocket.send(json.dumps({
                        "type": "peer-list",
                        "roomCode": room_code,
                        "occupants": len(rooms[room_code]["peers"])
                    }))
                else:
                    await websocket.send(json.dumps({"type": "error", "message": "Not in a room"}))
            elif msg_type in ("offer", "answer", "ice-candidate"):
                await handle_relay_message(websocket, data, msg_type)
            else:
                await websocket.send(json.dumps({"type": "error", "message": f"Unsupported message type: {msg_type}"}))

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        logging.error(f"Exception in connection handler: {e}")
    finally:
        # Cleanup connection state on disconnect
        if current_room_state["room_code"]:
            cleanup_room_peer(websocket, current_room_state["room_code"])
        
        if websocket in rate_limit_records:
            del rate_limit_records[websocket]
            
        active_connection_count -= 1
        logging.info(f"Connection closed. Active connections: {active_connection_count}")

# ── Server Startup ──

def health_check(connection, request):
    """
    Answer plain HTTP GET /health with a small JSON body so the web client can
    probe relay availability before attempting a WebSocket upgrade. Returning a
    Response short-circuits the handshake for this request; returning None lets
    the normal WebSocket upgrade proceed. A permissive CORS header is included
    because the probe is cross-origin (page on :8443, relay on :3001) and the
    browser must be allowed to read the response. No payloads are logged here.
    """
    path = request.path.split("?", 1)[0]
    if path == "/health":
        response = connection.respond(HTTPStatus.OK, '{"status":"ok"}')
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response
    return None

async def expiration_cleanup_loop():
    """
    Background worker that runs every 30 seconds to clean up inactive rooms
    (no activity for > 10 minutes).
    """
    while True:
        await asyncio.sleep(30)
        now = time.time()
        expired_rooms = []
        for room_code, room in list(rooms.items()):
            # A room is expired if it has been inactive for 10 minutes (600 seconds)
            if now - room["last_active"] > 600:
                expired_rooms.append(room_code)
        
        for room_code in expired_rooms:
            room = rooms.get(room_code)
            if room:
                logging.info(f"Cleaning up expired inactive room: {room_code}")
                # Close any remaining sockets in the expired room
                for peer_socket in list(room["peers"]):
                    try:
                        await peer_socket.close(code=4002, reason="Room expired due to inactivity")
                    except Exception:
                        pass
                if room_code in rooms:
                    del rooms[room_code]

async def main():
    ssl_context = build_ssl_context()
    scheme = "wss" if ssl_context else "ws"

    # Print welcome block
    logging.info(f"Starting GhostLink WebSocket Signaling Relay on {scheme}://0.0.0.0:{RELAY_PORT} ...")
    logging.info(f"Allowed Origins: {ALLOWED_ORIGINS_ENV}")
    if ssl_context:
        logging.info(f"TLS enabled using cert: {os.path.abspath(RELAY_CERT)}")
    else:
        logging.warning("TLS disabled (cert/key not found) — serving plain ws://; browsers on HTTPS pages will block this from a LAN IP.")

    # Set max payload size to 64KB (65536 bytes) for security.
    # websockets.serve closes connection if single frame size exceeds this limit.
    async with websockets.serve(
        handle_connection,
        "0.0.0.0",
        RELAY_PORT,
        max_size=65536,
        ssl=ssl_context,
        process_request=health_check
    ):
        # Run the expiration loop concurrently
        await expiration_cleanup_loop()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Signaling relay shut down by operator.")
    except Exception as e:
        logging.critical(f"Server crashed: {e}")
        sys.exit(1)

# ─── systemd Service File Example ──────────────────────────────────────────
# [Unit]
# Description=GhostLink Signaling Relay
# After=network.target
#
# [Service]
# ExecStart=/usr/bin/python3 /home/killer/Downloads/Ghostlink/server/relay.py
# Restart=always
# Environment=RELAY_PORT=3001
# Environment=ALLOWED_ORIGINS=https://kidus1234b.github.io
#
# [Install]
# WantedBy=multi-user.target
