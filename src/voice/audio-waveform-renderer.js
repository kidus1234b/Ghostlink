(function(exports) {
  'use strict';

  const CONFIG = {
    BAR_COUNT: 16,
    BAR_GAP: 2,
    MIN_BAR_HEIGHT: 2,
    CORNER_RADIUS: 2,
    DEFAULT_COLOR: '#4A90D9',
    PLAYED_COLOR: '#2563EB',
    UNPLAYED_COLOR: '#93C5FD',
    BACKGROUND_COLOR: 'transparent',
    PADDING: 4,
    ANIMATION_DURATION: 150
  };

  class AudioWaveformRenderer {
    constructor(options = {}) {
      this._canvas = null;
      this._ctx = null;
      this._animationFrameId = null;
      this._analyserNode = null;
      this._isDestroyed = false;
      this._isLive = false;

      this._waveformData = new Float32Array(CONFIG.BAR_COUNT);
      this._staticWaveformData = null;
      this._playbackProgress = 0;

      this._barColor = options.barColor || CONFIG.DEFAULT_COLOR;
      this._playedColor = options.playedColor || CONFIG.PLAYED_COLOR;
      this._unplayedColor = options.unplayedColor || CONFIG.UNPLAYED_COLOR;
      this._barCount = options.barCount || CONFIG.BAR_COUNT;
      this._minBarHeight = options.minBarHeight || CONFIG.MIN_BAR_HEIGHT;

      this._boundResizeHandler = this._handleResize.bind(this);
      this._boundRafLoop = this._rafLoop.bind(this);
    }

    mount(canvasElement) {
      if (!canvasElement || !(canvasElement instanceof HTMLCanvasElement)) {
        throw new Error('Valid canvas element required');
      }

      this._canvas = canvasElement;
      this._ctx = this._canvas.getContext('2d', {
        alpha: true,
        desynchronized: true
      });

      this._setupCanvas();
      window.addEventListener('resize', this._boundResizeHandler);

      return this;
    }

    unmount() {
      this._stopAnimation();

      window.removeEventListener('resize', this._boundResizeHandler);

      if (this._canvas) {
        this._clearCanvas();
      }

      this._ctx = null;
      this._canvas = null;
      this._isDestroyed = true;
    }

    _setupCanvas() {
      if (!this._canvas) return;

      const dpr = window.devicePixelRatio || 1;
      const rect = this._canvas.getBoundingClientRect();

      this._canvas.width = rect.width * dpr;
      this._canvas.height = rect.height * dpr;

      this._ctx.scale(dpr, dpr);

      this._logicalWidth = rect.width;
      this._logicalHeight = rect.height;
    }

    _handleResize() {
      this._setupCanvas();
      if (!this._isLive) {
        this._renderStatic(this._staticWaveformData);
      }
    }

    renderLive(analyserNode) {
      if (this._isDestroyed) return;

      this._analyserNode = analyserNode;
      this._isLive = true;
      this._staticWaveformData = null;

      this._startAnimation();
    }

    stopLiveRendering() {
      this._stopAnimation();
      this._analyserNode = null;
      this._isLive = false;
    }

    renderStatic(waveformData) {
      if (this._isDestroyed) return;

      this._stopAnimation();
      this._isLive = false;
      this._staticWaveformData = waveformData ? new Float32Array(waveformData) : null;

      this._renderStatic(waveformData);
    }

    _renderStatic(waveformData) {
      if (!this._ctx || !this._logicalWidth) return;

      this._clearCanvas();

      if (!waveformData || waveformData.length === 0) {
        this._renderPlaceholder();
        return;
      }

      const normalizedData = this._normalizeWaveformData(waveformData);
      const barWidth = this._calculateBarWidth();
      const barGap = CONFIG.BAR_GAP;
      const totalBarsWidth = (barWidth + barGap) * this._barCount - barGap;
      const startX = (this._logicalWidth - totalBarsWidth) / 2;
      const centerY = this._logicalHeight / 2;

      for (let i = 0; i < this._barCount; i++) {
        const value = normalizedData[i] || 0;
        const barHeight = Math.max(this._minBarHeight, value * (this._logicalHeight - CONFIG.PADDING * 2));

        const x = startX + i * (barWidth + barGap);
        const y = centerY - barHeight / 2;

        this._drawBar(x, y, barWidth, barHeight, this._barColor, CONFIG.CORNER_RADIUS);
      }
    }

    renderPlaybackProgress(waveformData, progress) {
      if (this._isDestroyed) return;

      this._stopAnimation();
      this._isLive = false;
      this._playbackProgress = Math.max(0, Math.min(1, progress));

      if (!waveformData || waveformData.length === 0) {
        this.renderStatic(this._staticWaveformData);
        return;
      }

      this._staticWaveformData = waveformData;
      this._renderProgressWaveform(waveformData);
    }

    _renderProgressWaveform(waveformData) {
      if (!this._ctx || !this._logicalWidth) return;

      this._clearCanvas();

      const normalizedData = this._normalizeWaveformData(waveformData);
      const barWidth = this._calculateBarWidth();
      const barGap = CONFIG.BAR_GAP;
      const totalBarsWidth = (barWidth + barGap) * this._barCount - barGap;
      const startX = (this._logicalWidth - totalBarsWidth) / 2;
      const centerY = this._logicalHeight / 2;

      const progressBarIndex = Math.floor(this._playbackProgress * this._barCount);

      for (let i = 0; i < this._barCount; i++) {
        const value = normalizedData[i] || 0;
        const barHeight = Math.max(this._minBarHeight, value * (this._logicalHeight - CONFIG.PADDING * 2));

        const x = startX + i * (barWidth + barGap);
        const y = centerY - barHeight / 2;

        const isPlayed = i < progressBarIndex;
        const color = isPlayed ? this._playedColor : this._unplayedColor;

        this._drawBar(x, y, barWidth, barHeight, color, CONFIG.CORNER_RADIUS);
      }
    }

    _renderPlaceholder() {
      const barWidth = this._calculateBarWidth();
      const barGap = CONFIG.BAR_GAP;
      const totalBarsWidth = (barWidth + barGap) * this._barCount - barGap;
      const startX = (this._logicalWidth - totalBarsWidth) / 2;
      const centerY = this._logicalHeight / 2;

      for (let i = 0; i < this._barCount; i++) {
        const barHeight = this._minBarHeight;
        const x = startX + i * (barWidth + barGap);
        const y = centerY - barHeight / 2;

        this._drawBar(x, y, barWidth, barHeight, '#E5E7EB', CONFIG.CORNER_RADIUS);
      }
    }

    _startAnimation() {
      if (this._animationFrameId) return;
      this._boundRafLoop();
    }

    _stopAnimation() {
      if (this._animationFrameId) {
        cancelAnimationFrame(this._animationFrameId);
        this._animationFrameId = null;
      }
    }

    _rafLoop() {
      if (this._isDestroyed) return;

      this._updateLiveWaveform();
      this._animationFrameId = requestAnimationFrame(this._boundRafLoop);
    }

    _updateLiveWaveform() {
      if (!this._analyserNode || !this._ctx) return;

      const frequencyData = new Uint8Array(this._analyserNode.frequencyBinCount);
      this._analyserNode.getByteFrequencyData(frequencyData);

      const samplesPerBar = Math.floor(frequencyData.length / this._barCount);
      const centerY = this._logicalHeight / 2;

      this._clearCanvas();

      const barWidth = this._calculateBarWidth();
      const barGap = CONFIG.BAR_GAP;
      const totalBarsWidth = (barWidth + barGap) * this._barCount - barGap;
      const startX = (this._logicalWidth - totalBarsWidth) / 2;

      for (let i = 0; i < this._barCount; i++) {
        let sum = 0;
        for (let j = 0; j < samplesPerBar; j++) {
          const index = i * samplesPerBar + j;
          if (index < frequencyData.length) {
            sum += frequencyData[index];
          }
        }
        const average = sum / samplesPerBar;
        const normalizedValue = average / 255;
        const barHeight = Math.max(this._minBarHeight, normalizedValue * (this._logicalHeight - CONFIG.PADDING * 2));

        const x = startX + i * (barWidth + barGap);
        const y = centerY - barHeight / 2;

        this._drawBar(x, y, barWidth, barHeight, this._barColor, CONFIG.CORNER_RADIUS);
      }
    }

    _normalizeWaveformData(data) {
      if (!data || data.length === 0) {
        return new Float32Array(this._barCount);
      }

      const result = new Float32Array(this._barCount);

      if (data.length === this._barCount) {
        for (let i = 0; i < this._barCount; i++) {
          result[i] = Math.max(0, Math.min(1, data[i]));
        }
      } else if (data.length > this._barCount) {
        const step = data.length / this._barCount;
        for (let i = 0; i < this._barCount; i++) {
          const startIdx = Math.floor(i * step);
          const endIdx = Math.floor((i + 1) * step);
          let sum = 0;
          let count = 0;
          for (let j = startIdx; j < endIdx && j < data.length; j++) {
            sum += data[j];
            count++;
          }
          result[i] = count > 0 ? Math.max(0, Math.min(1, sum / count)) : 0;
        }
      } else {
        const step = this._barCount / data.length;
        for (let i = 0; i < this._barCount; i++) {
          const dataIdx = Math.floor(i / step);
          result[i] = data[dataIdx] || 0;
        }
      }

      return result;
    }

    _calculateBarWidth() {
      const availableWidth = this._logicalWidth - CONFIG.PADDING * 2;
      const totalGapWidth = (this._barCount - 1) * CONFIG.BAR_GAP;
      return Math.max(1, (availableWidth - totalGapWidth) / this._barCount);
    }

    _drawBar(x, y, width, height, color, cornerRadius) {
      if (!this._ctx) return;

      const ctx = this._ctx;
      const radius = Math.min(cornerRadius, width / 2, height / 2);

      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + width - radius, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
      ctx.lineTo(x + width, y + height - radius);
      ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
      ctx.lineTo(x + radius, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();

      ctx.fillStyle = color;
      ctx.fill();
    }

    _clearCanvas() {
      if (!this._ctx || !this._logicalWidth || !this._logicalHeight) return;

      this._ctx.clearRect(0, 0, this._logicalWidth, this._logicalHeight);
    }

    setBarColor(color) {
      this._barColor = color;
    }

    setPlayedColor(color) {
      this._playedColor = color;
    }

    setUnplayedColor(color) {
      this._unplayedColor = color;
    }

    getPlaybackProgress() {
      return this._playbackProgress;
    }

    getWaveformData() {
      return this._staticWaveformData ? Array.from(this._staticWaveformData) : null;
    }

    isLive() {
      return this._isLive;
    }

    isDestroyed() {
      return this._isDestroyed;
    }

    static generateDeterministicWaveform(data, seed, barCount = CONFIG.BAR_COUNT) {
      const result = new Float32Array(barCount);

      if (!data || data.length === 0) {
        return result;
      }

      let hash = seed || 0;
      const prime = 31;

      for (let i = 0; i < data.length; i++) {
        hash = ((hash * prime) + (data.charCodeAt ? data.charCodeAt(i) : data[i])) >>> 0;
      }

      for (let i = 0; i < barCount; i++) {
        hash = ((hash * prime) + i) >>> 0;
        const random1 = (hash >>> 16) / 65535;
        hash = ((hash * prime) + 17) >>> 0;
        const random2 = (hash >>> 16) / 65535;

        const index1 = Math.floor(random1 * data.length);
        const index2 = Math.floor(random2 * data.length);

        const value1 = data[index1] || 0;
        const value2 = data[index2] || 0;

        result[i] = Math.max(0, Math.min(1, (value1 + value2) / 2));
      }

      return result;
    }

    destroy() {
      this.unmount();
      this._analyserNode = null;
      this._waveformData = null;
      this._staticWaveformData = null;
    }
  }

  exports.AudioWaveformRenderer = AudioWaveformRenderer;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);