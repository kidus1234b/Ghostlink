import { EventEmitter } from 'events';
import config from './config.js';
import logger from './logger.js';

export class ReputationManager extends EventEmitter {
  constructor(node, options = {}) {
    super();
    this.node = node;
    
    // Configurable parameters with fallback
    this.banDurationMs = options.banDurationMs || config.GMP_BAN_DURATION_MS;
    const recoveryIntervalMs = options.recoveryIntervalMs || config.GMP_REPUTATION_RECOVERY_INTERVAL_MS;
    
    this.scores = new Map(); // nodeIdHex -> score (0-100)
    this.bannedPeers = new Map(); // nodeIdHex -> ban expiration timestamp
    this.bannedIps = new Map(); // IP -> ban expiration timestamp
    
    // Set up recovery interval
    this.recoveryTimer = setInterval(() => {
      this.recoverScores();
    }, recoveryIntervalMs);
  }

  // Recover +1 reputation point for all non-banned peers below 100
  recoverScores() {
    for (const [nodeId, score] of this.scores.entries()) {
      if (this.isBanned(nodeId)) continue;
      if (score < 100) {
        const newScore = Math.min(100, score + 1);
        this.scores.set(nodeId, newScore);
      }
    }
  }

  getScore(nodeId) {
    if (!nodeId) return 100;
    if (this.scores.has(nodeId)) {
      return this.scores.get(nodeId);
    }
    return 100;
  }

  penalize(nodeId, points, reason = '', ip = null) {
    if (!nodeId) return;
    const currentScore = this.getScore(nodeId);
    const newScore = Math.max(0, currentScore - points);
    this.scores.set(nodeId, newScore);

    logger.warn('reputation', 'penalized', `Penalized peer ${nodeId.slice(0, 8)}: -${points} points (Reason: ${reason}). New score: ${newScore}`, {
      nodeId,
      points,
      reason,
      ip,
      newScore
    });

    if (newScore === 0) {
      this.ban(nodeId, ip, reason);
    }
  }

  ban(nodeId, ip, reason = '') {
    const expiresAt = Date.now() + this.banDurationMs;
    if (nodeId) {
      this.bannedPeers.set(nodeId, expiresAt);
    }
    if (ip) {
      this.bannedIps.set(ip, expiresAt);
    }

    logger.error('reputation', 'banned', `BANNED peer ${nodeId ? nodeId.slice(0, 8) : 'unknown'} (IP: ${ip || 'unknown'}) for ${this.banDurationMs}ms (Reason: ${reason})`, {
      nodeId,
      ip,
      banDurationMs: this.banDurationMs,
      reason
    });
    
    this.emit('ban', { nodeId, ip, expiresAt, reason });

    // Disconnect any active links to this peer NodeID or IP
    if (this.node) {
      for (const link of this.node.links.values()) {
        const linkIp = link.socket ? link.socket.remoteAddress : null;
        const linkNodeIdHex = link.remoteNodeId ? Buffer.from(link.remoteNodeId).toString('hex') : null;
        if ((nodeId && linkNodeIdHex === nodeId) || (ip && linkIp === ip)) {
          link.destroy(new Error(`Peer reputation reduced to 0: banned (Reason: ${reason})`));
        }
      }
    }
  }

  isBanned(nodeId, ip = null) {
    const now = Date.now();
    
    // Check NodeID ban
    if (nodeId && this.bannedPeers.has(nodeId)) {
      const expiresAt = this.bannedPeers.get(nodeId);
      if (now < expiresAt) {
        return true;
      } else {
        this.bannedPeers.delete(nodeId); // Ban expired
      }
    }

    // Check IP ban
    if (ip && this.bannedIps.has(ip)) {
      const expiresAt = this.bannedIps.get(ip);
      if (now < expiresAt) {
        return true;
      } else {
        this.bannedIps.delete(ip); // Ban expired
      }
    }

    return false;
  }

  close() {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
    }
  }
}
