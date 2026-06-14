(function(root) {
  'use strict';

  const EVENT_SOUND = 'alert:sound';
  const EVENT_UNREAD_CHANGED = 'alert:unread-changed';
  const EVENT_PULSE_SHOW = 'alert:pulse-show';
  const EVENT_PULSE_HIDE = 'alert:pulse-hide';

  const SOUND_TYPE_MESSAGE = 'message';
  const SOUND_TYPE_VOICE = 'voice';
  const SOUND_TYPE_CALL = 'call';
  const SOUND_TYPE_ERROR = 'error';

  const PULSE_ANIMATION_DURATION = 2000;
  const SOUND_DEBOUNCE_MS = 300;

  class InAppAlertManager {
    constructor(eventBus) {
      this._eventBus = eventBus || (typeof globalThis !== 'undefined' ? globalThis.GhostLink.EventBus : null) || (typeof globalThis !== 'undefined' ? globalThis.GhostLink.globalBus : null);

      this._unreadCounts = new Map();
      this._typingPeers = new Set();
      this._onlinePeers = new Set();
      this._pulseElements = new Map();
      this._pulseTimers = new Map();
      this._soundDebounceTimers = new Map();
      this._soundEnabled = true;
      this._volume = 0.5;
      this._destroyed = false;

      this._soundGenerator = null;

      this._init();
    }

    _init() {
      if (typeof window === 'undefined') return;

      this._setupVisibilityChangeListener();
      this._setupOnlineStatusListener();

      this._lazyInitSoundGenerator();
    }

    _setupVisibilityChangeListener() {
      if (typeof document === 'undefined') return;

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this._onTabHidden();
        } else {
          this._onTabVisible();
        }
      });
    }

    _setupOnlineStatusListener() {
      if (typeof window !== 'undefined') {
        window.addEventListener('online', () => this._emit(EVENT_SOUND, { type: 'online' }));
        window.addEventListener('offline', () => this._emit(EVENT_SOUND, { type: 'offline' }));
      }
    }

    _onTabHidden() {
      this._soundEnabled = true;
    }

    _onTabVisible() {
    }

    _lazyInitSoundGenerator() {
      if (this._soundGenerator) return;

      if (typeof globalThis !== 'undefined' && globalThis.GhostLink && globalThis.GhostLink.SoundGenerator) {
        this._soundGenerator = new globalThis.GhostLink.SoundGenerator();
        this._soundGenerator.setVolume(this._volume);
      }
    }

    _getEventBus() {
      if (this._eventBus) return this._eventBus;
      if (typeof globalThis !== 'undefined' && globalThis.GhostLink) {
        return globalThis.GhostLink.EventBus || globalThis.GhostLink.globalBus;
      }
      return null;
    }

    _emit(event, data) {
      const bus = this._getEventBus();
      if (bus && typeof bus.emit === 'function') {
        bus.emit(event, data);
      }
      if (typeof globalThis !== 'undefined' && globalThis.GhostLink && globalThis.GhostLink.emit) {
        globalThis.GhostLink.emit(event, data);
      }
    }

    playSound(type) {
      if (this._destroyed) return;
      if (!this._soundEnabled) return;

      if (this._isSoundDebounced(type)) return;

      this._setSoundDebounce(type);

      this._lazyInitSoundGenerator();

      if (this._soundGenerator && typeof this._soundGenerator.play === 'function') {
        this._soundGenerator.play(type);
        this._emit(EVENT_SOUND, { type: type });
      }
    }

    playNotificationSound(type) {
      this.playSound(type);
    }

    _isSoundDebounced(type) {
      const lastPlayed = this._soundDebounceTimers.get(type);
      if (!lastPlayed) return false;

      return (Date.now() - lastPlayed) < SOUND_DEBOUNCE_MS;
    }

    _setSoundDebounce(type) {
      this._soundDebounceTimers.set(type, Date.now());
    }

    addUnread(peerId) {
      if (this._destroyed) return;
      if (!peerId) return;

      const current = this._unreadCounts.get(peerId) || 0;
      this._unreadCounts.set(peerId, current + 1);

      this._emit(EVENT_UNREAD_CHANGED, {
        peerId: peerId,
        count: current + 1,
        total: this.getTotalUnread()
      });

      this.showPeerPulse(peerId);
      this.updateTabTitle();
    }

    removeUnread(peerId) {
      if (this._destroyed) return;
      if (!peerId) return;

      const current = this._unreadCounts.get(peerId) || 0;
      if (current > 0) {
        this._unreadCounts.set(peerId, current - 1);

        this._emit(EVENT_UNREAD_CHANGED, {
          peerId: peerId,
          count: current - 1,
          total: this.getTotalUnread()
        });

        if (current - 1 === 0) {
          this.hidePeerPulse(peerId);
        }
      }

      this.updateTabTitle();
    }

    getUnread(peerId) {
      return this._unreadCounts.get(peerId) || 0;
    }

    getTotalUnread() {
      let total = 0;
      for (const count of this._unreadCounts.values()) {
        total += count;
      }
      return total;
    }

    clearAllUnread() {
      if (this._destroyed) return;

      const clearedPeers = Array.from(this._unreadCounts.keys());

      this._unreadCounts.clear();

      for (const peerId of clearedPeers) {
        this.hidePeerPulse(peerId);
        this._emit(EVENT_UNREAD_CHANGED, {
          peerId: peerId,
          count: 0,
          total: 0
        });
      }

      this.updateTabTitle();
    }

    clearUnreadForPeer(peerId) {
      if (this._destroyed) return;
      if (!peerId) return;

      const hadUnread = this.getUnread(peerId) > 0;

      this._unreadCounts.delete(peerId);

      if (hadUnread) {
        this.hidePeerPulse(peerId);
        this._emit(EVENT_UNREAD_CHANGED, {
          peerId: peerId,
          count: 0,
          total: this.getTotalUnread()
        });
      }

      this.updateTabTitle();
    }

    showPeerPulse(peerId) {
      if (this._destroyed) return;
      if (!peerId) return;

      if (this._pulseTimers.has(peerId)) {
        clearTimeout(this._pulseTimers.get(peerId));
      }

      this._emit(EVENT_PULSE_SHOW, { peerId: peerId });

      const timer = setTimeout(() => {
        this.hidePeerPulse(peerId);
      }, PULSE_ANIMATION_DURATION);

      this._pulseTimers.set(peerId, timer);
    }

    hidePeerPulse(peerId) {
      if (this._destroyed) return;
      if (!peerId) return;

      const timer = this._pulseTimers.get(peerId);
      if (timer) {
        clearTimeout(timer);
        this._pulseTimers.delete(peerId);
      }

      this._emit(EVENT_PULSE_HIDE, { peerId: peerId });
    }

    setTyping(peerId, isTyping) {
      if (this._destroyed) return;
      if (!peerId) return;

      if (isTyping) {
        this._typingPeers.add(peerId);
      } else {
        this._typingPeers.delete(peerId);
      }
    }

    isTyping(peerId) {
      return this._typingPeers.has(peerId);
    }

    setPeerOnline(peerId, isOnline) {
      if (this._destroyed) return;
      if (!peerId) return;

      if (isOnline) {
        this._onlinePeers.add(peerId);
      } else {
        this._onlinePeers.delete(peerId);
      }
    }

    isPeerOnline(peerId) {
      return this._onlinePeers.has(peerId);
    }

    updateTabTitle() {
      if (typeof document === 'undefined' || !document) return;

      const totalUnread = this.getTotalUnread();

      if (totalUnread > 0) {
        document.title = `(${totalUnread}) GhostLink`;
      } else {
        document.title = 'GhostLink';
      }
    }

    setVolume(volume) {
      this._volume = Math.max(0, Math.min(1, volume));

      if (this._soundGenerator) {
        this._soundGenerator.setVolume(this._volume);
      }
    }

    getVolume() {
      return this._volume;
    }

    enableSound() {
      this._soundEnabled = true;
    }

    disableSound() {
      this._soundEnabled = false;
    }

    isSoundEnabled() {
      return this._soundEnabled;
    }

    getTypingPeers() {
      return Array.from(this._typingPeers);
    }

    getOnlinePeers() {
      return Array.from(this._onlinePeers);
    }

    getUnreadPeers() {
      return Array.from(this._unreadCounts.keys()).filter(peerId => this.getUnread(peerId) > 0);
    }

    getPeerInfo(peerId) {
      return {
        unread: this.getUnread(peerId),
        isTyping: this.isTyping(peerId),
        isOnline: this.isPeerOnline(peerId),
        hasPulse: this._pulseTimers.has(peerId)
      };
    }

    clearAllPeers() {
      this._typingPeers.clear();
      this._onlinePeers.clear();
      this._unreadCounts.clear();

      for (const timer of this._pulseTimers.values()) {
        clearTimeout(timer);
      }
      this._pulseTimers.clear();

      this.updateTabTitle();
    }

    destroy() {
      if (this._destroyed) return;

      this._destroyed = true;

      for (const timer of this._pulseTimers.values()) {
        clearTimeout(timer);
      }
      this._pulseTimers.clear();

      for (const timer of this._soundDebounceTimers.values()) {
        clearTimeout(timer);
      }
      this._soundDebounceTimers.clear();

      this._typingPeers.clear();
      this._onlinePeers.clear();
      this._unreadCounts.clear();
      this._pulseElements.clear();

      if (this._soundGenerator) {
        this._soundGenerator = null;
      }

      if (typeof document !== 'undefined' && document.title) {
        document.title = 'GhostLink';
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = InAppAlertManager;
  } else {
    root.InAppAlertManager = InAppAlertManager;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);