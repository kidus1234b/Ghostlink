(function(exports) {
  'use strict';

  const CHUNK_SIZE = 64 * 1024;
  const ACK_WINDOW = 16;
  const HIGH_WATER_MARK = ACK_WINDOW * 0.8;
  const LOW_WATER_MARK = ACK_WINDOW * 0.3;

  const SenderState = {
    IDLE: 'idle',
    SENDING: 'sending',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled'
  };

  const ReceiverState = {
    IDLE: 'idle',
    RECEIVING: 'receiving',
    ASSEMBLING: 'assembling',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled'
  };

  const TransferStatus = {
    PENDING: 'pending',
    IN_PROGRESS: 'in_progress',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    FAILED: 'failed'
  };

  class FileTransferManager {
    constructor({ eventBus, logger, connectionManager, keyManager }) {
      this.eventBus = eventBus;
      this.logger = logger;
      this.connectionManager = connectionManager;
      this.keyManager = keyManager;

      this.transfers = new Map();
      this.outgoingStreams = new Map();
      this.incomingStreams = new Map();
      this.pendingAcks = new Map();
      this.chunkBuffers = new Map();
      this.sequenceCounters = new Map();

      this.channel = null;
      this._setupChannel();
    }

    _setupChannel() {
      this.channel = this.connectionManager.getChannel('files');
      if (!this.channel) {
        this.logger.warn('Files channel not available');
        return;
      }

      this.channel.on('file-chunk', (data, peerId) => this._handleChunk(data, peerId));
      this.channel.on('file-metadata', (data, peerId) => this._handleMetadata(data, peerId));
      this.channel.on('file-ack', (data, peerId) => this._handleAck(data, peerId));
      this.channel.on('file-cancel', (data, peerId) => this._handleCancel(data, peerId));
      this.channel.on('file-pause', (data, peerId) => this._handlePause(data, peerId));
      this.channel.on('file-resume', (data, peerId) => this._handleResume(data, peerId));
    }

    async sendFile(peerId, file) {
      const transferId = this._generateTransferId();
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      const metadata = {
        transferId,
        peerId,
        filename: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        chunks: totalChunks,
        receivedChunks: 0,
        status: TransferStatus.PENDING,
        progress: 0,
        startTime: Date.now()
      };

      this.transfers.set(transferId, metadata);
      this.sequenceCounters.set(transferId, 0);
      this.pendingAcks.set(transferId, new Set());
      this.chunkBuffers.set(transferId, []);
      this.outgoingStreams.set(transferId, {
        file,
        offset: 0,
        state: SenderState.IDLE,
        paused: false,
        sentChunks: new Set()
      });

      this.logger.info(`Starting file transfer ${transferId} to ${peerId}: ${file.name} (${totalChunks} chunks)`);

      const metaMsg = {
        type: 'file-metadata',
        transferId,
        filename: file.name,
        fileSize: file.size,
        mimeType: file.mimeType,
        totalChunks
      };

      this.channel.send(metaMsg, peerId);

      this.eventBus.emit('file:start', { transferId, peerId, filename: file.name, fileSize: file.size });

      metadata.status = TransferStatus.IN_PROGRESS;
      const stream = this.outgoingStreams.get(transferId);
      stream.state = SenderState.SENDING;

      await this._sendChunks(transferId, peerId);

      return transferId;
    }

    async _sendChunks(transferId, peerId) {
      const stream = this.outgoingStreams.get(transferId);
      const metadata = this.transfers.get(transferId);
      const pendingAcks = this.pendingAcks.get(transferId);
      const sequence = this.sequenceCounters.get(transferId);

      while (stream.offset < stream.file.size && stream.state === SenderState.SENDING) {
        if (stream.paused) {
          await this._waitForResume(transferId);
          if (stream.state !== SenderState.SENDING) break;
        }

        while (pendingAcks.size >= ACK_WINDOW) {
          await this._waitForAck(transferId);
          if (stream.paused || stream.state !== SenderState.SENDING) break;
        }

        if (stream.state !== SenderState.SENDING) break;

        const chunkIndex = Math.floor(stream.offset / CHUNK_SIZE);
        const start = stream.offset;
        const end = Math.min(start + CHUNK_SIZE, stream.file.size);
        const chunk = stream.file.slice(start, end);

        const chunkData = await chunk.arrayBuffer();
        const iv = crypto.getRandomValues(new Uint8Array(12));

        let encryptedChunk;
        try {
          const key = await this.keyManager.getEncryptionKey(peerId);
          encryptedChunk = await this._encryptChunk(chunkData, key, iv);
        } catch (err) {
          this.logger.error(`Encryption failed for chunk ${chunkIndex}:`, err);
          this.eventBus.emit('file:error', { transferId, error: err.message });
          await this.cancelTransfer(transferId);
          return;
        }

        const msg = {
          type: 'file-chunk',
          transferId,
          chunkIndex,
          sequence: sequence + chunkIndex,
          iv: Array.from(iv),
          data: Array.from(new Uint8Array(encryptedChunk))
        };

        this.channel.send(msg, peerId);
        pendingAcks.add(chunkIndex);
        stream.sentChunks.add(chunkIndex);
        stream.offset += chunk.size;

        metadata.progress = Math.round((stream.offset / stream.file.size) * 100);
        metadata.receivedChunks = stream.sentChunks.size;
        this.eventBus.emit('file:progress', {
          transferId,
          progress: metadata.progress,
          bytesTransferred: stream.offset,
          totalBytes: stream.file.size,
          chunkIndex
        });

        await this._yieldToEventLoop();
      }

      if (stream.offset >= stream.file.size && stream.state === SenderState.SENDING) {
        stream.state = SenderState.COMPLETED;
        metadata.status = TransferStatus.COMPLETED;
        this.logger.info(`File transfer ${transferId} completed`);
        this.eventBus.emit('file:complete', { transferId, peerId });
        this._cleanupTransfer(transferId);
      }
    }

    async _encryptChunk(data, key, iv) {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );

      return crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        data
      );
    }

    async _decryptChunk(data, key, iv) {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );

      return crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(iv) },
        cryptoKey,
        data
      );
    }

    async _handleChunk(data, senderPeerId) {
      const { transferId, chunkIndex, sequence, iv, data: encryptedData } = data;

      let stream = this.incomingStreams.get(transferId);
      if (!stream) {
        this.logger.warn(`Received chunk for unknown transfer ${transferId}`);
        return;
      }

      const metadata = this.transfers.get(transferId);
      if (metadata.state === ReceiverState.IDLE) {
        metadata.state = ReceiverState.RECEIVING;
      }

      try {
        const key = await this.keyManager.getEncryptionKey(senderPeerId);
        const decrypted = await this._decryptChunk(new Uint8Array(encryptedData), key, iv);

        const chunkBuffer = this.chunkBuffers.get(transferId);
        chunkBuffer[chunkIndex] = new Uint8Array(decrypted);

        stream.receivedChunks.add(chunkIndex);
        metadata.receivedChunks = stream.receivedChunks.size;
        metadata.progress = Math.round((stream.receivedChunks.size / metadata.chunks) * 100);

        this.eventBus.emit('file:progress', {
          transferId,
          progress: metadata.progress,
          chunkIndex,
          receivedChunks: stream.receivedChunks.size,
          totalChunks: metadata.chunks
        });

        const ackMsg = { type: 'file-ack', transferId, chunkIndex, sequence };
        this.channel.send(ackMsg, senderPeerId);

        if (stream.receivedChunks.size === metadata.chunks) {
          metadata.state = ReceiverState.ASSEMBLING;
          await this._assembleFile(transferId);
        }
      } catch (err) {
        this.logger.error(`Chunk decryption failed for ${transferId}:`, err);
        this.eventBus.emit('file:error', { transferId, error: err.message });
        await this.cancelTransfer(transferId);
      }
    }

    async _assembleFile(transferId) {
      const stream = this.incomingStreams.get(transferId);
      const metadata = this.transfers.get(transferId);
      const chunkBuffer = this.chunkBuffers.get(transferId);

      const totalSize = chunkBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
      const assembled = new Uint8Array(totalSize);
      let offset = 0;

      for (let i = 0; i < chunkBuffer.length; i++) {
        if (!chunkBuffer[i]) {
          this.logger.error(`Missing chunk ${i} for transfer ${transferId}`);
          metadata.status = TransferStatus.FAILED;
          this.eventBus.emit('file:error', { transferId, error: 'Missing chunks' });
          return;
        }
        assembled.set(chunkBuffer[i], offset);
        offset += chunkBuffer[i].length;
      }

      stream.blob = new Blob([assembled], { type: metadata.mimeType });
      metadata.state = ReceiverState.COMPLETED;
      metadata.status = TransferStatus.COMPLETED;

      this.logger.info(`File assembly complete for transfer ${transferId}`);
      this.eventBus.emit('file:complete', {
        transferId,
        peerId: metadata.peerId,
        blob: stream.blob,
        filename: metadata.filename
      });

      this._cleanupTransfer(transferId);
    }

    async _handleMetadata(data, senderPeerId) {
      const { transferId, filename, fileSize, mimeType, totalChunks } = data;

      const metadata = {
        transferId,
        peerId: senderPeerId,
        filename,
        fileSize,
        mimeType,
        chunks: totalChunks,
        receivedChunks: 0,
        status: TransferStatus.IN_PROGRESS,
        progress: 0,
        startTime: Date.now(),
        state: ReceiverState.RECEIVING
      };

      this.transfers.set(transferId, metadata);
      this.incomingStreams.set(transferId, {
        receivedChunks: new Set(),
        blob: null,
        state: ReceiverState.RECEIVING
      });
      this.chunkBuffers.set(transferId, new Array(totalChunks));

      this.logger.info(`Incoming file transfer ${transferId} from ${senderPeerId}: ${filename}`);
      this.eventBus.emit('file:start', { transferId, peerId: senderPeerId, filename, fileSize });
    }

    _handleAck(data, peerId) {
      const { transferId, chunkIndex } = data;

      const pendingAcks = this.pendingAcks.get(transferId);
      if (pendingAcks) {
        pendingAcks.delete(chunkIndex);
      }

      const stream = this.outgoingStreams.get(transferId);
      if (stream) {
        stream.waitingAcks?.resolve?.();
      }
    }

    async _handleCancel(data, senderPeerId) {
      const { transferId } = data;

      const metadata = this.transfers.get(transferId);
      if (metadata) {
        metadata.status = TransferStatus.CANCELLED;
        this.logger.info(`Transfer ${transferId} cancelled by ${senderPeerId}`);
        this.eventBus.emit('file:cancel', { transferId, peerId: senderPeerId });
      }

      this._cleanupTransfer(transferId);
    }

    async _handlePause(data, senderPeerId) {
      const { transferId } = data;

      const stream = this.incomingStreams.get(transferId);
      const metadata = this.transfers.get(transferId);

      if (stream && metadata) {
        stream.state = ReceiverState.IDLE;
        metadata.status = TransferStatus.PAUSED;
        this.eventBus.emit('file:pause', { transferId, peerId: senderPeerId });
      }
    }

    async _handleResume(data, senderPeerId) {
      const { transferId } = data;

      const stream = this.incomingStreams.get(transferId);
      const metadata = this.transfers.get(transferId);

      if (stream && metadata) {
        stream.state = ReceiverState.RECEIVING;
        metadata.status = TransferStatus.IN_PROGRESS;
        this.eventBus.emit('file:resume', { transferId, peerId: senderPeerId });
      }
    }

    _waitForAck(transferId) {
      return new Promise(resolve => {
        const stream = this.outgoingStreams.get(transferId);
        if (stream) {
          stream.waitingAcks = { resolve };
        }
        setTimeout(() => resolve(), 5000);
      });
    }

    _waitForResume(transferId) {
      return new Promise(resolve => {
        const stream = this.outgoingStreams.get(transferId);
        if (stream) {
          stream.waitForResume = resolve;
        }
      });
    }

    _yieldToEventLoop() {
      return new Promise(resolve => setImmediate(resolve));
    }

    async cancelTransfer(transferId) {
      const metadata = this.transfers.get(transferId);
      if (!metadata) {
        this.logger.warn(`Cancel requested for unknown transfer ${transferId}`);
        return;
      }

      const peerId = metadata.peerId;
      const msg = { type: 'file-cancel', transferId };
      this.channel.send(msg, peerId);

      metadata.status = TransferStatus.CANCELLED;

      const stream = this.outgoingStreams.get(transferId);
      if (stream) stream.state = SenderState.CANCELLED;

      this.logger.info(`Transfer ${transferId} cancelled`);
      this.eventBus.emit('file:cancel', { transferId, peerId });
      this._cleanupTransfer(transferId);
    }

    async pauseTransfer(transferId) {
      const metadata = this.transfers.get(transferId);
      if (!metadata) return;

      const stream = this.outgoingStreams.get(transferId);
      if (stream) {
        stream.paused = true;
        stream.state = SenderState.PAUSED;
      }

      metadata.status = TransferStatus.PAUSED;
      this.eventBus.emit('file:pause', { transferId, peerId: metadata.peerId });
    }

    async resumeTransfer(transferId) {
      const metadata = this.transfers.get(transferId);
      if (!metadata) return;

      const stream = this.outgoingStreams.get(transferId);
      if (stream) {
        stream.paused = false;
        stream.state = SenderState.SENDING;
        if (stream.waitForResume) {
          stream.waitForResume();
          stream.waitForResume = null;
        }
      }

      metadata.status = TransferStatus.IN_PROGRESS;
      this.eventBus.emit('file:resume', { transferId, peerId: metadata.peerId });
    }

    getTransferStatus(transferId) {
      const metadata = this.transfers.get(transferId);
      if (!metadata) return null;

      return {
        transferId: metadata.transferId,
        peerId: metadata.peerId,
        filename: metadata.filename,
        fileSize: metadata.fileSize,
        mimeType: metadata.mimeType,
        chunks: metadata.chunks,
        receivedChunks: metadata.receivedChunks,
        status: metadata.status,
        progress: metadata.progress,
        startTime: metadata.startTime
      };
    }

    getActiveTransfers() {
      const active = [];
      for (const [transferId, metadata] of this.transfers) {
        if (metadata.status === TransferStatus.IN_PROGRESS || metadata.status === TransferStatus.PENDING || metadata.status === TransferStatus.PAUSED) {
          active.push(this.getTransferStatus(transferId));
        }
      }
      return active;
    }

    _cleanupTransfer(transferId) {
      this.transfers.delete(transferId);
      this.outgoingStreams.delete(transferId);
      this.incomingStreams.delete(transferId);
      this.pendingAcks.delete(transferId);
      this.chunkBuffers.delete(transferId);
      this.sequenceCounters.delete(transferId);
    }

    _generateTransferId() {
      return `ft_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    destroy() {
      for (const transferId of this.transfers.keys()) {
        this.cancelTransfer(transferId);
      }

      this.transfers.clear();
      this.outgoingStreams.clear();
      this.incomingStreams.clear();
      this.pendingAcks.clear();
      this.chunkBuffers.clear();
      this.sequenceCounters.clear();

      this.logger.info('FileTransferManager destroyed');
    }
  }

  exports.FileTransferManager = FileTransferManager;
})(typeof globalThis !== 'undefined' ? globalThis : this);