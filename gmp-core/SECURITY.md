# Security Policy — Ghost Mesh Protocol (GMP)

This document outlines the security model, cryptographic design assumptions, known limitations, and response policies for the Ghost Mesh Protocol.

---

## 1. Security Guarantees (What GMP Protects)

GMP is designed to establish secure, decentralised, and metadata-minimising communication between peer nodes. It provides the following guarantees:

- **End-to-End Encryption (E2E)**: All application data (`DATA` frames) is encrypted end-to-end between the sending and receiving endpoints using AES-256-GCM. Intermediate relaying nodes in the mesh can only view transport-level routing frames (`DATA` envelope and destination NodeID); they cannot access message payloads.
- **Perfect Forward Secrecy (PFS)**: Session keys are derived via ephemeral X25519 Elliptic Curve Diffie-Hellman (ECDH) key exchanges on every connection. Compromise of a node's long-term static identity key does not reveal past session communications.
- **Cryptographic Identity Verification**: Node addresses are 64-byte `NodeID` values derived securely via `SHA-512(staticPubKey)`. Handshakes authenticate node ownership using Ed25519 signatures, preventing impersonation and active MITM attacks.
- **Replay Protection**: Handshakes enforce timestamp freshness validation (2-minute window) and persistent nonce tracking via a dual-layer defense (`NonceStore` persistent high-water marks and an in-memory session key LRU cache).
- **Origin Security**: Local browser applications communicate with the background daemon node via a loopback WebSocket bridge protected by origin validation (`file://`, `localhost`, `127.0.0.1`, `::1` only) to block DNS rebinding and cross-site scripting (XSS) extraction.

---

## 2. Out of Scope (What GMP Does NOT Protect)

Operators and developers should understand the boundaries of the GMP security model:

- **Traffic Analysis**: Relaying nodes can observe packet sizes, timings, and destination/source routing paths. GMP does not natively obfuscate traffic patterns or packet schedules (though padding is utilized where feasible).
- **Endpoint Integrity**: If an operator's physical device, local file system, or React Native client memory is compromised, all security guarantees are bypassed. Private keys are protected at rest (AES-256-GCM) but must be loaded into memory to establish connections.
- **Metadata Protection of IP Addresses**: While NodeIDs protect cryptographic addresses, public rendezvous nodes (Public Peers) can see the physical IP addresses of nodes connecting to them.
- **Symmetric NAT Limitations**: Nodes behind symmetric NATs cannot directly establish P2P links without a relaying peer.

---

## 3. Known Limitations

- **Real-Network NAT Traversal (Beta status)**: TCP hole punching is verified on loopback and local networks. However, cross-network traversal across multi-layered carrier-grade NATs (CGNAT) remains unverified in production.
- **Clock Dependency**: Security replay checks depend on correct system time (tolerance window of 2 minutes). Substantial clock drift (> 2 minutes) prevents successful handshakes.

---

## 4. Responsible Disclosure

If you discover a security vulnerability in the Ghost Mesh Protocol, please report it privately:

- **Email**: [ghostlink@proton.me](mailto:ghostlink@proton.me)
- **Response Window**: We acknowledge all submissions within **72 hours** and aim to provide a concrete resolution path or patch timeline within 10 days.
- Please do **not** open public issues or pull requests for security vulnerabilities until a patch is ready.
