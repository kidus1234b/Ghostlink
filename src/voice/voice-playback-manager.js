(function(exports) {
  'use strict';

  const EVENTS = {
    PLAYBACK_START: 'voice:playback-start',
    PLAYBACK_PAUSE: 'voice:playback-pause',
    PLAYBACK_STOP: 'voice:playback-stop',
    PLAYBACK_COMPLETE: 'voice:playback-complete',
    PLAYBACK_ERROR: 'voice:playback-error',
    DECRYPT_START: 'voice:decrypt-start',
    DECRYPT_COMPLETE: 'voice:decrypt-complete'
  };

  const PLAYBACK_STATE = {
    IDLE: 'idle',
    LOADING: 'loading',
    DECRYPTING: 'decrypting',
    PLAYING: 'playing',
    PAUSED: 'paused',
    ERROR: 'error'
  };

  const CONFIG = {
    DECRYPT_CHUNK_SIZE: 64 * 1024,
    OBJECT_URL_CACHE_CLEANUP_DELAY: 100,
    PLAYBACK_START_DELAY: 50
  };

  class VoicePlaybackManager {
    constructor(eventBus) {
      this._eventBus = eventBus || window.GhostLink?.EventBus || window.GhostLink?.globalBus;
      this._state = PLAYBACK_STATE.IDLE;
      this._currentAudio = null;
      this._currentMessageId = null;
      this._currentObjectUrl = null;
      this._objectUrls = [];
      this._playbackStartTime = 0;
      this._pausedAt = 0;
      this._duration = 0;
      this._decryptedBuffer = null;
      this._currentPeerId = null;
      this._isDestroyed = false;
      this._cleanupTimeout = null;

      this._boundHandleEnded = this._handleEnded.bind(this);
      this._boundHandleError = this._handleError.bind(this);
      this._boundHandleLoadedMetadata = this._handleLoadedMetadata.bind(this);
      this._boundHandleTimeUpdate = this._handleTimeUpdate.bind(this);
    }

    static getInstance(eventBus) {
      if (!VoicePlaybackManager._instance) {
        VoicePlaybackManager._instance = new VoicePlaybackManager(eventBus);
      }
      return VoicePlaybackManager._instance;
    }

    async play(voiceMessage) {
      if (this._isDestroyed) {
        throw new Error('VoicePlaybackManager has been destroyed');
      }

      if (!voiceMessage || !voiceMessage.encryptedData) {
        throw new Error('Invalid voice message: missing encrypted data');
      }

      const messageId = voiceMessage.id || voiceMessage.messageId;
      const peerId = voiceMessage.peerId;
      const encryptedData = voiceMessage.encryptedData;
      const iv = voiceMessage.iv;
      const key = voiceMessage.key;

      if (this._currentMessageId === messageId && this._state === PLAYBACK_STATE.PAUSED) {
        return this._resumePlayback();
      }

      await this._autoPause();

      try {
        this._setState(PLAYBACK_STATE.DECRYPTING);
        this._emit(EVENTS.DECRYPT_START, { messageId, peerId });

        this._decryptedBuffer = await this._lazyDecrypt(encryptedData, iv, key);

        this._emit(EVENTS.DECRYPT_COMPLETE, { messageId, peerId });

        this._setState(PLAYBACK_STATE.LOADING);

        const blob = new Blob([this._decryptedBuffer], { type: voiceMessage.mimeType || 'audio/webm' });
        const objectUrl = this._createObjectURL(blob);

        this._currentObjectUrl = objectUrl;
        this._currentMessageId = messageId;
        this._currentPeerId = peerId;

        await this._setupAudioElement(objectUrl);

        this._setState(PLAYBACK_STATE.PLAYING);

        return true;

      } catch (error) {
        this._setState(PLAYBACK_STATE.ERROR);
        this._emit(EVENTS.PLAYBACK_ERROR, {
          messageId,
          peerId,
          error: error.message,
          code: 'PLAYBACK_ERROR'
        });
        throw error;
      }
    }

    async _lazyDecrypt(encryptedData, iv, key) {
      if (!encryptedData) {
        throw new Error('No encrypted data provided');
      }

      let dataBuffer = encryptedData;

      if (encryptedData instanceof ArrayBuffer) {
        dataBuffer = encryptedData;
      } else if (encryptedData.data && encryptedData.data instanceof ArrayBuffer) {
        dataBuffer = encryptedData.data;
      } else if (typeof encryptedData === 'string') {
        const binaryString = atob(encryptedData);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        dataBuffer = bytes.buffer;
      } else if (encryptedData.arrayBuffer) {
        dataBuffer = await encryptedData.arrayBuffer();
      } else if (ArrayBuffer.isView(encryptedData)) {
        dataBuffer = encryptedData.buffer;
      }

      if (!key || key.length === 0) {
        return dataBuffer;
      }

      try {
        const cryptoKey = await this._importKey(key);
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: new Uint8Array(iv) },
          cryptoKey,
          dataBuffer
        );
        return decrypted;
      } catch (decryptError) {
        if (decryptError.name === 'OperationError') {
          return dataBuffer;
        }
        throw decryptError;
      }
    }

    async _importKey(keyData) {
      const rawKey = typeof keyData === 'string' ? new Uint8Array(atob(keyData).split('').map(c => c.charCodeAt(0))) : new Uint8Array(keyData);

      return crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );
    }

    async _setupAudioElement(objectUrl) {
      return new Promise((resolve, reject) => {
        if (this._currentAudio) {
          this._cleanupAudioElement();
        }

        const audio = new Audio();
        this._currentAudio = audio;

        audio.preload = 'auto';
        audio.src = objectUrl;

        audio.onended = this._boundHandleEnded;
        audio.onerror = this._boundHandleError;
        audio.onloadedmetadata = this._boundHandleLoadedMetadata;
        audio.ontimeupdate = this._boundHandleTimeUpdate;

        const onCanPlay = () => {
          audio.removeEventListener('canplaythrough', onCanPlay);
          audio.removeEventListener('error', onError);
          resolve();
        };

        const onError = (error) => {
          audio.removeEventListener('canplaythrough', onCanPlay);
          audio.removeEventListener('error', onError);
          reject(new Error('Failed to load audio'));
        };

        audio.addEventListener('canplaythrough', onCanPlay, { once: true });
        audio.addEventListener('error', onError, { once: true });

        audio.load();
      });
    }

    _handleLoadedMetadata(event) {
      if (!this._currentAudio) return;

      this._duration = this._currentAudio.duration || 0;
    }

    _handleTimeUpdate(event) {
    }

    _handleEnded(event) {
      if (this._state === PLAYBACK_STATE.PLAYING) {
        this._emit(EVENTS.PLAYBACK_COMPLETE, {
          messageId: this._currentMessageId,
          peerId: this._currentPeerId
        });

        this._setState(PLAYBACK_STATE.IDLE);
        this._cleanup();
      }
    }

    _handleError(event) {
      const error = this._currentAudio?.error;

      this._emit(EVENTS.PLAYBACK_ERROR, {
        messageId: this._currentMessageId,
        peerId: this._currentPeerId,
        error: error?.message || 'Audio playback error',
        code: error?.code || 'UNKNOWN_ERROR'
      });

      this._setState(PLAYBACK_STATE.ERROR);
    }

    async _resumePlayback() {
      if (!this._currentAudio) {
        throw new Error('No audio to resume');
      }

      try {
        await this._currentAudio.play();
        this._playbackStartTime = Date.now() - (this._pausedAt * 1000);
        this._setState(PLAYBACK_STATE.PLAYING);

        this._emit(EVENTS.PLAYBACK_START, {
          messageId: this._currentMessageId,
          peerId: this._currentPeerId
        });

        return true;
      } catch (error) {
        this._emit(EVENTS.PLAYBACK_ERROR, {
          messageId: this._currentMessageId,
          peerId: this._currentPeerId,
          error: error.message
        });
        throw error;
      }
    }

    pause() {
      if (this._state !== PLAYBACK_STATE.PLAYING || !this._currentAudio) {
        return false;
      }

      try {
        this._currentAudio.pause();
        this._pausedAt = this._currentAudio.currentTime;
        this._setState(PLAYBACK_STATE.PAUSED);

        this._emit(EVENTS.PLAYBACK_PAUSE, {
          messageId: this._currentMessageId,
          peerId: this._currentPeerId,
          currentTime: this._pausedAt
        });

        return true;
      } catch (error) {
        return false;
      }
    }

    stop() {
      if (!this._currentAudio && this._state === PLAYBACK_STATE.IDLE) {
        return;
      }

      const messageId = this._currentMessageId;
      const peerId = this._currentPeerId;

      this._cleanup();
      this._setState(PLAYBACK_STATE.IDLE);

      this._emit(EVENTS.PLAYBACK_STOP, {
        messageId,
        peerId
      });
    }

    async seek(position) {
      if (!this._currentAudio) {
        throw new Error('No audio loaded');
      }

      if (position < 0 || position > this._duration) {
        throw new Error('Invalid seek position');
      }

      const wasPlaying = this._state === PLAYBACK_STATE.PLAYING;

      if (wasPlaying) {
        this._currentAudio.pause();
      }

      this._currentAudio.currentTime = position;

      if (wasPlaying) {
        await this._currentAudio.play();
      }
    }

    getDuration() {
      return this._duration;
    }

    getCurrentTime() {
      if (!this._currentAudio) {
        return 0;
      }

      if (this._state === PLAYBACK_STATE.PAUSED) {
        return this._pausedAt;
      }

      if (this._state === PLAYBACK_STATE.PLAYING) {
        return this._currentAudio.currentTime;
      }

      return 0;
    }

    getPlaybackState() {
      return this._state;
    }

    getCurrentMessageId() {
      return this._currentMessageId;
    }

    isPlaying() {
      return this._state === PLAYBACK_STATE.PLAYING;
    }

    isPaused() {
      return this._state === PLAYBACK_STATE.PAUSED;
    }

    isIdle() {
      return this._state === PLAYBACK_STATE.IDLE;
    }

    async _autoPause() {
      if (this._state === PLAYBACK_STATE.PLAYING) {
        this.pause();
      }

      this._cleanup();
    }

    _cleanup() {
      if (this._currentAudio) {
        this._cleanupAudioElement();
        this._currentAudio = null;
      }

      this._currentMessageId = null;
      this._currentPeerId = null;
      this._pausedAt = 0;
      this._playbackStartTime = 0;
      this._duration = 0;
      this._decryptedBuffer = null;
    }

    _cleanupAudioElement() {
      if (!this._currentAudio) return;

      try {
        this._currentAudio.pause();
      } catch (e) {
      }

      this._currentAudio.onended = null;
      this._currentAudio.onerror = null;
      this._currentAudio.onloadedmetadata = null;
      this._currentAudio.ontimeupdate = null;

      if (this._currentAudio.src && this._currentAudio.src.startsWith('blob:')) {
        this._revokeObjectURL(this._currentAudio.src);
      }

      this._currentAudio.src = '';
      this._currentAudio.load();
    }

    _createObjectURL(blob) {
      const url = URL.createObjectURL(blob);
      this._objectUrls.push(url);
      return url;
    }

    _revokeObjectURL(url) {
      if (url && url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {
        }
      }

      const index = this._objectUrls.indexOf(url);
      if (index > -1) {
        this._objectUrls.splice(index, 1);
      }
    }

    _revokeAllObjectURLs() {
      for (const url of this._objectUrls) {
        this._revokeObjectURL(url);
      }
      this._objectUrls = [];

      if (this._currentObjectUrl) {
        this._revokeObjectURL(this._currentObjectUrl);
        this._currentObjectUrl = null;
      }
    }

    _setState(newState) {
      const oldState = this._state;
      this._state = newState;
    }

    _emit(event, data) {
      if (this._eventBus) {
        this._eventBus.emit(event, data);
      }
    }

    reconstructBlob(chunks, mimeType = 'audio/webm') {
      if (!chunks || chunks.length === 0) {
        return new Blob([], { type: mimeType });
      }

      const sortedChunks = [...chunks].sort((a, b) => {
        const orderA = a.order ?? a.chunkIndex ?? 0;
        const orderB = b.order ?? b.chunkIndex ?? 0;
        return orderA - orderB;
      });

      const buffers = [];

      for (const chunk of sortedChunks) {
        let buffer = null;

        if (chunk.data instanceof ArrayBuffer) {
          buffer = chunk.data;
        } else if (chunk.data.arrayBuffer) {
          buffer = chunk.data.arrayBuffer();
        } else if (typeof chunk.data === 'string') {
          const binaryString = atob(chunk.data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          buffer = bytes.buffer;
        } else if (ArrayBuffer.isView(chunk.data)) {
          buffer = chunk.data.buffer;
        } else if (chunk.data.buffer) {
          buffer = chunk.data.buffer;
        }

        if (buffer) {
          buffers.push(buffer);
        }
      }

      if (buffers.length === 0) {
        return new Blob([], { type: mimeType });
      }

      const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;

      for (const buf of buffers) {
        combined.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
      }

      return new Blob([combined.buffer], { type: mimeType });
    }

    scheduleCleanup() {
      if (this._cleanupTimeout) {
        clearTimeout(this._cleanupTimeout);
      }

      this._cleanupTimeout = setTimeout(() => {
        this._revokeAllObjectURLs();
        this._cleanupTimeout = null;
      }, CONFIG.OBJECT_URL_CACHE_CLEANUP_DELAY);
    }

    destroy() {
      if (this._isDestroyed) {
        return;
      }

      this._isDestroyed = true;

      if (this._cleanupTimeout) {
        clearTimeout(this._cleanupTimeout);
        this._cleanupTimeout = null;
      }

      this._revokeAllObjectURLs();
      this._cleanup();

      this._eventBus = null;
    }
  }

  VoicePlaybackManager._instance = null;

  exports.VoicePlaybackManager = VoicePlaybackManager;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);