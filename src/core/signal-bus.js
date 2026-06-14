// signal-bus.js — Centralized typed signal bus for inter-module communication
// Wraps EventBus with typed channels for clean, predictable messaging.
(function(exports) {
  'use strict';

  const EventBus = (exports.GhostLink && exports.GhostLink.EventBus) || require('./event-bus.js').GhostLink.EventBus;

  /** @type {string[]} Predefined typed channel names */
  const CHANNEL_NAMES = ['peer', 'network', 'message', 'file', 'presence', 'security', 'system'];

  /**
   * SignalBus — Pre-channel typed event messaging for GhostLink
   * Each channel supports: on, once, emit, waitFor
   * @class
   */
  class SignalBus {
    /**
     * Creates a new SignalBus wrapping an internal EventBus
     * @param {Object} [options] - Optional configuration
     * @param {string} [options.busName='ghostlink-signals'] - Name for the internal EventBus
     * @param {Array<string>} [options.channels] - Additional custom channels beyond the defaults
     */
    constructor({ busName = 'ghostlink-signals', channels = [] } = {}) {
      /** @type {EventBus} Internal event bus instance */
      this._bus = new EventBus(busName);
      /** @type {Set<string>} Active channel names */
      this._channels = new Set([...CHANNEL_NAMES, ...channels]);
    }

    /**
     * Get a typed channel API
     * @param {string} channel - Channel name (e.g. 'peer', 'security')
     * @returns {Object} Channel API with on(), once(), emit(), waitFor()
     * @private
     */
    _channel(channel) {
      if (!this._channels.has(channel)) {
        throw new Error(`SignalBus: unknown channel "${channel}"`);
      }
      return {
        /**
         * Subscribe to events on this channel
         * @param {Function} fn - Handler function
         * @param {number} [priority=0] - Higher priority handlers fire first
         * @returns {Function} Unsubscribe function
         */
        on: (fn, priority = 0) => this._bus.on(channel, fn, priority),

        /**
         * Subscribe to a one-time event on this channel
         * @param {Function} fn - Handler function
         * @param {number} [priority=0] - Higher priority handlers fire first
         * @returns {Function} Unsubscribe function
         */
        once: (fn, priority = 0) => this._bus.once(channel, fn, priority),

        /**
         * Emit an event on this channel
         * @param {*} data - Event payload
         * @returns {Promise<Array>} Handler results
         */
        emit: (data) => this._bus.emit(channel, data),

        /**
         * Wait for the next event on this channel
         * @param {number} [timeout=5000] - Timeout in milliseconds
         * @returns {Promise<*>} Resolves with the event data
         */
        waitFor: (timeout = 5000) => this._bus.waitFor(channel, timeout),
      };
    }

    /** @returns {Object} peer channel */
    get peer()     { return this._channel('peer');     }
    /** @returns {Object} network channel */
    get network()  { return this._channel('network');  }
    /** @returns {Object} message channel */
    get message()  { return this._channel('message');  }
    /** @returns {Object} file channel */
    get file()     { return this._channel('file');     }
    /** @returns {Object} presence channel */
    get presence() { return this._channel('presence');}
    /** @returns {Object} security channel */
    get security() { return this._channel('security');}
    /** @returns {Object} system channel */
    get system()   { return this._channel('system');  }

    /**
     * Adds an arbitrary named channel dynamically
     * @param {string} channel - Name of the new channel
     */
    addChannel(channel) {
      this._channels.add(channel);
    }

    /**
     * List active channel names
     * @returns {string[]}
     */
    channels() {
      return Array.from(this._channels);
    }

    /**
     * Access raw underlying EventBus for advanced use
     * @returns {EventBus}
     */
    get rawBus() {
      return this._bus;
    }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.SignalBus = SignalBus;
})(typeof globalThis !== 'undefined' ? globalThis : this);