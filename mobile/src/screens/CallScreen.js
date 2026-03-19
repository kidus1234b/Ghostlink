import React, {useState, useEffect, useCallback, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Vibration,
  Dimensions,
  StatusBar,
  Platform,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  FadeIn,
  FadeOut,
  ZoomIn,
  Easing,
} from 'react-native-reanimated';
import {RTCView} from 'react-native-webrtc';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import {getWebRTCManager, resetWebRTCManager} from '../utils/webrtc';
import PeerAvatar from '../components/PeerAvatar';

const {width: SCREEN_WIDTH, height: SCREEN_HEIGHT} = Dimensions.get('window');

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function CallScreen({route, navigation}) {
  const {theme} = useTheme();
  const {state} = useApp();
  const peerId = route?.params?.peer;
  const isVideoCall = route?.params?.video ?? false;

  const [callState, setCallState] = useState('connecting');
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(isVideoCall);
  const [isSpeaker, setIsSpeaker] = useState(isVideoCall);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [localStreamUrl, setLocalStreamUrl] = useState(null);
  const [remoteStreamUrl, setRemoteStreamUrl] = useState(null);
  const [isPiP, setIsPiP] = useState(false);
  const [showControls, setShowControls] = useState(true);

  const durationRef = useRef(null);
  const rtcManager = useRef(null);

  const ringPulse = useSharedValue(1);
  const ringOpacity = useSharedValue(0.6);

  useEffect(() => {
    ringPulse.value = withRepeat(
      withSequence(
        withTiming(1.8, {duration: 1200, easing: Easing.out(Easing.ease)}),
        withTiming(1, {duration: 0}),
      ),
      -1,
    );
    ringOpacity.value = withRepeat(
      withSequence(
        withTiming(0, {duration: 1200}),
        withTiming(0.6, {duration: 0}),
      ),
      -1,
    );
  }, [ringPulse, ringOpacity]);

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{scale: ringPulse.value}],
    opacity: ringOpacity.value,
  }));

  const peerName = (() => {
    const peer = state.peers.find(p => p.id === peerId);
    return peer?.name || 'Peer';
  })();

  useEffect(() => {
    initializeCall();
    return () => {
      if (durationRef.current) clearInterval(durationRef.current);
      resetWebRTCManager();
    };
  }, []);

  async function initializeCall() {
    try {
      rtcManager.current = getWebRTCManager();
      rtcManager.current.onConnectionStateChange = (connState) => {
        if (connState === 'connected') {
          setCallState('active');
          Vibration.vibrate(50);
          durationRef.current = setInterval(() => {
            setDuration(d => d + 1);
          }, 1000);
        } else if (connState === 'disconnected' || connState === 'failed') {
          setCallState('ended');
          if (durationRef.current) clearInterval(durationRef.current);
        }
      };

      rtcManager.current.onRemoteStream = (stream) => {
        setRemoteStreamUrl(stream.toURL());
      };

      const localStream = await rtcManager.current.initialize(true, isVideoCall);
      if (localStream) {
        setLocalStreamUrl(localStream.toURL());
      }

      setTimeout(() => {
        if (callState === 'connecting') {
          setCallState('active');
          Vibration.vibrate(50);
          durationRef.current = setInterval(() => {
            setDuration(d => d + 1);
          }, 1000);
        }
      }, 2000);
    } catch (err) {
      console.warn('Call initialization error:', err);
      setCallState('error');
    }
  }

  const handleHangup = useCallback(() => {
    Vibration.vibrate(100);
    if (durationRef.current) clearInterval(durationRef.current);
    setCallState('ended');
    resetWebRTCManager();
    setTimeout(() => navigation.goBack(), 500);
  }, [navigation]);

  const toggleMute = useCallback(() => {
    Vibration.vibrate(15);
    if (rtcManager.current) {
      rtcManager.current.toggleMute();
    }
    setIsMuted(m => !m);
  }, []);

  const toggleVideo = useCallback(() => {
    Vibration.vibrate(15);
    if (rtcManager.current) {
      rtcManager.current.toggleVideo();
    }
    setIsVideoEnabled(v => !v);
  }, []);

  const toggleSpeaker = useCallback(() => {
    Vibration.vibrate(15);
    if (rtcManager.current) {
      rtcManager.current.toggleSpeaker();
    }
    setIsSpeaker(s => !s);
  }, []);

  const flipCamera = useCallback(async () => {
    Vibration.vibrate(15);
    if (rtcManager.current) {
      await rtcManager.current.flipCamera();
    }
    setIsFrontCamera(f => !f);
  }, []);

  const togglePiP = useCallback(() => {
    Vibration.vibrate(15);
    setIsPiP(p => !p);
  }, []);

  const statusText = (() => {
    switch (callState) {
      case 'connecting':
        return 'Connecting...';
      case 'ringing':
        return 'Ringing...';
      case 'active':
        return formatDuration(duration);
      case 'ended':
        return 'Call Ended';
      case 'error':
        return 'Connection Failed';
      default:
        return '';
    }
  })();

  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {isVideoCall && remoteStreamUrl && (
        <RTCView
          streamURL={remoteStreamUrl}
          style={styles.remoteVideo}
          objectFit="cover"
          mirror={false}
        />
      )}

      {isVideoCall && localStreamUrl && (
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={togglePiP}
          style={[
            styles.localVideo,
            isPiP && styles.localVideoPiP,
            {borderColor: theme.accent + '40'},
          ]}>
          <RTCView
            streamURL={localStreamUrl}
            style={StyleSheet.absoluteFill}
            objectFit="cover"
            mirror={isFrontCamera}
          />
        </TouchableOpacity>
      )}

      {(!isVideoCall || !remoteStreamUrl) && (
        <View style={styles.voiceCallUI}>
          <View style={styles.avatarContainer}>
            <Animated.View
              style={[
                styles.ringEffect,
                {borderColor: theme.accent},
                ringStyle,
              ]}
            />
            <PeerAvatar name={peerName} size={100} online />
          </View>
          <Animated.Text
            entering={FadeIn.delay(200)}
            style={[styles.peerName, {color: theme.text}]}>
            {peerName}
          </Animated.Text>
          <Text style={[styles.callType, {color: theme.textSecondary}]}>
            {isVideoCall ? 'Video Call' : 'Voice Call'}
          </Text>
          <Animated.Text
            entering={FadeIn.delay(400)}
            style={[
              styles.statusText,
              {
                color:
                  callState === 'active'
                    ? theme.accent
                    : callState === 'error'
                    ? theme.danger
                    : theme.textSecondary,
              },
            ]}>
            {statusText}
          </Animated.Text>

          {callState === 'active' && (
            <Animated.View entering={FadeIn.delay(600)} style={styles.encryptedBadge}>
              <View style={[styles.encBadgeInner, {backgroundColor: theme.accent + '15'}]}>
                <Text style={[styles.encBadgeText, {color: theme.accent}]}>
                  E2E Encrypted
                </Text>
              </View>
            </Animated.View>
          )}
        </View>
      )}

      {showControls && (
        <Animated.View
          entering={FadeIn.duration(200)}
          style={styles.controlsContainer}>
          <View style={styles.controlsRow}>
            <TouchableOpacity
              style={[
                styles.controlBtn,
                {
                  backgroundColor: isMuted ? theme.danger + '25' : theme.bgTertiary,
                  borderColor: isMuted ? theme.danger : theme.border,
                },
              ]}
              onPress={toggleMute}>
              <Text style={{color: isMuted ? theme.danger : theme.text, fontSize: 22}}>
                {isMuted ? '\u{1F507}' : '\u{1F3A4}'}
              </Text>
              <Text
                style={[
                  styles.controlLabel,
                  {color: isMuted ? theme.danger : theme.textSecondary},
                ]}>
                {isMuted ? 'Unmute' : 'Mute'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.controlBtn,
                {
                  backgroundColor: isSpeaker ? theme.accent + '20' : theme.bgTertiary,
                  borderColor: isSpeaker ? theme.accent : theme.border,
                },
              ]}
              onPress={toggleSpeaker}>
              <Text style={{color: isSpeaker ? theme.accent : theme.text, fontSize: 22}}>
                {'\u{1F50A}'}
              </Text>
              <Text
                style={[
                  styles.controlLabel,
                  {color: isSpeaker ? theme.accent : theme.textSecondary},
                ]}>
                {isSpeaker ? 'Speaker' : 'Earpiece'}
              </Text>
            </TouchableOpacity>

            {isVideoCall && (
              <>
                <TouchableOpacity
                  style={[
                    styles.controlBtn,
                    {
                      backgroundColor: !isVideoEnabled ? theme.danger + '25' : theme.bgTertiary,
                      borderColor: !isVideoEnabled ? theme.danger : theme.border,
                    },
                  ]}
                  onPress={toggleVideo}>
                  <Text
                    style={{
                      color: !isVideoEnabled ? theme.danger : theme.text,
                      fontSize: 22,
                    }}>
                    {isVideoEnabled ? '\u{1F4F9}' : '\u{1F6AB}'}
                  </Text>
                  <Text
                    style={[
                      styles.controlLabel,
                      {color: !isVideoEnabled ? theme.danger : theme.textSecondary},
                    ]}>
                    {isVideoEnabled ? 'Video' : 'No Video'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.controlBtn,
                    {backgroundColor: theme.bgTertiary, borderColor: theme.border},
                  ]}
                  onPress={flipCamera}>
                  <Text style={{color: theme.text, fontSize: 22}}>{'\u{1F504}'}</Text>
                  <Text style={[styles.controlLabel, {color: theme.textSecondary}]}>
                    Flip
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>

          <TouchableOpacity
            style={[styles.hangupBtn, {backgroundColor: theme.danger}]}
            onPress={handleHangup}>
            <Text style={styles.hangupIcon}>{'\u{1F4DE}'}</Text>
            <Text style={styles.hangupText}>End Call</Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  remoteVideo: {
    ...StyleSheet.absoluteFillObject,
  },
  localVideo: {
    position: 'absolute',
    top: 50,
    right: 16,
    width: 120,
    height: 170,
    borderRadius: 16,
    borderWidth: 2,
    overflow: 'hidden',
    zIndex: 10,
  },
  localVideoPiP: {
    width: 90,
    height: 130,
    top: 40,
    right: 12,
  },
  voiceCallUI: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 160,
  },
  avatarContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  ringEffect: {
    position: 'absolute',
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 2,
  },
  peerName: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  callType: {
    fontSize: 14,
    marginTop: 4,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  statusText: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 12,
    letterSpacing: 1,
  },
  encryptedBadge: {
    marginTop: 20,
  },
  encBadgeInner: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
  },
  encBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
  controlsContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 40,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginBottom: 24,
  },
  controlBtn: {
    width: 70,
    height: 70,
    borderRadius: 20,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  controlLabel: {
    fontSize: 10,
    fontWeight: '600',
    marginTop: 4,
    letterSpacing: 0.3,
  },
  hangupBtn: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 16,
    borderRadius: 30,
    gap: 8,
  },
  hangupIcon: {
    fontSize: 20,
    transform: [{rotate: '135deg'}],
  },
  hangupText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});
