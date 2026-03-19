import React, {useState, useCallback, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Vibration,
  Alert,
  Dimensions,
  Clipboard,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  SlideInUp,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import QRCodeScanner from 'react-native-qrcode-scanner';
import QRCode from 'react-native-qrcode-svg';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';

const {width: SCREEN_WIDTH} = Dimensions.get('window');

export default function QRScannerScreen({navigation}) {
  const {theme} = useTheme();
  const {state, dispatch} = useApp();
  const [mode, setMode] = useState('scan');
  const [scannedCode, setScannedCode] = useState(null);
  const [scanSuccess, setScanSuccess] = useState(false);
  const scannerRef = useRef(null);

  const scanLineY = useSharedValue(0);

  React.useEffect(() => {
    scanLineY.value = withRepeat(
      withSequence(
        withTiming(1, {duration: 2000}),
        withTiming(0, {duration: 2000}),
      ),
      -1,
    );
  }, [scanLineY]);

  const scanLineStyle = useAnimatedStyle(() => ({
    top: `${scanLineY.value * 100}%`,
  }));

  const handleScan = useCallback(
    (e) => {
      const code = e.data;
      Vibration.vibrate([0, 50, 50, 50]);
      setScanSuccess(true);
      setScannedCode(code);

      if (code.startsWith('GL-')) {
        Alert.alert(
          'Invite Code Found',
          `Join room with code:\n${code}`,
          [
            {text: 'Cancel', style: 'cancel', onPress: () => {
              setScanSuccess(false);
              setScannedCode(null);
              scannerRef.current?.reactivate();
            }},
            {
              text: 'Join',
              onPress: () => {
                const roomId = `room-${code.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
                dispatch({
                  type: 'ADD_ROOM',
                  payload: {
                    id: roomId,
                    name: `Room ${code.slice(3, 11)}`,
                    inviteCode: code,
                    createdAt: Date.now(),
                  },
                });
                dispatch({type: 'SET_ACTIVE_ROOM', payload: roomId});
                Vibration.vibrate(40);
                navigation.navigate('Chat');
              },
            },
          ],
        );
      } else {
        Alert.alert(
          'QR Code Scanned',
          code.length > 100 ? code.slice(0, 100) + '...' : code,
          [
            {text: 'OK', onPress: () => {
              setScanSuccess(false);
              setScannedCode(null);
              scannerRef.current?.reactivate();
            }},
            {
              text: 'Copy',
              onPress: () => {
                Clipboard.setString(code);
                setScanSuccess(false);
                setScannedCode(null);
                scannerRef.current?.reactivate();
              },
            },
          ],
        );
      }
    },
    [dispatch, navigation],
  );

  const myInviteCode = state.inviteCode || 'GL-00000000-00000000-00000000-00000000';

  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      <View style={[styles.header, {backgroundColor: theme.bgSecondary, borderBottomColor: theme.border}]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}>
          <Text style={[styles.backText, {color: theme.accent}]}>{'\u2190'} Back</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, {color: theme.text}]}>
          {mode === 'scan' ? 'Scan QR Code' : 'My QR Code'}
        </Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[
            styles.tab,
            {
              backgroundColor: mode === 'scan' ? theme.accentDim : 'transparent',
              borderColor: mode === 'scan' ? theme.accent : theme.border,
            },
          ]}
          onPress={() => {
            setMode('scan');
            Vibration.vibrate(10);
          }}>
          <Text style={{color: mode === 'scan' ? theme.accent : theme.textSecondary, fontWeight: '700', fontSize: 14}}>
            Scan
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.tab,
            {
              backgroundColor: mode === 'show' ? theme.accentDim : 'transparent',
              borderColor: mode === 'show' ? theme.accent : theme.border,
            },
          ]}
          onPress={() => {
            setMode('show');
            Vibration.vibrate(10);
          }}>
          <Text style={{color: mode === 'show' ? theme.accent : theme.textSecondary, fontWeight: '700', fontSize: 14}}>
            My Code
          </Text>
        </TouchableOpacity>
      </View>

      {mode === 'scan' ? (
        <View style={styles.scannerContainer}>
          <QRCodeScanner
            ref={scannerRef}
            onRead={handleScan}
            reactivate={false}
            reactivateTimeout={3000}
            showMarker
            markerStyle={{
              borderColor: scanSuccess ? theme.success : theme.accent,
              borderWidth: 2,
              borderRadius: 16,
            }}
            cameraStyle={styles.camera}
            containerStyle={styles.cameraContainer}
            topContent={null}
            bottomContent={null}
          />
          <View style={styles.scanOverlay}>
            <View style={[styles.scanFrame, {borderColor: theme.accent + '60'}]}>
              <Animated.View
                style={[
                  styles.scanLine,
                  {backgroundColor: theme.accent + '80'},
                  scanLineStyle,
                ]}
              />
              <View style={[styles.corner, styles.cornerTL, {borderColor: theme.accent}]} />
              <View style={[styles.corner, styles.cornerTR, {borderColor: theme.accent}]} />
              <View style={[styles.corner, styles.cornerBL, {borderColor: theme.accent}]} />
              <View style={[styles.corner, styles.cornerBR, {borderColor: theme.accent}]} />
            </View>
          </View>
          <Animated.View
            entering={FadeIn.delay(500)}
            style={styles.scanHint}>
            <Text style={[styles.scanHintText, {color: theme.textSecondary}]}>
              Point camera at a GhostLink QR code
            </Text>
          </Animated.View>

          {scanSuccess && (
            <Animated.View
              entering={FadeIn.duration(200)}
              style={[styles.successOverlay, {backgroundColor: theme.success + '20'}]}>
              <Text style={[styles.successText, {color: theme.success}]}>
                Code Detected
              </Text>
            </Animated.View>
          )}
        </View>
      ) : (
        <Animated.View entering={SlideInUp.duration(300)} style={styles.showContainer}>
          <View
            style={[
              styles.qrCard,
              {backgroundColor: theme.bgSecondary, borderColor: theme.border},
            ]}>
            <Text style={[styles.qrLabel, {color: theme.textSecondary}]}>
              Your GhostLink Invite
            </Text>
            <View style={[styles.qrWrapper, {backgroundColor: '#ffffff'}]}>
              <QRCode
                value={myInviteCode}
                size={SCREEN_WIDTH * 0.55}
                color="#000000"
                backgroundColor="#ffffff"
                ecl="H"
              />
            </View>
            <Text style={[styles.inviteCode, {color: theme.accent}]}>
              {myInviteCode}
            </Text>
            <Text style={[styles.qrDesc, {color: theme.textMuted}]}>
              Others can scan this to join your encrypted room
            </Text>

            <View style={styles.qrActions}>
              <TouchableOpacity
                style={[styles.qrActionBtn, {backgroundColor: theme.accentDim, borderColor: theme.accent + '30'}]}
                onPress={() => {
                  Clipboard.setString(myInviteCode);
                  Vibration.vibrate(20);
                  Alert.alert('Copied', 'Invite code copied to clipboard');
                }}>
                <Text style={[styles.qrActionText, {color: theme.accent}]}>Copy Code</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.qrActionBtn, {backgroundColor: theme.bgTertiary, borderColor: theme.border}]}
                onPress={() => {
                  Vibration.vibrate(20);
                  Alert.alert('Share', 'Share functionality would open native share sheet');
                }}>
                <Text style={[styles.qrActionText, {color: theme.text}]}>Share</Text>
              </TouchableOpacity>
            </View>
          </View>

          {state.identity && (
            <View
              style={[
                styles.identityCard,
                {backgroundColor: theme.bgSecondary, borderColor: theme.border},
              ]}>
              <Text style={[styles.identityLabel, {color: theme.textSecondary}]}>
                Identity Fingerprint
              </Text>
              <Text style={[styles.fingerprint, {color: theme.accent}]}>
                {state.identity.fingerprint}
              </Text>
            </View>
          )}
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    paddingTop: 48,
  },
  backBtn: {
    width: 70,
  },
  backText: {
    fontSize: 15,
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  scannerContainer: {
    flex: 1,
    position: 'relative',
  },
  camera: {
    flex: 1,
  },
  cameraContainer: {
    flex: 1,
  },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scanFrame: {
    width: SCREEN_WIDTH * 0.7,
    height: SCREEN_WIDTH * 0.7,
    borderWidth: 1,
    borderRadius: 16,
    position: 'relative',
    overflow: 'hidden',
  },
  scanLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderWidth: 3,
  },
  cornerTL: {
    top: -1,
    left: -1,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderTopLeftRadius: 16,
  },
  cornerTR: {
    top: -1,
    right: -1,
    borderLeftWidth: 0,
    borderBottomWidth: 0,
    borderTopRightRadius: 16,
  },
  cornerBL: {
    bottom: -1,
    left: -1,
    borderRightWidth: 0,
    borderTopWidth: 0,
    borderBottomLeftRadius: 16,
  },
  cornerBR: {
    bottom: -1,
    right: -1,
    borderLeftWidth: 0,
    borderTopWidth: 0,
    borderBottomRightRadius: 16,
  },
  scanHint: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  scanHintText: {
    fontSize: 14,
    fontWeight: '500',
  },
  successOverlay: {
    position: 'absolute',
    top: '40%',
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  successText: {
    fontSize: 16,
    fontWeight: '700',
  },
  showContainer: {
    flex: 1,
    padding: 20,
  },
  qrCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
    alignItems: 'center',
  },
  qrLabel: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  qrWrapper: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },
  inviteCode: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 8,
  },
  qrDesc: {
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 16,
  },
  qrActions: {
    flexDirection: 'row',
    gap: 10,
  },
  qrActionBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  qrActionText: {
    fontSize: 13,
    fontWeight: '700',
  },
  identityCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginTop: 16,
    alignItems: 'center',
  },
  identityLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  fingerprint: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
});
