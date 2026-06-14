(function(exports) {
  'use strict';

  const CONFIG = {
    ICON_SIZE: 24,
    BUTTON_SIZE: 36,
    WAVEFORM_HEIGHT: 24,
    MIN_WIDTH: 120,
    MAX_WIDTH: 280,
    PROGRESS_BAR_HEIGHT: 3,
    DECRYPT_SPINNER_SIZE: 20,
    COLORS: {
      PRIMARY: '#4A90D9',
      PLAYED: '#2563EB',
      UNPLAYED: '#93C5FD',
      BACKGROUND: '#F3F4F6',
      TEXT: '#374151',
      TEXT_SECONDARY: '#6B7280',
      ENCRYPTED_BADGE: '#10B981',
      ERROR: '#EF4444'
    },
    ANIMATION_DURATION: 200
  };

  class VoiceMessageUI {
    constructor(options = {}) {
      this._colors = { ...CONFIG.COLORS, ...options.colors };
      this._waveformHeight = options.waveformHeight || CONFIG.WAVEFORM_HEIGHT;
      this._minWidth = options.minWidth || CONFIG.MIN_WIDTH;
      this._maxWidth = options.maxWidth || CONFIG.MAX_WIDTH;
      this._eventBus = options.eventBus || window.GhostLink?.EventBus || window.GhostLink?.globalBus;
      this._isDestroyed = false;
      this._listeners = new Map();
    }

    renderVoiceMessage(message, options = {}) {
      if (this._isDestroyed) {
        return this._createErrorElement('Component destroyed');
      }

      const {
        isPlaying = false,
        playbackProgress = 0,
        waveformData = null,
        isDecrypting = false,
        isEncrypted = true,
        showDuration = true,
        timestamp = null,
        isOutgoing = false
      } = options;

      const container = this._createContainer(isOutgoing);
      const bubble = this._createBubble(isOutgoing);

      if (isDecrypting) {
        bubble.appendChild(this._createDecryptingState());
      } else {
        bubble.appendChild(this._createPlaybackButton(isPlaying));
        bubble.appendChild(this._createWaveformSection(waveformData, playbackProgress, isPlaying));
      }

      bubble.appendChild(this._createInfoSection(message, isEncrypted, showDuration, timestamp));

      container.appendChild(bubble);

      return container;
    }

    _createContainer(isOutgoing) {
      const container = document.createElement('div');
      container.className = 'voice-message-container';
      container.style.cssText = `
        display: flex;
        flex-direction: ${isOutgoing ? 'row-reverse' : 'row'};
        align-items: flex-end;
        gap: 8px;
        margin: 4px 0;
      `;
      return container;
    }

    _createBubble(isOutgoing) {
      const bubble = document.createElement('div');
      bubble.className = 'voice-message-bubble';
      bubble.style.cssText = `
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        background: ${isOutgoing ? this._colors.PRIMARY : this._colors.BACKGROUND};
        border-radius: 18px;
        min-width: ${this._minWidth}px;
        max-width: ${this._maxWidth}px;
        color: ${isOutgoing ? '#FFFFFF' : this._colors.TEXT};
      `;
      return bubble;
    }

    _createPlaybackButton(isPlaying) {
      const button = document.createElement('button');
      button.className = 'voice-playback-button';
      button.type = 'button';
      button.style.cssText = `
        width: ${CONFIG.BUTTON_SIZE}px;
        height: ${CONFIG.BUTTON_SIZE}px;
        border-radius: 50%;
        border: none;
        background: ${isPlaying ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.3)'};
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background ${CONFIG.ANIMATION_DURATION}ms ease;
        flex-shrink: 0;
      `;

      const icon = this._createPlaybackIcon(isPlaying);
      button.appendChild(icon);

      button.onmouseenter = () => {
        button.style.background = isPlaying ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.4)';
      };

      button.onmouseleave = () => {
        button.style.background = isPlaying ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.3)';
      };

      return button;
    }

    _createPlaybackIcon(isPlaying) {
      if (isPlaying) {
        const pauseIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        pauseIcon.setAttribute('viewBox', '0 0 24 24');
        pauseIcon.setAttribute('width', CONFIG.ICON_SIZE);
        pauseIcon.setAttribute('height', CONFIG.ICON_SIZE);
        pauseIcon.setAttribute('fill', 'white');

        const bar1 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bar1.setAttribute('x', '6');
        bar1.setAttribute('y', '4');
        bar1.setAttribute('width', '4');
        bar1.setAttribute('height', '16');
        bar1.setAttribute('rx', '1');

        const bar2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bar2.setAttribute('x', '14');
        bar2.setAttribute('y', '4');
        bar2.setAttribute('width', '4');
        bar2.setAttribute('height', '16');
        bar2.setAttribute('rx', '1');

        pauseIcon.appendChild(bar1);
        pauseIcon.appendChild(bar2);

        return pauseIcon;
      } else {
        const playIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        playIcon.setAttribute('viewBox', '0 0 24 24');
        playIcon.setAttribute('width', CONFIG.ICON_SIZE);
        playIcon.setAttribute('height', CONFIG.ICON_SIZE);
        playIcon.setAttribute('fill', 'white');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M8 5.14v14l11-7-11-7z');
        playIcon.appendChild(path);

        return playIcon;
      }
    }

    _createWaveformSection(waveformData, playbackProgress, isPlaying) {
      const container = document.createElement('div');
      container.className = 'voice-waveform-section';
      container.style.cssText = `
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      `;

      const waveformCanvas = this._createWaveformCanvas(waveformData, playbackProgress, isPlaying);
      container.appendChild(waveformCanvas);

      const progressBar = this._createProgressBar(playbackProgress);
      container.appendChild(progressBar);

      return container;
    }

    _createWaveformCanvas(waveformData, playbackProgress, isPlaying) {
      const canvas = document.createElement('canvas');
      canvas.className = 'voice-waveform-canvas';

      const dpr = window.devicePixelRatio || 1;
      const width = 100;
      const height = this._waveformHeight;

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.cssText = `
        width: 100%;
        height: ${height}px;
        display: block;
      `;

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      this._drawWaveform(ctx, waveformData, playbackProgress, width, height);

      return canvas;
    }

    _drawWaveform(ctx, waveformData, playbackProgress, width, height) {
      const barCount = 16;
      const barGap = 2;
      const barWidth = (width - CONFIG.PADDING * 2 - (barCount - 1) * barGap) / barCount;
      const centerY = height / 2;
      const maxBarHeight = height - CONFIG.PADDING * 2;

      const normalizedData = this._normalizeWaveformData(waveformData, barCount);
      const progressBarIndex = Math.floor(playbackProgress * barCount);

      for (let i = 0; i < barCount; i++) {
        const value = normalizedData[i] || 0;
        const barHeight = Math.max(2, value * maxBarHeight);

        const x = CONFIG.PADDING + i * (barWidth + barGap);
        const y = centerY - barHeight / 2;

        const isPlayed = i < progressBarIndex;
        const color = isPlayed ? this._colors.PLAYED : this._colors.UNPLAYED;

        ctx.fillStyle = color;
        this._drawRoundedRect(ctx, x, y, barWidth, barHeight, 1);
      }
    }

    _drawRoundedRect(ctx, x, y, width, height, radius) {
      const r = Math.min(radius, width / 2, height / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      ctx.fill();
    }

    _normalizeWaveformData(data, barCount) {
      if (!data || data.length === 0) {
        return new Array(barCount).fill(0.1);
      }

      const result = [];

      if (data.length === barCount) {
        return Array.from(data);
      } else if (data.length > barCount) {
        const step = data.length / barCount;
        for (let i = 0; i < barCount; i++) {
          const startIdx = Math.floor(i * step);
          const endIdx = Math.floor((i + 1) * step);
          let sum = 0;
          for (let j = startIdx; j < endIdx && j < data.length; j++) {
            sum += data[j];
          }
          result.push(sum / (endIdx - startIdx));
        }
        return result;
      } else {
        const step = barCount / data.length;
        for (let i = 0; i < barCount; i++) {
          const dataIdx = Math.floor(i / step);
          result.push(data[dataIdx] || 0);
        }
        return result;
      }
    }

    _createProgressBar(playbackProgress) {
      const progressBar = document.createElement('div');
      progressBar.className = 'voice-progress-bar';
      progressBar.style.cssText = `
        width: 100%;
        height: ${CONFIG.PROGRESS_BAR_HEIGHT}px;
        background: rgba(0, 0, 0, 0.1);
        border-radius: 2px;
        overflow: hidden;
      `;

      const progress = document.createElement('div');
      progress.className = 'voice-progress-fill';
      progress.style.cssText = `
        width: ${playbackProgress * 100}%;
        height: 100%;
        background: ${this._colors.PLAYED};
        transition: width 100ms linear;
        border-radius: 2px;
      `;

      progressBar.appendChild(progress);
      return progressBar;
    }

    _createInfoSection(message, isEncrypted, showDuration, timestamp) {
      const infoSection = document.createElement('div');
      infoSection.className = 'voice-info-section';
      infoSection.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 4px;
        flex-shrink: 0;
      `;

      if (showDuration) {
        const duration = this._formatDuration(message.duration || 0);
        const durationEl = document.createElement('span');
        durationEl.className = 'voice-duration';
        durationEl.style.cssText = `
          font-size: 12px;
          opacity: 0.8;
          font-weight: 500;
        `;
        durationEl.textContent = duration;
        infoSection.appendChild(durationEl);
      }

      const badges = document.createElement('div');
      badges.style.cssText = `
        display: flex;
        align-items: center;
        gap: 6px;
      `;

      if (isEncrypted) {
        const badge = this._createEncryptedBadge();
        badges.appendChild(badge);
      }

      if (timestamp) {
        const time = document.createElement('span');
        time.className = 'voice-timestamp';
        time.style.cssText = `
          font-size: 10px;
          opacity: 0.6;
        `;
        time.textContent = this._formatTime(timestamp);
        badges.appendChild(time);
      }

      infoSection.appendChild(badges);

      return infoSection;
    }

    _createEncryptedBadge() {
      const badge = document.createElement('span');
      badge.className = 'voice-encrypted-badge';
      badge.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 9px;
        padding: 2px 5px;
        background: ${this._colors.ENCRYPTED_BADGE};
        color: white;
        border-radius: 4px;
        font-weight: 600;
        text-transform: uppercase;
      `;

      const lockIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      lockIcon.setAttribute('viewBox', '0 0 24 24');
      lockIcon.setAttribute('width', 10);
      lockIcon.setAttribute('height', 10);
      lockIcon.setAttribute('fill', 'white');

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z');

      lockIcon.appendChild(path);
      badge.appendChild(lockIcon);
      badge.appendChild(document.createTextNode('E2E'));

      return badge;
    }

    _createDecryptingState() {
      const container = document.createElement('div');
      container.className = 'voice-decrypting-state';
      container.style.cssText = `
        display: flex;
        align-items: center;
        gap: 10px;
        flex: 1;
      `;

      const spinner = this._createSpinner();
      container.appendChild(spinner);

      const label = document.createElement('span');
      label.className = 'voice-decrypting-label';
      label.style.cssText = `
        font-size: 12px;
        opacity: 0.8;
      `;
      label.textContent = 'Decrypting...';
      container.appendChild(label);

      return container;
    }

    _createSpinner() {
      const spinner = document.createElement('div');
      spinner.className = 'voice-spinner';
      spinner.style.cssText = `
        width: ${CONFIG.DECRYPT_SPINNER_SIZE}px;
        height: ${CONFIG.DECRYPT_SPINNER_SIZE}px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: voice-spin 0.8s linear infinite;
      `;

      return spinner;
    }

    _formatDuration(seconds) {
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    _formatTime(timestamp) {
      const date = new Date(timestamp);
      const hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const hour12 = hours % 12 || 12;
      return `${hour12}:${minutes} ${ampm}`;
    }

    _createErrorElement(message) {
      const error = document.createElement('div');
      error.className = 'voice-message-error';
      error.style.cssText = `
        color: ${this._colors.ERROR};
        font-size: 12px;
        padding: 8px;
        background: rgba(239, 68, 68, 0.1);
        border-radius: 8px;
      `;
      error.textContent = message;
      return error;
    }

    createCompactVoiceIndicator(duration, isPlaying = false) {
      const container = document.createElement('div');
      container.className = 'voice-indicator-compact';
      container.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        background: rgba(74, 144, 217, 0.1);
        border-radius: 12px;
      `;

      const icon = this._createPlaybackIcon(isPlaying);
      icon.style.cssText = `
        width: 14px;
        height: 14px;
      `;
      container.appendChild(icon);

      const durationText = document.createElement('span');
      durationText.style.cssText = `
        font-size: 11px;
        color: ${this._colors.PRIMARY};
        font-weight: 500;
      `;
      durationText.textContent = this._formatDuration(duration);
      container.appendChild(durationText);

      return container;
    }

    updatePlaybackState(button, isPlaying) {
      if (!button || !button.firstChild) return;

      button.innerHTML = '';
      const icon = this._createPlaybackIcon(isPlaying);
      button.appendChild(icon);
    }

    updateProgressBar(progressElement, progress) {
      if (!progressElement) return;
      progressElement.style.width = `${progress * 100}%`;
    }

    updateWaveformCanvas(canvas, waveformData, playbackProgress) {
      if (!canvas) return;

      const dpr = window.devicePixelRatio || 1;
      const ctx = canvas.getContext('2d');
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;

      ctx.clearRect(0, 0, width, height);
      this._drawWaveform(ctx, waveformData, playbackProgress, width, height);
    }

    on(event, handler) {
      if (this._eventBus) {
        this._eventBus.on(event, handler);
        this._listeners.set(event, handler);
      }
    }

    off(event, handler) {
      if (this._eventBus) {
        this._eventBus.off(event, handler || this._listeners.get(event));
        this._listeners.delete(event);
      }
    }

    destroy() {
      if (this._isDestroyed) return;

      this._isDestroyed = true;

      for (const [event, handler] of this._listeners) {
        if (this._eventBus) {
          this._eventBus.off(event, handler);
        }
      }
      this._listeners.clear();

      this._eventBus = null;
    }
  }

  exports.VoiceMessageUI = VoiceMessageUI;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);