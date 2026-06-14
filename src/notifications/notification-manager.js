(function(exports) {
  'use strict';

  const EVENT_SHOWN = 'notification:shown';
  const EVENT_CLICKED = 'notification:clicked';
  const EVENT_PERMISSION_CHANGED = 'notification:permission-changed';
  const EVENT_ERROR = 'notification:error';

  const PERMISSION_DEFAULT = 'default';
  const PERMISSION_GRANTED = 'granted';
  const PERMISSION_DENIED = 'denied';

  const NOTIFICATION_TYPE_MESSAGE = 'message';
  const NOTIFICATION_TYPE_VOICE = 'voice';

  const THROTTLE_MIN_INTERVAL_MS = 5000;
  const ANTI_SPAM_COOLDOWN_MS = 10000;
  const MAX_TITLE_LENGTH = 200;

  class NotificationManager {
    constructor(eventBus) {
      this._eventBus = eventBus || (typeof globalThis !== 'undefined' ? globalThis.GhostLink.EventBus : null) || (typeof globalThis !== 'undefined' ? globalThis.GhostLink.globalBus : null);

      this._permission = PERMISSION_DEFAULT;
      this._isSupported = false;
      this._throttleTimers = new Map();
      this._antiSpamTimer = null;
      this._antiSpamLastNotification = 0;
      this._shownNotifications = new Map();
      this._unreadCounts = new Map();
      this._focused = false;
      this._destroyed = false;
      this._clickHandlers = new Map();

      this._init();
    }

    _init() {
      if (typeof window === 'undefined' || typeof document === 'undefined') {
        return;
      }

      this._isSupported = 'Notification' in window;

      if (this._isSupported) {
        this._permission = Notification.permission;
        this._updateFocusState();
        this._setupFocusListeners();
      }
    }

    _setupFocusListeners() {
      if (typeof window === 'undefined') return;

      window.addEventListener('focus', () => this._updateFocusState());
      window.addEventListener('blur', () => this._updateFocusState());
      window.addEventListener('resize', () => this._updateFocusState());
      document.addEventListener('visibilitychange', () => this._updateFocusState());
    }

    _updateFocusState() {
      const wasFocused = this._focused;
      this._focused = this._checkFocus();

      if (wasFocused !== this._focused && this._focused) {
        this._clearAllNotificationBadge();
      }
    }

    _checkFocus() {
      if (typeof document !== 'undefined' && typeof document.hasFocus === 'function') {
        return document.hasFocus();
      }
      if (typeof document !== 'undefined' && document.hidden !== undefined) {
        return !document.hidden;
      }
      return true;
    }

    isTabFocused() {
      return this._focused;
    }

    suppressIfFocused() {
      return this._focused;
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

    async requestPermission() {
      if (this._destroyed) {
        this._emit(EVENT_ERROR, { error: new Error('NotificationManager has been destroyed') });
        return PERMISSION_DENIED;
      }

      if (!this._isSupported) {
        this._emit(EVENT_ERROR, { error: new Error('Notifications not supported') });
        return PERMISSION_DENIED;
      }

      if (this._permission === PERMISSION_GRANTED) {
        return PERMISSION_GRANTED;
      }

      if (this._permission === PERMISSION_DENIED) {
        this._emit(EVENT_PERMISSION_CHANGED, { permission: PERMISSION_DENIED });
        return PERMISSION_DENIED;
      }

      try {
        const permission = await Notification.requestPermission();
        this._permission = permission;
        this._emit(EVENT_PERMISSION_CHANGED, { permission: permission });

        if (permission !== PERMISSION_GRANTED) {
          this._emit(EVENT_ERROR, { error: new Error('Notification permission denied') });
        }

        return permission;
      } catch (error) {
        this._emit(EVENT_ERROR, { error: error });
        return PERMISSION_DENIED;
      }
    }

    getPermissionState() {
      return this._permission;
    }

    isPermissionGranted() {
      return this._permission === PERMISSION_GRANTED;
    }

    isSupported() {
      return this._isSupported;
    }

    notify(type, data) {
      if (this._destroyed) return false;
      if (!this._isSupported) return false;

      if (type === NOTIFICATION_TYPE_MESSAGE) {
        return this.notifyMessage(data);
      } else if (type === NOTIFICATION_TYPE_VOICE) {
        return this.notifyVoiceMessage(data);
      }

      this._emit(EVENT_ERROR, { error: new Error(`Unknown notification type: ${type}`) });
      return false;
    }

    notifyMessage(data = {}) {
      if (this._destroyed) return false;
      if (!this._isSupported || !this.isPermissionGranted()) return false;

      const peerId = data.peerId || 'unknown';

      if (this._isThrottled(peerId)) {
        return false;
      }

      if (this._isAntiSpamActive()) {
        return false;
      }

      if (this.suppressIfFocused()) {
        return false;
      }

      if (this._isDuplicate(peerId, 'message')) {
        return false;
      }

      this._setThrottle(peerId);
      this._setAntiSpamCooldown();

      const notification = this._createNotification('message', {
        title: 'GhostLink',
        body: 'New encrypted message',
        tag: `message-${peerId}`,
        icon: this._getIcon()
      });

      if (notification) {
        this._trackShown(peerId, 'message', notification);
        this._setupClickHandler(notification, peerId);
        this._emit(EVENT_SHOWN, { type: 'message', peerId: peerId });
        return true;
      }

      return false;
    }

    notifyVoiceMessage(data = {}) {
      if (this._destroyed) return false;
      if (!this._isSupported || !this.isPermissionGranted()) return false;

      const peerId = data.peerId || 'unknown';

      if (this._isThrottled(peerId)) {
        return false;
      }

      if (this._isAntiSpamActive()) {
        return false;
      }

      if (this.suppressIfFocused()) {
        return false;
      }

      if (this._isDuplicate(peerId, 'voice')) {
        return false;
      }

      this._setThrottle(peerId);
      this._setAntiSpamCooldown();

      const notification = this._createNotification('voice', {
        title: 'GhostLink',
        body: 'New voice message',
        tag: `voice-${peerId}`,
        icon: this._getIcon()
      });

      if (notification) {
        this._trackShown(peerId, 'voice', notification);
        this._setupClickHandler(notification, peerId);
        this._emit(EVENT_SHOWN, { type: 'voice', peerId: peerId });
        return true;
      }

      return false;
    }

    _createNotification(type, options) {
      try {
        const notification = new Notification(options.title, {
          body: options.body,
          tag: options.tag,
          icon: options.icon,
          badge: options.badge,
          silent: true,
          requireInteraction: false,
          data: { type: type, timestamp: Date.now() }
        });

        return notification;
      } catch (error) {
        this._emit(EVENT_ERROR, { error: error });
        return null;
      }
    }

    _setupClickHandler(notification, peerId) {
      const handler = () => {
        if (typeof window !== 'undefined' && window.focus) {
          window.focus();
        }

        this.clearBadge(peerId);
        this._markAsRead(peerId);

        this._emit(EVENT_CLICKED, { peerId: peerId });

        if (notification && notification.close) {
          notification.close();
        }
      };

      this._clickHandlers.set(notification, handler);
      notification.addEventListener('click', handler);
    }

    _getIcon() {
      if (typeof globalThis !== 'undefined' && globalThis.GhostLink && globalThis.GhostLink.icons) {
        return globalThis.GhostLink.icons.notification || null;
      }
      return null;
    }

    _isThrottled(peerId) {
      const lastNotification = this._throttleTimers.get(peerId);
      if (!lastNotification) return false;

      const now = Date.now();
      return (now - lastNotification) < THROTTLE_MIN_INTERVAL_MS;
    }

    _setThrottle(peerId) {
      this._throttleTimers.set(peerId, Date.now());
    }

    _isAntiSpamActive() {
      const now = Date.now();
      return (now - this._antiSpamLastNotification) < ANTI_SPAM_COOLDOWN_MS;
    }

    _setAntiSpamCooldown() {
      this._antiSpamLastNotification = Date.now();
    }

    _isDuplicate(peerId, type) {
      const key = `${peerId}-${type}`;
      const lastNotification = this._shownNotifications.get(key);

      if (!lastNotification) return false;

      const now = Date.now();
      const timeout = 30000;

      if ((now - lastNotification.timestamp) > timeout) {
        this._shownNotifications.delete(key);
        return false;
      }

      return true;
    }

    _trackShown(peerId, type, notification) {
      const key = `${peerId}-${type}`;
      this._shownNotifications.set(key, {
        timestamp: Date.now(),
        notification: notification
      });

      this.incrementBadge(peerId);
      this._updateTabTitle();
    }

    _markAsRead(peerId) {
      this._unreadCounts.delete(peerId);
      this.updateTabTitle();
    }

    clearBadge(peerId) {
      if (!peerId) {
        this._clearAllNotificationBadge();
        return;
      }

      this._unreadCounts.delete(peerId);
      this._updateTabTitle();
    }

    _clearAllNotificationBadge() {
      if (typeof document !== 'undefined' && document.title) {
        document.title = 'GhostLink';
      }
    }

    incrementBadge(peerId) {
      if (!peerId) return;

      const current = this._unreadCounts.get(peerId) || 0;
      this._unreadCounts.set(peerId, current + 1);
      this._updateTabTitle();
    }

    decrementBadge(peerId) {
      if (!peerId) return;

      const current = this._unreadCounts.get(peerId) || 0;
      if (current > 0) {
        this._unreadCounts.set(peerId, current - 1);
      }
      this._updateTabTitle();
    }

    getTotalUnread() {
      let total = 0;
      for (const count of this._unreadCounts.values()) {
        total += count;
      }
      return total;
    }

    getUnreadCount(peerId) {
      return this._unreadCounts.get(peerId) || 0;
    }

    updateTabTitle() {
      if (typeof document === 'undefined' || !document.title) return;

      const totalUnread = this.getTotalUnread();

      if (totalUnread > 0) {
        document.title = `(${totalUnread}) GhostLink`;
      } else {
        document.title = 'GhostLink';
      }
    }

    getShownNotifications() {
      return new Map(this._shownNotifications);
    }

    clearOldNotifications(maxAgeMs = 60000) {
      const now = Date.now();
      const keysToDelete = [];

      for (const [key, data] of this._shownNotifications.entries()) {
        if ((now - data.timestamp) > maxAgeMs) {
          keysToDelete.push(key);
        }
      }

      for (const key of keysToDelete) {
        const data = this._shownNotifications.get(key);
        if (data && data.notification && data.notification.close) {
          data.notification.close();
        }
        this._shownNotifications.delete(key);
      }

      return keysToDelete.length;
    }

    destroy() {
      if (this._destroyed) return;

      this._destroyed = true;

      for (const [key, data] of this._shownNotifications.entries()) {
        if (data && data.notification && data.notification.close) {
          data.notification.close();
        }
      }
      this._shownNotifications.clear();

      for (const [notification, handler] of this._clickHandlers.entries()) {
        if (notification && notification.removeEventListener) {
          notification.removeEventListener('click', handler);
        }
      }
      this._clickHandlers.clear();

      this._throttleTimers.clear();

      if (this._antiSpamTimer) {
        clearTimeout(this._antiSpamTimer);
        this._antiSpamTimer = null;
      }

      this._unreadCounts.clear();

      if (typeof document !== 'undefined' && document.title) {
        document.title = 'GhostLink';
      }
    }
  }

  exports.NotificationManager = NotificationManager;

})(typeof globalThis !== 'undefined' ? globalThis : this);