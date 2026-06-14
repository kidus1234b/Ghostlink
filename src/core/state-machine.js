// StateMachine — Generic async state machine for GhostLink peer lifecycle
(function(exports) {
  'use strict';

  /**
   * Legal state transitions map
   * Defines allowed transitions from each state
   * @type {Object.<string, string[]>}
   */
  const LEGAL_TRANSITIONS = {
    idle:           ['connecting'],
    connecting:     ['signaling', 'disconnected', 'idle'],
    signaling:      ['handshaking', 'disconnected', 'idle'],
    handshaking:    ['connected', 'degraded', 'disconnected', 'idle'],
    connected:      ['degraded', 'disconnected'],
    degraded:       ['connected', 'disconnected'],
    disconnected:   ['reconnecting', 'idle'],
    reconnecting:   ['connecting', 'disconnected', 'idle'],
  };

  /**
   * StateMachine - Generic async state machine for peer connection lifecycle
   * Manages state transitions with enter/exit/change listeners and history
   * @class
   */
  class StateMachine {
    /**
     * Creates a new StateMachine instance
     * @param {string} [initialState='idle'] - Starting state
     * @param {Object} [options={}] - Configuration options
     * @param {number} [options.maxHistory=50] - Maximum history entries to retain
     * @param {Object} [options.log] - Logger instance for warnings
     */
    constructor(initialState = 'idle', options = {}) {
      /** @type {string} Current state */
      this._state = initialState;
      /** @type {Array<{state: string, ts: number, from?: string, meta?: Object}>} State history */
      this._history = [{ state: initialState, ts: Date.now() }];
      /** @type {number} Maximum history entries */
      this._maxHistory = options.maxHistory || 50;
      /** @type {Object.<string, Function[]>} Event listeners */
      this._listeners = { enter: [], exit: [], change: [] };
      /** @type {Object} Logger for warnings */
      this._log = options.log || console;
      /** @type {boolean} Transition lock to prevent reentrancy */
      this._locked = false;
    }

    /**
     * Gets the current state
     * @returns {string} Current state name
     */
    get state() { return this._state; }

    /**
     * Sets the current state (use transition() for state changes)
     * @param {string} s - New state
     */
    set state(s) { this._state = s; }

    /**
     * Checks if a transition to target state is legal from current state
     * @param {string} target - Target state name
     * @returns {boolean} True if transition is allowed
     */
    can(target) {
      return (LEGAL_TRANSITIONS[this._state] || []).includes(target);
    }

    /**
     * Attempts a state transition to target state
     * @param {string} target - Target state name
     * @param {Object} [meta={}] - Optional metadata for history
     * @returns {boolean} True if transition succeeded
     */
    transition(target, meta = {}) {
      if (this._locked) return false;

      if (!this.can(target)) {
        this._log.warn(`StateMachine: illegal transition ${this._state} -> ${target}`);
        return false;
      }

      this._locked = true;
      const prev = this._state;
      this._state = target;

      // Record history
      this._history.push({ state: target, ts: Date.now(), from: prev, meta });
      if (this._history.length > this._maxHistory) this._history.shift();

      this._locked = false;

      // Fire listeners
      for (const fn of this._listeners.exit)  { try { fn(prev, target); } catch (e) { /* swallow */ } }
      for (const fn of this._listeners.enter) { try { fn(target, prev); } catch (e) { /* swallow */ } }
      for (const fn of this._listeners.change){ try { fn(target, prev, meta); } catch (e) { /* swallow */ } }

      return true;
    }

    /**
     * Registers a listener for state change events
     * @param {string} event - Event type: 'enter', 'exit', or 'change'
     * @param {Function} fn - Listener callback function
     * @returns {Function} Deregistration function
     */
    on(event, fn) {
      if (['enter', 'exit', 'change'].includes(event)) {
        this._listeners[event].push(fn);
        return () => { this._listeners[event] = this._listeners[event].filter(f => f !== fn); };
      }
      return () => {};
    }

    /**
     * Returns a copy of the state change history
     * @returns {Array<{state: string, ts: number, from?: string, meta?: Object}>} History array
     */
    history() { return [...this._history]; }

    /**
     * Resets the state machine to idle state
     */
    reset() { this.transition('idle'); }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.StateMachine = StateMachine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
