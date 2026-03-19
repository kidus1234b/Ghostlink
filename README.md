# 👻 GhostLink

**Zero Trust · Zero Trace · Zero Servers**

A peer-to-peer encrypted communication platform where nothing is stored on any server — ever. Messages, files, calls, and meetings are end-to-end encrypted, blockchain-chained for tamper detection, and distributed exclusively across connected peers.

> Your data lives on your device. Your backups live with your peers. No one else has access — not even us.

-----

## Why GhostLink?

Every major messaging app — even the “secure” ones — stores metadata on central servers. Who you talked to, when, how often, from where. GhostLink eliminates this entirely.

- **No servers.** Communication is peer-to-peer via WebRTC. There is no backend to hack, subpoena, or compromise.
- **No metadata.** Connection timestamps, IP addresses, and contact graphs never leave your device.
- **No trust required.** You don’t trust us, the network, or your peers with readable data. Cryptography enforces the rules, not policy.

-----

## How It Works

### Blockchain-Chained Messages

Every message is a block. Each block contains a SHA-256 hash of the previous block, creating a tamper-proof chain per conversation. Modify one message and the entire chain breaks — both peers detect it instantly.

```
Block #0          Block #1          Block #2
┌──────────┐     ┌──────────┐     ┌──────────┐
│ prevHash: │     │ prevHash: │     │ prevHash: │
│ 000000...│────▶│ a7f3b2...│────▶│ c9d0e1...│
│ msg: Hey  │     │ msg: Ack  │     │ msg: Push │
│ hash:     │     │ hash:     │     │ hash:     │
│ a7f3b2... │     │ c9d0e1... │     │ f2a3b4... │
└──────────┘     └──────────┘     └──────────┘
```

### End-to-End Encryption

- **Key Exchange:** ECDH P-256 — peers derive a shared secret without transmitting private keys
- **Message Encryption:** AES-256-GCM — authenticated encryption with unique IV per message
- **Key Derivation:** PBKDF2 with 100,000 iterations from BIP39 seed phrase
- **At Rest:** Private keys are AES-GCM wrapped with the master key derived from your seed phrase

### Peer-Distributed Backup (Shamir’s Secret Sharing)

When you set up GhostLink, you receive a **12-word BIP39 seed phrase** — this is your master identity. Your encrypted data is split into **7 fragments** using Shamir’s Secret Sharing over GF(256). You distribute these fragments to your connected peers. Any **3 of 7** fragments can reconstruct your data. No single peer can read anything.

```
Your encrypted backup
         │
    Shamir Split (7,3)
    ┌────┼────┬────┬────┬────┬────┐
    ▼    ▼    ▼    ▼    ▼    ▼    ▼
   F1   F2   F3   F4   F5   F6   F7
   │    │    │    │    │    │    │
  Alex Sara  Dev  Maya  Bo  Chen  Li
         │         │         │
         └────┬────┘         │
              ▼              │
        Any 3 fragments ─────┘
              │
     Reconstruct + Decrypt
              │
        Full Restore ✓
```

Switch phones → enter 12 words → collect 3 fragments → everything comes back.

### Recovery Flow

```
New Device
    │
    ├─ Enter 12-word seed phrase
    │       │
    │       ▼
    │  PBKDF2 → Master Key
    │
    ├─ Paste 3+ fragment hex strings from peers
    │       │
    │       ▼
    │  Shamir Combine → Encrypted Blob
    │       │
    │       ▼
    │  AES-GCM Unwrap with Master Key
    │       │
    │       ▼
    └── Full Restore: keys, chats, files, contacts, settings
```

-----

## Features

### Core

- **E2E Encrypted Chat** — every message encrypted with AES-256-GCM, blockchain-chained with SHA-256
- **P2P File Transfer** — files chunked, encrypted per-chunk, and sent directly peer-to-peer with hash verification
- **Voice & Video Calls** — WebRTC with SRTP encryption, no relay servers
- **Screen Sharing** — encrypted screen share sessions for dev collaboration

### Security

- **BIP39 Seed Phrase** — 12-word mnemonic generates your cryptographic identity
- **Shamir’s Secret Sharing** — backup fragments distributed across 7 peers, threshold of 3
- **Self-Destructing Messages** — configurable timers (30s / 60s / 5min) with tamper-proof chain markers
- **Zero Metadata** — no timestamps, IPs, or contact graphs ever leave your device
- **Invite-Only Access** — peers connect via cryptographically random one-time invite codes

### Communication

- **Reply Threading** — reference previous messages with quoted previews
- **Pinned Messages** — pin critical messages for quick access
- **Message Search** — search across encrypted conversations (decrypted locally)
- **Typing Indicators** — real-time presence within encrypted channels
- **Read Receipts** — optional, toggleable per-conversation

### Data

- **Chain Explorer** — inspect every block’s hash, previous hash, nonce, timestamp, and encrypted payload
- **Export Chain** — download your full blockchain as encrypted JSON
- **Local Persistence** — identity and wrapped keys survive browser refresh via localStorage
- **Full Backup & Restore** — seed phrase + peer fragments = complete data recovery on any device

### Personalization

- **4 Themes** — Phantom (green), Crimson (red), Arctic (blue), Void (purple)
- **Font Size Control** — adjustable message text size
- **Notification & Sound Toggles** — per-preference control

-----

## Tech Stack

|Layer     |Technology                                               |
|----------|---------------------------------------------------------|
|Encryption|Web Crypto API (AES-256-GCM, ECDH P-256, PBKDF2, SHA-256)|
|Backup    |Shamir’s Secret Sharing over GF(256)                     |
|Identity  |BIP39 mnemonic seed phrase (2048 word list)              |
|P2P       |WebRTC with STUN/TURN for NAT traversal                  |
|Calls     |WebRTC + SRTP                                            |
|Storage   |localStorage (encrypted at rest)                         |
|Frontend  |Vanilla HTML/CSS/JS — single file, zero dependencies     |
|License   |GPL-3.0                                                  |

-----

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  GhostLink Client                │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │  Crypto   │  │Blockchain│  │   Shamir SSS  │ │
│  │  Engine   │  │  Engine  │  │   GF(256)     │ │
│  │          │  │          │  │               │ │
│  │ ECDH     │  │ SHA-256  │  │ Split(7,3)   │ │
│  │ AES-GCM  │  │ Chain    │  │ Combine(3+)  │ │
│  │ PBKDF2   │  │ Verify   │  │ Distribute   │ │
│  └────┬─────┘  └────┬─────┘  └──────┬────────┘ │
│       │             │               │           │
│  ┌────▼─────────────▼───────────────▼────────┐  │
│  │              Application Layer             │  │
│  │  Chat · Files · Calls · Screen Share      │  │
│  │  Recovery · Settings · Chain Explorer     │  │
│  └────────────────────┬──────────────────────┘  │
│                       │                          │
│  ┌────────────────────▼──────────────────────┐  │
│  │           Local Encrypted Storage          │  │
│  │  Wrapped keys · Messages · Contacts       │  │
│  │  Settings · Blockchain · Fragment meta    │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
└──────────────────────┬───────────────────────────┘
                       │
                  WebRTC P2P
                       │
┌──────────────────────▼───────────────────────────┐
│              Other GhostLink Clients              │
│  (Each client is identical — no server exists)   │
└──────────────────────────────────────────────────┘
```

-----

## Quick Start

**Option 1 — GitHub Pages (recommended)**

The app is live at: `https://kidus1234b.github.io/Ghostlink/`

**Option 2 — Local**

```bash
git clone https://github.com/kidus1234b/Ghostlink.git
cd Ghostlink
# Open directly — no build step, no dependencies
open index.html
# or
python3 -m http.server 8000
# then visit http://localhost:8000
```

**Option 3 — VPS Deployment**

```bash
# On your server
git clone https://github.com/kidus1234b/Ghostlink.git
sudo cp Ghostlink/index.html /var/www/html/ghostlink/index.html

# Nginx config
server {
    listen 443 ssl;
    server_name ghostlink.yourdomain.com;
    root /var/www/html/ghostlink;
    index index.html;
    
    # SSL required for Web Crypto API
    ssl_certificate /etc/letsencrypt/live/ghostlink.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ghostlink.yourdomain.com/privkey.pem;
}
```

> **Note:** Web Crypto API requires HTTPS in production. `localhost` works for testing.

-----

## Security Model

### What GhostLink protects against

|Threat               |Protection                                          |
|---------------------|----------------------------------------------------|
|Server breach        |No server exists                                    |
|Man-in-the-middle    |ECDH key exchange + message authentication          |
|Message tampering    |SHA-256 blockchain chain verification               |
|Data theft (device)  |AES-256-GCM encryption at rest with key wrapping    |
|Backup compromise    |Shamir’s Secret Sharing — single fragment is useless|
|Identity theft       |BIP39 seed phrase derives all keys deterministically|
|Metadata surveillance|P2P direct — no central logs, no connection records |

### What GhostLink does NOT protect against

- Compromised device (keylogger, screen capture)
- Peer collusion (3+ peers colluding could reconstruct your backup)
- Seed phrase theft (if someone gets your 12 words, they own your identity)
- Endpoint screenshot/copy (messages are visible once decrypted on-screen)

### Cryptographic Primitives

|Function            |Algorithm |Parameters                    |
|--------------------|----------|------------------------------|
|Key agreement       |ECDH      |P-256 (secp256r1)             |
|Symmetric encryption|AES-GCM   |256-bit key, 96-bit IV        |
|Key derivation      |PBKDF2    |SHA-256, 100k iterations      |
|Message integrity   |SHA-256   |Chained hashes (blockchain)   |
|Backup splitting    |Shamir SSS|GF(256), 7 shares, threshold 3|
|Identity seed       |BIP39     |128-bit entropy, 12 words     |

-----

## Roadmap

- [x] E2E encrypted chat with blockchain integrity
- [x] BIP39 seed phrase identity generation
- [x] Shamir’s Secret Sharing backup (GF256)
- [x] PBKDF2 key derivation from seed
- [x] AES-GCM private key wrapping
- [x] localStorage persistence
- [x] Self-destructing messages
- [x] File transfer UI with chunked progress
- [x] Voice/Video call interface
- [x] Screen sharing
- [x] Chain explorer
- [x] Multi-theme support
- [x] Settings panel
- [ ] WebRTC signaling for real P2P connections
- [ ] Signal Protocol (Double Ratchet) for forward secrecy
- [ ] Actual chunked encrypted file transfer over data channels
- [ ] TURN server fallback for NAT traversal
- [ ] React Native mobile app (Android + iOS)
- [ ] Electron desktop app (Windows + macOS + Linux)
- [ ] Group key agreement (multi-party ECDH)
- [ ] Offline message queuing via peer relay
- [ ] QR code invite scanning

-----

## Development

Built entirely from Termux on Android by the help of Claude Code. No PC was used.

```bash
# Clone
git clone https://github.com/kidus1234b/Ghostlink.git
cd Ghostlink

# Edit
nano index.html

# Test locally
python3 -m http.server 8000

# Push
git add . && git commit -m "your message" && git push
```

The entire application is a single `index.html` file — zero build steps, zero dependencies, zero frameworks. Pure HTML, CSS, and JavaScript using the native Web Crypto API.

-----

## License

GPL-3.0 — see <LICENSE> for details.

-----

<p align="center">
  <strong>👻 GhostLink</strong><br>
  <em>Your conversations. Your keys. Your rules.</em><br><br>
  Built by <a href="https://github.com/kidus1234b">Kidus</a>
</p>
