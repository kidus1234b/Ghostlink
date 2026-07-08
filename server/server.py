import socket
import ssl
import threading
import hashlib
import base64
import struct
import json
import os
import sys
import time

# --- Configuration ---
PORT = int(os.environ.get("RELAY_PORT", os.environ.get("PORT", 3001)))
WEB_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# --- TLS ---
# When the web app is served over HTTPS, browsers block plain ws:// / http:// to
# a LAN IP as mixed content, so this server must speak wss:// (TLS). Point
# RELAY_CERT / RELAY_KEY at a cert whose SAN covers the address clients use; by
# default we reuse the project's mkcert cert in WEB_ROOT. If the files are absent
# the server falls back to plain http/ws (fine for localhost-only use).
RELAY_CERT = os.environ.get("RELAY_CERT", os.path.join(WEB_ROOT, "cert.pem"))
RELAY_KEY = os.environ.get("RELAY_KEY", os.path.join(WEB_ROOT, "key.pem"))

def build_ssl_context():
    if os.path.exists(RELAY_CERT) and os.path.exists(RELAY_KEY):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(RELAY_CERT, RELAY_KEY)
        return ctx
    return None

# Set in main(); each connection thread wraps its socket with this if present.
SSL_CONTEXT = None

# --- MIME Types ---
MIME_TYPES = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}

# --- State ---
peers_lock = threading.Lock()
peers = {}        # peer_id -> socket (or helper wrapper)
rooms = {}        # room_id -> set(peer_id)
peer_room = {}    # peer_id -> room_id
peer_keys = {}    # peer_id -> public_key
ws_peer = {}      # socket -> peer_id
start_time = time.time()

# --- Helper to send WebSocket Text Frame ---
def send_ws_message(sock, data):
    try:
        payload = json.dumps(data).encode('utf-8')
        payload_len = len(payload)
        
        header = bytearray()
        header.append(0x81) # fin=1, opcode=1 (text)
        
        if payload_len < 126:
            header.append(payload_len)
        elif payload_len < 65536:
            header.append(126)
            header.extend(struct.pack('!H', payload_len))
        else:
            header.append(127)
            header.extend(struct.pack('!Q', payload_len))
            
        sock.sendall(header + payload)
        return True
    except Exception:
        return False

# --- Helper to read WebSocket Frame ---
def recv_ws_frame(sock):
    header = sock.recv(2)
    if not header or len(header) < 2:
        return None, None
        
    fin = (header[0] & 0x80) != 0
    opcode = header[0] & 0x0f
    masked = (header[1] & 0x80) != 0
    payload_len = header[1] & 0x7f
    
    if payload_len == 126:
        ext_len = sock.recv(2)
        if len(ext_len) < 2:
            return None, None
        payload_len = struct.unpack('!H', ext_len)[0]
    elif payload_len == 127:
        ext_len = sock.recv(8)
        if len(ext_len) < 8:
            return None, None
        payload_len = struct.unpack('!Q', ext_len)[0]
        
    mask_key = None
    if masked:
        mask_key = sock.recv(4)
        if len(mask_key) < 4:
            return None, None
            
    payload = bytearray()
    while len(payload) < payload_len:
        chunk = sock.recv(payload_len - len(payload))
        if not chunk:
            break
        payload.extend(chunk)
        
    if len(payload) < payload_len:
        return None, None
        
    if masked:
        unmasked = bytearray(payload_len)
        for i in range(payload_len):
            unmasked[i] = payload[i] ^ mask_key[i % 4]
        payload = unmasked
        
    return opcode, payload

def cleanup_peer(peer_id):
    with peers_lock:
        if peer_id in peer_room:
            room_id = peer_room[peer_id]
            if room_id in rooms:
                rooms[room_id].discard(peer_id)
                # Broadcast peer-left
                for pid in list(rooms[room_id]):
                    if pid in peers:
                        send_ws_message(peers[pid], {"type": "peer-left", "peerId": peer_id})
                if not rooms[room_id]:
                    del rooms[room_id]
            del peer_room[peer_id]
        if peer_id in peers:
            try:
                peers[peer_id].close()
            except:
                pass
            del peers[peer_id]
        if peer_id in peer_keys:
            del peer_keys[peer_id]

# --- Connection Handler ---
def handle_client(sock, addr):
    try:
        # Upgrade to TLS if configured. Done here (in the per-connection thread)
        # rather than in the accept loop so a slow/failed handshake can't stall
        # new connections. A plain-HTTP client hitting the TLS port fails here.
        if SSL_CONTEXT is not None:
            try:
                sock = SSL_CONTEXT.wrap_socket(sock, server_side=True)
            except (ssl.SSLError, OSError):
                try:
                    sock.close()
                except Exception:
                    pass
                return

        # Read HTTP request header
        request_data = bytearray()
        while b'\r\n\r\n' not in request_data:
            chunk = sock.recv(1024)
            if not chunk:
                break
            request_data.extend(chunk)
            if len(request_data) > 8192:
                break
                
        if b'\r\n\r\n' not in request_data:
            sock.close()
            return
            
        header_part, _ = request_data.split(b'\r\n\r\n', 1)
        lines = header_part.decode('utf-8', errors='ignore').split('\r\n')
        if not lines or not lines[0]:
            sock.close()
            return
            
        req_line = lines[0].split()
        if len(req_line) < 2:
            sock.close()
            return
            
        method, path_url = req_line[0], req_line[1]
        
        # Parse headers
        headers = {}
        for line in lines[1:]:
            if ':' in line:
                k, v = line.split(':', 1)
                headers[k.strip().lower()] = v.strip()
                
        # --- Check if it is a WebSocket Upgrade Request ---
        if headers.get('upgrade', '').lower() == 'websocket' and 'sec-websocket-key' in headers:
            # WebSocket Handshake
            ws_key = headers['sec-websocket-key']
            accept_key = base64.b64encode(hashlib.sha1((ws_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode('utf-8')).digest()).decode('utf-8')
            
            response = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Accept: {}\r\n\r\n"
            ).format(accept_key)
            sock.sendall(response.encode('utf-8'))
            
            # Start WebSocket Loop
            peer_id = None
            joined = False
            sock.settimeout(15.0)
            
            while True:
                try:
                    opcode, payload = recv_ws_frame(sock)
                except socket.timeout:
                    if not joined:
                        break
                    # Keepalive ping
                    sock.sendall(b'\x89\x00')
                    continue
                except Exception:
                    break
                    
                if opcode is None:
                    break
                    
                if opcode == 8:
                    break
                elif opcode == 9:
                    sock.sendall(b'\x8a\x00')
                    continue
                elif opcode == 10:
                    continue
                elif opcode == 1:
                    sock.settimeout(None)
                    try:
                        decoded_payload = payload.decode('utf-8')
                    except Exception as e:
                        print(f"[WS ERROR] Failed to decode payload as UTF-8: {e}")
                        send_ws_message(sock, {"type": "error", "message": "Invalid UTF-8"})
                        continue

                    if decoded_payload == '__ping__':
                        # Send __pong__ raw text frame back to the client
                        try:
                            pong_header = bytearray()
                            pong_header.append(0x81) # fin=1, opcode=1 (text)
                            pong_body = '__pong__'.encode('utf-8')
                            pong_len = len(pong_body)
                            pong_header.append(pong_len)
                            sock.sendall(pong_header + pong_body)
                        except Exception as e:
                            print(f"[WS ERROR] Failed to send __pong__: {e}")
                        continue

                    try:
                        msg = json.loads(decoded_payload)
                    except Exception as e:
                        print(f"[WS ERROR] json.loads failed: {e}. Raw payload was: {decoded_payload!r}")
                        send_ws_message(sock, {"type": "error", "message": f"Invalid JSON: {e}"})
                        continue
                        
                    msg_type = msg.get('type')
                    if not msg_type:
                        send_ws_message(sock, {"type": "error", "message": "Missing type"})
                        continue
                        
                    if msg_type == 'join':
                        pid = msg.get('peerId')
                        if not pid:
                            send_ws_message(sock, {"type": "error", "message": "Missing peerId"})
                            continue
                        with peers_lock:
                            if pid in peers and peers[pid] != sock:
                                try:
                                    peers[pid].close()
                                except:
                                    pass
                            peers[pid] = sock
                            peer_id = pid
                            joined = True
                        send_ws_message(sock, {"type": "joined", "peerId": peer_id})
                        
                    elif msg_type == 'join-room':
                        if not joined:
                            send_ws_message(sock, {"type": "error", "message": "Must join first"})
                            continue
                        room = msg.get('room')
                        pub_key = msg.get('publicKey')
                        if not room:
                            send_ws_message(sock, {"type": "error", "message": "Missing room"})
                            continue
                            
                        # Leave old room
                        if peer_id in peer_room:
                            cleanup_peer(peer_id)
                            with peers_lock:
                                peers[peer_id] = sock
                                
                        with peers_lock:
                            peer_room[peer_id] = room
                            if room not in rooms:
                                rooms[room] = set()
                            rooms[room].add(peer_id)
                            if pub_key:
                                peer_keys[peer_id] = pub_key
                                
                            list_peers = []
                            for pid in rooms[room]:
                                if pid != peer_id:
                                    list_peers.append({"peerId": pid, "publicKey": peer_keys.get(pid)})
                                    
                            send_ws_message(sock, {"type": "peer-list", "room": room, "peers": list_peers})
                            
                            for pid in list(rooms[room]):
                                if pid != peer_id and pid in peers:
                                    send_ws_message(peers[pid], {"type": "peer-joined", "peerId": peer_id, "publicKey": pub_key})
                        
                    elif msg_type == 'leave-room':
                        if joined and peer_id:
                            cleanup_peer(peer_id)
                            with peers_lock:
                                peers[peer_id] = sock
                            
                    elif msg_type == 'peer-list':
                        if not joined:
                            send_ws_message(sock, {"type": "error", "message": "Must join first"})
                            continue
                        room = msg.get('room') or peer_room.get(peer_id)
                        if not room:
                            send_ws_message(sock, {"type": "error", "message": "Not in a room"})
                            continue
                        with peers_lock:
                            list_peers = []
                            if room in rooms:
                                for pid in rooms[room]:
                                    if pid != peer_id:
                                        list_peers.append({"peerId": pid, "publicKey": peer_keys.get(pid)})
                            send_ws_message(sock, {"type": "peer-list", "room": room, "peers": list_peers})
                            
                    elif msg_type in ('offer', 'answer', 'ice-candidate'):
                        if not joined:
                            send_ws_message(sock, {"type": "error", "message": "Must join first"})
                            continue
                        to_pid = msg.get('to')
                        if not to_pid:
                            send_ws_message(sock, {"type": "error", "message": "Missing to peer"})
                            continue
                        relay_msg = dict(msg)
                        relay_msg['from'] = peer_id
                        if 'to' in relay_msg:
                            del relay_msg['to']
                        
                        target_sock = None
                        with peers_lock:
                            target_sock = peers.get(to_pid)
                        if target_sock:
                            send_ws_message(target_sock, relay_msg)
                            
                    elif msg_type == 'relay':
                        if not joined:
                            send_ws_message(sock, {"type": "error", "message": "Must join first"})
                            continue
                        to_pid = msg.get('to')
                        payload_data = msg.get('payload')
                        if not to_pid:
                            send_ws_message(sock, {"type": "error", "message": "Missing to peer"})
                            continue
                        target_sock = None
                        with peers_lock:
                            target_sock = peers.get(to_pid)
                        if target_sock:
                            send_ws_message(target_sock, {"type": "relay", "from": peer_id, "payload": payload_data})
                            
            if peer_id:
                cleanup_peer(peer_id)
            else:
                sock.close()
                
        # --- Handle HTTP Requests ---
        else:
            if method == 'GET' and path_url.split('?')[0] == '/health':
                uptime = time.time() - start_time
                with peers_lock:
                    num_peers = len(peers)
                    num_rooms = len(rooms)
                res_body = json.dumps({
                    "status": "ok",
                    "uptime": uptime,
                    "rooms": num_rooms,
                    "peers": num_peers,
                    "connectedSockets": num_peers,
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                })
                response = (
                    "HTTP/1.1 200 OK\r\n"
                    "Content-Type: application/json\r\n"
                    "Access-Control-Allow-Origin: *\r\n"
                    "Content-Length: {}\r\n\r\n"
                    "{}"
                ).format(len(res_body), res_body)
                sock.sendall(response.encode('utf-8'))
                sock.close()
                return
                
            if method == 'GET':
                clean_path = path_url.split('?')[0]
                if clean_path == '/':
                    clean_path = '/index.html'
                
                clean_path = clean_path.replace('../', '').replace('..\\', '')
                if clean_path.startswith('/'):
                    clean_path = clean_path[1:]
                    
                file_path = os.path.abspath(os.path.join(WEB_ROOT, clean_path))
                if not file_path.startswith(WEB_ROOT):
                    response = "HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\n\r\nForbidden"
                    sock.sendall(response.encode('utf-8'))
                    sock.close()
                    return
                    
                if os.path.exists(file_path) and not os.path.isdir(file_path):
                    _, ext = os.path.splitext(file_path)
                    mime = MIME_TYPES.get(ext.lower(), "application/octet-stream")
                    with open(file_path, "rb") as f:
                        file_data = f.read()
                    response_headers = (
                        "HTTP/1.1 200 OK\r\n"
                        "Content-Type: {}\r\n"
                        "Access-Control-Allow-Origin: *\r\n"
                        "Content-Length: {}\r\n\r\n"
                    ).format(mime, len(file_data))
                    sock.sendall(response_headers.encode('utf-8') + file_data)
                else:
                    res_body = '{"error": "Not found"}'
                    response = (
                        "HTTP/1.1 404 Not Found\r\n"
                        "Content-Type: application/json\r\n"
                        "Access-Control-Allow-Origin: *\r\n"
                        "Content-Length: {}\r\n\r\n"
                        "{}"
                    ).format(len(res_body), res_body)
                    sock.sendall(response.encode('utf-8'))
            else:
                response = "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n"
                sock.sendall(response.encode('utf-8'))
            sock.close()
    except Exception as e:
        try:
            sock.close()
        except:
            pass

def main():
    global SSL_CONTEXT
    SSL_CONTEXT = build_ssl_context()

    server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    
    actual_port = PORT
    max_port = PORT + 10
    bound = False
    
    while actual_port < max_port:
        try:
            server_sock.bind(('0.0.0.0', actual_port))
            bound = True
            break
        except OSError:
            print(f"Port {actual_port} is busy, trying {actual_port + 1}")
            actual_port += 1
            
    if not bound:
        print("Could not bind to any port in range.")
        sys.exit(1)
        
    server_sock.listen(128)
    _scheme = "https" if SSL_CONTEXT else "http"
    _ws = "wss" if SSL_CONTEXT else "ws"
    print(f"\n  GhostLink Python Server Ready:")
    if SSL_CONTEXT:
        print(f"  TLS:        enabled (cert: {os.path.abspath(RELAY_CERT)})")
    else:
        print(f"  TLS:        disabled (cert/key not found) — plain http/ws; HTTPS pages will block this from a LAN IP")
    print(f"  Web App:    {_scheme}://localhost:{actual_port}")
    print(f"  Signaling:  {_ws}://localhost:{actual_port}")
    print(f"  Health:     {_scheme}://localhost:{actual_port}/health\n")
    
    while True:
        try:
            client_sock, client_addr = server_sock.accept()
            t = threading.Thread(target=handle_client, args=(client_sock, client_addr))
            t.daemon = True
            t.start()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            break
        except Exception as e:
            time.sleep(0.1)

if __name__ == "__main__":
    main()
