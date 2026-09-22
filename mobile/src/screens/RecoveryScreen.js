import React, {useState, useCallback, useMemo, useEffect, useRef} from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Vibration,
  Alert,
  Clipboard,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
// Text and TextInput come from the scaled wrappers so the user's chosen
// size reaches every literal in this file's StyleSheet. See ScaledText.js.
import {Text, TextInput} from '../components/ScaledText';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import {
  CryptoEngine,
  generateBackupFragments,
  generateSeedPhrase,
} from '../utils/crypto';
import {
  wrapIdentity,
  deriveRecoveryTag,
  restoreFromPhrase,
  restoreFromFragments,
  unlockBundle,
  saveRecoveryBundle,
  RecoveryError,
  FRAGMENTS_STORAGE_KEY,
} from '../utils/recovery';
import {distributor} from '../services/MobileDistributor';

// ─── Constants ──────────────────────────────────────────────────
const TABS = ['Backup', 'Verify', 'Restore'];

const LAYER_BADGES = [
  {label: 'L1 Seed Phrase', color: '#00ffa3'},
  {label: 'L2 Shamir Shares', color: '#44ddff'},
  {label: 'L3 P2P Recovery', color: '#ff00ff'},
];

// Lightweight BIP39-style word list (same as AppContext uses)

// ─── Component ──────────────────────────────────────────────────
export default function RecoveryScreen({navigation}) {
  const {theme} = useTheme();
  const {identity, messages, setIdentity, wipeAll} = useApp();
  const webrtcRef = useRef(null);

  useEffect(() => {
    const initWebRTC = async () => {
      try {
        // Its own short-lived transport, deliberately not the app-wide one:
        // recovery talks to guardians over a separate connection.
        //
        // This used to attach a SignalingService, which dialled
        // ws://localhost:3001 — a signaling server that no longer exists
        // anywhere in the project, so guardian rendezvous has in fact been
        // broken since those servers were removed. The dial is gone rather
        // than left in place looking functional; reaching a guardian needs a
        // serverless rendezvous, which is tracked in MOBILE_BUILD.md.
        const {WebRTCService} = await import('../services/WebRTCService');

        const webrtc = new WebRTCService();
        distributor.useWebRTC(webrtc);
        webrtcRef.current = webrtc;
      } catch (e) {
        console.warn('[RecoveryScreen] WebRTC init failed:', e);
      }
    };

    initWebRTC();

    return () => {
      if (webrtcRef.current) {
        webrtcRef.current.destroy();
      }
    };
  }, []);

  // Tab state
  const [activeTab, setActiveTab] = useState(0);

  // Backup state
  const [seedPhrase, setSeedPhrase] = useState(() => generateSeedPhrase());
  const [fragments, setFragments] = useState([]);
  const [fragmentDist, setFragmentDist] = useState({});
  const [distributing, setDistributing] = useState(false);
  // fragmentDist shape: { fragmentIndex: { distributed: bool, peerName: string } }

  // Verify state
  const [verifyInputs, setVerifyInputs] = useState(['', '', '']);
  const [verifyResult, setVerifyResult] = useState(null); // null | 'success' | 'fail'

  // Restore state
  const [restoreStep, setRestoreStep] = useState(1);
  const [restoreSeedInput, setRestoreSeedInput] = useState('');
  const [restoreDerivStatus, setRestoreDerivStatus] = useState(null); // null | 'deriving' | 'success' | 'fail'
  const [shamirInputs, setShamirInputs] = useState(['', '', '']);
  const [shamirStatus, setShamirStatus] = useState(null); // null | 'combining' | 'success' | 'fail'

  // Peer state for P2P distribution
  const [connectedPeers, setConnectedPeers] = useState([]);
  const [showPeerPicker, setShowPeerPicker] = useState(false);
  const [pendingFragment, setPendingFragment] = useState(null);

  // ── Backup Handlers ──

  const handleGenerateFragments = useCallback(async () => {
    Vibration.vibrate(20);
    try {
      // Fragments carry the private key *wrapped* under the phrase, never the
      // phrase itself. The previous version put the 12 words in as plaintext,
      // which meant any three fragment-holders could collude to read the phrase
      // outright — collapsing "something you know" and "shares you distributed"
      // into a single factor, and handing them everything the phrase unlocks.
      const stored = await CryptoEngine.loadKeyPair();
      if (!stored || !stored.privateKeyRaw) {
        Alert.alert(
          'No key available',
          'Your private key could not be read from the keychain, so there is nothing to back up yet.',
        );
        return;
      }

      setDistributing(true);
      const bundle = await wrapIdentity(
        {
          privateKeyRaw: stored.privateKeyRaw,
          publicKeyHex: stored.publicKeyHex,
          name: identity?.name || '',
        },
        seedPhrase,
      );

      const frags = generateBackupFragments(JSON.stringify(bundle));
      setFragments(frags);
      setFragmentDist({});

      // The phrase shown on this screen is the one these fragments are wrapped
      // under, so it has to become the phrase that unlocks this device too —
      // otherwise the new fragments and the stored bundle disagree.
      await saveRecoveryBundle(bundle);
      await AsyncStorage.setItem(FRAGMENTS_STORAGE_KEY, JSON.stringify(frags));
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to generate backup fragments.');
    } finally {
      setDistributing(false);
    }
  }, [identity, seedPhrase]);

  const handleCopyPhrase = useCallback(() => {
    Clipboard.setString(seedPhrase.join(' '));
    Vibration.vibrate(15);
    Alert.alert('Copied', 'Seed phrase copied to clipboard. Store it safely offline.');
  }, [seedPhrase]);

  const handleRegenerate = useCallback(() => {
    Alert.alert(
      'Regenerate Seed?',
      'This will generate a completely new seed phrase. The old one will be lost.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Regenerate',
          onPress: () => {
            Vibration.vibrate(20);
            setSeedPhrase(generateSeedPhrase());
            setFragments([]);
            setFragmentDist({});
          },
        },
      ],
    );
  }, []);

  const handleCopyFragment = useCallback((frag, idx) => {
    Clipboard.setString(frag.data);
    Vibration.vibrate(15);
    Alert.alert('Copied', `Fragment ${frag.id} of 7 copied to clipboard.`);
  }, []);

  const handleGiveFragment = useCallback(async (frag, idx) => {
    setPendingFragment({frag, idx});
    setShowPeerPicker(true);
  }, []);

  const handleSelectPeer = useCallback(
    async peer => {
      if (!pendingFragment) return;

      const {frag, idx} = pendingFragment;
      setShowPeerPicker(false);
      setDistributing(true);

      try {
        if (webrtcRef.current && distributor) {
          // Same derivation the restoring device uses, so the lookup can
          // actually match. It was previously keyed on the public key here and
          // on the phrase at the recover end, which could never agree.
          const tag = await deriveRecoveryTag(seedPhrase);

          const stored = await CryptoEngine.loadKeyPair();
          if (!stored || !stored.privateKeyRaw) {
            Alert.alert('No key available', 'There is no private key on this device to back up.');
            return;
          }

          // What a peer holds is the wrapped bundle, never the phrase. Handing
          // peers the 12 words would let a single one of them read everything
          // the phrase unlocks, which defeats distributing shares at all.
          const bundle = await wrapIdentity(
            {
              privateKeyRaw: stored.privateKeyRaw,
              publicKeyHex: stored.publicKeyHex,
              name: identity?.name || '',
            },
            seedPhrase,
          );

          const result = await distributor.distribute(
            {tag, ...bundle},
            [peer],
            {n: 1, k: 1},
          );

          if (result.ok) {
            Vibration.vibrate(15);
            setFragmentDist(prev => ({
              ...prev,
              [idx]: {distributed: true, peerName: peer.name || peer.id},
            }));
            Alert.alert('Distributed', `Fragment ${frag.id} sent to ${peer.name || peer.id} via P2P.`);
          } else {
            throw new Error('Distribution failed');
          }
        } else {
          Clipboard.setString(frag.data);
          Vibration.vibrate(15);
          setFragmentDist(prev => ({
            ...prev,
            [idx]: {distributed: true, peerName: peer.name || peer.id},
          }));
          Alert.alert(
            'Fallback',
            `P2P not available. Fragment ${frag.id} copied to clipboard for manual sharing.`,
          );
        }
      } catch (e) {
        console.warn('[RecoveryScreen] Distribution error:', e);
        Clipboard.setString(frag.data);
        Vibration.vibrate(15);
        setFragmentDist(prev => ({
          ...prev,
          [idx]: {distributed: true, peerName: peer.name || peer.id, fallback: true},
        }));
        Alert.alert(
          'Fallback',
          `P2P distribution failed. Fragment ${frag.id} copied to clipboard.`,
        );
      } finally {
        setDistributing(false);
        setPendingFragment(null);
      }
    },
    [pendingFragment, identity, seedPhrase],
  );

  const handleManualGive = useCallback(
    (frag, idx) => {
      Alert.alert(
        'Manual Sharing',
        `Fragment ${frag.id} will be copied to clipboard. Share it with your trusted peer manually.`,
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Copy',
            onPress: () => {
              Clipboard.setString(frag.data);
              Vibration.vibrate(15);
              Alert.alert('Copied', `Fragment ${frag.id} copied to clipboard.`);
            },
          },
        ],
      );
    },
    [],
  );

  // ── Verify Handlers ──

  const handleVerify = useCallback(() => {
    Vibration.vibrate(15);
    const checks = [
      {index: 2, word: verifyInputs[0].trim().toLowerCase()},
      {index: 6, word: verifyInputs[1].trim().toLowerCase()},
      {index: 10, word: verifyInputs[2].trim().toLowerCase()},
    ];
    const pass = checks.every((c) => seedPhrase[c.index] === c.word);
    setVerifyResult(pass ? 'success' : 'fail');
    Vibration.vibrate(pass ? [0, 50, 50, 50] : [0, 200]);
  }, [verifyInputs, seedPhrase]);

  // ── Restore Handlers ──

  const handleDeriveSeed = useCallback(async () => {
    Vibration.vibrate(20);
    const words = restoreSeedInput
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);

    if (words.length !== 12) {
      Alert.alert('Invalid', 'Please enter exactly 12 words.');
      return;
    }

    setRestoreDerivStatus('deriving');

    try {
      // Unwraps the private key stored at setup. Previously this derived a key,
      // discarded it, and generated a brand-new random keypair — so "recovery"
      // silently produced a different identity with a different public key that
      // none of the user's peers would recognise.
      const identity = await restoreFromPhrase(words);

      setRestoreDerivStatus('success');
      Vibration.vibrate([0, 50, 50, 100]);
      setIdentity(identity);

      setTimeout(() => {
        navigation.reset({index: 0, routes: [{name: 'ChatList'}]});
      }, 1200);
    } catch (e) {
      setRestoreDerivStatus('fail');
      if (e.code === RecoveryError.NO_LOCAL_BUNDLE) {
        // Nothing to unwrap here, so send them to the fragment path rather than
        // implying the phrase was wrong.
        Alert.alert('No identity on this device', e.message);
        setRestoreStep(2);
      } else {
        Alert.alert('Recovery failed', e.message || 'Could not restore this identity.');
      }
    }
  }, [restoreSeedInput, setIdentity, navigation]);

  const handleShamirRestore = useCallback(async () => {
    Vibration.vibrate(20);

    const validFrags = shamirInputs.map((f) => f.trim()).filter((f) => f.length > 0);
    const words = restoreSeedInput
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);

    if (validFrags.length < 3 && connectedPeers.length === 0) {
      Alert.alert(
        'Need Fragments',
        'Please paste at least 3 recovery fragments or connect to peers for P2P recovery.',
      );
      return;
    }

    // Fragments carry only the wrapped private key. Without the phrase there is
    // nothing to unwrap it with, so ask for it before doing any work rather
    // than after reconstructing.
    if (words.length !== 12) {
      Alert.alert(
        'Recovery phrase needed',
        'Enter your 12-word phrase in step 1 as well. The fragments hold your key in encrypted form; the phrase is what unlocks it.',
      );
      setRestoreStep(1);
      return;
    }

    setShamirStatus('combining');

    if (validFrags.length >= 3) {
      try {
        const identity = await restoreFromFragments(validFrags, words);
        setShamirStatus('success');
        Vibration.vibrate([0, 50, 50, 50, 50, 100]);
        setIdentity(identity);
        setTimeout(() => {
          navigation.reset({index: 0, routes: [{name: 'ChatList'}]});
        }, 1200);
        return;
      } catch (e) {
        setShamirStatus('fail');
        Alert.alert(
          e.code === RecoveryError.WRONG_PHRASE ? 'Phrase does not match' : 'Recovery failed',
          e.message || 'Those fragments could not be combined.',
        );
        return;
      }
    }

    if (connectedPeers.length > 0 && distributor) {
      try {
        const tag = await deriveRecoveryTag(words);
        const blob = await distributor.recover(tag, connectedPeers, {k: 1});
        // Peers hold the same wrapped bundle, so it unlocks the same way.
        const identity = await unlockBundle(blob, words);
        await saveRecoveryBundle(blob);

        setShamirStatus('success');
        Vibration.vibrate([0, 50, 50, 50, 50, 100]);
        setIdentity(identity);
        setTimeout(() => {
          navigation.reset({index: 0, routes: [{name: 'ChatList'}]});
        }, 1200);
        return;
      } catch (e) {
        console.warn('[RecoveryScreen] P2P recovery failed:', e);
        setShamirStatus('fail');
        Alert.alert('Recovery failed', e.message || 'No peer could return your backup.');
        return;
      }
    }

    setShamirStatus('fail');
  }, [shamirInputs, connectedPeers, setIdentity, navigation, restoreSeedInput, distributor]);

  const handleRecoverFromPeers = useCallback(async () => {
    if (connectedPeers.length === 0) {
      Alert.alert('No Peers', 'Connect to peers first to recover via P2P.');
      return;
    }

    setShamirStatus('combining');

    const words = restoreSeedInput
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);

    if (words.length !== 12) {
      Alert.alert(
        'Recovery phrase needed',
        'Enter your 12-word phrase first. Peers hold your key in encrypted form; the phrase is what unlocks it.',
      );
      setShamirStatus(null);
      setRestoreStep(1);
      return;
    }

    try {
      const tag = await deriveRecoveryTag(words);
      const blob = await distributor.recover(tag, connectedPeers, {k: 1});

      // The peer returns the wrapped bundle, so it unlocks exactly like the
      // local and fragment paths do.
      const identity = await unlockBundle(blob, words);
      await saveRecoveryBundle(blob);

      setShamirStatus('success');
      Vibration.vibrate([0, 50, 50, 50, 50, 100]);
      setIdentity(identity);

      setTimeout(() => {
        navigation.reset({
          index: 0,
          routes: [{name: 'ChatList'}],
        });
      }, 1500);
    } catch (e) {
      console.warn('[RecoveryScreen] P2P recovery failed:', e);
      setShamirStatus('fail');
      Alert.alert(
        'P2P Recovery Failed',
        'Could not recover from peers. Make sure the correct peers are connected and they have your fragments.',
      );
    }
  }, [connectedPeers, restoreSeedInput, setIdentity, navigation]);

  // ── Derived ──

  const distributedCount = useMemo(() => {
    return Object.values(fragmentDist).filter((d) => d.distributed).length;
  }, [fragmentDist]);

  const safetyColor =
    distributedCount >= 5
      ? theme.success
      : distributedCount >= 3
        ? theme.warning
        : theme.danger;

  // ────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      {/* ── Header ── */}
      <View
        style={[
          styles.header,
          {backgroundColor: theme.bgSecondary, borderBottomColor: theme.border},
        ]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
          <Text style={[styles.backArrow, {color: theme.accent}]}>{'\u2190'}</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, {color: theme.text}]}>Recovery System</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* ── Tab Bar ── */}
      <View style={[styles.tabBar, {backgroundColor: theme.bgSecondary, borderBottomColor: theme.border}]}>
        {TABS.map((tab, idx) => {
          const active = activeTab === idx;
          return (
            <TouchableOpacity
              key={tab}
              style={[
                styles.tab,
                active && {borderBottomWidth: 2, borderBottomColor: theme.accent},
              ]}
              onPress={() => {
                Vibration.vibrate(10);
                setActiveTab(idx);
              }}>
              <Text
                style={[
                  styles.tabText,
                  {color: active ? theme.accent : theme.textMuted},
                ]}>
                {tab}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">

          {/* ═══════════════════ BACKUP TAB ═══════════════════ */}
          {activeTab === 0 && (
            <View>
              {/* Layer Badges */}
              <View style={styles.badgeRow}>
                {LAYER_BADGES.map((b) => (
                  <View
                    key={b.label}
                    style={[styles.badge, {backgroundColor: b.color + '18', borderColor: b.color + '40'}]}>
                    <Text style={[styles.badgeText, {color: b.color}]}>{b.label}</Text>
                  </View>
                ))}
              </View>

              {/* 12-Word Seed Phrase (3x4 grid) */}
              <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>SEED PHRASE</Text>
                <View style={styles.seedGrid}>
                  {seedPhrase.map((word, idx) => (
                    <View
                      key={idx}
                      style={[styles.seedCell, {backgroundColor: theme.bgTertiary, borderColor: theme.border}]}>
                      <Text style={[styles.seedIndex, {color: theme.textMuted}]}>{idx + 1}</Text>
                      <Text style={[styles.seedWord, {color: theme.text}]}>{word}</Text>
                    </View>
                  ))}
                </View>

                {/* Warning */}
                <View style={[styles.warningBanner, {backgroundColor: theme.warning + '15', borderColor: theme.warning + '30'}]}>
                  <Text style={[styles.warningText, {color: theme.warning}]}>
                    Write this phrase down and store it offline. Never share it digitally.
                  </Text>
                </View>

                {/* Buttons */}
                <View style={styles.seedActions}>
                  <TouchableOpacity
                    style={[styles.seedBtn, {backgroundColor: theme.accentDim}]}
                    onPress={handleCopyPhrase}
                    activeOpacity={0.7}>
                    <Text style={[styles.seedBtnText, {color: theme.accent}]}>Copy Phrase</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.seedBtn, {backgroundColor: theme.bgTertiary}]}
                    onPress={handleRegenerate}
                    activeOpacity={0.7}>
                    <Text style={[styles.seedBtnText, {color: theme.textSecondary}]}>Regenerate</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Shamir Fragments */}
              <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>SHAMIR FRAGMENTS</Text>

                {fragments.length === 0 ? (
                  <TouchableOpacity
                    style={[styles.genFragBtn, {backgroundColor: theme.accent}]}
                    onPress={handleGenerateFragments}
                    activeOpacity={0.7}>
                    <Text style={[styles.genFragBtnText, {color: theme.bg}]}>
                      Generate 7 Fragments
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <>
                    {/* Distribution counter */}
                    <View style={[styles.distCounter, {borderColor: safetyColor + '40'}]}>
                      <Text style={[styles.distCounterText, {color: safetyColor}]}>
                        {distributedCount}/7 distributed
                      </Text>
                      <Text style={[styles.distSafety, {color: safetyColor}]}>
                        {distributedCount >= 5
                          ? 'Excellent'
                          : distributedCount >= 3
                            ? 'Adequate'
                            : 'Needs more'}
                      </Text>
                    </View>

                    {/* Fragment list */}
                    {fragments.map((frag, idx) => {
                      const dist = fragmentDist[idx];
                      return (
                        <View
                          key={frag.id}
                          style={[
                            styles.fragCard,
                            {backgroundColor: theme.bgTertiary, borderColor: theme.border},
                          ]}>
                          <View style={styles.fragHeader}>
                            <Text style={[styles.fragNum, {color: theme.accent}]}>
                              Fragment {frag.id}
                            </Text>
                            <Text style={[styles.fragCheck, {color: theme.textMuted}]}>
                              {frag.check}
                            </Text>
                          </View>

                          {/* Distribution status */}
                          {dist?.distributed ? (
                            <Text style={[styles.fragDist, {color: theme.success}]}>
                              Distributed to {dist.peerName}
                            </Text>
                          ) : (
                            <Text style={[styles.fragDist, {color: theme.textMuted}]}>
                              Not distributed
                            </Text>
                          )}

                          {/* Action buttons */}
                          <View style={styles.fragActions}>
                            <TouchableOpacity
                              style={[styles.fragActionBtn, {backgroundColor: theme.accentDim}]}
                              onPress={() => handleCopyFragment(frag, idx)}>
                              <Text style={[styles.fragActionText, {color: theme.accent}]}>
                                COPY
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[
                                styles.fragActionBtn,
                                {backgroundColor: dist?.distributed ? theme.success + '20' : theme.bgSecondary},
                              ]}
                              onPress={() => handleGiveFragment(frag, idx)}
                              disabled={distributing}>
                              <Text
                                style={[
                                  styles.fragActionText,
                                  {color: dist?.distributed ? theme.success : theme.textSecondary},
                                ]}>
                                {dist?.distributed ? 'SENT' : distributing ? 'SENDING...' : 'SEND P2P'}
                              </Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      );
                    })}
                  </>
                )}
              </View>
            </View>
          )}

          {/* ═══════════════════ VERIFY TAB ═══════════════════ */}
          {activeTab === 1 && (
            <View>
              <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>
                  VERIFY YOUR SEED
                </Text>
                <Text style={[styles.verifyInstr, {color: theme.textSecondary}]}>
                  Enter words 3, 7, and 11 from your seed phrase to verify you recorded it correctly.
                </Text>

                {[3, 7, 11].map((wordNum, idx) => (
                  <View key={wordNum} style={styles.verifyInputGroup}>
                    <Text style={[styles.verifyLabel, {color: theme.textMuted}]}>
                      Word #{wordNum}
                    </Text>
                    <TextInput
                      style={[
                        styles.verifyInput,
                        {
                          backgroundColor: theme.bgTertiary,
                          borderColor: theme.border,
                          color: theme.text,
                        },
                      ]}
                      placeholder={`Enter word ${wordNum}`}
                      placeholderTextColor={theme.textMuted}
                      value={verifyInputs[idx]}
                      onChangeText={(text) => {
                        setVerifyResult(null);
                        setVerifyInputs((prev) => {
                          const next = [...prev];
                          next[idx] = text;
                          return next;
                        });
                      }}
                      autoCapitalize="none"
                      autoCorrect={false}
                      returnKeyType={idx < 2 ? 'next' : 'done'}
                    />
                  </View>
                ))}

                <TouchableOpacity
                  style={[styles.primaryBtn, {backgroundColor: theme.accent}]}
                  onPress={handleVerify}
                  activeOpacity={0.7}>
                  <Text style={[styles.primaryBtnText, {color: theme.bg}]}>Verify</Text>
                </TouchableOpacity>

                {/* Result banners */}
                {verifyResult === 'success' && (
                  <View
                    style={[
                      styles.resultBanner,
                      {backgroundColor: theme.success + '15', borderColor: theme.success + '40'},
                    ]}>
                    <Text style={[styles.resultTitle, {color: theme.success}]}>
                      Verification Passed
                    </Text>
                    <Text style={[styles.resultDesc, {color: theme.success}]}>
                      Your seed phrase was recorded correctly.
                    </Text>
                  </View>
                )}
                {verifyResult === 'fail' && (
                  <View
                    style={[
                      styles.resultBanner,
                      {backgroundColor: theme.danger + '15', borderColor: theme.danger + '40'},
                    ]}>
                    <Text style={[styles.resultTitle, {color: theme.danger}]}>
                      Verification Failed
                    </Text>
                    <Text style={[styles.resultDesc, {color: theme.danger}]}>
                      One or more words do not match. Check your seed phrase and try again.
                    </Text>
                  </View>
                )}
              </View>
            </View>
          )}

          {/* ═══════════════════ RESTORE TAB ═══════════════════ */}
          {activeTab === 2 && (
            <View>
              {/* Step 1: Seed Phrase Restore */}
              {restoreStep === 1 && (
                <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                  <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>
                    STEP 1: SEED PHRASE
                  </Text>
                  <Text style={[styles.restoreDesc, {color: theme.textSecondary}]}>
                    Enter your 12-word seed phrase to derive your identity key.
                  </Text>

                  <TextInput
                    style={[
                      styles.restoreTextarea,
                      {
                        backgroundColor: theme.bgTertiary,
                        borderColor: theme.border,
                        color: theme.text,
                      },
                    ]}
                    placeholder="Enter 12 words separated by spaces..."
                    placeholderTextColor={theme.textMuted}
                    value={restoreSeedInput}
                    onChangeText={(text) => {
                      setRestoreSeedInput(text);
                      setRestoreDerivStatus(null);
                    }}
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    textAlignVertical="top"
                  />

                  <TouchableOpacity
                    style={[
                      styles.primaryBtn,
                      {backgroundColor: theme.accent},
                      restoreDerivStatus === 'deriving' && {opacity: 0.6},
                    ]}
                    onPress={handleDeriveSeed}
                    disabled={restoreDerivStatus === 'deriving'}
                    activeOpacity={0.7}>
                    <Text style={[styles.primaryBtnText, {color: theme.bg}]}>
                      {restoreDerivStatus === 'deriving'
                        ? 'Deriving Key (PBKDF2)...'
                        : 'Derive Key & Check Device'}
                    </Text>
                  </TouchableOpacity>

                  {/* Status indicators */}
                  {restoreDerivStatus === 'deriving' && (
                    <View style={[styles.statusRow, {borderColor: theme.accent + '30'}]}>
                      <Text style={[styles.statusText, {color: theme.accent}]}>
                        Running PBKDF2 derivation...
                      </Text>
                    </View>
                  )}
                  {restoreDerivStatus === 'success' && (
                    <View
                      style={[
                        styles.resultBanner,
                        {backgroundColor: theme.success + '15', borderColor: theme.success + '40'},
                      ]}>
                      <Text style={[styles.resultTitle, {color: theme.success}]}>
                        Identity Restored
                      </Text>
                      <Text style={[styles.resultDesc, {color: theme.success}]}>
                        Key derived successfully. Redirecting to chat...
                      </Text>
                    </View>
                  )}
                  {restoreDerivStatus === 'fail' && (
                    <View
                      style={[
                        styles.resultBanner,
                        {backgroundColor: theme.danger + '15', borderColor: theme.danger + '40'},
                      ]}>
                      <Text style={[styles.resultTitle, {color: theme.danger}]}>
                        Seed Derivation Failed
                      </Text>
                      <Text style={[styles.resultDesc, {color: theme.danger}]}>
                        Could not restore from seed. Try Shamir fragment recovery below.
                      </Text>
                    </View>
                  )}
                </View>
              )}

              {/* Step 2: Shamir Fragment Restore */}
              {restoreStep === 2 && (
                <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                  <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>
                    STEP 2: SHAMIR FRAGMENTS
                  </Text>
                  <Text style={[styles.restoreDesc, {color: theme.textSecondary}]}>
                    Paste at least 3 Shamir fragments to reconstruct your identity, or recover from connected peers.
                  </Text>

                  {/* P2P Recovery Option */}
                  <View style={[styles.p2pRecoveryCard, {backgroundColor: theme.accent + '10', borderColor: theme.accent + '30'}]}>
                    <View style={styles.p2pRecoveryHeader}>
                      <Text style={[styles.p2pRecoveryTitle, {color: theme.accent}]}>
                        Recover from Peers
                      </Text>
                      <Text style={[styles.p2pRecoveryPeers, {color: theme.textMuted}]}>
                        {connectedPeers.length} peer{connectedPeers.length !== 1 ? 's' : ''} connected
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={[
                        styles.p2pRecoveryBtn,
                        {backgroundColor: theme.accent},
                        (shamirStatus === 'combining' || connectedPeers.length === 0) && {opacity: 0.6},
                      ]}
                      onPress={handleRecoverFromPeers}
                      disabled={shamirStatus === 'combining' || connectedPeers.length === 0}
                      activeOpacity={0.7}>
                      <Text style={[styles.p2pRecoveryBtnText, {color: theme.bg}]}>
                        Recover via P2P
                      </Text>
                    </TouchableOpacity>
                  </View>

                  <Text style={[styles.restoreDivider, {color: theme.textMuted}]}>
                    — or paste fragments manually —
                  </Text>

                  {shamirInputs.map((val, idx) => (
                    <View key={idx} style={styles.shamirInputGroup}>
                      <View style={styles.shamirLabelRow}>
                        <Text style={[styles.shamirLabel, {color: theme.accent}]}>
                          Fragment {idx + 1}
                        </Text>
                        {val.trim().length > 0 && (
                          <Text style={[styles.shamirOk, {color: theme.success}]}>Ready</Text>
                        )}
                      </View>
                      <TextInput
                        style={[
                          styles.shamirInput,
                          {
                            backgroundColor: theme.bgTertiary,
                            borderColor: theme.border,
                            color: theme.text,
                          },
                        ]}
                        placeholder="Paste hex fragment data..."
                        placeholderTextColor={theme.textMuted}
                        value={val}
                        onChangeText={(text) => {
                          setShamirStatus(null);
                          setShamirInputs((prev) => {
                            const next = [...prev];
                            next[idx] = text;
                            return next;
                          });
                        }}
                        multiline
                        autoCapitalize="none"
                        autoCorrect={false}
                        textAlignVertical="top"
                      />
                    </View>
                  ))}

                  <TouchableOpacity
                    style={[
                      styles.primaryBtn,
                      {backgroundColor: theme.accent},
                      shamirStatus === 'combining' && {opacity: 0.6},
                    ]}
                    onPress={handleShamirRestore}
                    disabled={shamirStatus === 'combining'}
                    activeOpacity={0.7}>
                    <Text style={[styles.primaryBtnText, {color: theme.bg}]}>
                      {shamirStatus === 'combining'
                        ? 'Combining Fragments...'
                        : 'Combine & Restore'}
                    </Text>
                  </TouchableOpacity>

                  {/* Status */}
                  {shamirStatus === 'combining' && (
                    <View style={[styles.statusRow, {borderColor: theme.accent + '30'}]}>
                      <Text style={[styles.statusText, {color: theme.accent}]}>
                        Reconstructing secret via Lagrange interpolation...
                      </Text>
                    </View>
                  )}
                  {shamirStatus === 'success' && (
                    <View
                      style={[
                        styles.resultBanner,
                        {backgroundColor: theme.success + '15', borderColor: theme.success + '40'},
                      ]}>
                      <Text style={[styles.resultTitle, {color: theme.success}]}>
                        Identity Restored
                      </Text>
                      <Text style={[styles.resultDesc, {color: theme.success}]}>
                        Shamir reconstruction successful. Redirecting to chat...
                      </Text>
                    </View>
                  )}
                  {shamirStatus === 'fail' && (
                    <View
                      style={[
                        styles.resultBanner,
                        {backgroundColor: theme.danger + '15', borderColor: theme.danger + '40'},
                      ]}>
                      <Text style={[styles.resultTitle, {color: theme.danger}]}>
                        Reconstruction Failed
                      </Text>
                      <Text style={[styles.resultDesc, {color: theme.danger}]}>
                        Fragment data is invalid or insufficient. Verify fragment integrity.
                      </Text>
                    </View>
                  )}

                  {/* Back to Step 1 */}
                  <TouchableOpacity
                    style={[styles.secondaryBtn, {borderColor: theme.border}]}
                    onPress={() => {
                      setRestoreStep(1);
                      setRestoreDerivStatus(null);
                    }}
                    activeOpacity={0.7}>
                    <Text style={[styles.secondaryBtnText, {color: theme.textSecondary}]}>
                      {'\u2190'} Back to Step 1
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Peer Picker Modal */}
      {showPeerPicker && (
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
            <Text style={[styles.modalTitle, {color: theme.text}]}>Send to Peer</Text>
            <Text style={[styles.modalSubtitle, {color: theme.textMuted}]}>
              Select a connected peer to receive this fragment
            </Text>

            {connectedPeers.length === 0 ? (
              <View style={styles.noPeersContainer}>
                <Text style={[styles.noPeersText, {color: theme.textMuted}]}>
                  No peers connected. Connect to peers first via the main chat screen.
                </Text>
                <TouchableOpacity
                  style={[styles.modalBtn, {backgroundColor: theme.accentDim}]}
                  onPress={() => setShowPeerPicker(false)}>
                  <Text style={[styles.modalBtnText, {color: theme.accent}]}>Close</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                {connectedPeers.map(peer => (
                  <TouchableOpacity
                    key={peer.id}
                    style={[styles.peerItem, {backgroundColor: theme.bgTertiary, borderColor: theme.border}]}
                    onPress={() => handleSelectPeer(peer)}>
                    <View style={[styles.peerAvatar, {backgroundColor: theme.accent}]}>
                      <Text style={styles.peerInitial}>
                        {(peer.name || peer.id)[0].toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.peerInfo}>
                      <Text style={[styles.peerName, {color: theme.text}]}>
                        {peer.name || peer.id}
                      </Text>
                      <Text style={[styles.peerStatus, {color: theme.success}]}>Connected</Text>
                    </View>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  style={[styles.modalBtn, {backgroundColor: theme.bgTertiary}]}
                  onPress={() => {
                    setShowPeerPicker(false);
                    if (pendingFragment) {
                      handleManualGive(pendingFragment.frag, pendingFragment.idx);
                    }
                  }}>
                  <Text style={[styles.modalBtnText, {color: theme.textSecondary}]}>
                    Manual (Copy to Clipboard)
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },

  /* Header */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    paddingTop: Platform.OS === 'ios' ? 54 : 48,
    borderBottomWidth: 1,
  },
  backBtn: {
    width: 40,
    alignItems: 'flex-start',
  },
  backArrow: {
    fontSize: 22,
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  headerSpacer: {
    width: 40,
  },

  /* Tab Bar */
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  /* Scroll */
  scroll: {
    padding: 16,
    paddingBottom: 50,
  },

  /* Card */
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
    marginBottom: 14,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 14,
  },

  /* Badge Row */
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },

  /* Seed Grid (3 columns, 4 rows) */
  seedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
  },
  seedCell: {
    width: '31%',
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  seedIndex: {
    fontSize: 10,
    fontWeight: '700',
    width: 18,
  },
  seedWord: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },

  /* Warning */
  warningBanner: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    marginBottom: 14,
  },
  warningText: {
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 18,
  },

  /* Seed Action Buttons */
  seedActions: {
    flexDirection: 'row',
    gap: 10,
  },
  seedBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  seedBtnText: {
    fontSize: 14,
    fontWeight: '700',
  },

  /* Fragment generation */
  genFragBtn: {
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  genFragBtnText: {
    fontSize: 16,
    fontWeight: '700',
  },

  /* Distribution Counter */
  distCounter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  distCounterText: {
    fontSize: 14,
    fontWeight: '700',
  },
  distSafety: {
    fontSize: 12,
    fontWeight: '600',
  },

  /* Fragment Card */
  fragCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  fragHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  fragNum: {
    fontSize: 14,
    fontWeight: '700',
  },
  fragCheck: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  fragDist: {
    fontSize: 12,
    marginBottom: 10,
  },
  fragActions: {
    flexDirection: 'row',
    gap: 8,
  },
  fragActionBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  fragActionText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },

  /* Verify */
  verifyInstr: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 16,
  },
  verifyInputGroup: {
    marginBottom: 14,
  },
  verifyLabel: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
  },
  verifyInput: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    fontWeight: '500',
  },

  /* Primary Button */
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

  /* Secondary Button */
  secondaryBtn: {
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },

  /* Result banners */
  resultBanner: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginTop: 14,
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

  /* Status indicator */
  statusRow: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
    alignItems: 'center',
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
  },

  /* Restore */
  restoreDesc: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 14,
  },
  restoreTextarea: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    minHeight: 100,
    textAlignVertical: 'top',
    marginBottom: 8,
  },

  /* Shamir Inputs */
  shamirInputGroup: {
    marginBottom: 12,
  },
  shamirLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  shamirLabel: {
    fontSize: 12,
    fontWeight: '700',
  },
  shamirOk: {
    fontSize: 11,
    fontWeight: '700',
  },
  shamirInput: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 12,
    minHeight: 70,
    textAlignVertical: 'top',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  /* Peer Picker Modal */
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  modalSubtitle: {
    fontSize: 13,
    marginBottom: 16,
  },
  noPeersContainer: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  noPeersText: {
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 20,
  },
  peerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    marginBottom: 8,
  },
  peerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  peerInitial: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  peerInfo: {
    flex: 1,
  },
  peerName: {
    fontSize: 15,
    fontWeight: '600',
  },
  peerStatus: {
    fontSize: 12,
    marginTop: 2,
  },
  modalBtn: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  modalBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },

  /* P2P Recovery */
  p2pRecoveryCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
  },
  p2pRecoveryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  p2pRecoveryTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  p2pRecoveryPeers: {
    fontSize: 12,
  },
  p2pRecoveryBtn: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  p2pRecoveryBtnText: {
    fontSize: 14,
    fontWeight: '700',
  },
  restoreDivider: {
    textAlign: 'center',
    marginVertical: 12,
    fontSize: 12,
  },
});
