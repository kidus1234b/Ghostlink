// types.js — GhostLink shared type constants and enums
(function(exports) {
  'use strict';

  /**
   * Peer connection states
   * @enum {string}
   */
  const PeerState = Object.freeze({
    IDLE:          'idle',
    CONNECTING:    'connecting',
    SIGNALING:     'signaling',
    HANDSHAKING:   'handshaking',
    CONNECTED:     'connected',
    DEGRADED:      'degraded',
    DISCONNECTED:  'disconnected',
    RECONNECTING:  'reconnecting',
  });

  /**
   * Connection mode types
   * @enum {string}
   */
  const ConnectionMode = Object.freeze({
    DIRECT:        'P2P Direct',
    RELAY:         'Relay Secure',
    MANUAL:        'Manual Signal',
    OFFLINE:       'Offline',
    RECONNECTING:  'Reconnecting',
  });

  /**
   * Message type identifiers for GhostLink protocol
   * @enum {string}
   */
  const MessageType = Object.freeze({
    CHAT:          'chat',
    TYPING:        'typing',
    REACTION:      'reaction',
    FILE_OFFER:    'file-offer',
    FILE_CHUNK:    'file-chunk',
    FILE_COMPLETE: 'file-complete',
    FILE_CANCEL:   'file-cancel',
    VOICE:         'voice',
    PRESENCE:      'presence',
    CALL_OFFER:    'call-offer',
    CALL_ANSWER:   'call-answer',
    CALL_ICE:      'call-ice',
    CALL_END:      'call-end',
    ACK:           'ack',
    SYSTEM:        'system',
  });

  /**
   * WebRTC DataChannel label constants
   * @enum {string}
   */
  const DataChannelLabel = Object.freeze({
    MESSAGES: 'messages',
    FILES:    'files',
    PRESENCE: 'presence',
    CALL:     'call',
  });

  /**
   * ICE connection states
   * @enum {string}
   */
  const ICEConnectionState = Object.freeze({
    NEW:         'new',
    CHECKING:    'checking',
    CONNECTED:   'connected',
    COMPLETED:   'completed',
    FAILED:      'failed',
    DISCONNECTED:'disconnected',
    CLOSED:      'closed',
  });

  /**
   * Candidate pair types for ICE
   * @enum {string}
   */
  const CandidatePairType = Object.freeze({
    HOST:         'host',
    SRFLX:        'srflx',
    PRFLX:        'prflx',
    RELAY:        'relay',
    LOCAL:        'local',
  });

  /**
   * Error code constants for GhostLink
   * @enum {string}
   */
  const ERROR_CODES = Object.freeze({
    PEER_NOT_FOUND:      'E_PEER_NOT_FOUND',
    CONNECTION_FAILED:   'E_CONNECTION_FAILED',
    TIMEOUT:             'E_TIMEOUT',
    INVALID_SIGNAL:      'E_INVALID_SIGNAL',
    ENCRYPTION_FAILED:   'E_ENCRYPTION_FAILED',
    DECRYPTION_FAILED:   'E_DECRYPTION_FAILED',
    CHANNEL_CLOSED:      'E_CHANNEL_CLOSED',
    RATE_LIMITED:        'E_RATE_LIMITED',
    REPLAY_DETECTED:     'E_REPLAY_DETECTED',
    SESSION_EXPIRED:    'E_SESSION_EXPIRED',
    INVALID_STATE:       'E_INVALID_STATE',
    FILE_TOO_LARGE:      'E_FILE_TOO_LARGE',
    INVALID_PACKET:      'E_INVALID_PACKET',
    FLOOD_DETECTED:      'E_FLOOD_DETECTED',
    MALFORMED_SDP:       'E_MALFORMED_SDP',
    SESSION_REVOKED:     'E_SESSION_REVOKED',
  });

  /** @type {number} Maximum file size: 100MB */
  const MAX_FILE_SIZE = 100 * 1024 * 1024;
  /** @type {number} Maximum chunk size: 64KB */
  const MAX_CHUNK_SIZE = 64 * 1024;
  /** @type {string} Chunk separator in file frames */
  const CHUNK_DELIMITER = '|';
  /** @type {number} Heartbeat interval: 30 seconds */
  const HEARTBEAT_INTERVAL_MS = 30000;
  /** @type {number} Heartbeat timeout: 45 seconds */
  const HEARTBEAT_TIMEOUT_MS = 45000;
  /** @type {number} Session expiry: 24 hours */
  const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
  /** @type {number} Key rotation interval: 7 days */
  const KEY_ROTATION_MS = 7 * 24 * 60 * 60 * 1000;
  /** @type {number} Maximum reconnect attempts */
  const MAX_RECONNECT_ATTEMPTS = 10;

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.Types = {
    // Enums
    PeerState,
    ConnectionMode,
    MessageType,
    DataChannelLabel,
    ICEConnectionState,
    CandidatePairType,
    ERROR_CODES,
    // Constants
    MAX_FILE_SIZE,
    MAX_CHUNK_SIZE,
    CHUNK_DELIMITER,
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_TIMEOUT_MS,
    SESSION_EXPIRY_MS,
    KEY_ROTATION_MS,
    MAX_RECONNECT_ATTEMPTS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
