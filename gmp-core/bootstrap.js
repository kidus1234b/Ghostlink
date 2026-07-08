import { EventEmitter } from 'events';
import { loadPublicPeers } from './public-peer-list.js';
import config from './config.js';
import logger from './logger.js';
import metrics from './metrics.js';

export class BootstrapManager extends EventEmitter {
  constructor(node, options = {}) {
    super();
    this.node = node;
    
    // Configure defaults from config.js
    this.minPeers = options.minPeers || config.GMP_MIN_PEERS;
    this.parallelCount = options.parallelCount || 5;
    this.disableBootstrap = options.disableBootstrap || false;
    this.publicPeersPath = options.publicPeersPath || null;
    this.stage1TimeoutMs = options.stage1TimeoutMs || config.GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS;
    this.stage2TimeoutMs = options.stage2TimeoutMs || config.GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS;
    this.rebootstrapBackoffInitialMs = options.rebootstrapBackoffInitialMs || config.GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS;

    this.stage = 'failed'; // 'stage1' | 'stage2' | 'failed' | 'sufficient'
    this.isBootstrapping = false;
    this.failureCount = 0;

    this.dialingNodeIds = new Set();
    this.failedAttempts = new Set();
    this.rebootstrapTimer = null;

    // Listen for peer disconnections to re-trigger bootstrap if below minPeers/2
    this.closeListener = () => {
      this.checkAndTriggerRebootstrap();
    };
    this.node.on('close', this.closeListener);
  }

  getDirectConnectionCount() {
    return Array.from(this.node.connections.values())
      .filter(link => link.state === 'connected' && !link.isVirtual).length;
  }

  async start() {
    if (this.disableBootstrap || this.isBootstrapping) return;

    if (this.rebootstrapTimer) {
      clearTimeout(this.rebootstrapTimer);
      this.rebootstrapTimer = null;
    }

    this.isBootstrapping = true;
    this.dialingNodeIds.clear();
    this.failedAttempts.clear();

    metrics.increment('bootstrap.attempts');
    metrics.set('bootstrap.lastAttemptAt', new Date().toISOString());

    // --- Stage 1: Cached Peers ---
    this.stage = 'stage1';
    const candidates = this.node.peerCache.getCandidates() || [];
    const topN = candidates.slice(0, this.parallelCount);

    logger.info('bootstrap', 'stage1-start', `Starting bootstrap stage 1 with ${topN.length} candidates`, {
      candidatesCount: topN.length
    });

    if (topN.length > 0) {
      topN.forEach(c => this.dialCandidate(c));
    }

    // Wait up to stage1TimeoutMs or until connectedCount >= minPeers
    let startTime = Date.now();
    while (Date.now() - startTime < this.stage1TimeoutMs) {
      if (this.getDirectConnectionCount() >= this.minPeers) {
        this.stage = 'sufficient';
        this.isBootstrapping = false;
        this.failureCount = 0;
        const count = this.getDirectConnectionCount();
        logger.info('bootstrap', 'complete', `Bootstrap complete with ${count} peers in Stage 1`, { peersConnected: count });
        this.emit('bootstrap-complete', count);
        this.node.emit('bootstrap-complete', count);
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    // --- Stage 2: Public Peers ---
    this.stage = 'stage2';
    const publicPeers = loadPublicPeers(this.publicPeersPath || undefined);
    const availablePublic = publicPeers.filter(p => !this.node.getLinkByNodeId(p.nodeId));
    const nextBatch = availablePublic.slice(0, this.parallelCount);

    logger.info('bootstrap', 'stage2-start', `Stage 1 timed out. Starting bootstrap stage 2 with ${nextBatch.length} public peers`, {
      publicPeersCount: nextBatch.length
    });

    if (nextBatch.length > 0) {
      nextBatch.forEach(p => this.dialCandidate(p));
    }

    // Wait up to stage2TimeoutMs or until connectedCount >= minPeers
    startTime = Date.now();
    while (Date.now() - startTime < this.stage2TimeoutMs) {
      if (this.getDirectConnectionCount() >= this.minPeers) {
        this.stage = 'sufficient';
        this.isBootstrapping = false;
        this.failureCount = 0;
        const count = this.getDirectConnectionCount();
        logger.info('bootstrap', 'complete', `Bootstrap complete with ${count} peers in Stage 2`, { peersConnected: count });
        this.emit('bootstrap-complete', count);
        this.node.emit('bootstrap-complete', count);
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    // --- Stage 3: Failed / Fallback ---
    this.stage = 'failed';
    this.isBootstrapping = false;
    const count = this.getDirectConnectionCount();
    
    logger.warn('bootstrap', 'failed', `Bootstrap finished without sufficient peers (connected: ${count}, required: ${this.minPeers})`, { peersConnected: count });
    this.emit('bootstrap-failed', count);
    this.node.emit('bootstrap-failed', count);

    // Exponential backoff re-run if below minPeers/2
    if (count < this.minPeers / 2) {
      const backoffInitial = this.rebootstrapBackoffInitialMs;
      const backoffs = [backoffInitial, backoffInitial * 2, backoffInitial * 4, backoffInitial * 10];
      const delay = backoffs[Math.min(this.failureCount, backoffs.length - 1)];
      this.failureCount++;

      logger.info('bootstrap', 'retry-scheduled', `Scheduling bootstrap retry in ${delay}ms`, { delay, failureCount: this.failureCount });

      this.rebootstrapTimer = setTimeout(() => {
        this.rebootstrapTimer = null;
        this.start();
      }, delay);
      
      if (this.rebootstrapTimer && this.rebootstrapTimer.unref) {
        this.rebootstrapTimer.unref();
      }
    }
  }

  async dialCandidate(candidate) {
    if (!candidate || !candidate.nodeId) return;

    const nodeIdHex = candidate.nodeId;
    if (this.node.identity && nodeIdHex === this.node.identity.nodeIdHex) return;

    if (this.node.getLinkByNodeId(nodeIdHex)) return;
    if (this.dialingNodeIds.has(nodeIdHex)) return;
    if (this.failedAttempts.has(nodeIdHex)) return;

    this.dialingNodeIds.add(nodeIdHex);

    try {
      await this.node.dial(candidate.address, candidate.port);
    } catch (err) {
      this.failedAttempts.add(nodeIdHex);
      this.node.peerCache.recordFailure(nodeIdHex);
    } finally {
      this.dialingNodeIds.delete(nodeIdHex);
    }
  }

  attemptCandidates() {
    if (!this.isBootstrapping) return;
    if (this.getDirectConnectionCount() >= this.minPeers) return;

    const candidates = this.node.peerCache.getCandidates() || [];
    const active = candidates.filter(c => !this.dialingNodeIds.has(c.nodeId) && !this.failedAttempts.has(c.nodeId) && !this.node.getLinkByNodeId(c.nodeId));
    
    if (active.length > 0) {
      const toDial = active.slice(0, this.parallelCount - this.dialingNodeIds.size);
      toDial.forEach(c => this.dialCandidate(c));
    }
  }

  checkAndTriggerRebootstrap() {
    if (this.disableBootstrap || this.isBootstrapping || this.rebootstrapTimer) return;
    const count = this.getDirectConnectionCount();
    if (count < this.minPeers / 2) {
      this.failureCount = 0; // Reset failureCount for new drop-triggered bootstrap
      const delay = this.rebootstrapBackoffInitialMs; // 30 seconds default
      logger.info('bootstrap', 'trigger-rebootstrap', `Peers below critical threshold (${count} < ${this.minPeers / 2}). Scheduling re-bootstrap in ${delay}ms.`, { peersConnected: count });
      this.rebootstrapTimer = setTimeout(() => {
        this.rebootstrapTimer = null;
        this.start();
      }, delay);
      if (this.rebootstrapTimer && this.rebootstrapTimer.unref) {
        this.rebootstrapTimer.unref();
      }
    }
  }

  close() {
    this.node.off('close', this.closeListener);
    if (this.rebootstrapTimer) {
      clearTimeout(this.rebootstrapTimer);
      this.rebootstrapTimer = null;
    }
  }
}
