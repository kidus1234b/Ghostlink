import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
} from 'react-native-webrtc';

const ICE_SERVERS = {
  iceServers: [
    {urls: 'stun:stun.l.google.com:19302'},
    {urls: 'stun:stun1.l.google.com:19302'},
    {urls: 'stun:stun2.l.google.com:19302'},
  ],
};

class WebRTCManager {
  constructor() {
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.dataChannel = null;
    this.onRemoteStream = null;
    this.onDataChannelMessage = null;
    this.onConnectionStateChange = null;
    this.onIceCandidate = null;
    this.isCaller = false;
    this.isVideoCall = false;
    this.currentCamera = 'front';
  }

  async initialize(isCaller, isVideo = false) {
    this.isCaller = isCaller;
    this.isVideoCall = isVideo;

    this.peerConnection = new RTCPeerConnection(ICE_SERVERS);

    this.peerConnection.onicecandidate = event => {
      if (event.candidate && this.onIceCandidate) {
        this.onIceCandidate(event.candidate);
      }
    };

    this.peerConnection.onaddstream = event => {
      this.remoteStream = event.stream;
      if (this.onRemoteStream) {
        this.onRemoteStream(event.stream);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(this.peerConnection.connectionState);
      }
    };

    if (isCaller) {
      this.dataChannel = this.peerConnection.createDataChannel('ghostlink-data', {
        ordered: true,
        maxRetransmits: 3,
      });
      this._setupDataChannel(this.dataChannel);
    } else {
      this.peerConnection.ondatachannel = event => {
        this.dataChannel = event.channel;
        this._setupDataChannel(this.dataChannel);
      };
    }

    try {
      const constraints = {
        audio: true,
        video: isVideo
          ? {
              facingMode: this.currentCamera === 'front' ? 'user' : 'environment',
              width: {ideal: 1280},
              height: {ideal: 720},
              frameRate: {ideal: 30},
            }
          : false,
      };

      this.localStream = await mediaDevices.getUserMedia(constraints);
      this.peerConnection.addStream(this.localStream);
    } catch (err) {
      console.warn('Failed to get user media:', err);
    }

    return this.localStream;
  }

  _setupDataChannel(channel) {
    channel.onopen = () => {
      console.log('Data channel opened');
    };

    channel.onclose = () => {
      console.log('Data channel closed');
    };

    channel.onmessage = event => {
      if (this.onDataChannelMessage) {
        try {
          const data = JSON.parse(event.data);
          this.onDataChannelMessage(data);
        } catch (_e) {
          this.onDataChannelMessage({type: 'raw', data: event.data});
        }
      }
    };
  }

  async createOffer() {
    if (!this.peerConnection) return null;
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    return offer;
  }

  async createAnswer(remoteOffer) {
    if (!this.peerConnection) return null;
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(remoteOffer));
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(remoteAnswer) {
    if (!this.peerConnection) return;
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(remoteAnswer));
  }

  async addIceCandidate(candidate) {
    if (!this.peerConnection) return;
    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }

  sendData(data) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  toggleMute() {
    if (!this.localStream) return false;
    const audioTracks = this.localStream.getAudioTracks();
    if (audioTracks.length > 0) {
      const enabled = !audioTracks[0].enabled;
      audioTracks[0].enabled = enabled;
      return enabled;
    }
    return false;
  }

  toggleVideo() {
    if (!this.localStream) return false;
    const videoTracks = this.localStream.getVideoTracks();
    if (videoTracks.length > 0) {
      const enabled = !videoTracks[0].enabled;
      videoTracks[0].enabled = enabled;
      return enabled;
    }
    return false;
  }

  async flipCamera() {
    if (!this.localStream || !this.isVideoCall) return;
    this.currentCamera = this.currentCamera === 'front' ? 'back' : 'front';
    const videoTracks = this.localStream.getVideoTracks();
    if (videoTracks.length > 0) {
      videoTracks[0]._switchCamera();
    }
  }

  toggleSpeaker() {
    // Speaker toggle is handled natively on Android/iOS
    // This would need InCallManager or a similar native module
    return true;
  }

  getConnectionState() {
    if (!this.peerConnection) return 'closed';
    return this.peerConnection.connectionState;
  }

  getStats() {
    if (!this.peerConnection) return Promise.resolve(null);
    return this.peerConnection.getStats();
  }

  async hangup() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach(track => track.stop());
      this.remoteStream = null;
    }

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }

  destroy() {
    this.hangup();
    this.onRemoteStream = null;
    this.onDataChannelMessage = null;
    this.onConnectionStateChange = null;
    this.onIceCandidate = null;
  }
}

let sharedInstance = null;

export function getWebRTCManager() {
  if (!sharedInstance) {
    sharedInstance = new WebRTCManager();
  }
  return sharedInstance;
}

export function resetWebRTCManager() {
  if (sharedInstance) {
    sharedInstance.destroy();
    sharedInstance = null;
  }
}

export {WebRTCManager};
export default WebRTCManager;
