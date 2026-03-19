import React, {useState, useCallback} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Vibration,
  Alert,
  Clipboard,
} from 'react-native';
import Animated, {FadeInDown, FadeIn} from 'react-native-reanimated';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import {CryptoEngine, generateBackupFragments, combineFragments} from '../utils/crypto';

const MODES = {
  MENU: 'menu',
  BACKUP: 'backup',
  RESTORE: 'restore',
  FRAGMENTS: 'fragments',
};

export default function RecoveryScreen({navigation}) {
  const {theme} = useTheme();
  const {state, dispatch} = useApp();
  const [mode, setMode] = useState(MODES.MENU);
  const [fragments, setFragments] = useState([]);
  const [restoreInputs, setRestoreInputs] = useState(['', '', '']);
  const [seedInput, setSeedInput] = useState('');
  const [restoreStatus, setRestoreStatus] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleGenerateBackup = useCallback(async () => {
    Vibration.vibrate(20);
    setLoading(true);
    try {
      const blob = JSON.stringify({
        version: 1,
        timestamp: Date.now(),
        name: state.displayName,
        fingerprint: state.identity?.fingerprint,
        pubKeyHex: state.identity?.publicKeyHex,
        messages: state.messages,
        chain: state.chain,
        rooms: state.rooms,
      });
      const frags = generateBackupFragments(blob);
      setFragments(frags);
      setMode(MODES.FRAGMENTS);
    } catch (e) {
      Alert.alert('Error', 'Failed to generate backup fragments.');
    } finally {
      setLoading(false);
    }
  }, [state]);

  const handleCopyFragment = useCallback((frag) => {
    Vibration.vibrate(15);
    Clipboard.setString(frag.data);
    Alert.alert('Copied', `Fragment ${frag.id} of 7 copied to clipboard. Share it with a trusted peer.`);
  }, []);

  const handleRestore = useCallback(async () => {
    Vibration.vibrate(20);
    setLoading(true);
    setRestoreStatus(null);

    const validFrags = restoreInputs.filter(f => f.trim().length > 0);
    if (validFrags.length < 3) {
      setRestoreStatus({success: false, error: 'Need at least 3 fragments to restore.'});
      setLoading(false);
      return;
    }

    const result = combineFragments(validFrags);
    if (result.success) {
      const blob = result.blob;
      dispatch({type: 'SET_DISPLAY_NAME', payload: blob.name || 'Restored'});
      if (blob.messages) {
        Object.entries(blob.messages).forEach(([roomId, msgs]) => {
          msgs.forEach(msg => dispatch({type: 'ADD_MESSAGE', payload: {roomId, message: msg}}));
        });
      }
      if (blob.chain) dispatch({type: 'SET_CHAIN', payload: blob.chain});
      if (blob.rooms) {
        blob.rooms.forEach(room => dispatch({type: 'ADD_ROOM', payload: room}));
      }
      dispatch({type: 'COMPLETE_SETUP'});
      setRestoreStatus({
        success: true,
        restored: {
          name: blob.name,
          messages: !!blob.messages,
          chain: !!blob.chain,
        },
      });
      Vibration.vibrate([0, 50, 50, 50, 50, 100]);
    } else {
      setRestoreStatus(result);
    }
    setLoading(false);
  }, [restoreInputs, dispatch]);

  const addRestoreInput = useCallback(() => {
    setRestoreInputs(prev => [...prev, '']);
  }, []);

  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      <View style={[styles.header, {backgroundColor: theme.bgSecondary, borderBottomColor: theme.border}]}>
        <TouchableOpacity onPress={() => {
          if (mode === MODES.MENU) navigation.goBack();
          else setMode(MODES.MENU);
        }}>
          <Text style={[styles.backText, {color: theme.accent}]}>
            {mode === MODES.MENU ? '\u2190 Back' : '\u2190 Menu'}
          </Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, {color: theme.text}]}>Recovery System</Text>
        <View style={{width: 50}} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {mode === MODES.MENU && (
          <>
            <Animated.View entering={FadeInDown.duration(300)} style={styles.introBox}>
              <Text style={[styles.introTitle, {color: theme.text}]}>3-Layer Recovery</Text>
              <Text style={[styles.introDesc, {color: theme.textSecondary}]}>
                GhostLink uses Shamir's Secret Sharing to split your identity into 7 fragments.
                Any 3 fragments can reconstruct your full identity and data.
              </Text>
            </Animated.View>

            <Animated.View entering={FadeInDown.delay(100).duration(300)}>
              <TouchableOpacity
                style={[styles.menuCard, {backgroundColor: theme.bgSecondary, borderColor: theme.accent + '30'}]}
                onPress={() => {
                  Vibration.vibrate(15);
                  setMode(MODES.BACKUP);
                }}>
                <View style={[styles.menuIcon, {backgroundColor: theme.accentDim}]}>
                  <Text style={{color: theme.accent, fontSize: 24}}>{'\u{1F6E1}'}</Text>
                </View>
                <View style={styles.menuInfo}>
                  <Text style={[styles.menuTitle, {color: theme.text}]}>Create Backup</Text>
                  <Text style={[styles.menuDesc, {color: theme.textSecondary}]}>
                    Generate 7 Shamir fragments from your identity
                  </Text>
                </View>
              </TouchableOpacity>
            </Animated.View>

            <Animated.View entering={FadeInDown.delay(200).duration(300)}>
              <TouchableOpacity
                style={[styles.menuCard, {backgroundColor: theme.bgSecondary, borderColor: theme.accent + '30'}]}
                onPress={() => {
                  Vibration.vibrate(15);
                  setMode(MODES.RESTORE);
                }}>
                <View style={[styles.menuIcon, {backgroundColor: theme.accentDim}]}>
                  <Text style={{color: theme.accent, fontSize: 24}}>{'\u{1F504}'}</Text>
                </View>
                <View style={styles.menuInfo}>
                  <Text style={[styles.menuTitle, {color: theme.text}]}>Restore Identity</Text>
                  <Text style={[styles.menuDesc, {color: theme.textSecondary}]}>
                    Combine 3+ fragments to recover your account
                  </Text>
                </View>
              </TouchableOpacity>
            </Animated.View>

            <Animated.View
              entering={FadeInDown.delay(300).duration(300)}
              style={[styles.securityNote, {backgroundColor: theme.accent + '08', borderColor: theme.accent + '20'}]}>
              <Text style={[styles.securityTitle, {color: theme.accent}]}>How It Works</Text>
              <View style={styles.steps}>
                {[
                  'Your identity is encrypted and split into 7 fragments using GF(256) polynomial interpolation',
                  'Distribute fragments to trusted peers or store in separate secure locations',
                  'Any 3 of 7 fragments can reconstruct your identity — fewer than 3 reveals nothing',
                ].map((step, idx) => (
                  <View key={idx} style={styles.stepRow}>
                    <View style={[styles.stepNum, {backgroundColor: theme.accentDim}]}>
                      <Text style={[styles.stepNumText, {color: theme.accent}]}>{idx + 1}</Text>
                    </View>
                    <Text style={[styles.stepText, {color: theme.textSecondary}]}>{step}</Text>
                  </View>
                ))}
              </View>
            </Animated.View>
          </>
        )}

        {mode === MODES.BACKUP && (
          <Animated.View entering={FadeInDown.duration(300)}>
            <Text style={[styles.sectionTitle, {color: theme.text}]}>Generate Backup Fragments</Text>
            <Text style={[styles.sectionDesc, {color: theme.textSecondary}]}>
              This will create 7 Shamir fragments from your current identity, messages, and chain data.
            </Text>
            <View style={[styles.statusCard, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
              <Text style={[styles.statusLabel, {color: theme.textMuted}]}>Identity</Text>
              <Text style={[styles.statusValue, {color: theme.text}]}>{state.displayName || 'Not set'}</Text>
              <Text style={[styles.statusLabel, {color: theme.textMuted, marginTop: 8}]}>Messages</Text>
              <Text style={[styles.statusValue, {color: theme.text}]}>
                {Object.values(state.messages).flat().length} total
              </Text>
              <Text style={[styles.statusLabel, {color: theme.textMuted, marginTop: 8}]}>Chain Blocks</Text>
              <Text style={[styles.statusValue, {color: theme.text}]}>{state.chain.length}</Text>
            </View>
            <TouchableOpacity
              style={[styles.primaryBtn, {backgroundColor: theme.accent}, loading && {opacity: 0.6}]}
              onPress={handleGenerateBackup}
              disabled={loading}>
              <Text style={[styles.primaryBtnText, {color: theme.bg}]}>
                {loading ? 'Generating...' : 'Generate 7 Fragments'}
              </Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {mode === MODES.FRAGMENTS && (
          <Animated.View entering={FadeInDown.duration(300)}>
            <Text style={[styles.sectionTitle, {color: theme.text}]}>Your Backup Fragments</Text>
            <Text style={[styles.sectionDesc, {color: theme.textSecondary}]}>
              Distribute these to trusted peers. Any 3 can restore your identity.
            </Text>
            {fragments.map((frag, idx) => (
              <Animated.View
                key={frag.id}
                entering={FadeInDown.delay(idx * 60).duration(250)}
                style={[styles.fragmentCard, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                <View style={styles.fragmentHeader}>
                  <View style={[styles.fragmentBadge, {backgroundColor: theme.accentDim}]}>
                    <Text style={[styles.fragmentBadgeText, {color: theme.accent}]}>
                      {frag.label}
                    </Text>
                  </View>
                  <Text style={[styles.fragmentCheck, {color: theme.textMuted}]}>
                    Check: {frag.check}
                  </Text>
                </View>
                <Text style={[styles.fragmentData, {color: theme.textSecondary}]} numberOfLines={2}>
                  {frag.data}
                </Text>
                <TouchableOpacity
                  style={[styles.copyBtn, {backgroundColor: theme.accentDim}]}
                  onPress={() => handleCopyFragment(frag)}>
                  <Text style={[styles.copyBtnText, {color: theme.accent}]}>Copy Fragment</Text>
                </TouchableOpacity>
              </Animated.View>
            ))}
          </Animated.View>
        )}

        {mode === MODES.RESTORE && (
          <Animated.View entering={FadeInDown.duration(300)}>
            <Text style={[styles.sectionTitle, {color: theme.text}]}>Restore Identity</Text>
            <Text style={[styles.sectionDesc, {color: theme.textSecondary}]}>
              Paste at least 3 backup fragments to reconstruct your identity.
            </Text>

            {restoreInputs.map((val, idx) => (
              <View key={idx} style={styles.restoreInputRow}>
                <View style={[styles.restoreLabel, {backgroundColor: theme.bgTertiary}]}>
                  <Text style={[styles.restoreLabelText, {color: theme.accent}]}>
                    Fragment {idx + 1}
                  </Text>
                </View>
                <TextInput
                  style={[
                    styles.restoreInput,
                    {
                      backgroundColor: theme.bgSecondary,
                      borderColor: theme.border,
                      color: theme.text,
                    },
                  ]}
                  placeholder="Paste fragment hex data..."
                  placeholderTextColor={theme.textMuted}
                  value={val}
                  onChangeText={text => {
                    setRestoreInputs(prev => {
                      const next = [...prev];
                      next[idx] = text;
                      return next;
                    });
                  }}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            ))}

            <TouchableOpacity
              style={[styles.addFragBtn, {borderColor: theme.border}]}
              onPress={addRestoreInput}>
              <Text style={[styles.addFragText, {color: theme.textSecondary}]}>
                + Add Another Fragment
              </Text>
            </TouchableOpacity>

            {restoreStatus && (
              <Animated.View
                entering={FadeIn.duration(200)}
                style={[
                  styles.resultCard,
                  {
                    backgroundColor: restoreStatus.success ? theme.success + '15' : theme.danger + '15',
                    borderColor: restoreStatus.success ? theme.success + '40' : theme.danger + '40',
                  },
                ]}>
                <Text
                  style={[
                    styles.resultTitle,
                    {color: restoreStatus.success ? theme.success : theme.danger},
                  ]}>
                  {restoreStatus.success ? 'Restoration Successful' : 'Restoration Failed'}
                </Text>
                <Text
                  style={[
                    styles.resultDesc,
                    {color: restoreStatus.success ? theme.success : theme.danger},
                  ]}>
                  {restoreStatus.success
                    ? `Restored as "${restoreStatus.restored?.name}". Messages: ${restoreStatus.restored?.messages ? 'Yes' : 'No'}, Chain: ${restoreStatus.restored?.chain ? 'Yes' : 'No'}`
                    : restoreStatus.error}
                </Text>
              </Animated.View>
            )}

            <TouchableOpacity
              style={[styles.primaryBtn, {backgroundColor: theme.accent}, loading && {opacity: 0.6}]}
              onPress={handleRestore}
              disabled={loading}>
              <Text style={[styles.primaryBtnText, {color: theme.bg}]}>
                {loading ? 'Restoring...' : 'Restore Identity'}
              </Text>
            </TouchableOpacity>
          </Animated.View>
        )}
      </ScrollView>
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
    paddingTop: 48,
    borderBottomWidth: 1,
  },
  backText: {
    fontSize: 15,
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  scroll: {
    padding: 16,
    paddingBottom: 40,
  },
  introBox: {
    marginBottom: 20,
  },
  introTitle: {
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 8,
  },
  introDesc: {
    fontSize: 14,
    lineHeight: 21,
  },
  menuCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },
  menuIcon: {
    width: 52,
    height: 52,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuInfo: {
    flex: 1,
    marginLeft: 14,
  },
  menuTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 3,
  },
  menuDesc: {
    fontSize: 12,
    lineHeight: 17,
  },
  securityNote: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    marginTop: 8,
  },
  securityTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 12,
  },
  steps: {
    gap: 10,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  stepNum: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
    marginTop: 1,
  },
  stepNumText: {
    fontSize: 12,
    fontWeight: '800',
  },
  stepText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
  },
  sectionDesc: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 16,
  },
  statusCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 16,
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  statusValue: {
    fontSize: 15,
    fontWeight: '600',
    marginTop: 2,
  },
  primaryBtn: {
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnText: {
    fontSize: 16,
    fontWeight: '700',
  },
  fragmentCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  fragmentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  fragmentBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  fragmentBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  fragmentCheck: {
    fontSize: 11,
  },
  fragmentData: {
    fontSize: 10,
    letterSpacing: 0.3,
    marginBottom: 10,
    lineHeight: 16,
  },
  copyBtn: {
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  copyBtnText: {
    fontSize: 13,
    fontWeight: '700',
  },
  restoreInputRow: {
    marginBottom: 12,
  },
  restoreLabel: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    marginBottom: 6,
    alignSelf: 'flex-start',
  },
  restoreLabelText: {
    fontSize: 12,
    fontWeight: '700',
  },
  restoreInput: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 12,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  addFragBtn: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    marginBottom: 16,
  },
  addFragText: {
    fontSize: 13,
    fontWeight: '600',
  },
  resultCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 16,
  },
  resultTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
  },
  resultDesc: {
    fontSize: 12,
    lineHeight: 18,
  },
});
