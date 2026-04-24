/**
 * GhostLink Signal Protocol Integration
 *
 * This module wraps the Signal Protocol (X3DH + Double Ratchet) for use
 * with the WebRTC manager. It provides forward secrecy and future secrecy
 * for all messages.
 *
 * Usage:
 *   import SignalCrypto from './SignalCrypto';
 *   const signalCrypto = new SignalCrypto();
 *   await signalCrypto.init();
 *
 *   // When connecting to a peer:
 *   const { initialMessage, preKeyBundle } = await signalCrypto.createSession(peerId);
 *
 *   // When receiving a session init:
 *   await signalCrypto.acceptSession(peerId, theirInitialMessage);
 *
 *   // Encrypt/decrypt messages:
 *   const encrypted = await signalCrypto.encrypt(peerId, plaintext);
 *   const decrypted = await signalCrypto.decrypt(peerId, encryptedEnvelope);
 */

import { X3DH, DoubleRatchet, SessionManager } from '../crypto/signal-protocol.js';

const SignalCrypto = {
  _sessionManager: null,
  _keysReady: false,

  async init(otpkCount = 100) {
    this._sessionManager = new SessionManager();
    await this._sessionManager.init(otpkCount);
    this._keysReady = true;
    return this.getPreKeyBundle();
  },

  getPreKeyBundle() {
    if (!this._keysReady) {
      throw new Error('SignalCrypto not initialized. Call init() first.');
    }
    return this._sessionManager.x3dh.getPreKeyBundle();
  },

  async createSession(peerId, theirPreKeyBundle) {
    if (!this._keysReady) {
      throw new Error('SignalCrypto not initialized. Call init() first.');
    }
    return this._sessionManager.createSession(peerId, theirPreKeyBundle);
  },

  async acceptSession(peerId, initialMessage) {
    if (!this._keysReady) {
      throw new Error('SignalCrypto not initialized. Call init() first.');
    }
    return this._sessionManager.acceptSession(peerId, initialMessage);
  },

  hasSession(peerId) {
    return this._sessionManager.getSession(peerId) !== undefined;
  },

  async encrypt(peerId, plaintext) {
    if (!this._sessionManager) {
      throw new Error('SignalCrypto not initialized. Call init() first.');
    }
    const envelope = await this._sessionManager.encryptMessage(peerId, plaintext);
    return {
      header: envelope.header,
      ciphertext: arrayBufferToBase64(envelope.ciphertext),
      nonce: arrayBufferToBase64(envelope.nonce),
    };
  },

  async decrypt(peerId, envelope) {
    if (!this._sessionManager) {
      throw new Error('SignalCrypto not initialized. Call init() first.');
    }
    const plaintext = await this._sessionManager.decryptMessage(peerId, {
      header: envelope.header,
      ciphertext: base64ToArrayBuffer(envelope.ciphertext),
      nonce: base64ToArrayBuffer(envelope.nonce),
    });
    return plaintext;
  },

  async exportState() {
    if (!this._sessionManager) {
      return null;
    }
    return this._sessionManager.exportSessions();
  },

  async importState(state) {
    if (!this._sessionManager) {
      throw new Error('SignalCrypto not initialized. Call init() first.');
    }
    await this._sessionManager.importSessions(state);
  },
};

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export default SignalCrypto;
export { SignalCrypto };
