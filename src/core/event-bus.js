// EventBus — centralized async event system for GhostLink
// Supports: sync/async handlers, wildcard '*' subscriptions, once() unregistration, priority
(function(exports) {
  'use strict';

  /**
   * Generates a unique identifier for subscriptions
   * @returns {string} A unique ID string
   */
  const _uuid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  /**
   * EventBus - A powerful async event system with wildcard support
   * Provides centralized event management for GhostLink components
   * @class
   */
  class EventBus {
    /**
     * Creates a new EventBus instance
     * @param {string} [name='ghostlink'] - Name identifier for this bus
     */
    constructor(name = 'ghostlink') {
      /** @type {string} Bus identifier */
      this.name = name;
      /** @type {Object.<string, Array<{id: string, fn: Function, once: boolean, priority: number}>>} */
      this._handlers = {};
      /** @type {Array<{id: string, fn: Function}>} Global interceptors */
      this._wiretaps = [];
      /** @type {Object.<string, {count: number, lastAt: number}>} Topic statistics */
      this._metrics = {};
      /** @type {Array<{topic: string, data: any, ts: number}>} Recent events log */
      this._log = [];
      /** @type {number} Maximum log entries to retain */
      this._maxLog = 200;
      /** @type {Map<string, Function>} Pending waitFor resolvers */
      this._waiters = new Map();
    }

    /**
     * Subscribe to an event topic
     * @param {string} topic - Event topic name (supports '*' wildcard)
     * @param {Function} fn - Handler function (can be async)
     * @param {number} [priority=0] - Higher priority handlers fire first
     * @returns {Function} Unsubscribe function
     */
    on(topic, fn, priority = 0) {
      if (!this._handlers[topic]) this._handlers[topic] = [];
      const id = _uuid();
      this._handlers[topic].push({ id, fn, once: false, priority });
      this._handlers[topic].sort((a, b) => b.priority - a.priority);
      return () => this.off(topic, id);
    }

    /**
     * Subscribe to an event topic for one-time execution
     * @param {string} topic - Event topic name
     * @param {Function} fn - Handler function (can be async)
     * @param {number} [priority=0] - Higher priority handlers fire first
     * @returns {Function} Unsubscribe function
     */
    once(topic, fn, priority = 0) {
      if (!this._handlers[topic]) this._handlers[topic] = [];
      const id = _uuid();
      this._handlers[topic].push({ id, fn, once: true, priority });
      this._handlers[topic].sort((a, b) => b.priority - a.priority);
      return () => this.off(topic, id);
    }

    /**
     * Unsubscribe a specific handler
     * @param {string} topic - Event topic name
     * @param {string} id - Handler subscription ID
     */
    off(topic, id) {
      if (!this._handlers[topic]) return;
      this._handlers[topic] = this._handlers[topic].filter(h => h.id !== id);
      if (!this._handlers[topic].length) delete this._handlers[topic];
    }

    /**
     * Emit an event asynchronously, collecting handler results
     * @param {string} topic - Event topic name
     * @param {*} data - Event payload data
     * @returns {Promise<Array<{id: string, ok: boolean, error?: string}>>} Handler results
     */
    async emit(topic, data) {
      // Log event entry
      const entry = { topic, data, ts: Date.now() };
      this._log.push(entry);
      if (this._log.length > this._maxLog) this._log.shift();

      // Update metrics
      if (!this._metrics[topic]) this._metrics[topic] = { count: 0, lastAt: null };
      this._metrics[topic].count++;
      this._metrics[topic].lastAt = Date.now();

      // Wiretaps fire first (before regular handlers)
      for (const tap of this._wiretaps) {
        try { await tap(topic, data); } catch (e) { console.error('[EventBus wiretap]', e); }
      }

      // Resolve any pending waitFor for this topic
      if (this._waiters.has(topic)) {
        const waiters = this._waiters.get(topic);
        this._waiters.delete(topic);
        for (const resolve of waiters) {
          try { resolve(data); } catch (e) { /* ignore resolve errors */ }
        }
      }

      // Get handlers for topic and wildcard '*'
      const handlers = this._handlers[topic] || [];
      const wildcardHandlers = this._handlers['*'] || [];
      const all = [...handlers, ...wildcardHandlers].sort((a, b) => b.priority - a.priority);

      const results = [];
      for (const h of all) {
        try {
          const result = h.fn(data);
          if (result instanceof Promise) await result;
          results.push({ id: h.id, ok: true });
        } catch (e) {
          results.push({ id: h.id, ok: false, error: e.message });
          console.error(`[EventBus:${topic}] handler ${h.id} error:`, e);
        }
      }

      // Remove once handlers after execution
      this._handlers[topic] = handlers.filter(h => !h.once);
      return results;
    }

    /**
     * Emit an event synchronously (no await on handlers)
     * @param {string} topic - Event topic name
     * @param {*} data - Event payload data
     */
    emitSync(topic, data) {
      const handlers = (this._handlers[topic] || []).concat(this._handlers['*'] || []);
      for (const h of handlers.sort((a, b) => b.priority - a.priority)) {
        try { h.fn(data); } catch (e) { console.error(`[EventBus:${topic}] sync error:`, e); }
      }
      this._handlers[topic] = (this._handlers[topic] || []).filter(h => !h.once);
    }

    /**
     * Add a global wiretap interceptor that fires before all handlers
     * @param {Function} fn - Interceptor function (async-compatible)
     * @returns {Function} Removal function
     */
    wiretap(fn) {
      const id = _uuid();
      this._wiretaps.push({ id, fn });
      return () => { this._wiretaps = this._wiretaps.filter(t => t.id !== id); };
    }

    /**
     * Returns a Promise that resolves on the first emit of the specified topic
     * @param {string} topic - Event topic to wait for
     * @param {number} [timeout=5000] - Timeout in milliseconds
     * @returns {Promise<*>} Resolves with the event data
     * @throws {Error} Rejects if timeout is reached
     */
    waitFor(topic, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._waiters.delete(topic);
          reject(new Error(`waitFor timeout: ${topic}`));
        }, timeout);

        if (!this._waiters.has(topic)) {
          this._waiters.set(topic, []);
        }
        this._waiters.get(topic).push((data) => {
          clearTimeout(timer);
          resolve(data);
        });
      });
    }

    /**
     * Returns metrics for a specific topic or all topics
     * @param {string} [topic] - Topic name (optional)
     * @returns {Object|null} Metrics object or null if not found
     */
    metrics(topic) {
      if (topic) return this._metrics[topic] || null;
      return { ...this._metrics };
    }

    /**
     * Returns a copy of the recent event log
     * @returns {Array<{topic: string, data: *, ts: number}>} Recent events
     */
    log() { return [...this._log]; }

    /**
     * Returns array of subscribed topic names
     * @returns {string[]} Array of topic names
     */
    topics() {
      return Object.keys(this._handlers);
    }

    /**
     * Returns handler IDs for a topic
     * @param {string} topic - Event topic name
     * @returns {string[]} Array of handler IDs
     */
    handlers(topic) { return (this._handlers[topic] || []).map(h => h.id); }
  }

  // Global singleton instance for application-wide use
  const globalBus = new EventBus('ghostlink-global');

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.EventBus = EventBus;
  exports.GhostLink.globalBus = globalBus;
})(typeof globalThis !== 'undefined' ? globalThis : this);
