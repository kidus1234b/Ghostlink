(function(exports) {
  'use strict';

  const STATE = {
    IDLE: 'idle',
    ARMING: 'arming',
    RECORDING: 'recording',
    ENCODING: 'encoding',
    ENCRYPTING: 'encrypting',
    UPLOADING: 'uploading'
  };

  const EVENTS = {
    RECORDING_START: 'voice:recording-start',
    RECORDING_STOP: 'voice:recording-stop',
    RECORDING_CANCEL: 'voice:recording-cancel',
    WAVEFORM_UPDATE: 'voice:waveform-update',
    DURATION_UPDATE: 'voice:duration-update',
    ERROR: 'voice:error'
  };

  const CONFIG = {
    MAX_DURATION_MS: 5 * 60 * 1000,
    MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024,
    SILENCE_TIMEOUT_MS: 3000,
    WEBM_CODEC: 'audio/webm;codecs=opus',
    TARGET_SAMPLE_RATE: 48000,
    SILENCE_THRESHOLD: 0.02,
    WAVEFORM_BARS: 16,
    WAVEFORM_UPDATE_INTERVAL: 50
  };

  class VoiceRecorderManager {
    constructor(eventBus, fileTransferManager) {
      this._eventBus = eventBus || window.GhostLink?.EventBus || window.GhostLink?.globalBus;
      this._fileTransferManager = fileTransferManager;
      this._state = STATE.IDLE;
      this._mediaStream = null;
      this._mediaRecorder = null;
      this._audioContext = null;
      this._analyserNode = null;
      this._recordedChunks = [];
      this._currentPeerId = null;
      this._recordingStartTime = null;
      this._durationTimer = null;
      this._silenceTimer = null;
      this._waveformUpdateTimer = null;
      this._isDestroyed = false;
      this._blobUrl = null;
      this._streamTracks = [];
      this._objectUrls = [];
      this._recordedBlob = null;
      this._pendingWaveformData = new Float32Array(CONFIG.WAVEFORM_BARS);
      this._lastAmplitude = 0;
      this._encodingPromise = null;

      this._bindMethods();
    }

    _bindMethods() {
      this.startRecording = this.startRecording.bind(this);
      this.stopRecording = this.stopRecording.bind(this);
      this.cancelRecording = this.cancelRecording.bind(this);
      this._handleDataAvailable = this._handleDataAvailable.bind(this);
      this._handleStop = this._handleStop.bind(this);
      this._handleError = this._handleError.bind(this);
      this._updateDuration = this._updateDuration.bind(this);
      this._updateWaveform = this._updateWaveform.bind(this);
      this._checkSilence = this._checkSilence.bind(this);
    }

    getState() {
      return this._state;
    }

    isRecording() {
      return this._state === STATE.RECORDING;
    }

    isArming() {
      return this._state === STATE.ARMING;
    }

    async startRecording(peerId) {
      if (this._isDestroyed) {
        throw new Error('VoiceRecorderManager has been destroyed');
      }

      if (this._state !== STATE.IDLE) {
        if (this._state === STATE.RECORDING) {
          return;
        }
        throw new Error(`Cannot start recording in state: ${this._state}`);
      }

      try {
        this._currentPeerId = peerId;
        this._setState(STATE.ARMING);

        const constraints = {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: CONFIG.TARGET_SAMPLE_RATE
          }
        };

        this._mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        this._streamTracks = this._mediaStream.getAudioTracks();

        this._audioContext = this._getOrCreateAudioContext();
        const source = this._audioContext.createMediaStreamSource(this._mediaStream);

        this._analyserNode = this._audioContext.createAnalyser();
        this._analyserNode.fftSize = 64;
        this._analyserNode.smoothingTimeConstant = 0.3;
        source.connect(this._analyserNode);

        this._recordedChunks = [];
        this._pendingWaveformData = new Float32Array(CONFIG.WAVEFORM_BARS);

        const mimeType = this._getSupportedMimeType();
        const recorderOptions = mimeType.includes('webm') ? { mimeType } : {};

        this._mediaRecorder = new MediaRecorder(this._mediaStream, recorderOptions);
        this._mediaRecorder.ondataavailable = this._handleDataAvailable;
        this._mediaRecorder.onstop = this._handleStop;
        this._mediaRecorder.onerror = this._handleError;

        this._setState(STATE.RECORDING);
        this._recordingStartTime = Date.now();

        this._emit(EVENTS.RECORDING_START, {
          peerId: this._currentPeerId,
          timestamp: this._recordingStartTime
        });

        this._mediaRecorder.start(100);

        this._startDurationTimer();
        this._startWaveformUpdateTimer();
        this._startSilenceTimer();

      } catch (error) {
        this._cleanup();
        this._setState(STATE.IDLE);
        this._emit(EVENTS.ERROR, {
          code: 'MEDIA_ERROR',
          message: error.message,
          peerId
        });
        throw error;
      }
    }

    stopRecording() {
      if (this._state !== STATE.RECORDING) {
        return null;
      }

      if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
        this._mediaRecorder.stop();
      }

      this._stopTimers();

      this._setState(STATE.ENCODING);

      const duration = this._getElapsedDuration();
      const blob = this._createBlob();

      this._emit(EVENTS.RECORDING_STOP, {
        peerId: this._currentPeerId,
        duration,
        blob,
        waveformData: Array.from(this._pendingWaveformData)
      });

      this._cleanup();
      this._setState(STATE.IDLE);

      return { blob, duration, waveformData: Array.from(this._pendingWaveformData) };
    }

    cancelRecording() {
      if (this._state !== STATE.RECORDING && this._state !== STATE.ARMING) {
        return;
      }

      if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
        this._mediaRecorder.stop();
      }

      this._stopTimers();

      this._emit(EVENTS.RECORDING_CANCEL, {
        peerId: this._currentPeerId,
        duration: this._getElapsedDuration()
      });

      this._cleanup();
      this._setState(STATE.IDLE);
    }

    _getOrCreateAudioContext() {
      if (!this._audioContext || this._audioContext.state === 'closed') {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this._audioContext = new AudioContextClass({ sampleRate: CONFIG.TARGET_SAMPLE_RATE });
      }

      if (this._audioContext.state === 'suspended') {
        this._audioContext.resume();
      }

      return this._audioContext;
    }

    _getSupportedMimeType() {
      const mimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg',
        'audio/mp4',
        'audio/mpeg'
      ];

      for (const mimeType of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
          return mimeType;
        }
      }

      return '';
    }

    _handleDataAvailable(event) {
      if (event.data && event.data.size > 0) {
        this._recordedChunks.push(event.data);

        if (event.data.size > CONFIG.MAX_FILE_SIZE_BYTES) {
          this._emit(EVENTS.ERROR, {
            code: 'MAX_SIZE_EXCEEDED',
            message: 'Maximum file size exceeded',
            peerId: this._currentPeerId
          });
          this.stopRecording();
        }
      }
    }

    _handleStop(event) {
    }

    _handleError(event) {
      this._emit(EVENTS.ERROR, {
        code: 'RECORDER_ERROR',
        message: event.error?.message || 'Unknown recorder error',
        peerId: this._currentPeerId
      });
    }

    _createBlob() {
      if (this._recordedChunks.length === 0) {
        return new Blob([], { type: 'audio/webm' });
      }

      const mimeType = this._getSupportedMimeType() || 'audio/webm';
      return new Blob(this._recordedChunks, { type: mimeType });
    }

    _startDurationTimer() {
      this._durationTimer = setInterval(() => {
        this._updateDuration();
      }, 100);
    }

    _stopDurationTimer() {
      if (this._durationTimer) {
        clearInterval(this._durationTimer);
        this._durationTimer = null;
      }
    }

    _updateDuration() {
      const duration = this._getElapsedDuration();

      this._emit(EVENTS.DURATION_UPDATE, {
        duration,
        peerId: this._currentPeerId
      });

      if (duration >= CONFIG.MAX_DURATION_MS) {
        this.stopRecording();
      }
    }

    _startWaveformUpdateTimer() {
      this._waveformUpdateTimer = setInterval(() => {
        this._updateWaveform();
      }, CONFIG.WAVEFORM_UPDATE_INTERVAL);
    }

    _stopWaveformUpdateTimer() {
      if (this._waveformUpdateTimer) {
        clearInterval(this._waveformUpdateTimer);
        this._waveformUpdateTimer = null;
      }
    }

    _updateWaveform() {
      if (!this._analyserNode || this._state !== STATE.RECORDING) {
        return;
      }

      const frequencyData = new Uint8Array(this._analyserNode.frequencyBinCount);
      this._analyserNode.getByteFrequencyData(frequencyData);

      const barCount = CONFIG.WAVEFORM_BARS;
      const samplesPerBar = Math.floor(frequencyData.length / barCount);
      const waveformData = new Float32Array(barCount);

      for (let i = 0; i < barCount; i++) {
        let sum = 0;
        for (let j = 0; j < samplesPerBar; j++) {
          const index = i * samplesPerBar + j;
          if (index < frequencyData.length) {
            sum += frequencyData[index];
          }
        }
        waveformData[i] = (sum / samplesPerBar) / 255;
      }

      this._pendingWaveformData = waveformData;

      const maxAmplitude = Math.max(...waveformData);
      this._lastAmplitude = maxAmplitude;
      this._resetSilenceTimer();

      this._emit(EVENTS.WAVEFORM_UPDATE, {
        waveformData: Array.from(waveformData),
        amplitude: maxAmplitude,
        peerId: this._currentPeerId
      });
    }

    _startSilenceTimer() {
      this._silenceTimer = setInterval(() => {
        this._checkSilence();
      }, 500);
    }

    _stopSilenceTimer() {
      if (this._silenceTimer) {
        clearInterval(this._silenceTimer);
        this._silenceTimer = null;
      }
    }

    _resetSilenceTimer() {
      this._silenceStartTime = null;
    }

    _checkSilence() {
      if (this._state !== STATE.RECORDING) {
        return;
      }

      if (this._lastAmplitude < CONFIG.SILENCE_THRESHOLD) {
        if (!this._silenceStartTime) {
          this._silenceStartTime = Date.now();
        } else {
          const silenceDuration = Date.now() - this._silenceStartTime;
          if (silenceDuration >= CONFIG.SILENCE_TIMEOUT_MS) {
            this.stopRecording();
          }
        }
      } else {
        this._resetSilenceTimer();
      }
    }

    _stopTimers() {
      this._stopDurationTimer();
      this._stopWaveformUpdateTimer();
      this._stopSilenceTimer();
    }

    _getElapsedDuration() {
      if (!this._recordingStartTime) {
        return 0;
      }
      return Date.now() - this._recordingStartTime;
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

    _cleanup() {
      this._stopTimers();

      if (this._mediaRecorder) {
        this._mediaRecorder.ondataavailable = null;
        this._mediaRecorder.onstop = null;
        this._mediaRecorder.onerror = null;
        this._mediaRecorder = null;
      }

      for (const track of this._streamTracks) {
        try {
          track.stop();
        } catch (e) {
        }
      }
      this._streamTracks = [];

      if (this._mediaStream) {
        try {
          this._mediaStream.getTracks().forEach(track => track.stop());
        } catch (e) {
        }
        this._mediaStream = null;
      }

      if (this._analyserNode) {
        try {
          this._analyserNode.disconnect();
        } catch (e) {
        }
        this._analyserNode = null;
      }

      this._recordedChunks = [];
      this._currentPeerId = null;
      this._recordingStartTime = null;
      this._lastAmplitude = 0;
      this._silenceStartTime = null;

      if (this._blobUrl) {
        this._revokeBlobUrl(this._blobUrl);
        this._blobUrl = null;
      }
    }

    _revokeBlobUrl(url) {
      if (url && url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {
        }
      }
    }

    createObjectURL(blob) {
      const url = URL.createObjectURL(blob);
      this._objectUrls.push(url);
      return url;
    }

    revokeObjectURL(url) {
      this._revokeBlobUrl(url);
      const index = this._objectUrls.indexOf(url);
      if (index > -1) {
        this._objectUrls.splice(index, 1);
      }
    }

    revokeAllObjectURLs() {
      for (const url of this._objectUrls) {
        this._revokeBlobUrl(url);
      }
      this._objectUrls = [];
    }

    getAnalyserNode() {
      return this._analyserNode;
    }

    getAudioContext() {
      return this._audioContext;
    }

    getCurrentWaveformData() {
      return Array.from(this._pendingWaveformData);
    }

    getRecordedBlob() {
      return this._recordedBlob;
    }

    async encodeAudioToWav(blob) {
      const arrayBuffer = await blob.arrayBuffer();
      const audioContext = this._getOrCreateAudioContext();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));

      const wavBuffer = this._audioBufferToWav(audioBuffer);
      return new Blob([wavBuffer], { type: 'audio/wav' });
    }

    _audioBufferToWav(audioBuffer) {
      const numChannels = audioBuffer.numberOfChannels;
      const sampleRate = audioBuffer.sampleRate;
      const format = 1;
      const bitDepth = 16;

      const bytesPerSample = bitDepth / 8;
      const blockAlign = numChannels * bytesPerSample;

      const samples = audioBuffer.length;
      const dataSize = samples * blockAlign;
      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);

      this._writeString(view, 0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true);
      this._writeString(view, 8, 'WAVE');
      this._writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, format, true);
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * blockAlign, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, bitDepth, true);
      this._writeString(view, 36, 'data');
      view.setUint32(40, dataSize, true);

      const channelData = [];
      for (let i = 0; i < numChannels; i++) {
        channelData.push(audioBuffer.getChannelData(i));
      }

      let offset = 44;
      for (let i = 0; i < samples; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
          const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
          const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
          view.setInt16(offset, intSample, true);
          offset += 2;
        }
      }

      return buffer;
    }

    _writeString(view, offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }

    getConfiguration() {
      return { ...CONFIG };
    }

    destroy() {
      if (this._isDestroyed) {
        return;
      }

      this._isDestroyed = true;
      this._cleanup();

      this.revokeAllObjectURLs();

      if (this._audioContext && this._audioContext.state !== 'closed') {
        this._audioContext.suspend().catch(() => {});
      }

      this._eventBus = null;
      this._fileTransferManager = null;
    }
  }

  exports.VoiceRecorderManager = VoiceRecorderManager;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);