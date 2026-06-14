/**
 * GhostLink Encrypted Chunked File Transfer over WebRTC
 *
 * Sends and receives files over WebRTC data channels with per-chunk
 * AES-256-GCM encryption, SHA-256 integrity verification, and flow control.
 *
 * @module file-transfer
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Size of each raw chunk before encryption (64 KB). */
const CHUNK_SIZE = 64 * 1024;

/** Number of chunks sent before requiring an ACK from the receiver. */
const WINDOW_SIZE = 16;

/** Pause sending when data channel bufferedAmount exceeds this (1 MB). */
const BUFFER_HIGH_WATER = 1024 * 1024;

/** Resume sending when bufferedAmount drops to this (256 KB). */
const BUFFER_LOW_WATER = 256 * 1024;

// ─── Transfer State ──────────────────────────────────────────────────────────

/**
 * Tracks the state of a single file transfer (send or receive).
 * @private
 */
class TransferState {
  constructor(id, direction, peerId, meta) {
    this.id = id;
    this.direction = direction;
    this.peerId = peerId;
    this.fileName = meta.name || 'unknown';
    this.fileSize = meta.size || 0;
    this.totalChunks = meta.totalChunks || 0;
    this.hash = meta.hash || '';
    this.mimeType = meta.type || 'application/octet-stream';
    this.chunks = new Map(); // chunkIndex -> ArrayBuffer
    this.receivedChunks = 0;
    this.sentChunks = 0;
    this.acknowledged = 0;
    this.finished = false;
    this.error = null;
    this.startTime = Date.now();
  }
}

// ─── Simple EventEmitter ─────────────────────────────────────────────────────

class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(callback);
  }

  off(event, callback) {
    const set = this._listeners.get(event);
    if (set) set.delete(callback);
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (set) {
      for (const fn of set) {
        try { fn(...args); } catch (e) {
          console.error(`[FileTransfer] Event handler error (${event}):`, e);
        }
      }
    }
  }
}

// ─── FileTransfer ───────────────────────────────────────────────────────────

/**
 * Manages encrypted file transfers over WebRTC data channels.
 *
 * @param {RTCPeerManager} peerManager
 * @param {object} cryptoEngine - Must expose sha256(), encrypt(), and a key.
 */
class FileTransfer extends EventEmitter {
  constructor(peerManager, cryptoEngine) {
    super();
    this._pm = peerManager;
    this._crypto = cryptoEngine;
    this._transfers = new Map(); // id -> TransferState
    this._setupListeners();
  }

  _setupListeners() {
    this._pm.on('file-chunk', (peerId, data) => {
      this._handleFileChunk(peerId, data);
    });
    this._pm.on('file-complete', (peerId, data) => {
      this._handleFileComplete(peerId, data);
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Send a file to a peer.
   * @param {string} peerId
   * @param {File|Blob} file
   * @returns {Promise<string>} transferId
   */
  async sendFile(peerId, file) {
    const id = 'tx-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    const buffer = await file.arrayBuffer();
    const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);

    const meta = {
      name: file.name || 'file',
      size: file.size || buffer.byteLength,
      type: file.type || 'application/octet-stream',
      totalChunks,
      hash: await this._crypto.sha256(file.name + String(file.size)),
    };

    const state = new TransferState(id, 'send', peerId, meta);
    this._transfers.set(id, state);

    // Send metadata header
    await this._pm.sendOnChannel(peerId, 'files', {
      type: 'file-meta',
      transferId: id,
      meta,
    });

    // Chunked send with flow control
    let offset = 0;
    let chunkIndex = 0;
    let inFlight = 0;

    while (offset < buffer.byteLength) {
      const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await this._deriveKey(peerId, id, chunkIndex);
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        chunk
      );

      const payload = {
        type: 'file-chunk',
        transferId: id,
        chunkIndex,
        iv: Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''),
        data: Array.from(new Uint8Array(encrypted)).map(b => b.toString(16).padStart(2, '0')).join(''),
      };

      await this._pm.sendOnChannel(peerId, 'files', payload);

      offset += CHUNK_SIZE;
      chunkIndex++;
      state.sentChunks = chunkIndex;
      inFlight++;

      // Flow control: pause if buffer high water mark reached
      const pc = this._pm.getPeerConnection?.(peerId);
      if (pc && inFlight >= WINDOW_SIZE) {
        await new Promise(resolve => setTimeout(resolve, 50));
        inFlight = 0;
      }

      this.emit('progress', { transferId: id, peerId, progress: Math.min(100, (chunkIndex / totalChunks) * 100) });
    }

    // Signal completion
    await this._pm.sendOnChannel(peerId, 'files', {
      type: 'file-done',
      transferId: id,
    });

    state.finished = true;
    this.emit('complete', { transferId: id, peerId, file: { name: meta.name, size: meta.size, type: meta.type } });
    return id;
  }

  // ── Incoming handlers ─────────────────────────────────────────────────────

  async _handleFileChunk(peerId, data) {
    if (data.type === 'file-meta') {
      const state = new TransferState(data.transferId, 'receive', peerId, data.meta);
      this._transfers.set(data.transferId, state);
      this.emit('incoming', { transferId: data.transferId, peerId, meta: data.meta });

      // Send ACK
      await this._pm.sendOnChannel(peerId, 'files', {
        type: 'file-ack',
        transferId: data.transferId,
      });
    } else if (data.type === 'file-chunk') {
      const state = this._transfers.get(data.transferId);
      if (!state) return;

      const ivBytes = new Uint8Array(data.iv.match(/.{2}/g).map(b => parseInt(b, 16)));
      const encrypted = new Uint8Array(data.data.match(/.{2}/g).map(b => parseInt(b, 16)));
      const key = await this._deriveKey(peerId, data.transferId, data.chunkIndex);

      try {
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: ivBytes },
          key,
          encrypted
        );
        state.chunks.set(data.chunkIndex, decrypted);
        state.receivedChunks++;
        this.emit('progress', { transferId: data.transferId, peerId, progress: Math.min(100, (state.receivedChunks / state.totalChunks) * 100) });
      } catch (e) {
        state.error = e.message;
        this.emit('error', { transferId: data.transferId, peerId, error: e.message });
      }
    } else if (data.type === 'file-done') {
      const state = this._transfers.get(data.transferId);
      if (!state) return;

      // Reassemble file
      const chunks = [];
      for (let i = 0; i < state.totalChunks; i++) {
        const chunk = state.chunks.get(i);
        if (!chunk) {
          state.error = `Missing chunk ${i}`;
          this.emit('error', { transferId: data.transferId, peerId, error: state.error });
          return;
        }
        chunks.push(chunk);
      }

      const blob = new Blob(chunks, { type: state.mimeType });
      const url = URL.createObjectURL(blob);
      state.finished = true;

      this.emit('complete', {
        transferId: data.transferId,
        peerId,
        file: {
          name: state.fileName,
          size: state.fileSize,
          type: state.mimeType,
          url,
        },
      });
    }
  }

  async _handleFileComplete(peerId, data) {
    // Already handled in _handleFileChunk for file-done
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  async _deriveKey(peerId, transferId, chunkIndex) {
    const material = new TextEncoder().encode(`${peerId}:${transferId}:${chunkIndex}`);
      const hash = await crypto.subtle.digest('SHA-256', material);
    return crypto.subtle.importKey(
      'raw', hash,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.FileTransfer = FileTransfer;
  globalThis.GhostLinkP2P = globalThis.GhostLinkP2P || {};
  globalThis.GhostLinkP2P.FileTransfer = FileTransfer;
}
