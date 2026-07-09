/**
 * GMP Link Module — Phase 2a
 * Single-link implementation for Electron (Node.js TCP).
 *
 * Phase 2a additions:
 * - Session key uniqueness check (LRU set, size 50) to detect key reuse attacks
 * - Nonce store integration for persisted high-water marks
 * - Rate limiter integration for connection flood protection
 * - Handshake timeouts (10s HELLO, 10s full handshake)
 * - New events: 'rate-limited', 'connection-cap-reached', 'hello-timeout', 'handshake-timeout'
 *
 * Implements the Ghost Mesh Protocol wire format per gmp-core/PROTOCOL_SPEC.md:
 * - Length-prefixed binary framing: [4 bytes length][1 byte type][N bytes payload]
 * - 2-message handshake: HELLO -> HELLO_ACK (with staticPubKey for NodeID verification)
 * - AES-256-GCM session encryption with forward secrecy via ephemeral ECDH
 * - PING/PONG keepalive
 *
 * Port: 49500 (default)
 */

import { EventEmitter } from 'events';
import net from 'net';
import tls from 'tls';
import crypto from 'crypto';
import {
  deriveIdentityFromSeedPhrase,
  generateEphemeralKeyPair,
  x25519DeriveSharedSecret,
  deriveSessionKeys,
  signMessage,
  verifySignature,
  sha512,
  bytesToHex,
  stringToBytes,
} from './identity.js';
import { NonceStore } from './nonce-store.js';
import { RateLimiter } from './rate-limiter.js';
import { detectNATType } from './nat-detector.js';
import { RoutingTable } from './routing-table.js';
import { TopologyManager } from './topology-announce.js';
import { Forwarder } from './forwarder.js';
import { PeerCache } from './peer-cache.js';
import { PeerExchangeManager } from './peer-exchange.js';
import { BootstrapManager } from './bootstrap.js';
import { NetworkHealthMonitor } from './network-health.js';
import { KeyRotationManager } from './key-rotation.js';
import { ReputationManager } from './peer-reputation.js';
import config from './config.js';
import logger from './logger.js';


function toHex(nodeId) {
  if (typeof nodeId === 'string') return nodeId;
  if (Buffer.isBuffer(nodeId) || nodeId instanceof Uint8Array) {
    return Buffer.from(nodeId).toString('hex');
  }
  return nodeId;
}

const MESSAGETYPES = {
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  DATA: 0x03,
  PING: 0x04,
  PONG: 0x05,
  BINDING_REQUEST: 0x06,
  BINDING_RESPONSE: 0x07,
  TOPOLOGY_ANNOUNCE: 0x08,
  PEER_REQUEST: 0x09,
  PEER_RESPONSE: 0x0A,
  KEY_ROTATION: 0x0B,
};

const DEFAULT_PORT = config.GMP_PORT || 49500;
const PING_INTERVAL_MS = config.GMP_PING_INTERVAL_MS || 30000;
const PONG_TIMEOUT_MS = config.GMP_PING_TIMEOUT_MS || 10000;
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_MESSAGE_SIZE = 1024 * 1024;
const SESSION_KEY_LRU_SIZE = 50;

const HELLO_PAYLOAD_LEN = 265;
const HELLO_ACK_PAYLOAD_LEN = 280;

function writeUint32BE(buffer, value, offset) {
  buffer[offset] = (value >> 24) & 0xff;
  buffer[offset + 1] = (value >> 16) & 0xff;
  buffer[offset + 2] = (value >> 8) & 0xff;
  buffer[offset + 3] = value & 0xff;
}

function readUint32BE(buffer, offset) {
  return (
    (buffer[offset] << 24) |
    (buffer[offset + 1] << 16) |
    (buffer[offset + 2] << 8) |
    buffer[offset + 3]
  ) >>> 0;
}

// Build a 12-byte AES-GCM IV from a 64-bit counter value
// IV structure: 4 bytes zero + 8 bytes counter (big-endian)
function buildGCMIV(counter) {
  const iv = Buffer.alloc(12, 0);
  iv.writeBigUInt64BE(BigInt(counter), 4);
  return iv;
}

function encryptAESGCM(key, nonceCounter, plaintext, aad) {
  const iv = buildGCMIV(nonceCounter);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([authTag, encrypted]);
}

function decryptAESGCM(key, nonceCounter, ciphertext, aad) {
  const iv = buildGCMIV(nonceCounter);
  const authTag = ciphertext.slice(0, 16);
  const encrypted = ciphertext.slice(16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  if (aad) decipher.setAAD(aad);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function uint8ArrayEquals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Compare two buffers for equality (timing-safe)
function bufferEquals(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Compute a fingerprint of a session key for LRU tracking
function fingerprintKey(sessionKey) {
  return crypto.createHash('sha256').update(Buffer.from(sessionKey)).digest('hex').slice(0, 32);
}

// LRU Set for session key deduplication
class SessionKeyLRUSet {
  constructor(maxSize = SESSION_KEY_LRU_SIZE) {
    this._maxSize = maxSize;
    this._map = new Map();
    this._order = [];
  }

  _touch(key) {
    const idx = this._order.indexOf(key);
    if (idx !== -1) {
      this._order.splice(idx, 1);
    }
    this._order.push(key);
  }

  has(key) {
    return this._map.has(key);
  }

  add(key) {
    if (this._map.has(key)) {
      this._touch(key);
      return false;
    }

    if (this._order.length >= this._maxSize) {
      const oldest = this._order.shift();
      this._map.delete(oldest);
    }

    this._map.set(key, true);
    this._order.push(key);
    return true;
  }

  clear() {
    this._map.clear();
    this._order = [];
  }

  size() {
    return this._order.length;
  }
}

class GMPLink extends EventEmitter {
  /**
   * Construct a GMP link over an existing TCP socket.
   *
   * Phase 2a changes:
   * - Accepts rateLimiter for handshake timeout enforcement
   * - Accepts nonceStore for persisted high-water mark tracking
   * - Accepts sessionKeyLRUSet for detecting key reuse across connections
   * - Performs session key uniqueness check to prevent nonce reuse attacks
   */
  constructor({ identity, socket, isInitiator, ephemeralKeyPair, rateLimiter, nonceStore, sessionKeyLRUSet, pingIntervalMs, pongTimeoutMs, node, isVirtual }) {
    super();
    this.identity = identity;
    this.socket = socket;
    this.isInitiator = isInitiator;
    this.remoteNodeId = null;
    this.remoteStaticPubkey = null;
    this.remoteSigningPubkey = null;
    this.ephemeralKeyPair = ephemeralKeyPair;

    this.sessionKey = null;
    this.sendKey = null;
    this.recvKey = null;
    this.sendNonceCounter = 0;
    this.recvNonceCounter = 0;
    this.state = 'handshaking';

    this.recvBuffer = Buffer.alloc(0);
    this.expectedPayloadLen = 0;
    this.currentMessageType = null;

    this.pingIntervalMs = pingIntervalMs || PING_INTERVAL_MS;
    this.pongTimeoutMs = pongTimeoutMs || PONG_TIMEOUT_MS;

    this.pingTimer = null;
    this.pongTimer = null;
    this.lastPongReceived = false;

    this.initiatorNonce = null;
    this.initiatorEphemeralPubkey = null;

    this.rateLimiter = rateLimiter;
    this.nonceStore = nonceStore;
    this.sessionKeyLRUSet = sessionKeyLRUSet;
    this.node = node;
    this.isVirtual = !!isVirtual;
    this._connId = `link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this._setupSocketHandlers();
  }

  _updateNonceStore() {
    if (this.nonceStore && this.remoteNodeId && this.sendKey) {
      this.nonceStore.updateCounters(
        this.remoteNodeId,
        this.sendKey,
        this.sendNonceCounter,
        this.recvNonceCounter
      );
    }
  }

  _setupSocketHandlers() {
    this.socket.on('data', (data) => this._handleData(data));
    this.socket.on('close', () => this._handleClose());
    this.socket.on('error', (err) => this.emit('error', err));
  }

  _handleData(data) {
    this.recvBuffer = Buffer.concat([this.recvBuffer, data]);

    // Intercept plain HTTP GET/HEAD requests (e.g. from reverse proxy health checks)
    if (this.recvBuffer.length >= 4) {
      const prefix = this.recvBuffer.slice(0, 4).toString('utf8');
      if (prefix === 'GET ' || prefix === 'HEAD') {
        const response = 
          "HTTP/1.1 200 OK\r\n" +
          "Content-Type: application/json\r\n" +
          "Content-Length: 20\r\n" +
          "Connection: close\r\n\r\n" +
          '{"status":"healthy"}';
        this.socket.write(response, () => {
          this.socket.end();
        });
        return;
      }
    }

    while (this.recvBuffer.length >= 5) {
      if (this.expectedPayloadLen === 0) {
        this.expectedPayloadLen = readUint32BE(this.recvBuffer, 0);
        this.currentMessageType = this.recvBuffer[4];

        if (this.expectedPayloadLen > MAX_MESSAGE_SIZE) {
          this.destroy(new Error('Message too large'));
          return;
        }
      }

      const totalLen = 5 + this.expectedPayloadLen;
      if (this.recvBuffer.length < totalLen) return;

      const type = this.currentMessageType;  // Capture before resetting
      const payload = this.recvBuffer.slice(5, totalLen);
      this.recvBuffer = this.recvBuffer.slice(totalLen);
      this.expectedPayloadLen = 0;
      this.currentMessageType = null;

      this._processMessage(type, payload);
    }
  }

  _processMessage(type, payload) {
    switch (type) {
      case MESSAGETYPES.HELLO:
        this._handleHELLO(payload);
        break;
      case MESSAGETYPES.HELLO_ACK:
        this._handleHELLO_ACK(payload);
        break;
      case MESSAGETYPES.DATA:
        this._handleDATA(payload);
        break;
      case MESSAGETYPES.PING:
        this._handlePING(payload);
        break;
      case MESSAGETYPES.PONG:
        this._handlePONG(payload);
        break;
      case MESSAGETYPES.BINDING_REQUEST:
        this._handleBINDING_REQUEST(payload);
        break;
      case MESSAGETYPES.BINDING_RESPONSE:
        this._handleBINDING_RESPONSE(payload);
        break;
      case MESSAGETYPES.TOPOLOGY_ANNOUNCE:
        this._handleTOPOLOGY_ANNOUNCE(payload);
        break;
      case MESSAGETYPES.PEER_REQUEST:
        this._handlePEER_REQUEST(payload);
        break;
      case MESSAGETYPES.PEER_RESPONSE:
        this._handlePEER_RESPONSE(payload);
        break;
      case MESSAGETYPES.KEY_ROTATION:
        this._handleKEY_ROTATION(payload);
        break;
      default:
        this.destroy(new Error(`Unknown message type: ${type}`));
    }
  }

  async _handleHELLO(payload) {
    if (this.state !== 'handshaking') { return; }

    if (this.rateLimiter) {
      this.rateLimiter.recordHelloReceived(this._connId);
    }

    if (payload.length !== HELLO_PAYLOAD_LEN) {
      this.destroy(new Error(`Invalid HELLO payload length: ${payload.length}, expected ${HELLO_PAYLOAD_LEN}`));
      return;
    }

    // Parse HELLO version byte
    const version = payload[0];
    if (version !== 0x01) {
      this.destroy(new Error(`Unsupported protocol version: ${version}`));
      return;
    }

    // Parse HELLO message fields (shifted by 1 byte)
    const initiatorNodeId = payload.slice(1, 65);
    const initiatorNodeIdHex = Buffer.from(initiatorNodeId).toString('hex');
    const remoteIp = this.socket ? this.socket.remoteAddress : null;

    if (this.node && this.node.reputation && this.node.reputation.isBanned(initiatorNodeIdHex, remoteIp)) {
      this.destroy(new Error('Peer is banned'));
      return;
    }

    const initiatorStaticPubkey = payload.slice(65, 97);
    const initiatorSigningPubkey = payload.slice(97, 129);
    const initiatorEphemeralPubkey = payload.slice(129, 161);
    const timestamp = Number(payload.readBigUInt64BE(161));
    const initiatorNonce = payload.slice(169, 201);
    const signature = payload.slice(201, 265);

    // Verify NodeID = SHA-512(staticPubkey) or SHA-512(signingPubkey) (to support rotated identities) using timing-safe bufferEquals
    const computedNodeIdX = sha512(initiatorStaticPubkey);
    const computedNodeIdEd = sha512(initiatorSigningPubkey);
    if (!bufferEquals(computedNodeIdX, initiatorNodeId) && !bufferEquals(computedNodeIdEd, initiatorNodeId)) {
      this._penalizeSuspicious('HELLO NodeID does not match SHA-512(staticPubkey) or SHA-512(signingPubkey)');
      this.destroy(new Error('HELLO NodeID does not match SHA-512(staticPubkey) or SHA-512(signingPubkey)'));
      return;
    }

    // Verify timestamp is within tolerance
    const now = this.node ? this.node.now() : Date.now();
    const delta = Math.abs(now - timestamp);
    const windowMs = this.node ? this.node.timestampWindowMs : 120000;
    if (delta > windowMs) {
      this._penalizeSuspicious('HELLO timestamp out of range');
      this.destroy(new Error('HELLO timestamp out of range'));
      return;
    }

    if (delta > 5 * 60 * 1000) {
      this.emit('clock-skew-detected', { delta, remoteNodeId: initiatorNodeId });
      if (this.node) {
        this.node.emit('clock-skew-detected', { delta, link: this, remoteNodeId: initiatorNodeId });
      }
    }

    // msgToVerify = bytes 0..200 (the signed portion = all fields except the signature itself)
    const msgToVerify = payload.slice(0, 201);
    if (!verifySignature(initiatorSigningPubkey, new Uint8Array(msgToVerify), new Uint8Array(signature))) {
      this._penalizeUntrusted('HELLO signature verification failed');
      this.destroy(new Error('HELLO signature verification failed'));
      return;
    }

    this.remoteNodeId = initiatorNodeId;
    this.remoteStaticPubkey = initiatorStaticPubkey;
    this.remoteSigningPubkey = initiatorSigningPubkey;

    this.initiatorNonce = initiatorNonce;
    this.initiatorEphemeralPubkey = initiatorEphemeralPubkey;

    // Derive shared session keys using ephemeral X25519 ECDH
    const sharedSecret = x25519DeriveSharedSecret(
      new Uint8Array(this.ephemeralKeyPair.ephemeralPriv),
      new Uint8Array(initiatorEphemeralPubkey)
    );

    const { initiatorKey, responderKey } = deriveSessionKeys(
      sharedSecret,
      new Uint8Array(initiatorNodeId),
      new Uint8Array(this.identity.nodeId)
    );

    // As responder: sendKey = responderKey, recvKey = initiatorKey
    this.sendKey = Buffer.from(responderKey);
    this.recvKey = Buffer.from(initiatorKey);

    // Nonce store uniqueness check (Phase 2a persisted check)
    if (this.nonceStore) {
      const nsResult = this.nonceStore.checkNonce(this.remoteNodeId, fingerprintKey(this.sendKey), 0);
      if (!nsResult.valid) {
        logger.error('link', 'security-nonce-check-failed', `Nonce store check failed: ${nsResult.reason}`, {
          reason: nsResult.reason
        });
        this._penalizeUntrusted(`Nonce store check failed: ${nsResult.reason}`);
        this.destroy(new Error(`Nonce store check failed: ${nsResult.reason}`));
        return;
      }
    }

    // Session key uniqueness check (Phase 2a)
    const keyFingerprint = fingerprintKey(this.sendKey);
    if (this.sessionKeyLRUSet) {
      if (this.sessionKeyLRUSet.has(keyFingerprint)) {
        logger.error('link', 'security-duplicate-session-key', `Duplicate session key detected for peer ${Buffer.from(initiatorNodeId).toString('hex').slice(0, 16)}...`);
        this._penalizeUntrusted('Session key reuse detected');
        this.destroy(new Error('Session key reuse detected - possible attack or crypto bug'));
        return;
      }
      this.sessionKeyLRUSet.add(keyFingerprint);
    }

    // Encrypt the initiator's nonce as proof-of-key using responder's send key
    // This proves we (responder) successfully derived the session key
    const encryptedProof = encryptAESGCM(
      this.sendKey,
      this.sendNonceCounter,
      Buffer.from(initiatorNonce),
      null  // No AAD for the proof encryption in Phase 1
    );
    this.sendNonceCounter++;
    this._updateNonceStore();

    await this._sendHELLO_ACK(encryptedProof);
    this.state = 'connected';
    this._startPingTimer();
    this.emit('connected', { peerNodeId: this.remoteNodeId });
  }

  async _handleHELLO_ACK(payload) {
    if (this.state !== 'handshaking') { return; }

    if (payload.length !== HELLO_ACK_PAYLOAD_LEN) {
      this.destroy(new Error(`Invalid HELLO_ACK payload length: ${payload.length}, expected ${HELLO_ACK_PAYLOAD_LEN}`));
      return;
    }

    // Parse HELLO_ACK message fields
    const responderNodeId = payload.slice(0, 64);
    const responderNodeIdHex = Buffer.from(responderNodeId).toString('hex');
    const remoteIp = this.socket ? this.socket.remoteAddress : null;

    if (this.node && this.node.reputation && this.node.reputation.isBanned(responderNodeIdHex, remoteIp)) {
      this.destroy(new Error('Peer is banned'));
      return;
    }

    const responderStaticPubkey = payload.slice(64, 96);
    const responderSigningPubkey = payload.slice(96, 128);
    const responderEphemeralPubkey = payload.slice(128, 160);
    const timestamp = Number(payload.readBigUInt64BE(160));
    const encryptedProof = payload.slice(168, 216); // 48 bytes: 16 tag + 32 ciphertext
    const signature = payload.slice(216, 280);

    // Verify NodeID = SHA-512(staticPubkey) or SHA-512(signingPubkey) (to support rotated identities) using timing-safe bufferEquals
    const computedNodeIdX = sha512(responderStaticPubkey);
    const computedNodeIdEd = sha512(responderSigningPubkey);
    if (!bufferEquals(computedNodeIdX, responderNodeId) && !bufferEquals(computedNodeIdEd, responderNodeId)) {
      this._penalizeSuspicious('HELLO_ACK NodeID does not match SHA-512(staticPubkey) or SHA-512(signingPubkey)');
      this.destroy(new Error('HELLO_ACK NodeID does not match SHA-512(staticPubkey) or SHA-512(signingPubkey)'));
      return;
    }

    // Verify timestamp
    const now = this.node ? this.node.now() : Date.now();
    const delta = Math.abs(now - timestamp);
    const windowMs = this.node ? this.node.timestampWindowMs : 120000;
    if (delta > windowMs) {
      this._penalizeSuspicious('HELLO_ACK timestamp out of range');
      this.destroy(new Error('HELLO_ACK timestamp out of range'));
      return;
    }

    if (delta > 5 * 60 * 1000) {
      this.emit('clock-skew-detected', { delta, remoteNodeId: responderNodeId });
      if (this.node) {
        this.node.emit('clock-skew-detected', { delta, link: this, remoteNodeId: responderNodeId });
      }
    }

    // Verify signature over signed portion (bytes 0..215)
    // Signature is at offset 216, so signed portion is 0..215 (216 bytes)
    const signedPortion = payload.slice(0, 216);
    const sig = payload.slice(216, 280);
    if (!verifySignature(responderSigningPubkey, new Uint8Array(signedPortion), new Uint8Array(sig))) {
      this._penalizeUntrusted('HELLO_ACK signature verification failed');
      this.destroy(new Error('HELLO_ACK signature verification failed'));
      return;
    }

    this.remoteNodeId = responderNodeId;
    this.remoteStaticPubkey = responderStaticPubkey;
    this.remoteSigningPubkey = responderSigningPubkey;

    // Derive shared session keys using ephemeral X25519 ECDH
    const sharedSecret = x25519DeriveSharedSecret(
      new Uint8Array(this.ephemeralKeyPair.ephemeralPriv),
      new Uint8Array(responderEphemeralPubkey)
    );

    // As initiator (isInitiator=true), we are the "initiator" in protocol terms
    // initiatorInfo binds keys to (initiatorNodeId, responderNodeId)
    const { initiatorKey, responderKey } = deriveSessionKeys(
      sharedSecret,
      new Uint8Array(this.identity.nodeId),
      new Uint8Array(responderNodeId)
    );

    // As initiator: sendKey = initiatorKey, recvKey = responderKey
    this.sendKey = Buffer.from(initiatorKey);
    this.recvKey = Buffer.from(responderKey);

    // Nonce store uniqueness check (Phase 2a persisted check)
    if (this.nonceStore) {
      const nsResult = this.nonceStore.checkNonce(this.remoteNodeId, fingerprintKey(this.sendKey), 0);
      if (!nsResult.valid) {
        logger.error('link', 'security-nonce-check-failed', `Nonce store check failed: ${nsResult.reason}`, {
          reason: nsResult.reason
        });
        this._penalizeUntrusted(`Nonce store check failed: ${nsResult.reason}`);
        this.destroy(new Error(`Nonce store check failed: ${nsResult.reason}`));
        return;
      }
    }

    // Session key uniqueness check (Phase 2a)
    const keyFingerprint = fingerprintKey(this.sendKey);
    if (this.sessionKeyLRUSet) {
      if (this.sessionKeyLRUSet.has(keyFingerprint)) {
        logger.error('link', 'security-duplicate-session-key', `Duplicate session key detected for peer ${Buffer.from(responderNodeId).toString('hex').slice(0, 16)}...`);
        this._penalizeUntrusted('Session key reuse detected');
        this.destroy(new Error('Session key reuse detected - possible attack or crypto bug'));
        return;
      }
      this.sessionKeyLRUSet.add(keyFingerprint);
    }

    // Decrypt proof to verify session key derivation
    // The proof is the initiator's nonce, encrypted with the responder's key
    try {
      const decryptedProof = decryptAESGCM(
        this.recvKey,
        this.recvNonceCounter,
        Buffer.from(encryptedProof),
        null
      );
      this.recvNonceCounter++;
      this._updateNonceStore();

      // Verify the decrypted proof matches our original initiatorNonce
      if (!bufferEquals(Buffer.from(decryptedProof), Buffer.from(this.initiatorNonce))) {
        this._penalizeUntrusted('HELLO_ACK proof verification failed - nonce mismatch');
        this.destroy(new Error('HELLO_ACK proof verification failed - nonce mismatch'));
        return;
      }
    } catch (e) {
      this._penalizeUntrusted('HELLO_ACK proof decryption failed - possible replay or tampering');
      this.destroy(new Error('HELLO_ACK proof decryption failed - possible replay or tampering'));
      return;
    }

    this.state = 'connected';
    this._startPingTimer();
    this.emit('connected', { peerNodeId: this.remoteNodeId });
  }

  _handleDATA(payload) {
    if (this.state !== 'connected') return;

    try {
      const header = Buffer.alloc(5);
      writeUint32BE(header, payload.length - 16, 0); // payload includes 16-byte auth tag
      header[4] = MESSAGETYPES.DATA;

      const plaintext = decryptAESGCM(
        this.recvKey,
        this.recvNonceCounter,
        Buffer.from(payload),
        header
      );
      this.recvNonceCounter++;
      this._updateNonceStore();

      if (this.node && this.node.forwarder) {
        const result = this.node.forwarder.processIncoming(plaintext, this);
        if (result) {
          if (result.local) {
            this.node.handleIncomingRoutedPayload(result.sourceNodeId, result.payload);
          }
          return;
        }
      }

      this.emit('message', plaintext.toString('utf8'));
    } catch (e) {
      this._penalizeSuspicious('DATA decryption failed');
      this.destroy(new Error('DATA decryption failed'));
    }
  }

  _handlePING(payload) {
    if (this.state !== 'connected') return;
    try {
      const header = Buffer.alloc(5);
      writeUint32BE(header, payload.length - 16, 0);
      header[4] = MESSAGETYPES.PING;

      decryptAESGCM(this.recvKey, this.recvNonceCounter, Buffer.from(payload), header);
      this.recvNonceCounter++;
      this._updateNonceStore();
      this._sendPONG();
    } catch (e) {
      this._penalizeSuspicious('PING decryption failed');
      this.destroy(new Error('PING decryption failed'));
    }
  }

  _handlePONG(payload) {
    if (this.state !== 'connected') return;
    try {
      const header = Buffer.alloc(5);
      writeUint32BE(header, payload.length - 16, 0);
      header[4] = MESSAGETYPES.PONG;

      decryptAESGCM(this.recvKey, this.recvNonceCounter, Buffer.from(payload), header);
      this.recvNonceCounter++;
      this._updateNonceStore();
      this.lastPongReceived = true;
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
    } catch (e) {
      this._penalizeSuspicious('PONG decryption failed');
      this.destroy(new Error('PONG decryption failed'));
    }
  }

  async _sendHELLO() {
    // Generate fresh ephemeral keypair for this connection (provides forward secrecy)
    this.ephemeralKeyPair = generateEphemeralKeyPair();
    const timestamp = this.node ? this.node.now() : Date.now();
    const initiatorNonce = crypto.randomBytes(32);

    this.initiatorNonce = initiatorNonce;

    // Build the signed portion of HELLO (bytes 0..200 = 201 bytes)
    const signedPayload = Buffer.alloc(201);
    signedPayload[0] = 0x01;                                                    // 0: version (0x01)
    signedPayload.set(Buffer.from(this.identity.nodeId), 1);                    // 1-64: nodeId
    signedPayload.set(Buffer.from(this.identity.staticPubKey), 65);             // 65-96: staticPubkey
    signedPayload.set(Buffer.from(this.identity.signingPubKey), 97);            // 97-128: signingPubkey
    signedPayload.set(Buffer.from(this.ephemeralKeyPair.ephemeralPub), 129);   // 129-160: ephemeralPubkey
    signedPayload.writeBigUInt64BE(BigInt(timestamp), 161);                     // 161-168: timestamp
    signedPayload.set(initiatorNonce, 169);                                     // 169-200: nonce

    // Sign the signed portion with our Ed25519 signing key
    const signature = signMessage(
      new Uint8Array(this.identity.signingPrivKey),
      new Uint8Array(signedPayload)
    );

    // Build complete HELLO payload (265 bytes)
    const payload = Buffer.alloc(HELLO_PAYLOAD_LEN);
    payload.set(signedPayload, 0);
    payload.set(Buffer.from(signature), 201);

    await this._sendRawMessage(MESSAGETYPES.HELLO, payload);
  }

  async _sendHELLO_ACK(encryptedProof) {
    const timestamp = this.node ? this.node.now() : Date.now();

    // Build signed portion (bytes 0..215): all fields except signature
    // NodeID(64) + staticPub(32) + signingPub(32) + ephemeralPub(32) + timestamp(8) + encryptedProof(48) = 216
    const signedPayload = Buffer.alloc(216);
    signedPayload.set(Buffer.from(this.identity.nodeId), 0);
    signedPayload.set(Buffer.from(this.identity.staticPubKey), 64);
    signedPayload.set(Buffer.from(this.identity.signingPubKey), 96);
    signedPayload.set(Buffer.from(this.ephemeralKeyPair.ephemeralPub), 128);
    signedPayload.writeBigUInt64BE(BigInt(timestamp), 160);
    signedPayload.set(encryptedProof, 168);

    const signature = signMessage(
      new Uint8Array(this.identity.signingPrivKey),
      new Uint8Array(signedPayload)
    );

    // Build complete payload (280 bytes)
    const payload = Buffer.alloc(HELLO_ACK_PAYLOAD_LEN);
    payload.set(Buffer.from(this.identity.nodeId), 0);
    payload.set(Buffer.from(this.identity.staticPubKey), 64);
    payload.set(Buffer.from(this.identity.signingPubKey), 96);
    payload.set(Buffer.from(this.ephemeralKeyPair.ephemeralPub), 128);
    payload.writeBigUInt64BE(BigInt(timestamp), 160);
    payload.set(encryptedProof, 168);
    payload.set(Buffer.from(signature), 216);

    await this._sendRawMessage(MESSAGETYPES.HELLO_ACK, payload);
  }

  _sendPING() {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(0, 0); // Empty plaintext = 0 bytes
    header[4] = MESSAGETYPES.PING;

    const encryptedPayload = encryptAESGCM(this.sendKey, this.sendNonceCounter, Buffer.alloc(0), header);
    this.sendNonceCounter++;
    this._updateNonceStore();
    this._sendRawNoEncrypt(MESSAGETYPES.PING, encryptedPayload);

    this.lastPongReceived = false;
    this.pongTimer = setTimeout(() => {
      if (!this.lastPongReceived) {
        this.destroy(new Error('PONG timeout'));
      }
    }, this.pongTimeoutMs);
  }

  _sendPONG() {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(0, 0);
    header[4] = MESSAGETYPES.PONG;

    const encryptedPayload = encryptAESGCM(this.sendKey, this.sendNonceCounter, Buffer.alloc(0), header);
    this.sendNonceCounter++;
    this._updateNonceStore();
    this._sendRawNoEncrypt(MESSAGETYPES.PONG, encryptedPayload);
  }

  async send(data) {
    if (this.state !== 'connected') {
      throw new Error('Cannot send on non-connected link');
    }
    const header = Buffer.alloc(5);
    header.writeUInt32BE(Buffer.byteLength(data), 0);
    header[4] = MESSAGETYPES.DATA;

    const encryptedPayload = encryptAESGCM(
      this.sendKey,
      this.sendNonceCounter,
      Buffer.from(data, 'utf8'),
      header
    );
    this.sendNonceCounter++;
    this._updateNonceStore();
    await this._sendRawNoEncrypt(MESSAGETYPES.DATA, encryptedPayload);
  }

  _sendRawMessage(type, payload) {
    return new Promise((resolve, reject) => {
      const lenBuf = Buffer.alloc(4);
      writeUint32BE(lenBuf, payload.length, 0);
      const frame = Buffer.concat([lenBuf, Buffer.from([type]), payload]);
      this.socket.write(frame, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  _sendRawNoEncrypt(type, payload) {
    const lenBuf = Buffer.alloc(4);
    writeUint32BE(lenBuf, payload.length, 0);
    const frame = Buffer.concat([lenBuf, Buffer.from([type]), payload]);
    this.socket.write(frame);
  }

  _startPingTimer() {
    this.pingTimer = setInterval(() => {
      if (this.state === 'connected') {
        this._sendPING();
      }
    }, this.pingIntervalMs);
  }

  _handleClose() {
    this._cleanup();
    this.emit('close');
  }

  _cleanup() {
    this._updateNonceStore();
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.state = 'closed';
  }

  destroy(err) {
    this._cleanup();
    if (err) this.emit('error', err);
    try {
      this.socket.destroy();
    } catch (e) {}
  }

  _penalizeSuspicious(reason) {
    if (this.node && this.node.reputation) {
      const peerHex = this.remoteNodeId ? Buffer.from(this.remoteNodeId).toString('hex') : null;
      const remoteIp = this.socket ? this.socket.remoteAddress : null;
      this.node.reputation.penalize(peerHex, 10, reason, remoteIp);
    }
  }

  _penalizeUntrusted(reason) {
    if (this.node && this.node.reputation) {
      const peerHex = this.remoteNodeId ? Buffer.from(this.remoteNodeId).toString('hex') : null;
      const remoteIp = this.socket ? this.socket.remoteAddress : null;
      this.node.reputation.penalize(peerHex, 50, reason, remoteIp);
    }
  }

  _penalizeBanned(reason) {
    if (this.node && this.node.reputation) {
      const peerHex = this.remoteNodeId ? Buffer.from(this.remoteNodeId).toString('hex') : null;
      const remoteIp = this.socket ? this.socket.remoteAddress : null;
      this.node.reputation.penalize(peerHex, 100, reason, remoteIp);
    }
  }

  _handleBINDING_REQUEST(payload) {
    if (this.state !== 'connected') return;
    try {
      const header = Buffer.alloc(5);
      writeUint32BE(header, payload.length - 16, 0);
      header[4] = MESSAGETYPES.BINDING_REQUEST;

      decryptAESGCM(this.recvKey, this.recvNonceCounter, Buffer.from(payload), header);
      this.recvNonceCounter++;
      this._updateNonceStore();

      this._sendBINDING_RESPONSE();
    } catch (e) {
      this._penalizeSuspicious('BINDING_REQUEST decryption failed');
      this.destroy(new Error('BINDING_REQUEST decryption failed'));
    }
  }

  _sendBINDING_RESPONSE() {
    const remoteAddress = this.socket.remoteAddress;
    const remotePort = this.socket.remotePort;
    const dataStr = JSON.stringify({ address: remoteAddress, port: remotePort });
    const dataBuf = Buffer.from(dataStr, 'utf8');

    const header = Buffer.alloc(5);
    header.writeUInt32BE(dataBuf.length, 0);
    header[4] = MESSAGETYPES.BINDING_RESPONSE;

    const encryptedPayload = encryptAESGCM(
      this.sendKey,
      this.sendNonceCounter,
      dataBuf,
      header
    );
    this.sendNonceCounter++;
    this._updateNonceStore();
    this._sendRawNoEncrypt(MESSAGETYPES.BINDING_RESPONSE, encryptedPayload);
  }

  _handleBINDING_RESPONSE(payload) {
    if (this.state !== 'connected') return;
    try {
      const header = Buffer.alloc(5);
      writeUint32BE(header, payload.length - 16, 0);
      header[4] = MESSAGETYPES.BINDING_RESPONSE;

      const plaintext = decryptAESGCM(
        this.recvKey,
        this.recvNonceCounter,
        Buffer.from(payload),
        header
      );
      this.recvNonceCounter++;
      this._updateNonceStore();

      const info = JSON.parse(plaintext.toString('utf8'));
      this.emit('binding-response', info);
    } catch (e) {
      this._penalizeSuspicious('BINDING_RESPONSE decryption or parsing failed');
      this.destroy(new Error('BINDING_RESPONSE decryption or parsing failed'));
    }
  }

  sendBindingRequest() {
    if (this.state !== 'connected') {
      throw new Error('Cannot send binding request on non-connected link');
    }
    const header = Buffer.alloc(5);
    header.writeUInt32BE(0, 0);
    header[4] = MESSAGETYPES.BINDING_REQUEST;

    const encryptedPayload = encryptAESGCM(this.sendKey, this.sendNonceCounter, Buffer.alloc(0), header);
    this.sendNonceCounter++;
    this._updateNonceStore();
    this._sendRawNoEncrypt(MESSAGETYPES.BINDING_REQUEST, encryptedPayload);
  }

  _handleTOPOLOGY_ANNOUNCE(payload) {
    if (this.state !== 'connected') return;
    try {
      const header = Buffer.alloc(5);
      writeUint32BE(header, payload.length - 16, 0);
      header[4] = MESSAGETYPES.TOPOLOGY_ANNOUNCE;

      const plaintext = decryptAESGCM(
        this.recvKey,
        this.recvNonceCounter,
        Buffer.from(payload),
        header
      );
      this.recvNonceCounter++;
      this._updateNonceStore();

      const announce = JSON.parse(plaintext.toString('utf8'));
      if (this.node && this.node.topologyManager) {
        this.node.topologyManager.handleReceivedAnnounce(announce, this);
      }
    } catch (e) {
      this._penalizeSuspicious('TOPOLOGY_ANNOUNCE decryption failed');
      this.destroy(new Error('TOPOLOGY_ANNOUNCE decryption failed'));
    }
  }

  sendTopologyAnnounce(announce) {
    if (this.state !== 'connected') {
      throw new Error('Cannot send topology announce on non-connected link');
    }
    const dataStr = JSON.stringify(announce);
    const dataBuf = Buffer.from(dataStr, 'utf8');

    const header = Buffer.alloc(5);
    header.writeUInt32BE(dataBuf.length, 0);
    header[4] = MESSAGETYPES.TOPOLOGY_ANNOUNCE;

    const encryptedPayload = encryptAESGCM(
      this.sendKey,
      this.sendNonceCounter,
      dataBuf,
      header
    );
    this.sendNonceCounter++;
    this._updateNonceStore();
    this._sendRawNoEncrypt(MESSAGETYPES.TOPOLOGY_ANNOUNCE, encryptedPayload);
  }

  sendPeerRequest(maxPeers) {
    if (this.state !== 'connected') {
      throw new Error('Cannot send peer request on non-connected link');
    }
    const dataStr = JSON.stringify({ maxPeers });
    const dataBuf = Buffer.from(dataStr, 'utf8');

    const header = Buffer.alloc(5);
    header.writeUInt32BE(dataBuf.length, 0);
    header[4] = MESSAGETYPES.PEER_REQUEST;

    const encryptedPayload = encryptAESGCM(
      this.sendKey,
      this.sendNonceCounter,
      dataBuf,
      header
    );
    this.sendNonceCounter++;
    this._updateNonceStore();
    this._sendRawNoEncrypt(MESSAGETYPES.PEER_REQUEST, encryptedPayload);
  }

  sendPeerResponse(peers) {
    if (this.state !== 'connected') {
      throw new Error('Cannot send peer response on non-connected link');
    }
    const dataStr = JSON.stringify({ peers });
    const dataBuf = Buffer.from(dataStr, 'utf8');

    const header = Buffer.alloc(5);
    header.writeUInt32BE(dataBuf.length, 0);
    header[4] = MESSAGETYPES.PEER_RESPONSE;

    const encryptedPayload = encryptAESGCM(
      this.sendKey,
      this.sendNonceCounter,
      dataBuf,
      header
    );
    this.sendNonceCounter++;
    this._updateNonceStore();
    this._sendRawNoEncrypt(MESSAGETYPES.PEER_RESPONSE, encryptedPayload);
  }

  _handlePEER_REQUEST(payload) {
    if (this.state !== 'connected') return;
    try {
      const header = Buffer.alloc(5);
      writeUint32BE(header, payload.length - 16, 0);
      header[4] = MESSAGETYPES.PEER_REQUEST;

      const plaintext = decryptAESGCM(
        this.recvKey,
        this.recvNonceCounter,
        Buffer.from(payload),
        header
      );
      this.recvNonceCounter++;
      this._updateNonceStore();

      const msg = JSON.parse(plaintext.toString('utf8'));
      if (this.node && this.node.peerExchange) {
        this.node.peerExchange.handlePeerRequest(this, msg);
      }
    } catch (e) {
      this._penalizeSuspicious('PEER_REQUEST decryption failed');
      this.destroy(new Error('PEER_REQUEST decryption failed'));
    }
  }

  _handlePEER_RESPONSE(payload) {
    if (this.state !== 'connected') return;
    try {
      const header = Buffer.alloc(5);
      writeUint32BE(header, payload.length - 16, 0);
      header[4] = MESSAGETYPES.PEER_RESPONSE;

      const plaintext = decryptAESGCM(
        this.recvKey,
        this.recvNonceCounter,
        Buffer.from(payload),
        header
      );
      this.recvNonceCounter++;
      this._updateNonceStore();

      const msg = JSON.parse(plaintext.toString('utf8'));
      if (this.node && this.node.peerExchange) {
        this.node.peerExchange.handlePeerResponse(this, msg);
      }
    } catch (e) {
      this._penalizeSuspicious('PEER_RESPONSE decryption failed');
      this.destroy(new Error('PEER_RESPONSE decryption failed'));
    }
  }

  sendKeyRotation(cert, sequenceNumber, ttl) {
    if (this.state !== 'connected') {
      throw new Error('Cannot send key rotation on non-connected link');
    }
    const dataStr = JSON.stringify({ cert, sequenceNumber, ttl });
    const dataBuf = Buffer.from(dataStr, 'utf8');

    const header = Buffer.alloc(5);
    header.writeUInt32BE(dataBuf.length, 0);
    header[4] = MESSAGETYPES.KEY_ROTATION;

    const encryptedPayload = encryptAESGCM(
      this.sendKey,
      this.sendNonceCounter,
      dataBuf,
      header
    );
    this.sendNonceCounter++;
    this._updateNonceStore();
    this._sendRawNoEncrypt(MESSAGETYPES.KEY_ROTATION, encryptedPayload);
  }

  _handleKEY_ROTATION(payload) {
    if (this.state !== 'connected') return;
    try {
      const header = Buffer.alloc(5);
      writeUint32BE(header, payload.length - 16, 0);
      header[4] = MESSAGETYPES.KEY_ROTATION;

      const plaintext = decryptAESGCM(
        this.recvKey,
        this.recvNonceCounter,
        Buffer.from(payload),
        header
      );
      this.recvNonceCounter++;
      this._updateNonceStore();

      const msg = JSON.parse(plaintext.toString('utf8'));
      if (this.node && this.node.keyRotationManager) {
        this.node.keyRotationManager.handleReceivedRotation(msg, this);
      }
    } catch (e) {
      this._penalizeSuspicious('KEY_ROTATION decryption failed');
      this.destroy(new Error('KEY_ROTATION decryption failed'));
    }
  }

  sendRoutedDATA(finalDest, hopCount, payload, sourceNodeId) {
    if (this.state !== 'connected') {
      throw new Error('Cannot send on non-connected link');
    }

    const source = sourceNodeId || this.identity.nodeId.slice(0, 32);
    const dest = toHex(finalDest);
    const destBuf = Buffer.from(dest, 'hex').slice(0, 32);

    const plaintext = Buffer.alloc(1 + 32 + 32 + 1 + payload.length);
    plaintext[0] = 0x01; // isRouted
    plaintext.set(source, 1);
    plaintext.set(destBuf, 33);
    plaintext[65] = hopCount;
    plaintext.set(payload, 66);

    const header = Buffer.alloc(5);
    header.writeUInt32BE(plaintext.length, 0);
    header[4] = MESSAGETYPES.DATA;

    const encryptedPayload = encryptAESGCM(
      this.sendKey,
      this.sendNonceCounter,
      plaintext,
      header
    );
    this.sendNonceCounter++;
    this._updateNonceStore();
    this._sendRawNoEncrypt(MESSAGETYPES.DATA, encryptedPayload);
  }
}

class VirtualSocket extends EventEmitter {
  constructor({ node, sourceNodeId, destNodeId }) {
    super();
    this.node = node;
    this.sourceNodeId = sourceNodeId;
    this.destNodeId = destNodeId;
    this.remoteAddress = '127.0.0.1';
    this.remotePort = 0;
  }

  write(data, callback) {
    const destHex = toHex(this.destNodeId);
    const route = this.node.routingTable.getBestRoute(destHex);
    if (!route) {
      this.node.emit('no-route', { finalDestinationNodeId: Buffer.from(destHex, 'hex').slice(0, 32) });
      const err = new Error('no-route');
      this.emit('error', err);
      if (callback) callback(err);
      return;
    }

    const nextHopLink = this.node.getLinkByNodeId(route.nextHopNodeId);
    if (!nextHopLink || nextHopLink.state !== 'connected') {
      this.node.emit('no-route', { finalDestinationNodeId: Buffer.from(destHex, 'hex').slice(0, 32) });
      const err = new Error('no-route');
      this.emit('error', err);
      if (callback) callback(err);
      return;
    }

    try {
      nextHopLink.sendRoutedDATA(destHex, 16, data, this.node.identity.nodeId.slice(0, 32));
      if (callback) callback();
    } catch (e) {
      this.emit('error', e);
      if (callback) callback(e);
    }
  }

  destroy() {
    this.emit('close');
  }
}

class GMPNode extends EventEmitter {
  constructor({
    port = DEFAULT_PORT,
    rateLimiter = null,
    nonceStore = null,
    sessionKeyLRUSet = null,
    isPublicPeer = false,
    establishedPeers = new Set(),
    bindingRateLimiter = null,
    pingIntervalMs = null,
    pongTimeoutMs = null,
    forwardRateLimitMax = 500,
    forwardRateLimitWindowMs = 60000,
    announceIntervalMs = 60000,
    peerCachePath = null,
    publicPeersPath = null,
    minPeers = 3,
    bootstrapParallelCount = 5,
    disableBootstrap = !!(process.argv[1] && process.argv[1].includes('test')),
    seedPhrase = null,
    timestampWindowMs = 120000,
    reputationBanDurationMs = 24 * 60 * 60 * 1000,
    reputationRecoveryIntervalMs = 60 * 1000,
  } = {}) {
    super();
    this.port = port;
    this.server = null;
    this.links = new Map();
    this.identity = null;
    this.connections = new Map();
    this.rateLimiter = rateLimiter;
    this.nonceStore = nonceStore;
    this.sessionKeyLRUSet = sessionKeyLRUSet;
    this.isPublicPeer = isPublicPeer;
    this.establishedPeers = establishedPeers;
    this.bindingRateLimiter = bindingRateLimiter || (isPublicPeer ? new RateLimiter({
      windowMs: 60000,
      maxPerIp: 2,
      maxGlobal: 20,
    }) : null);
    this.pingIntervalMs = pingIntervalMs;
    this.pongTimeoutMs = pongTimeoutMs;

    this.forwardRateLimitMax = forwardRateLimitMax;
    this.forwardRateLimitWindowMs = forwardRateLimitWindowMs;
    this.timestampWindowMs = timestampWindowMs;

    // Phase 3 Modules
    this.routingTable = new RoutingTable();
    this.topologyManager = new TopologyManager(this, { announceIntervalMs });
    this.forwarder = new Forwarder(this);
    this.virtualConnections = new Map();

    // Key derivation for at-rest encryption
    let cacheKey = null;
    let nonceKey = null;
    if (seedPhrase) {
      cacheKey = crypto.pbkdf2Sync(seedPhrase, 'ghostlink-peer-cache-v1', 100000, 32, 'sha256');
      nonceKey = crypto.pbkdf2Sync(seedPhrase, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');
    }

    // Phase 4 Modules
    this.peerCache = new PeerCache({ filePath: peerCachePath });
    if (cacheKey) {
      this.peerCache.setEncryptionKey(cacheKey);
    }
    if (this.nonceStore && nonceKey) {
      this.nonceStore.setEncryptionKey(nonceKey);
    }

    this.peerExchange = new PeerExchangeManager(this);
    this.bootstrap = new BootstrapManager(this, { minPeers, parallelCount: bootstrapParallelCount, disableBootstrap, publicPeersPath });
    this.healthMonitor = new NetworkHealthMonitor(this);
    this.keyRotationManager = new KeyRotationManager(this);
    this.reputation = new ReputationManager(this, {
      banDurationMs: reputationBanDurationMs,
      recoveryIntervalMs: reputationRecoveryIntervalMs
    });

    // Record success in Peer Cache upon successful connection
    this.on('connection', ({ link, peerNodeId }) => {
      if (link && !link.isVirtual && peerNodeId) {
        const peerNodeIdHex = Buffer.from(peerNodeId).toString('hex');
        const address = link.socket.remoteAddress;
        const port = link.socket.remotePort;
        const signingPubKeyHex = link.remoteSigningPubkey ? Buffer.from(link.remoteSigningPubkey).toString('hex') : null;
        this.peerCache.recordSuccess(peerNodeIdHex, address, port, signingPubKeyHex);
      }
    });

    this.on('rate-limited', ({ ip, sourceNodeId }) => {
      if (this.reputation) {
        const nodeIdHex = sourceNodeId ? Buffer.from(sourceNodeId).toString('hex') : null;
        this.reputation.ban(nodeIdHex, ip, 'Rate limit exceeded');
      }
    });

    this._helloTimeoutHandler = ({ linkId }) => {
      const link = this.links.get(linkId);
      if (link) {
        link.destroy(new Error('HELLO timeout'));
      }
    };
    this._handshakeTimeoutHandler = ({ linkId }) => {
      const link = this.links.get(linkId);
      if (link) {
        link.destroy(new Error('Handshake timeout'));
      }
    };

    if (this.rateLimiter) {
      this._setupRateLimiterTimeoutHandlers(this.rateLimiter);
    }
    if (this.bindingRateLimiter) {
      this._setupRateLimiterTimeoutHandlers(this.bindingRateLimiter);
    }

    this.natType = 'UNKNOWN';
    this.natDetectionTimer = null;
  }

  _setupRateLimiterTimeoutHandlers(limiter) {
    limiter.on('hello-timeout', this._helloTimeoutHandler);
    limiter.on('handshake-timeout', this._handshakeTimeoutHandler);
  }

  _removeRateLimiterTimeoutHandlers(limiter) {
    if (limiter) {
      limiter.off('hello-timeout', this._helloTimeoutHandler);
      limiter.off('handshake-timeout', this._handshakeTimeoutHandler);
    }
  }

  now() {
    return Date.now();
  }

  async detectNATType(publicPeers, timeoutMs = 5000) {
    try {
      this.natType = await detectNATType(this, publicPeers, timeoutMs);
    } catch (e) {
      logger.warn('node', 'nat-detection-failed', `NAT type detection failed: ${e.message}`, { err: e.message });
      this.natType = 'UNKNOWN';
    }
    return this.natType;
  }

  startNATDetectionInterval(publicPeers, intervalMs = 10 * 60 * 1000) {
    this.stopNATDetectionInterval();
    
    // Run detection immediately
    this.detectNATType(publicPeers).catch(() => {});

    this.natDetectionTimer = setInterval(() => {
      this.detectNATType(publicPeers).catch(() => {});
    }, intervalMs);
  }

  stopNATDetectionInterval() {
    if (this.natDetectionTimer) {
      clearInterval(this.natDetectionTimer);
      this.natDetectionTimer = null;
    }
  }

  async loadIdentity(seedPhrase) {
    this.identity = await deriveIdentityFromSeedPhrase(seedPhrase);
    if (this.identity) {
      this.identity.nodeIdHex = Buffer.from(this.identity.nodeId).toString('hex');
    }
    const cacheKey = crypto.pbkdf2Sync(seedPhrase, 'ghostlink-peer-cache-v1', 100000, 32, 'sha256');
    const nonceKey = crypto.pbkdf2Sync(seedPhrase, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');
    if (this.peerCache) {
      this.peerCache.setEncryptionKey(cacheKey);
    }
    if (this.nonceStore) {
      this.nonceStore.setEncryptionKey(nonceKey);
    }
    return this.identity;
  }

  rotateKey(newKeypair) {
    if (!this.identity) throw new Error('Identity not loaded');

    const oldNodeId = this.identity.nodeIdHex;
    const oldSigningPrivKey = this.identity.signingPrivKey;

    const newPublicKey = newKeypair.signingPubKeyHex;
    const newNodeId = newKeypair.nodeIdHex || bytesToHex(sha512(hexToBytes(newPublicKey)));

    const rotationTimestamp = Date.now();
    const msg = oldNodeId + newPublicKey + rotationTimestamp;
    const signatureBytes = signMessage(oldSigningPrivKey, stringToBytes(msg));
    const signature = bytesToHex(signatureBytes);

    const cert = {
      oldNodeId,
      newPublicKey,
      newNodeId,
      rotationTimestamp,
      signature
    };

    // Flood the rotation certificate
    if (this.keyRotationManager) {
      this.keyRotationManager.floodRotation(cert);
    }

    // Switch node's operating identity
    this.identity.signingPrivKey = newKeypair.signingPrivKey;
    this.identity.signingPubKey = newKeypair.signingPubKey;
    this.identity.signingPubKeyHex = newKeypair.signingPubKeyHex;
    
    // Rotate to newNodeId
    const newNodeIdBytes = sha512(newKeypair.signingPubKey);
    this.identity.nodeId = newNodeIdBytes;
    this.identity.nodeIdHex = bytesToHex(newNodeIdBytes);

    if (newKeypair.staticPrivKey) this.identity.staticPrivKey = newKeypair.staticPrivKey;
    if (newKeypair.staticPubKey) this.identity.staticPubKey = newKeypair.staticPubKey;
    if (newKeypair.staticPubKeyHex) this.identity.staticPubKeyHex = newKeypair.staticPubKeyHex;

    return cert;
  }

  getLinkByNodeId(nodeId) {
    const targetHex = toHex(nodeId);
    for (const link of this.connections.values()) {
      if (link.state === 'connected' && link.remoteNodeId) {
        const peerHex = toHex(link.remoteNodeId);
        if (peerHex === targetHex) {
          return link;
        }
      }
    }
    return null;
  }

  async listen() {
    if (!this.identity) throw new Error('Identity not loaded');

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        if (this.reputation && this.reputation.isBanned(null, socket.remoteAddress)) {
          socket.destroy();
          return;
        }

        let activeLimiter = this.rateLimiter;
        if (this.isPublicPeer && this.bindingRateLimiter) {
          activeLimiter = this.bindingRateLimiter;
        }

        if (activeLimiter) {
          if (!activeLimiter.checkConnection(socket)) {
            socket.destroy();
            this.emit('rate-limited', { ip: socket.remoteAddress, type: activeLimiter === this.bindingRateLimiter ? 'binding' : 'standard' });
            return;
          }
        }

        const ephemeralKeyPair = generateEphemeralKeyPair();
        const link = new GMPLink({
          identity: this.identity,
          socket,
          isInitiator: false,
          ephemeralKeyPair,
          rateLimiter: activeLimiter,
          nonceStore: this.nonceStore,
          sessionKeyLRUSet: this.sessionKeyLRUSet,
          pingIntervalMs: this.pingIntervalMs,
          pongTimeoutMs: this.pongTimeoutMs,
          node: this,
          isVirtual: false
        });

        const connId = `incoming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.links.set(connId, link);

        if (activeLimiter) {
          activeLimiter.recordPendingConnection(socket, connId);
        }

        link.on('connected', ({ peerNodeId }) => {
          const peerNodeIdHex = Buffer.from(peerNodeId).toString('hex');
          if (this.isPublicPeer && this.establishedPeers && this.establishedPeers.has(peerNodeIdHex)) {
            if (this.bindingRateLimiter) {
              this.bindingRateLimiter.recordConnectionClosed(connId);
            }
            if (this.rateLimiter) {
              this.rateLimiter._globalCount++;
              this.rateLimiter.recordHandshakeComplete(connId);
            }
            link.rateLimiter = this.rateLimiter;
          } else {
            if (activeLimiter) {
              activeLimiter.recordHandshakeComplete(connId);
            }
          }

          this.connections.set(connId, link);
          
          if (!link.isVirtual) {
            this.topologyManager.handleLinkEstablished(peerNodeIdHex);
          }

          this.emit('connection', { connId, link, peerNodeId, type: 'incoming' });
        });

        link.on('message', (msg) => {
          this.emit('message', { connId, msg });
        });

        link.on('close', () => {
          this.links.delete(connId);
          this.connections.delete(connId);
          if (link.rateLimiter) {
            link.rateLimiter.recordConnectionClosed(connId);
          }
          if (!link.isVirtual && link.remoteNodeId) {
            const peerNodeIdHex = Buffer.from(link.remoteNodeId).toString('hex');
            this.topologyManager.handleLinkClosed(peerNodeIdHex);
            this.routingTable.removeRoutesVia(peerNodeIdHex);
          }
          this.emit('close', { connId });
          if (link.state === 'handshaking') {
            reject(new Error('Link closed during handshake'));
          }
        });

        link.on('error', (err) => {
          if (this.listenerCount('error') > 0) {
            this.emit('error', { connId, err });
          } else {
            logger.warn('node', 'link-error', `Link error on ${connId}: ${err.message}`, { connId, err: err.message });
          }
        });
      });

      this.server.on('error', reject);
      const bindHost = this.isPublicPeer ? '0.0.0.0' : '::';
      this.server.listen({ host: bindHost, port: this.port }, () => {
        this.bootstrap.start();
        resolve({ port: this.port });
      });
    });
  }

  async dial(address, port = DEFAULT_PORT, options = {}) {
    if (!this.identity) throw new Error('Identity not loaded');
    if (this.reputation && this.reputation.isBanned(null, address)) {
      throw new Error(`Target IP ${address} is banned`);
    }

    const useTls = options.tls || port === 443;

    return new Promise((resolve, reject) => {
      let settled = false;

      const connectOptions = { host: address, port };
      if (useTls) {
        connectOptions.servername = address;
        connectOptions.rejectUnauthorized = false; // verified cryptographically in protocol layer
      }      let socket;
      const connectionCallback = async () => {
        const ephemeralKeyPair = generateEphemeralKeyPair();
        const link = new GMPLink({
          identity: this.identity,
          socket,
          isInitiator: true,
          ephemeralKeyPair,
          rateLimiter: this.rateLimiter,
          nonceStore: this.nonceStore,
          sessionKeyLRUSet: this.sessionKeyLRUSet,
          pingIntervalMs: this.pingIntervalMs,
          pongTimeoutMs: this.pongTimeoutMs,
          node: this,
          isVirtual: false
        });

        const connId = `outgoing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.links.set(connId, link);

        if (this.rateLimiter) {
          this.rateLimiter.recordPendingConnection(socket, connId);
        }

        link.on('connected', ({ peerNodeId }) => {
          settled = true;
          const peerNodeIdHex = Buffer.from(peerNodeId).toString('hex');
          this.connections.set(connId, link);
          if (this.rateLimiter) {
            this.rateLimiter.recordHandshakeComplete(connId);
          }
          if (!link.isVirtual) {
            this.topologyManager.handleLinkEstablished(peerNodeIdHex);
          }
          this.emit('connection', { connId, link, peerNodeId, type: 'outgoing' });
          resolve({ connId, link, peerNodeId });
        });

        link.on('message', (msg) => {
          this.emit('message', { connId, msg });
        });

        link.on('close', () => {
          this.links.delete(connId);
          this.connections.delete(connId);
          if (link.rateLimiter) {
            link.rateLimiter.recordConnectionClosed(connId);
          }
          if (!link.isVirtual && link.remoteNodeId) {
            const peerNodeIdHex = Buffer.from(link.remoteNodeId).toString('hex');
            this.topologyManager.handleLinkClosed(peerNodeIdHex);
            this.routingTable.removeRoutesVia(peerNodeIdHex);
          }
          this.emit('close', { connId });
          if (!settled) {
            settled = true;
            reject(new Error('Link closed during handshake'));
          }
        });

        link.on('error', (err) => {
          if (this.listenerCount('error') > 0) {
            this.emit('error', { connId, err });
          }
          if (!settled) {
            settled = true;
            reject(err);
          }
        });

        try {
          await link._sendHELLO();
        } catch (e) {
          if (!settled) {
            settled = true;
            reject(e);
          }
        }
      };

      socket = useTls
        ? tls.connect(connectOptions, connectionCallback)
        : net.connect(connectOptions, connectionCallback);

      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  async dialWithSocket(socket) {
    if (!this.identity) throw new Error('Identity not loaded');

    return new Promise((resolve, reject) => {
      let settled = false;
      const ephemeralKeyPair = generateEphemeralKeyPair();
      const link = new GMPLink({
        identity: this.identity,
        socket,
        isInitiator: true,
        ephemeralKeyPair,
        rateLimiter: this.rateLimiter,
        nonceStore: this.nonceStore,
        sessionKeyLRUSet: this.sessionKeyLRUSet,
        pingIntervalMs: this.pingIntervalMs,
        pongTimeoutMs: this.pongTimeoutMs,
        node: this,
        isVirtual: false
      });

      const connId = `outgoing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.links.set(connId, link);

      if (this.rateLimiter) {
        this.rateLimiter.recordPendingConnection(socket, connId);
      }

      link.on('connected', ({ peerNodeId }) => {
        settled = true;
        const peerNodeIdHex = Buffer.from(peerNodeId).toString('hex');
        this.connections.set(connId, link);
        if (this.rateLimiter) {
          this.rateLimiter.recordHandshakeComplete(connId);
        }
        if (!link.isVirtual) {
          this.topologyManager.handleLinkEstablished(peerNodeIdHex);
        }
        this.emit('connection', { connId, link, peerNodeId, type: 'outgoing' });
        resolve({ connId, link, peerNodeId });
      });

      link.on('message', (msg) => {
        this.emit('message', { connId, msg });
      });

      link.on('close', () => {
        this.links.delete(connId);
        this.connections.delete(connId);
        if (link.rateLimiter) {
          link.rateLimiter.recordConnectionClosed(connId);
        }
        if (!link.isVirtual && link.remoteNodeId) {
          const peerNodeIdHex = Buffer.from(link.remoteNodeId).toString('hex');
          this.topologyManager.handleLinkClosed(peerNodeIdHex);
          this.routingTable.removeRoutesVia(peerNodeIdHex);
        }
        this.emit('close', { connId });
        if (!settled) {
          settled = true;
          reject(new Error('Link closed during handshake'));
        }
      });

      link.on('error', (err) => {
        if (this.listenerCount('error') > 0) {
          this.emit('error', { connId, err });
        }
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      link._sendHELLO().catch((e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
    });
  }

  async dialVirtual(destNodeId) {
    if (!this.identity) throw new Error('Identity not loaded');
    const destHex = toHex(destNodeId);
    if (this.reputation && this.reputation.isBanned(destHex)) {
      throw new Error(`Target peer NodeID ${destHex} is banned`);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new VirtualSocket({
        node: this,
        sourceNodeId: this.identity.nodeId,
        destNodeId: destNodeId
      });

      const ephemeralKeyPair = generateEphemeralKeyPair();
      const link = new GMPLink({
        identity: this.identity,
        socket,
        isInitiator: true,
        ephemeralKeyPair,
        rateLimiter: this.rateLimiter,
        nonceStore: this.nonceStore,
        sessionKeyLRUSet: this.sessionKeyLRUSet,
        pingIntervalMs: this.pingIntervalMs,
        pongTimeoutMs: this.pongTimeoutMs,
        node: this,
        isVirtual: true
      });

      const connId = `virtual-outgoing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.links.set(connId, link);

      const destHex = toHex(destNodeId).slice(0, 64);
      this.virtualConnections.set(destHex, link);

      const timeoutTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          link.destroy(new Error('Virtual handshake timeout'));
          reject(new Error('Virtual handshake timeout'));
        }
      }, 2000);

      link.on('connected', ({ peerNodeId }) => {
        settled = true;
        clearTimeout(timeoutTimer);
        const peerHex = toHex(peerNodeId).slice(0, 64);
        this.emit('connection', { connId, link, peerNodeId, type: 'outgoing' });
        resolve({ connId, link, peerNodeId });
      });

      link.on('message', (msg) => {
        this.emit('message', { connId, msg });
      });

      link.on('close', () => {
        clearTimeout(timeoutTimer);
        this.links.delete(connId);
        const peerHex = link.remoteNodeId ? toHex(link.remoteNodeId).slice(0, 64) : destHex;
        if (peerHex) this.virtualConnections.delete(peerHex);
        this.emit('close', { connId });
        if (!settled) {
          settled = true;
          reject(new Error('Link closed during handshake'));
        }
      });

      link.on('error', (err) => {
        clearTimeout(timeoutTimer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      link._sendHELLO().catch((e) => {
        clearTimeout(timeoutTimer);
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
    });
  }

  handleIncomingRoutedPayload(sourceNodeId, payload) {
    const sourceHex = toHex(sourceNodeId).slice(0, 64);
    let virtualLink = this.virtualConnections.get(sourceHex);

    if (!virtualLink) {
      const socket = new VirtualSocket({
        node: this,
        sourceNodeId: this.identity.nodeId,
        destNodeId: sourceNodeId
      });

      const ephemeralKeyPair = generateEphemeralKeyPair();
      virtualLink = new GMPLink({
        identity: this.identity,
        socket,
        isInitiator: false,
        ephemeralKeyPair,
        rateLimiter: this.rateLimiter,
        nonceStore: this.nonceStore,
        sessionKeyLRUSet: this.sessionKeyLRUSet,
        pingIntervalMs: this.pingIntervalMs,
        pongTimeoutMs: this.pongTimeoutMs,
        node: this,
        isVirtual: true
      });

      const connId = `virtual-incoming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.links.set(connId, virtualLink);
      this.virtualConnections.set(sourceHex, virtualLink);

      virtualLink.on('connected', ({ peerNodeId }) => {
        const peerHex = toHex(peerNodeId).slice(0, 64);
        this.emit('connection', { connId, link: virtualLink, peerNodeId, type: 'incoming' });
      });

      virtualLink.on('message', (msg) => {
        this.emit('message', { connId, msg });
      });

      virtualLink.on('close', () => {
        this.links.delete(connId);
        const peerHex = virtualLink.remoteNodeId ? toHex(virtualLink.remoteNodeId).slice(0, 64) : sourceHex;
        if (peerHex) this.virtualConnections.delete(peerHex);
        this.emit('close', { connId });
      });

      virtualLink.on('error', (err) => {
        if (this.listenerCount('error') > 0) {
          this.emit('error', { connId, err });
        }
      });
    }

    virtualLink.socket.emit('data', payload);
  }

  get bootstrapStatus() {
    if (this.bootstrap) {
      return {
        stage: this.bootstrap.stage,
        peersConnected: this.bootstrap.getDirectConnectionCount(),
        sufficient: this.bootstrap.getDirectConnectionCount() >= this.bootstrap.minPeers
      };
    }
    return { stage: 'failed', peersConnected: 0, sufficient: false };
  }

  getHealthReport() {
    if (this.healthMonitor) {
      return this.healthMonitor.getHealthReport();
    }
    return null;
  }

  close() {
    this.stopNATDetectionInterval();
    this._removeRateLimiterTimeoutHandlers(this.rateLimiter);
    this._removeRateLimiterTimeoutHandlers(this.bindingRateLimiter);

    if (this.topologyManager) {
      this.topologyManager.close();
    }
    if (this.routingTable) {
      this.routingTable.close();
    }
    if (this.peerCache) {
      this.peerCache.close();
    }
    if (this.peerExchange) {
      this.peerExchange.close();
    }
    if (this.bootstrap) {
      this.bootstrap.close();
    }
    if (this.healthMonitor) {
      this.healthMonitor.close();
    }
    if (this.keyRotationManager) {
      this.keyRotationManager.close();
    }
    if (this.reputation) {
      this.reputation.close();
    }

    for (const link of this.links.values()) {
      link.destroy();
    }
    this.links.clear();
    this.connections.clear();
    this.virtualConnections.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.rateLimiter) {
      this.rateLimiter.close();
    }
    if (this.bindingRateLimiter) {
      this.bindingRateLimiter.close();
    }
    if (this.nonceStore) {
      this.nonceStore.close();
    }
  }
}

export { GMPNode, GMPLink, MESSAGETYPES, DEFAULT_PORT, SessionKeyLRUSet };