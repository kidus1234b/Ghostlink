/**
 * GhostLink Voice/Video Call Handler
 *
 * Manages media streams (voice, video, screen share) over WebRTC peer
 * connections. Integrates with RTCPeerManager for signaling and track
 * management.
 *
 * @module media-handler
 */

// ─── Media Constraints ───────────────────────────────────────────────────────

/** @type {MediaStreamConstraints} */
const VOICE_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
  },
};

/** @type {MediaStreamConstraints} */
const VIDEO_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
  },
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    facingMode: 'user',
  },
};

/** @type {MediaStreamConstraints} */
const SCREEN_CONSTRAINTS = {
  video: {
    displaySurface: 'monitor',
  },
  audio: false,
};

// ─── Call State ──────────────────────────────────────────────────────────────

/**
 * Tracks the state of a call with a specific peer.
 * @private
 */
class CallState {
  /**
   * @param {string} peerId
   * @param {'voice'|'video'|'screen'} type
   */
  constructor(peerId, type) {
    /** @type {string} */
    this.peerId = peerId;
    /** @type {'voice'|'video'|'screen'} */
    this.type = type;
    /** @type {MediaStream|null} */
    this.localStream = null;
    /** @type {MediaStream|null} */
    this.remoteStream = null;
    /** @type {RTCRtpSender[]} Senders added to the peer connection. */
    this.senders = [];
    /** @type {boolean} */
    this.micEnabled = true;
    /** @type {boolean} */
    this.cameraEnabled = true;
    /** @type {'ringing'|'active'|'ended'} */
    this.status = 'ringing';
    /** @type {'front'|'back'} */
    this.facingMode = 'user';
  }
}

// ─── Simple EventEmitter (reuse from webrtc-manager.js) ─────────────────────

if (typeof EventEmitter === 'undefined') {
  class EventEmitter {
    constructor() {
      this._listeners = new Map();
    }
    on(event, cb) {
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      this._listeners.get(event).add(cb);
    }
    off(event, cb) {
      const s = this._listeners.get(event);
      if (s) s.delete(cb);
    }
    emit(event, ...args) {
      const s = this._listeners.get(event);
      if (s) for (const fn of s) {
        try { fn(...args); } catch (e) { console.error(`[MediaHandler] Event error (${event}):`, e); }
      }
    }
  }
}

// ─── MediaHandler ────────────────────────────────────────────────────────────

/**
 * Voice/video call and screen sharing handler for GhostLink.
 *
 * Uses RTCPeerManager to add/remove media tracks and to send call signaling
 * messages (offer, answer, hangup) over the encrypted messages data channel.
 *
 * @example
 * const media = new MediaHandler(peerManager);
 * media.on('incoming-call', (peerId, type) => showCallUI(peerId, type));
 * media.on('remote-stream', (peerId, stream) => attachToVideo(stream));
 * await media.startVoiceCall(peerId);
 */
class MediaHandler extends EventEmitter {
  /**
   * @param {import('./webrtc-manager.js').RTCPeerManager} peerManager
   */
  constructor(peerManager) {
    super();
    /** @private */
    this._pm = peerManager;
    /** @private @type {Map<string, CallState>} */
    this._calls = new Map();

    // Listen for incoming call offers and remote streams
    this._pm.on('call-offer', (peerId, data) => this._handleCallOffer(peerId, data));
    this._pm.on('call-answer', (peerId, data) => this._handleCallAnswer(peerId, data));
    this._pm.on('message', (peerId, data) => this._handleMessage(peerId, data));
    this._pm.on('stream-added', (peerId, stream) => this._handleRemoteStream(peerId, stream));
    this._pm.on('stream-removed', (peerId) => this._handleStreamRemoved(peerId));
  }

  // ── Outgoing Calls ─────────────────────────────────────────────────────

  /**
   * Start a voice call with a peer.
   * Acquires a local audio stream, adds tracks to the peer connection,
   * and sends a call offer via the messages data channel.
   *
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  async startVoiceCall(peerId) {
    await this._initiateCall(peerId, 'voice', VOICE_CONSTRAINTS);
  }

  /**
   * Start a video call with a peer.
   * Acquires local audio + video, adds tracks, and sends a call offer.
   *
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  async startVideoCall(peerId) {
    await this._initiateCall(peerId, 'video', VIDEO_CONSTRAINTS);
  }

  /**
   * Start screen sharing with a peer.
   * Uses getDisplayMedia to capture the screen, adds the video track
   * to the peer connection, and sends a call offer.
   *
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  async startScreenShare(peerId) {
    if (this._calls.has(peerId)) {
      throw new Error(`Already in a call with ${peerId}`);
    }

    const state = new CallState(peerId, 'screen');
    this._calls.set(peerId, state);

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(SCREEN_CONSTRAINTS);
      state.localStream = stream;
      this.emit('local-stream', peerId, stream);

      // Add tracks to the peer connection
      for (const track of stream.getTracks()) {
        const sender = await this._pm.addTrack(peerId, track, stream);
        state.senders.push(sender);

        // Handle the user stopping the screen share via the browser UI
        track.onended = () => {
          this.endCall(peerId);
        };
      }

      // Send call offer
      await this._pm.sendMessage(peerId, {
        type: 'call-offer',
        callType: 'screen',
      });

      state.status = 'ringing';
    } catch (e) {
      this._calls.delete(peerId);
      console.error('[MediaHandler] Screen share failed:', e);
      throw e;
    }
  }

  // ── Answering Calls ────────────────────────────────────────────────────

  /**
   * Answer an incoming call from a peer.
   *
   * @param {string} peerId
   * @param {boolean} [withVideo=false]  Whether to enable video when answering.
   * @returns {Promise<void>}
   */
  async answerCall(peerId, withVideo = false) {
    const state = this._calls.get(peerId);
    if (!state) throw new Error(`No incoming call from ${peerId}`);

    const constraints = (withVideo || state.type === 'video')
      ? VIDEO_CONSTRAINTS
      : VOICE_CONSTRAINTS;

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.localStream = stream;
      state.cameraEnabled = withVideo || state.type === 'video';
      this.emit('local-stream', peerId, stream);

      // Add tracks to the peer connection
      for (const track of stream.getTracks()) {
        const sender = await this._pm.addTrack(peerId, track, stream);
        state.senders.push(sender);
      }

      // Send call answer signal
      await this._pm.sendMessage(peerId, {
        type: 'call-answer',
        accepted: true,
        withVideo: state.cameraEnabled,
      });

      state.status = 'active';
      this.emit('call-started', peerId, state.type);
    } catch (e) {
      // Media acquisition failed — reject the call
      await this._pm.sendMessage(peerId, {
        type: 'call-answer',
        accepted: false,
        reason: 'media-error',
      });
      this._calls.delete(peerId);
      console.error('[MediaHandler] Failed to answer call:', e);
      throw e;
    }
  }

  // ── End Call ───────────────────────────────────────────────────────────

  /**
   * End an active or ringing call with a peer.
   * Stops all local media tracks, removes senders from the peer connection,
   * and notifies the peer.
   *
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  async endCall(peerId) {
    const state = this._calls.get(peerId);
    if (!state) return;

    // Stop all local tracks
    if (state.localStream) {
      for (const track of state.localStream.getTracks()) {
        track.stop();
      }
    }

    // Remove senders from the peer connection
    for (const sender of state.senders) {
      try {
        await this._pm.removeTrack(peerId, sender);
      } catch (_) { /* peer may already be disconnected */ }
    }

    // Notify the peer
    try {
      await this._pm.sendMessage(peerId, {
        type: 'call-hangup',
      });
    } catch (_) { /* best effort */ }

    const callType = state.type;
    this._calls.delete(peerId);
    this.emit('call-ended', peerId, callType);
  }

  // ── Media Controls ─────────────────────────────────────────────────────

  /**
   * Toggle the microphone on/off for the current call.
   * Affects all active calls.
   *
   * @returns {boolean} The new mic enabled state.
   */
  toggleMic() {
    let newState = true;
    for (const state of this._calls.values()) {
      if (state.localStream) {
        for (const track of state.localStream.getAudioTracks()) {
          track.enabled = !track.enabled;
          newState = track.enabled;
        }
        state.micEnabled = newState;
      }
    }
    this.emit('mic-toggled', newState);
    return newState;
  }

  /**
   * Toggle the camera on/off for the current call.
   * Affects all active video calls.
   *
   * @returns {boolean} The new camera enabled state.
   */
  toggleCamera() {
    let newState = true;
    for (const state of this._calls.values()) {
      if (state.localStream && state.type === 'video') {
        for (const track of state.localStream.getVideoTracks()) {
          track.enabled = !track.enabled;
          newState = track.enabled;
        }
        state.cameraEnabled = newState;
      }
    }
    this.emit('cam-toggled', newState);
    return newState;
  }

  /**
   * Switch between front and back camera (mobile devices).
   * Replaces the video track in the active call.
   *
   * @returns {Promise<void>}
   */
  async switchCamera() {
    for (const [peerId, state] of this._calls) {
      if (state.type !== 'video' || !state.localStream) continue;

      // Determine new facing mode
      const currentFacing = state.facingMode === 'user' ? 'environment' : 'user';
      state.facingMode = currentFacing;

      // Stop current video tracks
      for (const track of state.localStream.getVideoTracks()) {
        track.stop();
      }

      // Get new stream with opposite camera
      const constraints = {
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: currentFacing,
        },
      };

      try {
        const newStream = await navigator.mediaDevices.getUserMedia(constraints);
        const newVideoTrack = newStream.getVideoTracks()[0];

        // Replace the track in the peer connection sender
        for (const sender of state.senders) {
          if (sender.track && sender.track.kind === 'video') {
            await sender.replaceTrack(newVideoTrack);
          }
        }

        // Replace in the local stream
        const oldVideoTrack = state.localStream.getVideoTracks()[0];
        if (oldVideoTrack) {
          state.localStream.removeTrack(oldVideoTrack);
        }
        state.localStream.addTrack(newVideoTrack);

        this.emit('local-stream', peerId, state.localStream);
      } catch (e) {
        console.error('[MediaHandler] Camera switch failed:', e);
        throw e;
      }
    }
  }

  // ── Stream Access ──────────────────────────────────────────────────────

  /**
   * Get the local media stream (if any call is active).
   * @returns {MediaStream|null}
   */
  getLocalStream() {
    for (const state of this._calls.values()) {
      if (state.localStream) return state.localStream;
    }
    return null;
  }

  /**
   * Get the remote media stream for a specific peer.
   * @param {string} peerId
   * @returns {MediaStream|null}
   */
  getRemoteStream(peerId) {
    const state = this._calls.get(peerId);
    return state ? state.remoteStream : null;
  }

  /**
   * Check if there is an active call with a peer.
   * @param {string} peerId
   * @returns {boolean}
   */
  isInCall(peerId) {
    return this._calls.has(peerId);
  }

  /**
   * Get the call state for a peer.
   * @param {string} peerId
   * @returns {{ type: string, status: string, micEnabled: boolean, cameraEnabled: boolean }|null}
   */
  getCallState(peerId) {
    const state = this._calls.get(peerId);
    if (!state) return null;
    return {
      type: state.type,
      status: state.status,
      micEnabled: state.micEnabled,
      cameraEnabled: state.cameraEnabled,
    };
  }

  // ── Internal: Initiate Call ────────────────────────────────────────────

  /**
   * Common logic for initiating a voice or video call.
   * @private
   * @param {string} peerId
   * @param {'voice'|'video'} type
   * @param {MediaStreamConstraints} constraints
   * @returns {Promise<void>}
   */
  async _initiateCall(peerId, type, constraints) {
    if (this._calls.has(peerId)) {
      throw new Error(`Already in a call with ${peerId}`);
    }

    const state = new CallState(peerId, type);
    this._calls.set(peerId, state);

    try {
      // Check if we're on HTTPS or localhost
      const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      if (!isSecure) {
        throw new Error('Camera/Microphone require HTTPS. Please use https:// or run on localhost.');
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.localStream = stream;
      state.cameraEnabled = type === 'video';
      this.emit('local-stream', peerId, stream);

      // Add all tracks to the peer connection
      for (const track of stream.getTracks()) {
        const sender = await this._pm.addTrack(peerId, track, stream);
        state.senders.push(sender);
      }

      // Send call offer via messages data channel
      await this._pm.sendMessage(peerId, {
        type: 'call-offer',
        callType: type,
      });

      state.status = 'ringing';
    } catch (e) {
      this._calls.delete(peerId);
      console.error(`[MediaHandler] Failed to start ${type} call:`, e);
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        throw new Error('Camera/Microphone permission denied. Please allow access in your browser settings.');
      }
      throw e;
    }
  }

  // ── Internal: Signal Handlers ──────────────────────────────────────────

  /**
   * Handle an incoming call offer received on the messages data channel.
   * @private
   * @param {string} peerId
   * @param {object} data
   */
  _handleCallOffer(peerId, data) {
    if (this._calls.has(peerId)) {
      // Already in a call — auto-reject
      this._pm.sendMessage(peerId, {
        type: 'call-answer',
        accepted: false,
        reason: 'busy',
      }).catch(() => {});
      return;
    }

    const type = data.callType || 'voice';
    const state = new CallState(peerId, type);
    state.status = 'ringing';
    this._calls.set(peerId, state);

    this.emit('incoming-call', peerId, type);
  }

  /**
   * Handle a call answer signal.
   * @private
   * @param {string} peerId
   * @param {object} data
   */
  _handleCallAnswer(peerId, data) {
    const state = this._calls.get(peerId);
    if (!state) return;

    if (data.accepted) {
      state.status = 'active';
      this.emit('call-started', peerId, state.type);
    } else {
      // Call rejected
      if (state.localStream) {
        for (const track of state.localStream.getTracks()) track.stop();
      }
      this._calls.delete(peerId);
      this.emit('call-ended', peerId, state.type);
    }
  }

  /**
   * Handle general messages that might be call-related (e.g., hangup).
   * @private
   * @param {string} peerId
   * @param {object} data
   */
  _handleMessage(peerId, data) {
    if (data.type === 'call-hangup') {
      const state = this._calls.get(peerId);
      if (!state) return;

      // Stop local tracks
      if (state.localStream) {
        for (const track of state.localStream.getTracks()) track.stop();
      }

      const callType = state.type;
      this._calls.delete(peerId);
      this.emit('call-ended', peerId, callType);
    }
  }

  /**
   * Handle a remote media stream being added to the peer connection.
   * @private
   * @param {string} peerId
   * @param {MediaStream} stream
   */
  _handleRemoteStream(peerId, stream) {
    const state = this._calls.get(peerId);
    if (state) {
      state.remoteStream = stream;

      // Listen for track removal on the stream
      stream.onremovetrack = () => {
        if (stream.getTracks().length === 0) {
          this._handleStreamRemoved(peerId);
        }
      };
    }

    this.emit('remote-stream', peerId, stream);
  }

  /**
   * Handle a remote stream being removed.
   * @private
   * @param {string} peerId
   */
  _handleStreamRemoved(peerId) {
    const state = this._calls.get(peerId);
    if (state) {
      state.remoteStream = null;
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  /**
   * End all active calls and release all media resources.
   */
  async destroy() {
    const peerIds = [...this._calls.keys()];
    for (const peerId of peerIds) {
      await this.endCall(peerId);
    }
  }
}

window.MediaHandler = MediaHandler;
