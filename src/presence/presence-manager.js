(function(exports) {
  'use strict';

  const HEARTBEAT_INTERVAL = 5000;
  const STALE_TIMEOUT = 20000;
  const AWAY_TIMEOUT = 300000;

  const PeerStatus = {
    ACTIVE: 'active',
    IDLE: 'idle',
    AWAY: 'away',
    OFFLINE: 'offline'
  };

  class PresenceManager {
    constructor({ eventBus, logger, connectionManager }) {
      this.eventBus = eventBus;
      this.logger = logger;
      this.connectionManager = connectionManager;

      this.channel = null;
      this.peerStatuses = new Map();
      this.localStatus = PeerStatus.ACTIVE;
      this.heartbeatInterval = null;
      this.staleCheckInterval = null;
      this.lastActivityTime = Date.now();
      this.initialized = false;

      this._setupChannel();
      this._startHeartbeat();
      this._startStaleDetection();
    }

    _setupChannel() {
      this.channel = this.connectionManager.getChannel('presence');
      if (!this.channel) {
        this.logger.warn('Presence channel not available');
        return;
      }

      this.channel.on('presence-update', (data, peerId) => this._handlePresenceUpdate(data, peerId));
      this.channel.on('presence-query', (data, peerId) => this._handleQuery(data, peerId));
      this.initialized = true;

      this.logger.info('PresenceManager initialized');
    }

    _startHeartbeat() {
      this.heartbeatInterval = setInterval(() => {
        this._updateLocalStatus();
        this.broadcast(this.localStatus);
      }, HEARTBEAT_INTERVAL);
    }

    _startStaleDetection() {
      this.staleCheckInterval = setInterval(() => {
        const now = Date.now();
        for (const [peerId, status] of this.peerStatuses) {
          if (status.status !== PeerStatus.OFFLINE && now - status.lastSeen > STALE_TIMEOUT) {
            const previousStatus = status.status;
            status.status = PeerStatus.OFFLINE;
            this.logger.info(`Peer ${peerId} marked as stale/offline`);
            this.eventBus.emit('presence:stale', { peerId, previousStatus, currentStatus: PeerStatus.OFFLINE });
            this.eventBus.emit('presence:offline', { peerId });
            this.eventBus.emit('presence:status-change', {
              peerId,
              previousStatus,
              currentStatus: PeerStatus.OFFLINE
            });
          }
        }
      }, HEARTBEAT_INTERVAL);
    }

    _updateLocalStatus() {
      const now = Date.now();
      const idleTime = now - this.lastActivityTime;

      if (idleTime > AWAY_TIMEOUT) {
        this.localStatus = PeerStatus.AWAY;
      } else if (idleTime > STALE_TIMEOUT) {
        this.localStatus = PeerStatus.IDLE;
      } else {
        this.localStatus = PeerStatus.ACTIVE;
      }
    }

    broadcast(status) {
      if (!this.channel || !this.initialized) return;

      const message = {
        type: 'presence-update',
        status: status || this.localStatus,
        timestamp: Date.now()
      };

      this.channel.send(message);
    }

    reportActivity() {
      this.lastActivityTime = Date.now();
      if (this.localStatus !== PeerStatus.ACTIVE) {
        this.localStatus = PeerStatus.ACTIVE;
        this.broadcast(this.localStatus);
      }
    }

    _handlePresenceUpdate(data, peerId) {
      const { status, timestamp } = data;

      let peerStatus = this.peerStatuses.get(peerId);
      const wasOffline = !peerStatus || peerStatus.status === PeerStatus.OFFLINE;
      const previousStatus = peerStatus?.status || PeerStatus.OFFLINE;

      if (!peerStatus) {
        peerStatus = {
          status: PeerStatus.ACTIVE,
          lastSeen: timestamp,
          firstSeen: timestamp
        };
        this.peerStatuses.set(peerId, peerStatus);
      }

      peerStatus.lastSeen = timestamp;
      peerStatus.status = status;

      if (wasOffline) {
        this.logger.info(`Peer ${peerId} came online with status ${status}`);
        this.eventBus.emit('presence:online', { peerId, status });
      }

      if (previousStatus !== status && !wasOffline) {
        this.logger.debug(`Peer ${peerId} status changed: ${previousStatus} -> ${status}`);
        this.eventBus.emit('presence:status-change', { peerId, previousStatus, currentStatus: status });
      }

      this.eventBus.emit('presence:update', { peerId, status, timestamp });
    }

    _handleQuery(data, queryPeerId) {
      const response = {
        type: 'presence-update',
        status: this.localStatus,
        timestamp: Date.now()
      };
      this.channel.send(response, queryPeerId);
    }

    getPeerStatus(peerId) {
      const status = this.peerStatuses.get(peerId);
      if (!status) return PeerStatus.OFFLINE;
      return status.status;
    }

    getAllStatuses() {
      const statuses = {};
      for (const [peerId, status] of this.peerStatuses) {
        statuses[peerId] = {
          status: status.status,
          lastSeen: status.lastSeen,
          firstSeen: status.firstSeen
        };
      }
      return statuses;
    }

    getLocalStatus() {
      return this.localStatus;
    }

    setStatus(status) {
      if (!Object.values(PeerStatus).includes(status)) {
        this.logger.warn(`Invalid status: ${status}`);
        return;
      }
      this.localStatus = status;
      this.broadcast(status);
    }

    _cleanupPeer(peerId) {
      const status = this.peerStatuses.get(peerId);
      if (status) {
        this.eventBus.emit('presence:offline', { peerId });
        this.peerStatuses.delete(peerId);
      }
    }

    destroy() {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }

      if (this.staleCheckInterval) {
        clearInterval(this.staleCheckInterval);
        this.staleCheckInterval = null;
      }

      this.peerStatuses.clear();
      this.initialized = false;

      this.logger.info('PresenceManager destroyed');
    }
  }

  exports.PresenceManager = PresenceManager;
  exports.PeerStatus = PeerStatus;
})(typeof globalThis !== 'undefined' ? globalThis : this);