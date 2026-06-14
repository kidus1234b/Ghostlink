(function(exports) {
  'use strict';

  const EVENTS = {
    VOICE_SEND_START: 'voice:send-start',
    VOICE_SEND_PROGRESS: 'voice:send-progress',
    VOICE_SEND_COMPLETE: 'voice:send-complete',
    VOICE_SEND_ERROR: 'voice:send-error',
    VOICE_RECEIVE_START: 'voice:receive-start',
    VOICE_RECEIVE_PROGRESS: 'voice:receive-progress',
    VOICE_RECEIVE_COMPLETE: 'voice:receive-complete',
    VOICE_RECEIVE_ERROR: 'voice:receive-error'
  };

  const TRANSFER_STATE = {
    IDLE: 'idle',
    ENCRYPTING: 'encrypting',
    CHUNKING: 'chunking',
    TRANSFERRING: 'transferring',
    RECEIVING: 'receiving',
    DECRYPTING: 'decrypting',
    REASSEMBLING: 'reassembling',
    COMPLETE: 'complete',
    ERROR: 'error'
  };

  const CONFIG = {
    CHUNK_SIZE: 64 * 1024,
    MAX_CHUNK_RETRIES: 3,
    CHUNK_TIMEOUT_MS: 30000,
    HASH_ALGORITHM: 'SHA-256',
    AES_KEY_LENGTH: 256,
    AES_IV_LENGTH: 12,
    METADATA_VERSION: 1,
    TRANSFER_cleanup_DELAY: 5000,
    PARTIAL_RECOVERY_ENABLED: true
  };

  class VoiceTransferManager {
    constructor(eventBus, fileTransferManager) {
      this._eventBus = eventBus || window.GhostLink?.EventBus || window.GhostLink?.globalBus;
      this._fileTransferManager = fileTransferManager;
      this._state = TRANSFER_STATE.IDLE;
      this._isDestroyed = false;
      this._activeTransfers = new Map();
      this._pendingChunks = new Map();
      this._receivedChunks = new Map();
      this._cryptoKey = null;
      this._timeoutCleanupTimers = new Map();
      this._retryCount = new Map();

      this._boundHandleChunkAck = this._handleChunkAck.bind(this);
      this._boundHandleChunkNack = this._handleChunkNack.bind(this);
    }

    async sendVoiceMessage(peerId, blob, duration, waveformData) {
      if (this._isDestroyed) {
        throw new Error('VoiceTransferManager has been destroyed');
      }

      if (!peerId || !blob) {
        throw new Error('Peer ID and blob are required');
      }

      const transferId = this._generateTransferId();
      this._activeTransfers.set(transferId, {
        peerId,
        blob,
        duration,
        waveformData,
        state: TRANSFER_STATE.ENCRYPTING,
        startTime: Date.now(),
        chunks: [],
        ackedChunks: new Set()
      });

      try {
        this._setState(TRANSFER_STATE.ENCRYPTING);

        const arrayBuffer = await blob.arrayBuffer();
        const key = await this._generateKey();
        const { ciphertext, iv } = await this.encryptBinary(arrayBuffer, key);

        this._setState(TRANSFER_STATE.CHUNKING);

        const chunks = this._chunkData(ciphertext);
        const hash = await this._computeHash(ciphertext);

        const metadata = {
          type: 'voice',
          version: CONFIG.METADATA_VERSION,
          duration: duration,
          chunks: chunks.length,
          waveform: waveformData,
          hash: hash,
          timestamp: Date.now(),
          transferId: transferId,
          mimeType: blob.type || 'audio/webm',
          totalSize: ciphertext.byteLength
        };

        this._setState(TRANSFER_STATE.TRANSFERRING);

        const metadataPacket = JSON.stringify(metadata);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const chunkData = {
            transferId,
            chunkIndex: i,
            totalChunks: chunks.length,
            data: chunk,
            metadata: metadataPacket,
            isLast: i === chunks.length - 1
          };

          await this._sendChunk(peerId, chunkData);
          this._activeTransfers.get(transferId).chunks.push(i);
        }

        this._activeTransfers.get(transferId).state = TRANSFER_STATE.COMPLETE;
        this._setState(TRANSFER_STATE.COMPLETE);

        this._emit(EVENTS.VOICE_SEND_COMPLETE, {
          transferId,
          peerId,
          duration,
          chunks: chunks.length
        });

        this._scheduleCleanup(transferId);

        return {
          transferId,
          metadata,
          key: await this._exportKey(key)
        };

      } catch (error) {
        this._activeTransfers.get(transferId).state = TRANSFER_STATE.ERROR;
        this._setState(TRANSFER_STATE.ERROR);

        this._emit(EVENTS.VOICE_SEND_ERROR, {
          transferId,
          peerId,
          error: error.message
        });

        throw error;
      }
    }

    async _sendChunk(peerId, chunkData) {
      const maxRetries = CONFIG.MAX_CHUNK_RETRIES;
      let attempt = 0;

      while (attempt < maxRetries) {
        try {
          const result = await this._fileTransferManager.sendFileChunk(
            peerId,
            chunkData.data,
            chunkData.chunkIndex,
            chunkData.totalChunks,
            {
              transferId: chunkData.transferId,
              metadata: chunkData.metadata,
              isLast: chunkData.isLast,
              type: 'voice'
            }
          );

          if (result && result.success) {
            return result;
          }

          attempt++;
        } catch (error) {
          attempt++;
          if (attempt >= maxRetries) {
            throw error;
          }
          await this._delay(100 * Math.pow(2, attempt));
        }
      }
    }

    async handleIncomingVoiceChunk(peerId, chunkData, metadata) {
      if (this._isDestroyed) {
        throw new Error('VoiceTransferManager has been destroyed');
      }

      const transferId = metadata.transferId || `${peerId}-${metadata.timestamp}`;

      if (!this._receivedChunks.has(transferId)) {
        this._receivedChunks.set(transferId, {
          peerId,
          chunks: new Map(),
          metadata,
          state: TRANSFER_STATE.RECEIVING,
          receivedCount: 0,
          totalChunks: metadata.chunks,
          startTime: Date.now()
        });

        this._emit(EVENTS.VOICE_RECEIVE_START, {
          transferId,
          peerId,
          totalChunks: metadata.chunks
        });
      }

      const transfer = this._receivedChunks.get(transferId);

      if (transfer.chunks.has(chunkData.chunkIndex)) {
        return { success: true, duplicate: true };
      }

      transfer.chunks.set(chunkData.chunkIndex, {
        data: chunkData,
        receivedAt: Date.now()
      });
      transfer.receivedCount++;

      this._emit(EVENTS.VOICE_RECEIVE_PROGRESS, {
        transferId,
        peerId,
        received: transfer.receivedCount,
        total: transfer.totalChunks,
        progress: transfer.receivedCount / transfer.totalChunks
      });

      this._resetChunkTimeout(transferId);

      if (transfer.receivedCount === transfer.totalChunks) {
        try {
          await this.reconstructVoiceMessage(transferId);
          return { success: true, complete: true };
        } catch (error) {
          this._emit(EVENTS.VOICE_RECEIVE_ERROR, {
            transferId,
            peerId,
            error: error.message
          });
          return { success: false, error: error.message };
        }
      }

      return { success: true, complete: false };
    }

    async reconstructVoiceMessage(transferId) {
      const transfer = this._receivedChunks.get(transferId);

      if (!transfer) {
        throw new Error(`Transfer ${transferId} not found`);
      }

      if (transfer.state === TRANSFER_STATE.REASSEMBLING) {
        return;
      }

      transfer.state = TRANSFER_STATE.REASSEMBLING;
      this._setState(TRANSFER_STATE.REASSEMBLING);

      const sortedChunks = Array.from(transfer.chunks.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([index, chunk]) => chunk.data.data);

      let combinedBuffer;

      if (sortedChunks.length === 1) {
        combinedBuffer = sortedChunks[0];
      } else {
        const totalLength = sortedChunks.reduce((sum, buf) => sum + buf.byteLength, 0);
        combinedBuffer = new Uint8Array(totalLength);
        let offset = 0;
        for (const buf of sortedChunks) {
          combinedBuffer.set(new Uint8Array(buf), offset);
          offset += buf.byteLength;
        }
        combinedBuffer = combinedBuffer.buffer;
      }

      this._setState(TRANSFER_STATE.DECRYPTING);

      const { metadata } = transfer;
      let decryptedBuffer = combinedBuffer;

      if (metadata.hash) {
        const computedHash = await this._computeHash(combinedBuffer);
        if (computedHash !== metadata.hash) {
          throw new Error('Voice message hash verification failed');
        }
      }

      const voiceMessage = {
        type: 'voice',
        transferId,
        peerId: transfer.peerId,
        duration: metadata.duration,
        waveformData: metadata.waveform,
        timestamp: metadata.timestamp,
        mimeType: metadata.mimeType,
        encryptedData: decryptedBuffer,
        metadata: metadata
      };

      transfer.state = TRANSFER_STATE.COMPLETE;
      this._setState(TRANSFER_STATE.COMPLETE);

      this._emit(EVENTS.VOICE_RECEIVE_COMPLETE, {
        transferId,
        peerId: transfer.peerId,
        duration: metadata.duration,
        message: voiceMessage
      });

      this._receivedChunks.delete(transferId);
      this._clearChunkTimeout(transferId);

      return voiceMessage;
    }

    async encryptBinary(arrayBuffer, key) {
      const iv = crypto.getRandomValues(new Uint8Array(CONFIG.AES_IV_LENGTH));

      const cryptoKey = await this._importKey(key);

      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        arrayBuffer
      );

      return {
        ciphertext: encrypted,
        iv: iv
      };
    }

    async decryptBinary(ciphertext, iv, key) {
      const cryptoKey = await this._importKey(key);

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(iv) },
        cryptoKey,
        ciphertext
      );

      return decrypted;
    }

    async _importKey(keyData) {
      let rawKey;

      if (typeof keyData === 'string') {
        const binaryString = atob(keyData);
        rawKey = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          rawKey[i] = binaryString.charCodeAt(i);
        }
      } else if (keyData instanceof Uint8Array) {
        rawKey = keyData;
      } else if (keyData instanceof ArrayBuffer) {
        rawKey = new Uint8Array(keyData);
      } else {
        rawKey = new Uint8Array(keyData);
      }

      return crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'AES-GCM', length: CONFIG.AES_KEY_LENGTH },
        false,
        ['encrypt', 'decrypt']
      );
    }

    async _generateKey() {
      return crypto.subtle.generateKey(
        { name: 'AES-GCM', length: CONFIG.AES_KEY_LENGTH },
        true,
        ['encrypt', 'decrypt']
      );
    }

    async _exportKey(key) {
      const exported = await crypto.subtle.exportKey('raw', key);
      return btoa(String.fromCharCode.apply(null, new Uint8Array(exported)));
    }

    _chunkData(arrayBuffer) {
      const chunks = [];
      const chunkSize = CONFIG.CHUNK_SIZE;
      const view = new DataView(arrayBuffer);
      let offset = 0;

      while (offset < arrayBuffer.byteLength) {
        const chunkEnd = Math.min(offset + chunkSize, arrayBuffer.byteLength);
        const chunk = new ArrayBuffer(chunkEnd - offset);
        const chunkView = new DataView(chunk);

        for (let i = 0; i < chunk.byteLength; i++) {
          chunkView.setUint8(i, view.getUint8(offset + i));
        }

        chunks.push(chunk);
        offset = chunkEnd;
      }

      return chunks;
    }

    async _computeHash(data) {
      const buffer = data instanceof ArrayBuffer ? data : data.buffer || data;
      const hashBuffer = await crypto.subtle.digest(CONFIG.HASH_ALGORITHM, buffer);
      const hashArray = new Uint8Array(hashBuffer);
      return btoa(String.fromCharCode.apply(null, hashArray));
    }

    async _handleChunkAck(peerId, chunkInfo) {
      const transferId = chunkInfo.transferId;
      const transfer = this._activeTransfers.get(transferId);

      if (transfer) {
        transfer.ackedChunks.add(chunkInfo.chunkIndex);
      }

      this._resetChunkTimeout(`${transferId}-${chunkInfo.chunkIndex}`);
    }

    async _handleChunkNack(peerId, chunkInfo) {
      const transferId = chunkInfo.transferId;
      const chunkIndex = chunkInfo.chunkIndex;
      const key = `${transferId}-${chunkIndex}`;

      const currentRetry = this._retryCount.get(key) || 0;

      if (currentRetry < CONFIG.MAX_CHUNK_RETRIES) {
        this._retryCount.set(key, currentRetry + 1);

        const transfer = this._activeTransfers.get(transferId);
        if (transfer && transfer.chunks[chunkIndex]) {
          await this._sendChunk(peerId, {
            transferId,
            chunkIndex,
            data: transfer.chunks[chunkIndex],
            metadata: null,
            isLast: chunkIndex === transfer.chunks.length - 1
          });
        }
      } else {
        this._emit(EVENTS.VOICE_SEND_ERROR, {
          transferId,
          peerId,
          error: `Chunk ${chunkIndex} failed after ${CONFIG.MAX_CHUNK_RETRIES} retries`
        });
      }
    }

    _generateTransferId() {
      return `voice-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    _setChunkTimeout(transferId, chunkIndex, timeoutMs = CONFIG.CHUNK_TIMEOUT_MS) {
      const key = `${transferId}-${chunkIndex}`;

      this._clearChunkTimeout(key);

      const timer = setTimeout(() => {
        this._handleChunkTimeout(transferId, chunkIndex);
      }, timeoutMs);

      this._timeoutCleanupTimers.set(key, timer);
    }

    _resetChunkTimeout(transferId, chunkIndex) {
      if (chunkIndex !== undefined) {
        const key = `${transferId}-${chunkIndex}`;
        this._clearChunkTimeout(key);
      } else {
        for (const [timerKey, timer] of this._timeoutCleanupTimers) {
          if (timerKey.startsWith(transferId)) {
            this._clearChunkTimeout(timerKey);
          }
        }
      }
    }

    _clearChunkTimeout(key) {
      const timer = this._timeoutCleanupTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        this._timeoutCleanupTimers.delete(key);
      }
    }

    _handleChunkTimeout(transferId, chunkIndex) {
      const transfer = this._activeTransfers.get(transferId);

      if (transfer && !transfer.ackedChunks.has(chunkIndex)) {
        const peerId = transfer.peerId;

        this._retryCount.set(`${transferId}-${chunkIndex}`,
          (this._retryCount.get(`${transferId}-${chunkIndex}`) || 0) + 1);

        this._emit(EVENTS.VOICE_SEND_ERROR, {
          transferId,
          peerId,
          error: `Chunk ${chunkIndex} timed out after ${CONFIG.MAX_CHUNK_RETRIES} retries`,
          code: 'CHUNK_TIMEOUT'
        });
      }
    }

    _setState(newState) {
      this._state = newState;
    }

    _emit(event, data) {
      if (this._eventBus) {
        this._eventBus.emit(event, data);
      }
    }

    _delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    _scheduleCleanup(transferId) {
      setTimeout(() => {
        this._activeTransfers.delete(transferId);
        this._receivedChunks.delete(transferId);

        for (const [key, timer] of this._timeoutCleanupTimers) {
          if (key.startsWith(transferId)) {
            clearTimeout(timer);
            this._timeoutCleanupTimers.delete(key);
          }
        }

        for (const key of this._retryCount.keys()) {
          if (key.startsWith(transferId)) {
            this._retryCount.delete(key);
          }
        }
      }, CONFIG.TRANSFER_cleanup_DELAY);
    }

    getState() {
      return this._state;
    }

    getActiveTransferCount() {
      return this._activeTransfers.size;
    }

    getPendingChunksCount() {
      return this._pendingChunks.size;
    }

    cancelTransfer(transferId) {
      const transfer = this._activeTransfers.get(transferId);

      if (transfer) {
        transfer.state = TRANSFER_STATE.ERROR;
        this._scheduleCleanup(transferId);
        return true;
      }

      const received = this._receivedChunks.get(transferId);
      if (received) {
        received.state = TRANSFER_STATE.ERROR;
        this._scheduleCleanup(transferId);
        return true;
      }

      return false;
    }

    async recoverPartialTransfer(transferId, availableChunks) {
      if (!CONFIG.PARTIAL_RECOVERY_ENABLED) {
        throw new Error('Partial recovery is disabled');
      }

      const transfer = this._receivedChunks.get(transferId);

      if (!transfer) {
        throw new Error(`Transfer ${transferId} not found`);
      }

      const missingChunks = [];
      for (let i = 0; i < transfer.totalChunks; i++) {
        if (!transfer.chunks.has(i)) {
          missingChunks.push(i);
        }
      }

      if (missingChunks.length === 0) {
        return this.reconstructVoiceMessage(transferId);
      }

      return {
        transferId,
        recovered: transfer.receivedCount,
        missing: missingChunks,
        total: transfer.totalChunks
      };
    }

    destroy() {
      if (this._isDestroyed) {
        return;
      }

      this._isDestroyed = true;

      for (const timer of this._timeoutCleanupTimers.values()) {
        clearTimeout(timer);
      }
      this._timeoutCleanupTimers.clear();

      this._activeTransfers.clear();
      this._pendingChunks.clear();
      this._receivedChunks.clear();
      this._retryCount.clear();
      this._cryptoKey = null;
      this._eventBus = null;
      this._fileTransferManager = null;
    }
  }

  exports.VoiceTransferManager = VoiceTransferManager;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);