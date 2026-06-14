// RetryQueue — Async operation retry with exponential backoff
(function(exports) {
  'use strict';

  /**
   * RetryQueue - Async operation retry with exponential backoff
   * Manages a queue of operations with automatic retry on failure
   * @class
   */
  class RetryQueue {
    /**
     * Creates a new RetryQueue instance
     * @param {Object} [options={}] - Configuration options
     * @param {number} [options.maxRetries=5] - Maximum retry attempts per item
     * @param {number} [options.baseDelay=500] - Base delay in milliseconds
     * @param {number} [options.maxDelay=30000] - Maximum delay cap in milliseconds
     * @param {boolean} [options.jitter=true] - Add random jitter to delays
     * @param {Function} [options.onRetry] - Callback: (attempt, delay, error) => void
     * @param {Function} [options.onExhausted] - Callback: (error) => void when retries exhausted
     */
    constructor(options = {}) {
      /** @type {number} Maximum retry attempts */
      this.maxRetries = options.maxRetries || 5;
      /** @type {number} Base delay for exponential backoff */
      this.baseDelay = options.baseDelay || 500;
      /** @type {number} Maximum delay cap */
      this.maxDelay = options.maxDelay || 30000;
      /** @type {boolean} Whether to add random jitter */
      this.jitter = options.jitter !== undefined ? options.jitter : true;
      /** @type {Function|null} Retry callback */
      this.onRetry = options.onRetry || null;
      /** @type {Function|null} Exhausted callback */
      this.onExhausted = options.onExhausted || null;
      /** @type {Array} Internal queue of pending items */
      this._queue = [];
      /** @type {boolean} Whether queue is currently processing */
      this._processing = false;
      /** @type {number} Number of active operations being processed */
      this._activeCount = 0;
      /** @type {Array<Function>} Promise resolvers for drain() */
      this._drainResolvers = [];
    }

    /**
     * Calculates delay for a given attempt number with exponential backoff
     * @param {number} attempt - Current attempt number (0-indexed)
     * @returns {number} Delay in milliseconds
     * @private
     */
    _delay(attempt) {
      const exp = Math.min(this.baseDelay * Math.pow(2, attempt), this.maxDelay);
      const jitter = this.jitter ? Math.random() * exp * 0.2 : 0;
      return exp + jitter;
    }

    /**
     * Adds an operation to the retry queue
     * @param {Function} fn - Async function to execute
     * @param {*} [context=null] - Optional context passed to fn
     * @returns {Promise<*>} Resolves with fn's result
     */
    async enqueue(fn, context = null) {
      return new Promise((resolve, reject) => {
        this._queue.push({ fn, context, resolve, reject, attempt: 0 });
        if (!this._processing) this._process();
      });
    }

    /**
     * Internal queue processor - processes items sequentially with retry logic
     * @returns {Promise<void>}
     * @private
     */
    async _process() {
      if (this._processing || !this._queue.length) return;
      this._processing = true;

      while (this._queue.length) {
        const item = this._queue[0];
        this._activeCount++;

        try {
          const result = await item.fn(item.context);
          this._queue.shift();
          this._activeCount--;
          item.resolve(result);

          // Check if drain waiting
          if (this._activeCount === 0 && this._drainResolvers.length > 0) {
            const drainers = this._drainResolvers.splice(0);
            for (const resolve of drainers) resolve();
          }
        } catch (err) {
          this._activeCount--;

          if (item.attempt < this.maxRetries) {
            item.attempt++;
            const delay = this._delay(item.attempt);
            this._queue.shift();

            if (this.onRetry) this.onRetry(item.attempt, delay, err);

            // Delay then re-add to end of queue
            await new Promise(r => setTimeout(r, delay));
            this._queue.push(item);
          } else {
            this._queue.shift();
            if (this.onExhausted) this.onExhausted(err);
            item.reject(err);
          }
        }
      }

      this._processing = false;
    }

    /**
     * Clears all pending items from the queue
     */
    clear() { this._queue = []; }

    /**
     * Gets the number of pending items in the queue
     * @returns {number} Queue size
     */
    get size() { return this._queue.length; }

    /**
     * Returns a promise that resolves when all current items complete
     * Does not wait for new items added after drain() is called
     * @returns {Promise<void>}
     */
    drain() {
      return new Promise((resolve) => {
        if (this._activeCount === 0 && this._queue.length === 0) {
          resolve();
          return;
        }
        this._drainResolvers.push(resolve);
      });
    }
  }

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.RetryQueue = RetryQueue;
})(typeof globalThis !== 'undefined' ? globalThis : this);
