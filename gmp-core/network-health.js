import { EventEmitter } from 'events';
import config from './config.js';
import logger from './logger.js';
import metrics from './metrics.js';

export class NetworkHealthMonitor extends EventEmitter {
  constructor(node) {
    super();
    this.node = node;
    this.startTime = Date.now();

    this.metrics = {
      currentPeerCount: 0,
      peakPeerCount: 0,
      messagesForwarded: 0,
      messagesDroppedNoRoute: 0,
      messagesDroppedTTL: 0,
      uptimeSeconds: 0,
      bootstrapAttempts: 0
    };

    // Keep track of timestamps for sliding window drop checks
    this.noRouteTimestamps = [];

    // Setup event listeners on node to track metrics
    this.forwardedListener = () => {
      this.metrics.messagesForwarded++;
    };
    this.ttlExpiredListener = () => {
      this.metrics.messagesDroppedTTL++;
    };
    this.noRouteListener = () => {
      this.metrics.messagesDroppedNoRoute++;
      this.noRouteTimestamps.push(Date.now());
    };

    this.node.on('forwarded', this.forwardedListener);
    this.node.on('ttl-expired', this.ttlExpiredListener);
    this.node.on('no-route', this.noRouteListener);

    // Periodical health check every 30 seconds
    const intervalMs = config.GMP_REANNOUNCE_INTERVAL_MS ? (config.GMP_REANNOUNCE_INTERVAL_MS / 2) : 30000;
    this.checkInterval = setInterval(() => {
      this.runHealthCheck();
    }, intervalMs);

    if (this.checkInterval && this.checkInterval.unref) {
      this.checkInterval.unref();
    }
  }

  getDirectConnectionCount() {
    return Array.from(this.node.connections.values())
      .filter(link => link.state === 'connected' && !link.isVirtual).length;
  }

  updatePeerCounts() {
    const current = this.getDirectConnectionCount();
    this.metrics.currentPeerCount = current;
    if (current > this.metrics.peakPeerCount) {
      this.metrics.peakPeerCount = current;
    }
  }

  runHealthCheck() {
    this.updatePeerCounts();

    const minPeers = this.node.bootstrap ? this.node.bootstrap.minPeers : config.GMP_MIN_PEERS;

    // 1. If connected peers < minPeers and not already bootstrapping, trigger bootstrap
    if (this.metrics.currentPeerCount < minPeers && this.node.bootstrap && !this.node.bootstrap.isBootstrapping) {
      logger.info('health-monitor', 'check-trigger-bootstrap', `Low peer count (${this.metrics.currentPeerCount} < ${minPeers}). Initiating re-bootstrap.`);
      this.node.bootstrap.start().catch(() => {});
    }

    // 2. Routing degradation check (sliding window of 5 minutes)
    const now = Date.now();
    const cutoff = now - 5 * 60 * 1000;
    this.noRouteTimestamps = this.noRouteTimestamps.filter(t => t > cutoff);
    const droppedInLast5M = this.noRouteTimestamps.length;
    const totalForwarded = this.metrics.messagesForwarded;

    if (droppedInLast5M > 0 && (totalForwarded === 0 || droppedInLast5M > 0.20 * totalForwarded)) {
      logger.warn('health-monitor', 'routing-degraded', `Routing tables are degraded: ${droppedInLast5M} drops in last 5m`, {
        droppedInLast5M,
        totalForwarded
      });
      this.node.emit('routing-degraded', {
        droppedInLast5M,
        totalForwarded
      });
      this.emit('routing-degraded', {
        droppedInLast5M,
        totalForwarded
      });
    }
  }

  getHealthReport() {
    this.updatePeerCounts();
    this.metrics.uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

    // Determine status
    let status = 'healthy';
    const minPeers = this.node.bootstrap ? this.node.bootstrap.minPeers : config.GMP_MIN_PEERS;

    const now = Date.now();
    const cutoff = now - 5 * 60 * 1000;
    const recentDrops = this.noRouteTimestamps.filter(t => t > cutoff).length;
    const totalForwarded = this.metrics.messagesForwarded;
    const isDegradedRouting = recentDrops > 0 && (totalForwarded === 0 || recentDrops > 0.20 * totalForwarded);

    if (this.node.bootstrap && this.node.bootstrap.isBootstrapping) {
      status = 'bootstrapping';
    } else if (this.metrics.currentPeerCount === 0) {
      status = 'isolated';
    } else if (this.metrics.currentPeerCount < minPeers || isDegradedRouting) {
      status = 'degraded';
    }

    return {
      status,
      metrics: { ...this.metrics }
    };
  }

  close() {
    this.node.off('forwarded', this.forwardedListener);
    this.node.off('ttl-expired', this.ttlExpiredListener);
    this.node.off('no-route', this.noRouteListener);

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}
