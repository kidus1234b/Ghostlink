import React, {useState, useCallback, useEffect, useRef} from 'react';
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
  Platform,
} from 'react-native';
import Animated, {
  FadeInDown,
  FadeInUp,
  FadeOutLeft,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withRepeat,
  withSequence,
  withTiming,
  SlideInRight,
  SlideOutLeft,
} from 'react-native-reanimated';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import {CryptoEngine, ShamirSSS, generateBackupFragments} from '../utils/crypto';

// ==================== BIP39 512-WORD LIST ====================
// Same word list used by the GhostLink web app (index.html)
const BIP39_WORDS = [
  "abandon","ability","able","above","absent","absorb","abuse","access",
  "account","achieve","acid","across","action","actor","adapt","address",
  "admit","adult","advance","advice","afford","afraid","again","agent",
  "agree","aim","airport","alarm","album","alert","alien","alley",
  "allow","almost","alone","already","alter","amateur","amazing","anchor",
  "ancient","anger","angle","animal","annual","antenna","anxiety","appear",
  "approve","arch","arctic","area","argue","armor","army","arrest",
  "arrive","artist","aspect","assault","assist","athlete","attach","attend",
  "attract","audit","author","autumn","aware","awesome","axis","balance",
  "bamboo","banner","barely","barrel","battle","beauty","become","benefit",
  "betray","bicycle","biology","birth","bitter","blade","blame","blast",
  "bless","blind","blossom","boost","border","bounce","bracket","brave",
  "bridge","brief","bright","brisk","broken","brother","bubble","bullet",
  "bundle","burden","burst","business","butter","cable","cactus","canvas",
  "capable","captain","carbon","cargo","carry","castle","casual","catalog",
  "cause","caution","cement","century","cereal","champion","chapter","charge",
  "chase","cheap","chest","chief","child","choice","circuit","citizen",
  "civil","claim","clever","client","climb","clinic","clog","cloth",
  "cloud","cluster","clutch","coast","coconut","combine","comfort","company",
  "confirm","congress","connect","consider","control","convince","copper","coral",
  "correct","cotton","country","couple","cousin","cover","crack","cradle",
  "craft","crane","crash","cream","cricket","crime","crisp","cross",
  "crucial","crystal","culture","curious","current","custom","cycle","damage",
  "danger","daring","daughter","decade","decline","define","delay","deliver",
  "demand","dental","derive","describe","design","detect","develop","device",
  "diagram","diamond","digital","dilemma","discover","display","domain","donate",
  "double","dragon","drama","draw","dream","dress","drift","drive",
  "dynamic","eagle","economy","effort","eight","electric","element","elite",
  "emerge","emotion","employ","enable","endorse","energy","enforce","engage",
  "engine","enjoy","enough","enrich","enter","equal","equip","escape",
  "estate","ethics","evidence","evolve","exact","excess","excite","exercise",
  "exhaust","exist","expand","explain","expose","extend","fabric","faculty",
  "faith","famous","fantasy","fashion","feature","festival","fiction","figure",
  "filter","fiscal","fitness","flame","flavor","flight","float","flower",
  "fluid","focus","forest","fortune","fossil","frame","frequent","fresh",
  "future","galaxy","gallery","garlic","gather","genius","genuine","ghost",
  "giant","ginger","giraffe","global","gospel","govern","grace","grain",
  "grape","gravity","great","guard","guide","guitar","habit","harvest",
  "hazard","health","heavy","height","hidden","history","hobby","hockey",
  "holiday","honey","hospital","hover","humble","humor","hybrid","icon",
  "ignore","illegal","image","immune","impact","improve","impulse","income",
  "indoor","industry","infant","innocent","inquiry","inspire","install","intact",
  "invest","invite","island","isolate","jacket","jaguar","jealous","journey",
  "jungle","kangaroo","kingdom","kitchen","knowledge","language","laptop","laundry",
  "lawsuit","leader","lecture","legend","liberty","license","liquid","lottery",
  "luggage","luxury","magic","magnet","marble","margin","marine","master",
  "matrix","meadow","melody","memory","mentor","mercy","middle","midnight",
  "miracle","mitten","monitor","monkey","moral","morning","mountain","museum",
  "mystery","nature","network","neutral","noble","nominee","nuclear","object",
  "obtain","ocean","olympic","onion","orbit","orchard","order","organ",
  "orphan","ostrich","output","oxygen","paddle","palace","panic","patrol",
  "payment","peasant","pelican","penalty","perfect","permit","phrase","physical",
  "pioneer","pistol","planet","plastic","pledge","polar","popular","portrait",
  "pottery","poverty","predict","preserve","primary","priority","prison","produce",
  "profit","program","promote","property","protect","provide","pudding","quantum",
  "question","rabbit","raccoon","radar","rainbow","rally","random","rebel",
  "rebuild","recall","recipe","reduce","reform","region","regular","release",
  "remain","remind","rescue","resist","resource","result","retire","reunion",
  "reveal","reward","rhythm","ribbon","ritual","robust","romance","rookie",
  "rotate","satellite","satisfy","scatter","science","scorpion","screen","second",
  "section","security","segment","seminar","separate","shadow","sheriff","shield",
  "signal","silent","similar","simple","siren","social","solar","soldier",
  "solution","someone","source","space","spatial","spawn","special","sphere",
  "spirit","sponsor","stable","stadium","stairs","strategy","street","struggle",
  "student","style","submit","subway","surface","surprise","sustain","symbol",
  "symptom","tackle","talent","target","texture","theory","thunder","timber",
  "tissue","token","tornado","tourist","traffic","tragic","transfer","trigger",
  "trophy","trumpet","tunnel","unique","universe","unlock","unusual","upgrade",
  "uphold","urban","utility","vacant","valley","vendor","venture","verify",
  "vibrant","victory","vintage","virtual","vital","vivid","volcano","voyage",
  "walnut","warfare","warrior","wealth","weapon","wedding","whisper","wildlife",
  "wisdom","witness","wonder","wrist","yellow","zebra","zero",
];

// ==================== STEP DEFINITIONS ====================
const STEPS = {
  NAME: 0,
  SEED: 1,
  CONFIRM: 2,
};

// Verification word positions (0-indexed): words 3, 7, 11
const VERIFY_INDICES = [2, 6, 10];

function generateSeedPhrase() {
  const words = [];
  for (let i = 0; i < 12; i++) {
    const idx = Math.floor(Math.random() * BIP39_WORDS.length);
    words.push(BIP39_WORDS[idx]);
  }
  return words;
}

export default function SetupScreen({navigation}) {
  const {theme} = useTheme();
  const {dispatch} = useApp();
  const [step, setStep] = useState(STEPS.NAME);
  const [displayName, setDisplayName] = useState('');
  const [seedPhrase, setSeedPhrase] = useState([]);
  const [confirmWords, setConfirmWords] = useState({2: '', 6: '', 10: ''});
  const [loading, setLoading] = useState(false);
  const [generatingFragments, setGeneratingFragments] = useState(false);

  // Refs for confirm inputs
  const confirmRef7 = useRef(null);
  const confirmRef11 = useRef(null);

  // Ghost icon pulse animation
  const ghostPulse = useSharedValue(1);

  useEffect(() => {
    ghostPulse.value = withRepeat(
      withSequence(
        withTiming(1.08, {duration: 1800}),
        withTiming(1, {duration: 1800}),
      ),
      -1,
      true,
    );
  }, [ghostPulse]);

  const ghostStyle = useAnimatedStyle(() => ({
    transform: [{scale: ghostPulse.value}],
  }));

  // Step 1: Handle name submission — generate seed phrase
  const handleNameSubmit = useCallback(() => {
    const name = displayName.trim();
    if (!name) {
      Alert.alert('Name Required', 'Enter a display name to continue.');
      return;
    }
    if (name.length < 2) {
      Alert.alert('Too Short', 'Display name must be at least 2 characters.');
      return;
    }
    Vibration.vibrate(20);
    const seed = generateSeedPhrase();
    setSeedPhrase(seed);
    setStep(STEPS.SEED);
  }, [displayName]);

  // Step 2: "I've written it down" — move to verify
  const handleSeedWrittenDown = useCallback(() => {
    Vibration.vibrate(20);
    setConfirmWords({2: '', 6: '', 10: ''});
    setStep(STEPS.CONFIRM);
  }, []);

  // Step 3: Verify words 3, 7, 11 then generate keys, wrap, Shamir, store
  const handleVerifyAndFinish = useCallback(async () => {
    // Check the three verification words
    for (const idx of VERIFY_INDICES) {
      const entered = (confirmWords[idx] || '').toLowerCase().trim();
      const expected = seedPhrase[idx];
      if (entered !== expected) {
        Alert.alert(
          'Verification Failed',
          `Word #${idx + 1} does not match. Check your seed phrase backup and try again.`,
        );
        return;
      }
    }

    Vibration.vibrate(30);
    setLoading(true);
    setGeneratingFragments(true);

    try {
      // 1. Generate ECDH P-256 keypair
      const keyPair = CryptoEngine.generateKeyPair();
      const fingerprint = await CryptoEngine.sha256(keyPair.publicKeyHex);

      // 2. PBKDF2 key derivation from seed phrase
      const derivedKeyHex = await CryptoEngine.deriveKeyFromSeed(seedPhrase);

      // 3. Wrap private key using derived key (AES-GCM envelope)
      const wrappedPrivKey = CryptoEngine.encrypt(keyPair.privateKeyRaw, derivedKeyHex);

      // 4. Store keypair securely in Keychain
      await CryptoEngine.storeKeyPair(keyPair.publicKeyHex, keyPair.privateKeyRaw);

      // 5. Generate Shamir fragments (7 shares, threshold 3) for the wrapped key
      const wrappedBlob = JSON.stringify({
        wrappedKey: wrappedPrivKey,
        publicKeyHex: keyPair.publicKeyHex,
        displayName: displayName.trim(),
      });
      const fragments = generateBackupFragments(wrappedBlob);

      // 6. Store fragments and identity data in AsyncStorage
      await AsyncStorage.setItem('gl_shamir_fragments', JSON.stringify(fragments));
      await AsyncStorage.setItem('gl_wrapped_privkey', JSON.stringify(wrappedPrivKey));
      await AsyncStorage.setItem('gl_seed_check', await CryptoEngine.sha256(seedPhrase.join(' ')));

      // 7. Generate invite code
      const inviteCode = CryptoEngine.genInvite();

      // 8. Update app context
      const identity = {
        publicKeyHex: keyPair.publicKeyHex,
        fingerprint: fingerprint.slice(0, 16),
        name: displayName.trim(),
      };

      dispatch({type: 'SET_IDENTITY', payload: identity});
      dispatch({type: 'SET_SEED_PHRASE', payload: seedPhrase});
      dispatch({type: 'SET_DISPLAY_NAME', payload: displayName.trim()});
      dispatch({type: 'SET_INVITE_CODE', payload: inviteCode});
      dispatch({type: 'COMPLETE_SETUP'});

      Vibration.vibrate(40);

      // Navigate to main screen
      navigation.reset({
        index: 0,
        routes: [{name: 'Main'}],
      });
    } catch (e) {
      Alert.alert('Setup Error', 'Failed to generate identity. Please try again.\n\n' + (e.message || ''));
    } finally {
      setLoading(false);
      setGeneratingFragments(false);
    }
  }, [confirmWords, seedPhrase, displayName, dispatch, navigation]);

  // ==================== RENDER ====================
  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>

        {/* Ghost Icon Header */}
        <Animated.View style={[styles.logoContainer, ghostStyle]}>
          <View style={[styles.ghostIcon, {borderColor: theme.accent + '40', backgroundColor: theme.accent + '08'}]}>
            <Text style={[styles.ghostGlyph, {color: theme.accent}]}>G</Text>
          </View>
          <Text style={[styles.title, {color: theme.text}]}>GhostLink</Text>
          <Text style={[styles.subtitle, {color: theme.textSecondary}]}>
            Zero Trust. Zero Trace.
          </Text>
        </Animated.View>

        {/* Step indicator */}
        <View style={styles.stepIndicator}>
          {[0, 1, 2].map(i => (
            <View key={i} style={styles.stepDotRow}>
              <View
                style={[
                  styles.stepDot,
                  {
                    backgroundColor: step >= i ? theme.accent : theme.bgTertiary,
                    borderColor: step >= i ? theme.accent : theme.border,
                  },
                ]}
              />
              {i < 2 && (
                <View
                  style={[
                    styles.stepLine,
                    {backgroundColor: step > i ? theme.accent : theme.bgTertiary},
                  ]}
                />
              )}
            </View>
          ))}
        </View>

        {/* ==================== STEP 1: DISPLAY NAME ==================== */}
        {step === STEPS.NAME && (
          <Animated.View entering={SlideInRight.duration(350)} exiting={SlideOutLeft.duration(250)} style={styles.stepContainer}>
            <Text style={[styles.stepTitle, {color: theme.text}]}>
              Choose Your Identity
            </Text>
            <Text style={[styles.stepDesc, {color: theme.textSecondary}]}>
              This name is visible to peers in your encrypted conversations. It cannot be changed later without re-keying.
            </Text>

            <View
              style={[
                styles.inputWrapper,
                {backgroundColor: theme.bgSecondary, borderColor: theme.border},
              ]}>
              <Text style={[styles.inputIcon, {color: theme.textMuted}]}>@</Text>
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
                autoCapitalize="none"
                autoCorrect={false}
              />
              {displayName.length > 0 && (
                <Text style={[styles.charCount, {color: theme.textMuted}]}>
                  {displayName.length}/24
                </Text>
              )}
            </View>

            <TouchableOpacity
              style={[
                styles.primaryBtn,
                {backgroundColor: theme.accent},
                !displayName.trim() && {opacity: 0.4},
              ]}
              onPress={handleNameSubmit}
              disabled={!displayName.trim()}
              activeOpacity={0.7}>
              <Text style={[styles.primaryBtnText, {color: theme.bg}]}>
                Generate Identity
              </Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* ==================== STEP 2: SEED PHRASE ==================== */}
        {step === STEPS.SEED && (
          <Animated.View entering={SlideInRight.duration(350)} exiting={SlideOutLeft.duration(250)} style={styles.stepContainer}>
            <Text style={[styles.stepTitle, {color: theme.text}]}>
              Your Recovery Seed
            </Text>
            <Text style={[styles.stepDesc, {color: theme.textSecondary}]}>
              Write down these 12 words in order. They are your only way to recover your identity.
            </Text>

            {/* 3x4 Seed Grid */}
            <View style={styles.seedGrid}>
              {seedPhrase.map((word, idx) => (
                <Animated.View
                  key={idx}
                  entering={FadeInUp.delay(idx * 60).duration(300)}
                  style={[
                    styles.seedWord,
                    {backgroundColor: theme.bgTertiary, borderColor: theme.border},
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

            {/* Warning Banner */}
            <Animated.View
              entering={FadeInDown.delay(700).duration(400)}
              style={[
                styles.warningBox,
                {backgroundColor: theme.warning + '12', borderColor: theme.warning + '30'},
              ]}>
              <Text style={[styles.warningIcon]}>!</Text>
              <View style={styles.warningContent}>
                <Text style={[styles.warningTitle, {color: theme.warning}]}>
                  Write these down. Never share digitally.
                </Text>
                <Text style={[styles.warningText, {color: theme.warning + 'CC'}]}>
                  Store these words on paper in a secure location. Anyone with these words controls your identity. Screenshots and digital copies are vulnerable.
                </Text>
              </View>
            </Animated.View>

            <TouchableOpacity
              style={[styles.primaryBtn, {backgroundColor: theme.accent}]}
              onPress={handleSeedWrittenDown}
              activeOpacity={0.7}>
              <Text style={[styles.primaryBtnText, {color: theme.bg}]}>
                I've Written It Down
              </Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* ==================== STEP 3: VERIFY WORDS 3, 7, 11 ==================== */}
        {step === STEPS.CONFIRM && (
          <Animated.View entering={SlideInRight.duration(350)} style={styles.stepContainer}>
            <Text style={[styles.stepTitle, {color: theme.text}]}>
              Verify Your Backup
            </Text>
            <Text style={[styles.stepDesc, {color: theme.textSecondary}]}>
              Enter words #3, #7, and #11 from your seed phrase to confirm you saved it correctly.
            </Text>

            {/* Word #3 */}
            <View style={styles.confirmRow}>
              <View style={[styles.confirmLabel, {backgroundColor: theme.accent + '18'}]}>
                <Text style={[styles.confirmLabelText, {color: theme.accent}]}>
                  Word #3
                </Text>
              </View>
              <View
                style={[
                  styles.confirmInputWrap,
                  {backgroundColor: theme.bgSecondary, borderColor: theme.border},
                ]}>
                <TextInput
                  style={[styles.confirmInput, {color: theme.text}]}
                  placeholder="Enter word #3..."
                  placeholderTextColor={theme.textMuted}
                  value={confirmWords[2]}
                  onChangeText={text => setConfirmWords(prev => ({...prev, 2: text}))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                  onSubmitEditing={() => confirmRef7.current?.focus()}
                  autoFocus
                />
              </View>
            </View>

            {/* Word #7 */}
            <View style={styles.confirmRow}>
              <View style={[styles.confirmLabel, {backgroundColor: theme.accent + '18'}]}>
                <Text style={[styles.confirmLabelText, {color: theme.accent}]}>
                  Word #7
                </Text>
              </View>
              <View
                style={[
                  styles.confirmInputWrap,
                  {backgroundColor: theme.bgSecondary, borderColor: theme.border},
                ]}>
                <TextInput
                  ref={confirmRef7}
                  style={[styles.confirmInput, {color: theme.text}]}
                  placeholder="Enter word #7..."
                  placeholderTextColor={theme.textMuted}
                  value={confirmWords[6]}
                  onChangeText={text => setConfirmWords(prev => ({...prev, 6: text}))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                  onSubmitEditing={() => confirmRef11.current?.focus()}
                />
              </View>
            </View>

            {/* Word #11 */}
            <View style={styles.confirmRow}>
              <View style={[styles.confirmLabel, {backgroundColor: theme.accent + '18'}]}>
                <Text style={[styles.confirmLabelText, {color: theme.accent}]}>
                  Word #11
                </Text>
              </View>
              <View
                style={[
                  styles.confirmInputWrap,
                  {backgroundColor: theme.bgSecondary, borderColor: theme.border},
                ]}>
                <TextInput
                  ref={confirmRef11}
                  style={[styles.confirmInput, {color: theme.text}]}
                  placeholder="Enter word #11..."
                  placeholderTextColor={theme.textMuted}
                  value={confirmWords[10]}
                  onChangeText={text => setConfirmWords(prev => ({...prev, 10: text}))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={handleVerifyAndFinish}
                />
              </View>
            </View>

            {/* Progress info while generating */}
            {generatingFragments && (
              <Animated.View
                entering={FadeInDown.duration(300)}
                style={[styles.progressBox, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                <Text style={[styles.progressText, {color: theme.textSecondary}]}>
                  Generating ECDH P-256 keypair...
                </Text>
                <Text style={[styles.progressText, {color: theme.textSecondary}]}>
                  Deriving PBKDF2 wrapping key from seed...
                </Text>
                <Text style={[styles.progressText, {color: theme.textSecondary}]}>
                  Splitting into 7 Shamir fragments (threshold 3)...
                </Text>
              </Animated.View>
            )}

            <TouchableOpacity
              style={[
                styles.primaryBtn,
                {backgroundColor: theme.accent},
                loading && {opacity: 0.6},
              ]}
              onPress={handleVerifyAndFinish}
              disabled={loading}
              activeOpacity={0.7}>
              <Text style={[styles.primaryBtnText, {color: theme.bg}]}>
                {loading ? 'Generating Keys & Fragments...' : 'Verify & Create Identity'}
              </Text>
            </TouchableOpacity>

            {/* Back to seed link */}
            {!loading && (
              <TouchableOpacity
                style={styles.backLink}
                onPress={() => setStep(STEPS.SEED)}
                activeOpacity={0.6}>
                <Text style={[styles.backLinkText, {color: theme.textSecondary}]}>
                  Show seed phrase again
                </Text>
              </TouchableOpacity>
            )}
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}

// ==================== STYLES ====================
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
    marginBottom: 24,
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
  ghostGlyph: {
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

  // Step indicator
  stepIndicator: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 30,
  },
  stepDotRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
  },
  stepLine: {
    width: 40,
    height: 2,
    marginHorizontal: 4,
    borderRadius: 1,
  },

  // Step content
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

  // Name input
  inputWrapper: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputIcon: {
    fontSize: 18,
    fontWeight: '600',
    marginRight: 8,
  },
  input: {
    fontSize: 16,
    paddingVertical: 14,
    fontWeight: '500',
    flex: 1,
  },
  charCount: {
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 8,
  },

  // Primary button
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

  // Seed grid (3 columns x 4 rows)
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
    textAlign: 'right',
  },
  seedText: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },

  // Warning banner
  warningBox: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  warningIcon: {
    fontSize: 18,
    fontWeight: '900',
    color: '#ffaa00',
    marginRight: 10,
    marginTop: 1,
    width: 20,
    textAlign: 'center',
  },
  warningContent: {
    flex: 1,
  },
  warningTitle: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  warningText: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '500',
  },

  // Confirm step
  confirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  confirmLabel: {
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderRadius: 10,
    minWidth: 80,
    alignItems: 'center',
  },
  confirmLabelText: {
    fontSize: 13,
    fontWeight: '700',
  },
  confirmInputWrap: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    marginLeft: 10,
  },
  confirmInput: {
    fontSize: 15,
    paddingVertical: 13,
    fontWeight: '500',
  },

  // Progress indicator
  progressBox: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginTop: 12,
    marginBottom: 4,
  },
  progressText: {
    fontSize: 12,
    lineHeight: 20,
    fontWeight: '500',
  },

  // Back link
  backLink: {
    alignItems: 'center',
    marginTop: 16,
    paddingVertical: 8,
  },
  backLinkText: {
    fontSize: 13,
    fontWeight: '500',
    textDecorationLine: 'underline',
  },
});
