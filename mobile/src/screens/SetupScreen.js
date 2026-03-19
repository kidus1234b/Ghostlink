import React, {useState, useCallback, useEffect} from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Switch,
  Vibration,
  StatusBar,
} from 'react-native';
import Animated, {
  FadeInDown,
  FadeInUp,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import {CryptoEngine} from '../utils/crypto';

const STEPS = {
  NAME: 0,
  SEED: 1,
  CONFIRM: 2,
  BIOMETRIC: 3,
};

export default function SetupScreen({navigation}) {
  const {theme} = useTheme();
  const {setupIdentity, dispatch} = useApp();
  const [step, setStep] = useState(STEPS.NAME);
  const [displayName, setDisplayName] = useState('');
  const [seedPhrase, setSeedPhrase] = useState([]);
  const [seedConfirmed, setSeedConfirmed] = useState(false);
  const [confirmWords, setConfirmWords] = useState({});
  const [confirmIndices, setConfirmIndices] = useState([]);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  const ghostPulse = useSharedValue(1);

  useEffect(() => {
    ghostPulse.value = withRepeat(
      withSequence(
        withTiming(1.05, {duration: 1500}),
        withTiming(1, {duration: 1500}),
      ),
      -1,
      true,
    );
    checkBiometrics();
  }, [ghostPulse]);

  const ghostStyle = useAnimatedStyle(() => ({
    transform: [{scale: ghostPulse.value}],
  }));

  async function checkBiometrics() {
    const available = await CryptoEngine.hasBiometrics();
    setBiometricAvailable(available);
  }

  const handleNameSubmit = useCallback(async () => {
    if (!displayName.trim()) {
      Alert.alert('Name Required', 'Enter a display name to continue.');
      return;
    }
    Vibration.vibrate(20);
    setLoading(true);
    try {
      const result = await setupIdentity(displayName.trim());
      setSeedPhrase(result.seedPhrase);
      const indices = [];
      while (indices.length < 3) {
        const idx = Math.floor(Math.random() * 12);
        if (!indices.includes(idx)) indices.push(idx);
      }
      setConfirmIndices(indices.sort((a, b) => a - b));
      setStep(STEPS.SEED);
    } catch (e) {
      Alert.alert('Error', 'Failed to generate identity. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [displayName, setupIdentity]);

  const handleSeedConfirm = useCallback(() => {
    Vibration.vibrate(20);
    setStep(STEPS.CONFIRM);
  }, []);

  const handleWordConfirm = useCallback(() => {
    let allCorrect = true;
    for (const idx of confirmIndices) {
      if (
        !confirmWords[idx] ||
        confirmWords[idx].toLowerCase().trim() !== seedPhrase[idx]
      ) {
        allCorrect = false;
        break;
      }
    }
    if (!allCorrect) {
      Alert.alert('Incorrect', 'One or more words do not match. Check your seed phrase backup.');
      return;
    }
    Vibration.vibrate(30);
    setSeedConfirmed(true);
    if (biometricAvailable) {
      setStep(STEPS.BIOMETRIC);
    } else {
      finishSetup(false);
    }
  }, [confirmWords, confirmIndices, seedPhrase, biometricAvailable]);

  const finishSetup = useCallback(
    (useBiometric) => {
      Vibration.vibrate(40);
      dispatch({type: 'SET_BIOMETRIC', payload: useBiometric});
      dispatch({type: 'COMPLETE_SETUP'});
      navigation.reset({
        index: 0,
        routes: [{name: 'Main'}],
      });
    },
    [dispatch, navigation],
  );

  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled">
        <Animated.View style={[styles.logoContainer, ghostStyle]}>
          <View style={[styles.ghostIcon, {borderColor: theme.accent + '40'}]}>
            <Text style={[styles.ghostEmoji, {color: theme.accent}]}>G</Text>
          </View>
          <Text style={[styles.title, {color: theme.text}]}>GhostLink</Text>
          <Text style={[styles.subtitle, {color: theme.textSecondary}]}>
            Zero Trust. Zero Trace.
          </Text>
        </Animated.View>

        {step === STEPS.NAME && (
          <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
            <Text style={[styles.stepTitle, {color: theme.text}]}>
              Choose Your Identity
            </Text>
            <Text style={[styles.stepDesc, {color: theme.textSecondary}]}>
              This name is visible to peers in your encrypted rooms.
            </Text>
            <View
              style={[
                styles.inputWrapper,
                {
                  backgroundColor: theme.bgSecondary,
                  borderColor: theme.border,
                },
              ]}>
              <TextInput
                style={[styles.input, {color: theme.text}]}
                placeholder="Display name..."
                placeholderTextColor={theme.textMuted}
                value={displayName}
                onChangeText={setDisplayName}
                maxLength={24}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleNameSubmit}
              />
            </View>
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                {backgroundColor: theme.accent},
                loading && {opacity: 0.6},
              ]}
              onPress={handleNameSubmit}
              disabled={loading}>
              <Text style={[styles.primaryBtnText, {color: theme.bg}]}>
                {loading ? 'Generating Keys...' : 'Generate Identity'}
              </Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {step === STEPS.SEED && (
          <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
            <Text style={[styles.stepTitle, {color: theme.text}]}>
              Your Recovery Seed
            </Text>
            <Text style={[styles.stepDesc, {color: theme.textSecondary}]}>
              Write down these 12 words in order. They are your only way to recover your identity.
            </Text>
            <View style={styles.seedGrid}>
              {seedPhrase.map((word, idx) => (
                <Animated.View
                  key={idx}
                  entering={FadeInUp.delay(idx * 60).duration(300)}
                  style={[
                    styles.seedWord,
                    {
                      backgroundColor: theme.bgTertiary,
                      borderColor: theme.border,
                    },
                  ]}>
                  <Text style={[styles.seedIndex, {color: theme.textMuted}]}>
                    {idx + 1}
                  </Text>
                  <Text style={[styles.seedText, {color: theme.accent}]}>
                    {word}
                  </Text>
                </Animated.View>
              ))}
            </View>
            <View
              style={[
                styles.warningBox,
                {backgroundColor: theme.warning + '15', borderColor: theme.warning + '30'},
              ]}>
              <Text style={[styles.warningText, {color: theme.warning}]}>
                Store these words securely offline. Anyone with these words can recover your identity.
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.primaryBtn, {backgroundColor: theme.accent}]}
              onPress={handleSeedConfirm}>
              <Text style={[styles.primaryBtnText, {color: theme.bg}]}>
                I Have Saved My Seed
              </Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {step === STEPS.CONFIRM && (
          <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
            <Text style={[styles.stepTitle, {color: theme.text}]}>
              Confirm Your Seed
            </Text>
            <Text style={[styles.stepDesc, {color: theme.textSecondary}]}>
              Enter the words at the following positions to verify your backup.
            </Text>
            {confirmIndices.map(idx => (
              <View key={idx} style={styles.confirmRow}>
                <View style={[styles.confirmLabel, {backgroundColor: theme.bgTertiary}]}>
                  <Text style={[styles.confirmLabelText, {color: theme.accent}]}>
                    Word #{idx + 1}
                  </Text>
                </View>
                <View
                  style={[
                    styles.inputWrapper,
                    {
                      backgroundColor: theme.bgSecondary,
                      borderColor: theme.border,
                      flex: 1,
                      marginLeft: 10,
                    },
                  ]}>
                  <TextInput
                    style={[styles.input, {color: theme.text}]}
                    placeholder="Enter word..."
                    placeholderTextColor={theme.textMuted}
                    value={confirmWords[idx] || ''}
                    onChangeText={text =>
                      setConfirmWords(prev => ({...prev, [idx]: text}))
                    }
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              </View>
            ))}
            <TouchableOpacity
              style={[styles.primaryBtn, {backgroundColor: theme.accent, marginTop: 20}]}
              onPress={handleWordConfirm}>
              <Text style={[styles.primaryBtnText, {color: theme.bg}]}>
                Verify & Continue
              </Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {step === STEPS.BIOMETRIC && (
          <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
            <Text style={[styles.stepTitle, {color: theme.text}]}>
              Biometric Unlock
            </Text>
            <Text style={[styles.stepDesc, {color: theme.textSecondary}]}>
              Enable fingerprint or face unlock for quick access to GhostLink.
            </Text>
            <View
              style={[
                styles.biometricToggle,
                {backgroundColor: theme.bgSecondary, borderColor: theme.border},
              ]}>
              <View>
                <Text style={[styles.biometricTitle, {color: theme.text}]}>
                  Enable Biometric Lock
                </Text>
                <Text style={[styles.biometricSub, {color: theme.textSecondary}]}>
                  Require biometric auth to open the app
                </Text>
              </View>
              <Switch
                value={biometricEnabled}
                onValueChange={setBiometricEnabled}
                trackColor={{false: theme.bgTertiary, true: theme.accent + '50'}}
                thumbColor={biometricEnabled ? theme.accent : theme.textMuted}
              />
            </View>
            <TouchableOpacity
              style={[styles.primaryBtn, {backgroundColor: theme.accent}]}
              onPress={() => finishSetup(biometricEnabled)}>
              <Text style={[styles.primaryBtnText, {color: theme.bg}]}>
                Enter GhostLink
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
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 60,
    paddingBottom: 40,
  },
  logoContainer: {
    alignItems: 'center',
    marginBottom: 40,
  },
  ghostIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  ghostEmoji: {
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: 1,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  subtitle: {
    fontSize: 13,
    letterSpacing: 2,
    marginTop: 4,
    textTransform: 'uppercase',
  },
  stepContainer: {
    flex: 1,
  },
  stepTitle: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
  },
  stepDesc: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 24,
  },
  inputWrapper: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  input: {
    fontSize: 16,
    paddingVertical: 14,
    fontWeight: '500',
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
    letterSpacing: 0.5,
  },
  seedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  seedWord: {
    width: '31%',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  seedIndex: {
    fontSize: 11,
    fontWeight: '700',
    marginRight: 6,
    width: 18,
  },
  seedText: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  warningBox: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
  },
  warningText: {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '500',
  },
  confirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  confirmLabel: {
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderRadius: 10,
  },
  confirmLabelText: {
    fontSize: 13,
    fontWeight: '700',
  },
  biometricToggle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
  },
  biometricTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  biometricSub: {
    fontSize: 12,
    marginTop: 2,
  },
});
