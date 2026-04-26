# 👻 GhostLink

**Zero Trust · Zero Trace · Zero Servers**

A peer-to-peer encrypted communication platform where nothing is stored on any server — ever. Messages, files, calls, and meetings are end-to-end encrypted, blockchain-chained for tamper detection, and distributed exclusively across connected peers.

> Your data lives on your device. Your backups live with your peers. No one else has access — not even us.


-----

## Why GhostLink?

Every major messaging app — even the “secure” ones — stores metadata on central servers. Who you talked to, when, how often, from where. GhostLink eliminates this entirely.

- **No servers.** Communication is peer-to-peer via WebRTC. There is no backend to hack, subpoena, or compromise.
- **No metadata.** Connection timestamps, IP addresses, and contact graphs never leave your device.
- **No trust required.** Cryptography enforces the rules, not policy.

-----

## Architecture

```
┌──────────────────────────────────────────┐
│             USER DEVICES                  │
│                                           │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐ │
│  │   Web    │  │ Desktop  │  │ Mobile  │ │
│  │ (React)  │  │(Electron)│  │ (React  │ │
│  │          │  │          │  │ Native) │ │
│  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│       │              │              │      │
│       └──────────┬───┘──────────────┘      │
│                  │                          │
│          ┌───────▼────────┐                 │
│          │  WebRTC P2P    │  ◄── Direct     │
│          │  Data Channels │      Connection │
│          └───────┬────────┘                 │
│                  │                          │
│          ┌───────▼────────┐                 │
│          │    Hybrid      │  ◄── QR/Paste   │
│          │   Signaling    │      first,     │
│          │                │      relay for  │
│          │                │      reconnect  │
│          └────────────────┘                 │
└──────────────────────────────────────────┘
```

-----

## Cryptographic Stack

|Layer             |Technology                             |Purpose                                               |
|------------------|---------------------------------------|------------------------------------------------------|
|Key Exchange      |ECDH P-256                             |Derive shared secrets between peers                   |
|Message Encryption|AES-256-GCM                            |Encrypt every message with unique IV                  |
|Forward Secrecy   |Signal Protocol (X3DH + Double Ratchet)|New keys per message — past messages safe if key leaks|
|Hashing           |SHA-256                                |Blockchain integrity, fingerprints                    |
|Key Derivation    |PBKDF2 (100,000 iterations)            |Derive master key from seed phrase                    |
|Identity Recovery |Shamir’s Secret Sharing GF(256)        |Split identity into 7 shares, any 3 recover it        |
|Seed Backup       |BIP39-style 12-word phrase             |Human-readable identity backup                        |

-----

## Platform Details

### Web App — `index.html` (~2,600 lines)

Single HTML file with React 18 + Babel transpilation. No build step needed.

**Screens:** Splash (ghost animation + loading) → Setup (name + 12-word seed generation) → Main Chat (full interface with sidebar)

**Features:**

- 4 themes: Phantom (teal), Crimson (red), Arctic (cyan), Void (purple)
- Responsive layouts: mobile, tablet, desktop
- Drag-and-drop encrypted file upload
- Emoji picker (30 curated emojis)
- Self-destruct messages (30s / 60s / 5min)
- Reply threading and pinned messages
- Blockchain explorer (view SHA-256 chain per conversation)
- QR code invite generation (pure SVG, Reed-Solomon error correction)
- Message search across encrypted conversations

### Desktop App — Electron (5 modules, ~880 lines)

|Module       |Lines|Purpose                                                           |
|-------------|-----|------------------------------------------------------------------|
|`main.js`    |~520 |Window management, IPC, embedded signaling server, deep links, CSP|
|`preload.js` |~160 |Secure contextBridge API (`window.ghostlink`)                     |
|`titlebar.js`|~250 |Custom frameless title bar (38px, draggable)                      |
|`tray.js`    |~260 |System tray icon, badge count, flash on messages                  |
|`updater.js` |~170 |Auto-updates via GitHub Releases                                  |

**Desktop-specific features:**

- Frameless window with custom title bar
- Minimize to system tray with badge count
- Deep link protocol (`ghostlink://`)
- Auto-update (download + install from GitHub Releases)
- Signaling server embedded — starts automatically on port 3001
- Persistent window position and pop-out chat windows
- Secure storage via `electron-store`
- Strict Content-Security-Policy headers

### Mobile App — React Native (18 files, ~4,500+ lines)

**Screens:**

|Screen          |Purpose                                                  |
|----------------|---------------------------------------------------------|
|`SetupScreen`   |3-step identity creation (name → seed → confirm)         |
|`ChatListScreen`|Chat list with swipe actions (pin, mute, delete), FAB    |
|`ChatScreen`    |Full chat with bubbles, typing indicators, voice messages|
|`CallScreen`    |Voice/video with draggable PiP, ringing animations       |
|`SettingsScreen`|5 themes, security info, font slider, network config     |
|`RecoveryScreen`|Backup/Verify/Restore with Shamir fragments              |

**Services:**

|Service           |Purpose                                               |
|------------------|------------------------------------------------------|
|`CryptoService`   |ECDH, AES-GCM, SHA-256, ECDSA (OpenSSL-backed)        |
|`WebRTCService`   |`react-native-webrtc` peer connections + data channels|
|`SignalingService`|WebSocket with auto-reconnect + health probe          |
|`StorageService`  |AsyncStorage wrapper with encryption                  |

**Components:**

|Component        |Purpose                                                       |
|-----------------|--------------------------------------------------------------|
|`GhostAvatar`    |Deterministic gradient avatar from name hash                  |
|`MessageBubble`  |Chat bubble with receipts, replies, self-destruct, attachments|
|`EncryptionBadge`|E2EE status pill (tap for cipher details)                     |

**5 Themes:** Phantom, Neon, Blood, Ocean, Cyber

-----

## P2P Connectivity

### Hybrid Signaling (Zero Server by Default)

GhostLink uses a hybrid approach to solve the WebRTC signaling problem without requiring a permanent server:

```
FIRST CONNECTION (true zero server):
  User A generates QR code / invite string
      │
      ▼
  Contains: SDP offer + ICE candidates + public key
      │
      ▼
  User B scans QR / pastes string
      │
      ▼
  User B generates SDP answer → sends back via QR/paste
      │
      ▼
  WebRTC direct connection established
      │
      ▼
  Peers cache each other's network info locally

RECONNECTION (automatic):
  App starts → checks cached peer info
      │
      ├── Direct reconnect using cached ICE candidates
      │
      └── Fallback: embedded relay (Electron port 3001)
           or VPS relay if available
```

No permanent server needed. The signaling relay is only used as a fallback for NAT changes.

### WebRTC Data Channels (3 multiplexed)

|Channel   |ID|Mode             |Purpose                |
|----------|--|-----------------|-----------------------|
|`messages`|0 |Reliable, ordered|Chat messages          |
|`files`   |1 |Reliable, ordered|Encrypted file transfer|
|`presence`|2 |Unreliable       |Typing indicators      |

### Signaling Server — `signaling-core.js` (~650 lines)

Lightweight WebSocket relay that only passes connection info — never sees message content.

- **Message types:** `join`, `join-room`, `leave-room`, `peer-list`, `offer`, `answer`, `ice-candidate`, `relay`
- **Deployment:** Embedded in Electron (auto-start, port 3001) or standalone on VPS (`node server/index.js`)
- **Auto-discovery:** Web app probes `localhost` → `same-host` → `saved URL`
- **Security:** Rate limiting (200/min), handshake timeout (15s), origin whitelist, max 64KB messages, max 100 peers/room

### NAT Traversal

- **STUN servers:** `stun.l.google.com:19302` (3 servers)
- **Fallback:** Signaling relay for symmetric NAT
- **Auto-reconnect:** Exponential backoff (1s → 30s)

-----

## Encrypted File Transfer

- 64 KB chunks with per-chunk AES-256-GCM encryption
- Unique IV per chunk
- SHA-256 hash verification (whole file)
- Flow control: 16-chunk ACK window
- Backpressure handling (buffer high/low water marks)
- Progress events (0–100%)

-----

## Voice / Video / Screen Sharing

|Mode  |Audio                                |Video                 |Method             |
|------|-------------------------------------|----------------------|-------------------|
|Voice |Echo cancellation + noise suppression|—                     |`getUserMedia()`   |
|Video |Echo cancellation + noise suppression|1280x720, front camera|`getUserMedia()`   |
|Screen|—                                    |Display surface       |`getDisplayMedia()`|

All media streams encrypted via SRTP (built into WebRTC).

-----

## Message Blockchain

Every message creates a SHA-256 linked block:

```
Block #N
├── index: N
├── sender: "Alice"
├── content: "Hello"
├── timestamp: 1711027200000
├── hash: sha256(N + sender + content + timestamp + prevHash)
├── prevHash: Block #(N-1).hash
├── nonce: N
└── encrypted: { iv: "...", ciphertext: "..." }
```

Chain explorer UI lets you verify integrity, view any block, and export the full chain as JSON.

-----

## Identity Recovery (3 Layers)

```
Layer 1: 12-word BIP39 seed phrase
    ↓ PBKDF2 (100K iterations)
Layer 2: Master key → Shamir split into 7 shares (threshold 3)
    ↓ Distribute to trusted peers
Layer 3: P2P recovery

┌────────────────────────────────────────────┐
│              BACKUP FLOW                    │
│                                             │
│  Identity + Chats + Files + Contacts        │
│              │                              │
│        AES-256-GCM encrypt                  │
│        with master key                      │
│              │                              │
│        Shamir Split (7,3)                   │
│    ┌──┬──┬──┼──┬──┬──┐                     │
│    F1 F2 F3 F4 F5 F6 F7                    │
│    │  │  │  │  │  │  │                      │
│   Copy-paste to 7 trusted peers             │
│                                             │
│         RESTORE FLOW                        │
│                                             │
│  New device → Enter 12 words                │
│              │                              │
│        PBKDF2 → Master key                  │
│              │                              │
│  Paste 3+ fragments from peers              │
│              │                              │
│        Shamir Combine                       │
│              │                              │
│        AES-GCM decrypt                      │
│              │                              │
│  Full restore: keys, chats, files,          │
│  contacts, settings, blockchain             │
└────────────────────────────────────────────┘
```

-----

## Offline Support

- IndexedDB queue stores messages when offline
- 24-hour TTL with auto-cleanup
- Auto-sync when peer reconnects
- Relay via trusted third peer

-----

## Security Model

### What GhostLink protects against

|Threat               |Protection                                          |
|---------------------|----------------------------------------------------|
|Server breach        |No server exists to breach                          |
|Man-in-the-middle    |ECDH key exchange + message authentication          |
|Message tampering    |SHA-256 blockchain chain verification               |
|Key compromise       |Forward secrecy via Double Ratchet                  |
|Data theft (device)  |AES-256-GCM encryption at rest with key wrapping    |
|Backup compromise    |Shamir’s Secret Sharing — single fragment is useless|
|Identity theft       |BIP39 seed phrase derives all keys deterministically|
|Metadata surveillance|P2P direct — no central logs, no connection records |
|Replay attacks       |Unique IV per message + blockchain ordering         |

### What GhostLink does NOT protect against

- Compromised device (keylogger, screen capture malware)
- Peer collusion (3+ peers colluding could reconstruct your backup)
- Seed phrase theft (if someone gets your 12 words, they own your identity)
- Endpoint visibility (messages are readable once decrypted on-screen)
- Rubber-hose cryptanalysis (physical coercion)

### Cryptographic Primitives

|Function            |Algorithm            |Parameters                    |
|--------------------|---------------------|------------------------------|
|Key agreement       |ECDH                 |P-256 (secp256r1)             |
|Symmetric encryption|AES-GCM              |256-bit key, 96-bit IV        |
|Key derivation      |PBKDF2               |SHA-256, 100K iterations      |
|Forward secrecy     |X3DH + Double Ratchet|Signal Protocol               |
|Message integrity   |SHA-256              |Chained hashes (blockchain)   |
|Backup splitting    |Shamir SSS           |GF(256), 7 shares, threshold 3|
|Identity seed       |BIP39                |128-bit entropy, 12 words     |
|Signing             |ECDSA                |P-256                         |
|File chunks         |AES-GCM              |64KB per chunk, unique IV     |

-----

## Quick Start

### Web (recommended for testing)

The app is live at: **https://kidus1234b.github.io/Ghostlink/**

Or run locally:

```bash
git clone https://github.com/kidus1234b/Ghostlink.git
cd Ghostlink
python3 -m http.server 8000
# visit http://localhost:8000
```

### Desktop (Electron)

```bash
cd desktop
npm install
npm start
# Signaling server auto-starts on port 3001
```

### Mobile (React Native)

```bash
cd mobile
npm install

# Android
npx react-native run-android

# iOS
cd ios && pod install && cd ..
npx react-native run-ios
```

### Signaling Server (standalone)

```bash
cd server
npm install
node index.js
# Runs on port 3001
```

### VPS Deployment

```bash
# Clone on server
git clone https://github.com/kidus1234b/Ghostlink.git

# Web app via Nginx
sudo cp Ghostlink/index.html /var/www/html/ghostlink/index.html

# Signaling relay
cd Ghostlink/server
npm install
node index.js &

# Nginx config
server {
    listen 443 ssl;
    server_name ghostlink.yourdomain.com;
    root /var/www/html/ghostlink;
    index index.html;

    ssl_certificate /etc/letsencrypt/live/ghostlink.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ghostlink.yourdomain.com/privkey.pem;

    # WebSocket proxy for signaling
    location /ws {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $websocket;
        proxy_set_header Connection "upgrade";
    }
}
```

> **Note:** Web Crypto API requires HTTPS in production. `localhost` works for testing.

-----

## Project Structure

```
Ghostlink/
├── index.html              # Web app (~2,600 lines, single file)
├── README.md
├── LICENSE                  # GPL-3.0
│
├── desktop/                 # Electron app
│   ├── main.js             # Window management, IPC, signaling
│   ├── preload.js          # Secure contextBridge
│   ├── titlebar.js         # Custom frameless title bar
│   ├── tray.js             # System tray + badge
│   ├── updater.js          # Auto-update via GitHub Releases
│   └── package.json
│
├── mobile/                  # React Native app
│   ├── screens/
│   │   ├── SetupScreen.js
│   │   ├── ChatListScreen.js
│   │   ├── ChatScreen.js
│   │   ├── CallScreen.js
│   │   ├── SettingsScreen.js
│   │   └── RecoveryScreen.js
│   ├── services/
│   │   ├── CryptoService.js
│   │   ├── WebRTCService.js
│   │   ├── SignalingService.js
│   │   └── StorageService.js
│   ├── components/
│   │   ├── GhostAvatar.js
│   │   ├── MessageBubble.js
│   │   └── EncryptionBadge.js
│   ├── App.js
│   └── package.json
│
└── server/                  # Signaling relay
    ├── signaling-core.js   # WebSocket relay (~650 lines)
    └── index.js            # Entry point
```

-----

## Development

Built entirely from **Termux on Android** using Claude Code with the Anthropic API. No PC was used.

```bash
# Clone
git clone https://github.com/kidus1234b/Ghostlink.git
cd Ghostlink

# Edit
nano index.html

# Test
python3 -m http.server 8000

# Push
git add . && git commit -m "your message" && git push
```

-----

## License

GPL-3.0 — see <LICENSE> for details.

-----

<p align="center">
  <strong>👻 GhostLink</strong><br>
  <em>Your conversations. Your keys. Your rules.</em><br><br>
  Built by <a href="https://github.com/kidus1234b">Kidus</a>
</p>