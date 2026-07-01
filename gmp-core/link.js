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
import crypto from 'crypto';
import {
  deriveIdentityFromSeedPhrase,
  generateEphemeralKeyPair,
  x25519DeriveSharedSecret,
  deriveSessionKeys,
  signMessage,
  verifySignature,
  sha512,
} from './identity.js';
import { NonceStore } from './nonce-store.js';
import { RateLimiter } from './rate-limiter.js';
import { detectNATType } from './nat-detector.js';

const MESSAGETYPES = {
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  DATA: 0x03,
  PING: 0x04,
  PONG: 0x05,
  BINDING_REQUEST: 0x06,
  BINDING_RESPONSE: 0x07,
};

const DEFAULT_PORT = 49500;
const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 10000;
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_MESSAGE_SIZE = 1024 * 1024;
const SESSION_KEY_LRU_SIZE = 50;

const HELLO_PAYLOAD_LEN = 264;
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
  constructor({ identity, socket, isInitiator, ephemeralKeyPair, rateLimiter, nonceStore, sessionKeyLRUSet, pingIntervalMs, pongTimeoutMs }) {
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

    // Parse HELLO message fields
    const initiatorNodeId = payload.slice(0, 64);
    const initiatorStaticPubkey = payload.slice(64, 96);
    const initiatorSigningPubkey = payload.slice(96, 128);
    const initiatorEphemeralPubkey = payload.slice(128, 160);
    const timestamp = Number(payload.readBigUInt64BE(160));
    const initiatorNonce = payload.slice(168, 200);
    const signature = payload.slice(200, 264);

    // Verify NodeID = SHA-512(staticPubkey)
    const computedNodeId = sha512(initiatorStaticPubkey);
    if (!uint8ArrayEquals(computedNodeId, initiatorNodeId)) {
      this.destroy(new Error('HELLO NodeID does not match SHA-512(staticPubkey)'));
      return;
    }

    // Verify timestamp is within tolerance
    const now = Date.now();
    if (Math.abs(now - timestamp) > TIMESTAMP_TOLERANCE_MS) {
      this.destroy(new Error('HELLO timestamp out of range'));
      return;
    }

    // CHANGE: Signature verification - convert Uint8Array for noble-curves
    // msgToVerify = bytes 0..199 (the signed portion = all fields except the signature itself)
    const msgToVerify = payload.slice(0, 200);
    if (!verifySignature(initiatorSigningPubkey, new Uint8Array(msgToVerify), new Uint8Array(signature))) {
      this.destroy(new Error('HELLO signature verification failed'));
      return;
    }

    this.remoteNodeId = initiatorNodeId;
    this.remoteStaticPubkey = initiatorStaticPubkey;
    this.remoteSigningPubkey = initiatorSigningPubkey;

    // CHANGE: Store for proof construction and ECDH
    this.initiatorNonce = initiatorNonce;
    this.initiatorEphemeralPubkey = initiatorEphemeralPubkey;

    // Derive shared session keys using ephemeral X25519 ECDH
    // sharedSecret = X25519(localEphemeralPriv, initiatorEphemeralPub)
    const sharedSecret = x25519DeriveSharedSecret(
      new Uint8Array(this.ephemeralKeyPair.ephemeralPriv),
      new Uint8Array(initiatorEphemeralPubkey)
    );

    // deriveSessionKeys(sharedSecret, initiatorNodeId, responderNodeId)
    // As responder (isInitiator=false), we are the "responder" in protocol terms
    // initiatorInfo binds keys to (initiatorNodeId, responderNodeId)
    // CHANGE: Pass Uint8Array nodeIds
    const { initiatorKey, responderKey } = deriveSessionKeys(
      sharedSecret,
      new Uint8Array(initiatorNodeId),
      new Uint8Array(this.identity.nodeId)
    );

    // As responder: sendKey = responderKey (sends using responder's key),
    //              recvKey = initiatorKey (receives using initiator's key)
    this.sendKey = Buffer.from(responderKey);
    this.recvKey = Buffer.from(initiatorKey);

    // Nonce store uniqueness check (Phase 2a persisted check)
    if (this.nonceStore) {
      const nsResult = this.nonceStore.checkAndUpdate(this.remoteNodeId, this.sendKey, 0, 0);
      if (!nsResult.allowed) {
        console.error(`[GMPLink] CRITICAL SECURITY: Nonce store check failed: ${nsResult.reason}`);
        this.destroy(new Error(`Nonce store check failed: ${nsResult.reason}`));
        return;
      }
    }

    // Session key uniqueness check (Phase 2a)
    // If we've seen this exact session key before, refuse the connection.
    // This should NEVER happen in correct operation (ephemeral keys ensure uniqueness).
    // If it does, it indicates a serious bug or an attack.
    const keyFingerprint = fingerprintKey(this.sendKey);
    if (this.sessionKeyLRUSet) {
      if (this.sessionKeyLRUSet.has(keyFingerprint)) {
        console.error(`[GMPLink] CRITICAL SECURITY: Duplicate session key detected for peer ${Buffer.from(initiatorNodeId).toString('hex').slice(0, 16)}...`);
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
    // NodeID(64) + staticPub(32) + signingPub(32) + ephemeralPub(32) + timestamp(8) + encryptedProof(48) + sig(64)
    const responderNodeId = payload.slice(0, 64);
    const responderStaticPubkey = payload.slice(64, 96);
    const responderSigningPubkey = payload.slice(96, 128);
    const responderEphemeralPubkey = payload.slice(128, 160);
    const timestamp = Number(payload.readBigUInt64BE(160));
    const encryptedProof = payload.slice(168, 216); // 48 bytes: 16 tag + 32 ciphertext
    const signature = payload.slice(216, 280);

    // Verify NodeID = SHA-512(staticPubkey)
    const computedNodeId = sha512(responderStaticPubkey);
    if (!uint8ArrayEquals(computedNodeId, responderNodeId)) {
      this.destroy(new Error('HELLO_ACK NodeID does not match SHA-512(staticPubkey)'));
      return;
    }

    // Verify timestamp
    const now = Date.now();
    if (Math.abs(now - timestamp) > TIMESTAMP_TOLERANCE_MS) {
      this.destroy(new Error('HELLO_ACK timestamp out of range'));
      return;
    }

    // Verify signature over signed portion (bytes 0..215)
    // Signature is at offset 216, so signed portion is 0..215 (216 bytes)
    const signedPortion = payload.slice(0, 216);
    const sig = payload.slice(216, 280);
    if (!verifySignature(responderSigningPubkey, new Uint8Array(signedPortion), new Uint8Array(sig))) {
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
      const nsResult = this.nonceStore.checkAndUpdate(this.remoteNodeId, this.sendKey, 0, 0);
      if (!nsResult.allowed) {
        console.error(`[GMPLink] CRITICAL SECURITY: Nonce store check failed: ${nsResult.reason}`);
        this.destroy(new Error(`Nonce store check failed: ${nsResult.reason}`));
        return;
      }
    }

    // Session key uniqueness check (Phase 2a)
    const keyFingerprint = fingerprintKey(this.sendKey);
    if (this.sessionKeyLRUSet) {
      if (this.sessionKeyLRUSet.has(keyFingerprint)) {
        console.error(`[GMPLink] CRITICAL SECURITY: Duplicate session key detected for peer ${Buffer.from(responderNodeId).toString('hex').slice(0, 16)}...`);
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
        this.destroy(new Error('HELLO_ACK proof verification failed - nonce mismatch'));
        return;
      }
    } catch (e) {
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
      this.emit('message', plaintext.toString('utf8'));
    } catch (e) {
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
      this.destroy(new Error('PONG decryption failed'));
    }
  }

  async _sendHELLO() {
    // Generate fresh ephemeral keypair for this connection (provides forward secrecy)
    this.ephemeralKeyPair = generateEphemeralKeyPair();
    const timestamp = Date.now();
    const initiatorNonce = crypto.randomBytes(32);

    // CHANGE: Store nonce for later proof verification
    this.initiatorNonce = initiatorNonce;

    // Build the signed portion of HELLO (bytes 0..199)
    const signedPayload = Buffer.alloc(200);
    signedPayload.set(Buffer.from(this.identity.nodeId), 0);                    // 0-63: nodeId
    signedPayload.set(Buffer.from(this.identity.staticPubKey), 64);             // 64-95: staticPubkey
    signedPayload.set(Buffer.from(this.identity.signingPubKey), 96);            // 96-127: signingPubkey
    signedPayload.set(Buffer.from(this.ephemeralKeyPair.ephemeralPub), 128);   // 128-159: ephemeralPubkey
    signedPayload.writeBigUInt64BE(BigInt(timestamp), 160);                     // 160-167: timestamp
    signedPayload.set(initiatorNonce, 168);                                     // 168-199: nonce

    // Sign the signed portion with our Ed25519 signing key
    const signature = signMessage(
      new Uint8Array(this.identity.signingPrivKey),
      new Uint8Array(signedPayload)
    );

    // Build complete HELLO payload (264 bytes)
    const payload = Buffer.alloc(HELLO_PAYLOAD_LEN);
    payload.set(Buffer.from(this.identity.nodeId), 0);
    payload.set(Buffer.from(this.identity.staticPubKey), 64);
    payload.set(Buffer.from(this.identity.signingPubKey), 96);
    payload.set(Buffer.from(this.ephemeralKeyPair.ephemeralPub), 128);
    payload.writeBigUInt64BE(BigInt(timestamp), 160);
    payload.set(initiatorNonce, 168);
    payload.set(Buffer.from(signature), 200);

    await this._sendRawMessage(MESSAGETYPES.HELLO, payload);
  }

  async _sendHELLO_ACK(encryptedProof) {
    const timestamp = Date.now();

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

  async detectNATType(publicPeers, timeoutMs = 5000) {
    try {
      this.natType = await detectNATType(this, publicPeers, timeoutMs);
    } catch (e) {
      console.warn('[GMPNode] NAT type detection failed:', e.message);
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
    return this.identity;
  }

  async listen() {
    if (!this.identity) throw new Error('Identity not loaded');

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
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
          this.emit('close', { connId });
        });

        link.on('error', (err) => {
          if (this.listenerCount('error') > 0) {
            this.emit('error', { connId, err });
          } else {
            console.warn(`[GMPNode] Link error on ${connId}:`, err.message);
          }
        });
      });

      this.server.on('error', reject);
      this.server.listen({ host: '::', port: this.port }, () => {
        resolve({ port: this.port });
      });
    });
  }

  async dial(address, port = DEFAULT_PORT) {
    if (!this.identity) throw new Error('Identity not loaded');

    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: address, port }, async () => {
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
        });

        const connId = `outgoing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.links.set(connId, link);

        if (this.rateLimiter) {
          this.rateLimiter.recordPendingConnection(socket, connId);
        }

        link.on('connected', ({ peerNodeId }) => {
          this.connections.set(connId, link);
          if (this.rateLimiter) {
            this.rateLimiter.recordHandshakeComplete(connId);
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
          this.emit('close', { connId });
        });

        link.on('error', (err) => {
          if (this.listenerCount('error') > 0) {
            this.emit('error', { connId, err });
          }
          reject(err);
        });

        try {
          await link._sendHELLO();
        } catch (e) {
          reject(e);
        }
      });

      socket.on('error', reject);
    });
  }

  async dialWithSocket(socket) {
    if (!this.identity) throw new Error('Identity not loaded');

    return new Promise((resolve, reject) => {
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
      });

      const connId = `outgoing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.links.set(connId, link);

      if (this.rateLimiter) {
        this.rateLimiter.recordPendingConnection(socket, connId);
      }

      link.on('connected', ({ peerNodeId }) => {
        this.connections.set(connId, link);
        if (this.rateLimiter) {
          this.rateLimiter.recordHandshakeComplete(connId);
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
        this.emit('close', { connId });
      });

      link.on('error', (err) => {
        if (this.listenerCount('error') > 0) {
          this.emit('error', { connId, err });
        }
        reject(err);
      });

      link._sendHELLO().catch(reject);
    });
  }

  close() {
    this.stopNATDetectionInterval();
    this._removeRateLimiterTimeoutHandlers(this.rateLimiter);
    this._removeRateLimiterTimeoutHandlers(this.bindingRateLimiter);

    for (const link of this.links.values()) {
      link.destroy();
    }
    this.links.clear();
    this.connections.clear();
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