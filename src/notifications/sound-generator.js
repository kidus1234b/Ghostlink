(function(exports) {
  'use strict';

  const SOUND_TYPE_MESSAGE = 'message';
  const SOUND_TYPE_VOICE = 'voice';
  const SOUND_TYPE_ERROR = 'error';
  const SOUND_TYPE_CALL = 'call';

  const DEFAULT_VOLUME = 0.5;

  const PING_FREQUENCY = 800;
  const PING_DURATION = 100;
  const PING_ATTACK = 10;
  const PING_DECAY = 90;

  const VOICE_FREQUENCY = 600;
  const VOICE_DURATION = 150;
  const VOICE_ATTACK = 15;
  const VOICE_DECAY = 135;

  const ERROR_FREQUENCY = 300;
  const ERROR_DURATION = 100;
  const ERROR_REPEATS = 2;

  const CALL_FREQUENCY = 440;
  const CALL_DURATION = 500;
  const CALL_REPEATS = 3;

  class SoundGenerator {
    constructor() {
      this._audioContext = null;
      this._volume = DEFAULT_VOLUME;
      this._enabled = true;
      this._destroyed = false;
    }

    _getAudioContext() {
      if (this._audioContext) return this._audioContext;

      if (typeof AudioContext !== 'undefined') {
        this._audioContext = new AudioContext();
      } else if (typeof webkitAudioContext !== 'undefined') {
        this._audioContext = new webkitAudioContext();
      }

      return this._audioContext;
    }

    _createEnvelope(audioContext, gainNode, attackTime, decayTime, duration) {
      const now = audioContext.currentTime;

      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(this._volume, now + (attackTime / 1000));
      gainNode.gain.linearRampToValueAtTime(0, now + ((attackTime + decayTime) / 1000));

      return now + (duration / 1000);
    }

    _playTone(options) {
      if (this._destroyed) return;
      if (!this._enabled) return;

      const audioContext = this._getAudioContext();
      if (!audioContext) return;

      if (audioContext.state === 'suspended') {
        audioContext.resume();
      }

      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.type = options.waveType || 'sine';
      oscillator.frequency.setValueAtTime(options.frequency, audioContext.currentTime);

      if (options.frequencyEnd) {
        oscillator.frequency.linearRampToValueAtTime(
          options.frequencyEnd,
          audioContext.currentTime + (options.duration / 1000)
        );
      }

      gainNode.gain.setValueAtTime(0, audioContext.currentTime);

      this._createEnvelope(
        audioContext,
        gainNode,
        options.attack || 10,
        options.decay || 90,
        options.duration || 100
      );

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + (options.duration / 1000) + 0.1);

      oscillator.onended = () => {
        this._cleanupNode(oscillator);
        this._cleanupNode(gainNode);
      };
    }

    _cleanupNode(node) {
      if (!node) return;

      try {
        if (typeof node.disconnect === 'function') {
          node.disconnect();
        }
      } catch (e) {
      }
    }

    _playSequence(tones, intervalMs = 0) {
      if (this._destroyed) return;
      if (!this._enabled) return;

      let delay = 0;

      for (const tone of tones) {
        setTimeout(() => {
          if (!this._destroyed && this._enabled) {
            this._playTone(tone);
          }
        }, delay);

        delay += tone.duration + intervalMs;
      }
    }

    playNotificationPing() {
      if (this._destroyed) return;
      if (!this._enabled) return;

      this._playTone({
        frequency: PING_FREQUENCY,
        waveType: 'sine',
        duration: PING_DURATION,
        attack: PING_ATTACK,
        decay: PING_DECAY
      });
    }

    playVoiceTone() {
      if (this._destroyed) return;
      if (!this._enabled) return;

      this._playTone({
        frequency: VOICE_FREQUENCY,
        waveType: 'triangle',
        duration: VOICE_DURATION,
        attack: VOICE_ATTACK,
        decay: VOICE_DECAY
      });
    }

    playErrorBeep() {
      if (this._destroyed) return;
      if (!this._enabled) return;

      const tones = [];

      for (let i = 0; i < ERROR_REPEATS; i++) {
        tones.push({
          frequency: ERROR_FREQUENCY,
          waveType: 'square',
          duration: ERROR_DURATION,
          attack: 5,
          decay: ERROR_DURATION - 5
        });
      }

      this._playSequence(tones, 50);
    }

    playCallRing() {
      if (this._destroyed) return;
      if (!this._enabled) return;

      const tones = [];

      for (let i = 0; i < CALL_REPEATS; i++) {
        tones.push({
          frequency: CALL_FREQUENCY,
          waveType: 'sine',
          duration: CALL_DURATION / 2,
          attack: 20,
          decay: (CALL_DURATION / 2) - 20
        });

        tones.push({
          frequency: CALL_FREQUENCY * 1.2,
          waveType: 'sine',
          duration: CALL_DURATION / 2,
          attack: 20,
          decay: (CALL_DURATION / 2) - 20
        });
      }

      this._playSequence(tones, 50);
    }

    play(type) {
      if (this._destroyed) return;
      if (!this._enabled) return;

      switch (type) {
        case SOUND_TYPE_MESSAGE:
          this.playNotificationPing();
          break;

        case SOUND_TYPE_VOICE:
          this.playVoiceTone();
          break;

        case SOUND_TYPE_ERROR:
          this.playErrorBeep();
          break;

        case SOUND_TYPE_CALL:
          this.playCallRing();
          break;

        default:
          this.playNotificationPing();
          break;
      }
    }

    setVolume(volume) {
      this._volume = Math.max(0, Math.min(1, volume));
    }

    getVolume() {
      return this._volume;
    }

    isEnabled() {
      return this._enabled;
    }

    enable() {
      this._enabled = true;
    }

    disable() {
      this._enabled = false;
    }

    destroy() {
      if (this._destroyed) return;

      this._destroyed = true;

      if (this._audioContext) {
        if (this._audioContext.state !== 'closed') {
          this._audioContext.close();
        }
        this._audioContext = null;
      }

      this._volume = DEFAULT_VOLUME;
    }
  }

  exports.SoundGenerator = SoundGenerator;

})(typeof globalThis !== 'undefined' ? globalThis : this);