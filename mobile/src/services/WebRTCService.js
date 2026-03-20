/**
 * GhostLink Mobile — WebRTC Service
 *
 * Manages WebRTC peer connections on React Native using `react-native-webrtc`.
 *
 * Install peer dependency:
 *   npm install react-native-webrtc
 *
 * iOS: cd ios && pod install
 * Android: auto-linked via React Native CLI.
 *
 * This module mirrors the web RTCPeerManager connection lifecycle:
 *   createConnection -> offer/answer exchange -> ICE negotiation -> data channel open
 *
 * @module WebRTCService
 */

import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
} from 'react-native-webrtc';

// ─── ICE Configuration ──────────────────────────────────────────────────────

const DEFAULT_ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'all',
};

// ─── Constants ──────────────────────────────────────────────────────────────

const DATA_CHANNEL_LABEL = 'ghostlink-data';
const DATA_CHANNEL_CONFIG = { ordered: true };

// ─── Connection State ───────────────────────────────────────────────────────

export const PeerState = Object.freeze({
  NEW: 'new',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
  CLOSED: 'closed',
});

// ─── Event Emitter (lightweight) ────────────────────────────────────────────

class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(fn);
      if (set.size === 0) this._listeners.delete(event);
    }
    return this;
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (set) {
      for (const fn of set) {
        try {
          fn(...args);
        } catch (err) {
          console.error(`[GhostLink:WebRTC] Event error (${event}):`, err);
        }
      }
    }
  }

  removeAllListeners() {
    this._listeners.clear();
  }
}

// ─── PeerSession ────────────────────────────────────────────────────────────

/**
 * Encapsulates a single RTCPeerConnection, its data channel, and media streams.
 * @private
 */
class PeerSession {
  /**
   * @param {string} peerId
   * @param {RTCPeerConnection} pc
   */
  constructor(peerId, pc) {
    this.peerId = peerId;
    this.pc = pc;
    /** @type {RTCDataChannel|null} */
    this.dataChannel = null;
    /** @type {string} */
    this.state = PeerState.NEW;
    /** @type {MediaStream|null} */
    this.localStream = null;
    /** @type {MediaStream|null} */
    this.remoteStream = null;
  }

  close() {
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch (_) {
        /* ignore */
      }
      this.dataChannel = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    try {
      this.pc.close();
    } catch (_) {
      /* ignore */
    }
    this.state = PeerState.CLOSED;
  }
}

// ─── WebRTCService ──────────────────────────────────────────────────────────

class WebRTCService extends Emitter {
  /**
   * @param {object} [options]
   * @param {object} [options.iceConfig] Override default ICE configuration.
   */
  constructor(options = {}) {
    super();
    /** @private */ this._iceConfig = {
      ...DEFAULT_ICE_CONFIG,
      ...(options.iceConfig || {}),
    };
    /** @private @type {Map<string, PeerSession>} */
    this._peers = new Map();
    /** @private @type {import('./SignalingService').default|null} */
    this._signaling = null;
  }

  /**
   * Attach a SignalingService instance so that offers, answers, and ICE
   * candidates can be exchanged automatically.
   *
   * @param {import('./SignalingService').default} signalingService
   */
  attachSignaling(signalingService) {
    this._signaling = signalingService;

    // Listen for incoming signaling messages
    signalingService.on('offer', (data) => this._handleOffer(data));
    signalingService.on('answer', (data) => this._handleAnswer(data));
    signalingService.on('ice-candidate', (data) =>
      this._handleRemoteIceCandidate(data),
    );
  }

  // ── Connection Creation ─────────────────────────────────────────────────

  /**
   * Create a new RTCPeerConnection to a remote peer and initiate the
   * offer/answer exchange via the attached signaling service.
   *
   * @param {string} peerId Remote peer identifier.
   * @param {object} [options]
   * @param {boolean} [options.initiator=true] If true, create and send an offer.
   * @returns {Promise<PeerSession>}
   */
  async createConnection(peerId, { initiator = true } = {}) {
    if (this._peers.has(peerId)) {
      return this._peers.get(peerId);
    }

    const pc = new RTCPeerConnection(this._iceConfig);
    const session = new PeerSession(peerId, pc);
    this._peers.set(peerId, session);

    session.state = PeerState.CONNECTING;
    this.emit('peer-state', { peerId, state: PeerState.CONNECTING });

    // ── ICE Candidate Handling ──────────────────────────────────────────

    pc.onicecandidate = (event) => {
      if (event.candidate && this._signaling) {
        this._signaling.sendIceCandidate(peerId, event.candidate);
      }
    };

    pc.onicecandidateerror = (event) => {
      console.warn(
        `[GhostLink:WebRTC] ICE candidate error for ${peerId}:`,
        event,
      );
    };

    // ── Connection State ────────────────────────────────────────────────

    pc.onconnectionstatechange = () => {
      const csState = pc.connectionState;
      let mapped;
      switch (csState) {
        case 'connected':
          mapped = PeerState.CONNECTED;
          break;
        case 'disconnected':
          mapped = PeerState.DISCONNECTED;
          break;
        case 'failed':
          mapped = PeerState.FAILED;
          break;
        case 'closed':
          mapped = PeerState.CLOSED;
          break;
        default:
          mapped = PeerState.CONNECTING;
      }
      session.state = mapped;
      this.emit('peer-state', { peerId, state: mapped });

      if (mapped === PeerState.FAILED || mapped === PeerState.CLOSED) {
        this._cleanupPeer(peerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      this.emit('ice-state', {
        peerId,
        state: pc.iceConnectionState,
      });
    };

    // ── Data Channel ────────────────────────────────────────────────────

    if (initiator) {
      const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, DATA_CHANNEL_CONFIG);
      this._setupDataChannel(session, dc);
    }

    pc.ondatachannel = (event) => {
      this._setupDataChannel(session, event.channel);
    };

    // ── Remote Media Stream ─────────────────────────────────────────────

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        session.remoteStream = event.streams[0];
        this.emit('remote-stream', {
          peerId,
          stream: event.streams[0],
        });
      }
    };

    // ── Create Offer (if initiator) ─────────────────────────────────────

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (this._signaling) {
        this._signaling.sendOffer(peerId, pc.localDescription);
      }
    }

    return session;
  }

  // ── Incoming Signaling Handlers ─────────────────────────────────────────

  /**
   * Handle an incoming SDP offer from a remote peer.
   * @private
   * @param {{ from: string, offer: object }} data
   */
  async _handleOffer(data) {
    const { from, offer } = data;
    const session = await this.createConnection(from, { initiator: false });
    const pc = session.pc;

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    if (this._signaling) {
      this._signaling.sendAnswer(from, pc.localDescription);
    }
  }

  /**
   * Handle an incoming SDP answer from a remote peer.
   * @private
   * @param {{ from: string, answer: object }} data
   */
  async _handleAnswer(data) {
    const { from, answer } = data;
    const session = this._peers.get(from);
    if (!session) return;

    await session.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  /**
   * Handle an incoming ICE candidate from a remote peer.
   * @private
   * @param {{ from: string, candidate: object }} data
   */
  async _handleRemoteIceCandidate(data) {
    const { from, candidate } = data;
    const session = this._peers.get(from);
    if (!session) return;

    try {
      await session.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn(`[GhostLink:WebRTC] Failed to add ICE candidate for ${from}:`, err);
    }
  }

  // ── Data Channel ──────────────────────────────────────────────────────

  /**
   * Wire up data channel event handlers.
   * @private
   * @param {PeerSession} session
   * @param {RTCDataChannel} dc
   */
  _setupDataChannel(session, dc) {
    session.dataChannel = dc;

    dc.onopen = () => {
      this.emit('datachannel-open', { peerId: session.peerId });
    };

    dc.onclose = () => {
      this.emit('datachannel-close', { peerId: session.peerId });
    };

    dc.onerror = (err) => {
      console.error(
        `[GhostLink:WebRTC] DataChannel error for ${session.peerId}:`,
        err,
      );
      this.emit('datachannel-error', { peerId: session.peerId, error: err });
    };

    dc.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (_) {
        payload = event.data;
      }
      this.emit('message', { peerId: session.peerId, data: payload });
    };
  }

  /**
   * Send a message to a specific peer over the data channel.
   *
   * @param {string} peerId
   * @param {object|string} data Will be JSON-stringified if an object.
   * @returns {boolean} True if sent, false if channel not ready.
   */
  sendMessage(peerId, data) {
    const session = this._peers.get(peerId);
    if (!session || !session.dataChannel) return false;

    const dc = session.dataChannel;
    if (dc.readyState !== 'open') return false;

    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    dc.send(payload);
    return true;
  }

  /**
   * Broadcast a message to all connected peers.
   *
   * @param {object|string} data
   * @returns {number} Count of peers the message was sent to.
   */
  broadcast(data) {
    let sent = 0;
    for (const [peerId] of this._peers) {
      if (this.sendMessage(peerId, data)) sent++;
    }
    return sent;
  }

  // ── Media Streams ─────────────────────────────────────────────────────

  /**
   * Add a local media stream (audio/video) to a peer connection.
   *
   * @param {string} peerId
   * @param {{ audio?: boolean, video?: boolean }} [constraints]
   * @returns {Promise<MediaStream>} The local stream that was added.
   */
  async addMediaStream(peerId, constraints = { audio: true, video: true }) {
    const session = this._peers.get(peerId);
    if (!session) throw new Error(`No session for peer ${peerId}`);

    const stream = await mediaDevices.getUserMedia(constraints);
    session.localStream = stream;

    for (const track of stream.getTracks()) {
      session.pc.addTrack(track, stream);
    }

    this.emit('local-stream', { peerId, stream });
    return stream;
  }

  /**
   * Remove the local media stream from a peer connection and stop all tracks.
   *
   * @param {string} peerId
   */
  removeMediaStream(peerId) {
    const session = this._peers.get(peerId);
    if (!session || !session.localStream) return;

    session.localStream.getTracks().forEach((track) => {
      track.stop();
      const senders = session.pc.getSenders();
      const sender = senders.find((s) => s.track === track);
      if (sender) {
        session.pc.removeTrack(sender);
      }
    });

    session.localStream = null;
    this.emit('local-stream-removed', { peerId });
  }

  // ── Peer Queries ──────────────────────────────────────────────────────

  /**
   * Get the current state of a peer connection.
   * @param {string} peerId
   * @returns {string|null}
   */
  getPeerState(peerId) {
    const session = this._peers.get(peerId);
    return session ? session.state : null;
  }

  /**
   * Get all connected peer IDs.
   * @returns {string[]}
   */
  getConnectedPeers() {
    const connected = [];
    for (const [peerId, session] of this._peers) {
      if (session.state === PeerState.CONNECTED) {
        connected.push(peerId);
      }
    }
    return connected;
  }

  /**
   * Get the remote media stream for a peer (if any).
   * @param {string} peerId
   * @returns {MediaStream|null}
   */
  getRemoteStream(peerId) {
    const session = this._peers.get(peerId);
    return session ? session.remoteStream : null;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Disconnect from a single peer and clean up resources.
   * @param {string} peerId
   */
  disconnectPeer(peerId) {
    this._cleanupPeer(peerId);
  }

  /**
   * Disconnect from all peers and release all resources.
   */
  disconnectAll() {
    for (const [peerId] of this._peers) {
      this._cleanupPeer(peerId);
    }
  }

  /**
   * Internal cleanup for a single peer.
   * @private
   * @param {string} peerId
   */
  _cleanupPeer(peerId) {
    const session = this._peers.get(peerId);
    if (!session) return;

    session.close();
    this._peers.delete(peerId);
    this.emit('peer-closed', { peerId });
  }

  /**
   * Full teardown — disconnect all peers and remove all event listeners.
   */
  destroy() {
    this.disconnectAll();
    this.removeAllListeners();
  }
}

export default WebRTCService;
