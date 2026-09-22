/**
 * GhostLink Mobile — Restore an identity from its recovery phrase.
 *
 * Until this existed the phrase could not be entered anywhere: a user who
 * reinstalled or changed phones had written down twelve words that nothing
 * would accept.
 *
 * WHAT COMES BACK, AND WHAT DOES NOT
 *
 * The phrase derives the identity — the Ghost Address and, for identities
 * created from this version onward, the messaging keypair — so contacts
 * recognise you. It does not bring back messages, files, contacts or settings:
 * those lived on the other device and there is no server holding a copy. The
 * screen says so before the user commits, rather than leaving them to discover
 * an empty app.
 *
 * ON VERIFICATION
 *
 * The wordlist is a curated 575-word list, not BIP-39, and carries no
 * checksum — so a phrase cannot be proved correct before deriving from it. A
 * typo that happens to land on another valid word simply produces a different
 * identity, silently. What stands in for a checksum is showing the resulting
 * Ghost Address and asking the user to confirm it is the one they expect. That
 * is also why a wrong phrase reveals nothing about whether an identity
 * "exists": every phrase derives something.
 */

import React, {useCallback, useMemo, useRef, useState} from 'react';
import {
  View,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Vibration,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import {Text, TextInput} from '../components/ScaledText';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import {CryptoEngine} from '../utils/crypto';
import {SEED_PHRASE_WORDS} from '../utils/wordlist';
import {splitPhrase, validatePhrase, suggestWords} from '../utils/phrase-entry';
import {useSecureScreen} from '../utils/useSecureScreen';

export default function RestoreIdentityScreen({navigation}) {
  const {theme, scale} = useTheme();
  const {setIdentity} = useApp();

  // Blocks screenshots and the recents thumbnail while a phrase is on screen.
  useSecureScreen();

  const [words, setWords] = useState(() => Array(SEED_PHRASE_WORDS).fill(''));
  const [focused, setFocused] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const inputs = useRef([]);

  const validation = useMemo(() => validatePhrase(words), [words]);
  const suggestions = useMemo(
    () => (focused >= 0 ? suggestWords(words[focused]) : []),
    [focused, words],
  );

  const setWord = useCallback((index, value) => {
    setWords(prev => {
      // A paste into any box fills the whole phrase — people paste the lot.
      const parts = splitPhrase(value);
      if (parts.length >= SEED_PHRASE_WORDS) {
        return parts.slice(0, SEED_PHRASE_WORDS);
      }
      const next = [...prev];
      next[index] = value.toLowerCase().replace(/[^a-z]/g, '');
      return next;
    });
  }, []);

  const acceptSuggestion = useCallback(
    word => {
      if (focused < 0) return;
      setWords(prev => {
        const next = [...prev];
        next[focused] = word;
        return next;
      });
      if (focused < SEED_PHRASE_WORDS - 1) inputs.current[focused + 1]?.focus();
    },
    [focused],
  );

  /** Derive and show the address, so the user can confirm before committing. */
  const handleDerive = useCallback(async () => {
    if (!validation.ok || busy) return;
    Vibration.vibrate(15);
    setBusy(true);
    try {
      const phrase = words.map(w => w.trim().toLowerCase());
      const [ghost, keyPair] = await Promise.all([
        CryptoEngine.deriveGhostIdentity(phrase),
        CryptoEngine.deriveIdentityKeyPair(phrase),
      ]);
      const fingerprint = await CryptoEngine.sha256(keyPair.publicKeyHex);
      setPreview({ghost, keyPair, fingerprint: fingerprint.slice(0, 16)});
    } catch (err) {
      Alert.alert(
        'Could not derive an identity',
        'Something went wrong working out your identity from those words. ' +
          'Check them and try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [busy, validation.ok, words]);

  /** Commit: store the key and set the identity. */
  const handleConfirm = useCallback(async () => {
    if (!preview || busy) return;
    setBusy(true);
    try {
      await CryptoEngine.storeKeyPair(preview.keyPair.publicKeyHex, preview.keyPair.privateKeyRaw);
      setIdentity({
        publicKeyHex: preview.keyPair.publicKeyHex,
        fingerprint: preview.fingerprint,
        name: displayName.trim() || 'You',
        ghostAddress: preview.ghost.ghostAddress,
        meshNodeId: preview.ghost.nodeIdHex,
        keyDerivation: 'phrase-v1',
      });
      // Deliberately not cleared to a new array: overwrite in place so the
      // words do not linger in a detached object waiting on the collector.
      setWords(prev => prev.map(() => ''));
      setPreview(null);
    } catch (err) {
      Alert.alert(
        "Couldn't finish restoring",
        'Your identity could not be saved to this device. Nothing has been changed — please try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [busy, displayName, preview, setIdentity]);

  const s = styles(theme, scale);

  if (preview) {
    return (
      <ScrollView style={s.screen} contentContainerStyle={s.content}>
        <Text style={s.title}>Is this your identity?</Text>
        <Text style={s.body}>
          These words produce the address below. Check it against your other device
          before continuing — if it doesn't match, one of the words is wrong.
        </Text>

        <View style={s.addressCard} accessibilityRole="text">
          <Text style={s.addressLabel}>GHOST ADDRESS</Text>
          <Text style={s.address} selectable>
            {preview.ghost.ghostAddress}
          </Text>
          <Text style={s.addressLabel}>FINGERPRINT</Text>
          <Text style={s.fingerprint} selectable>
            {preview.fingerprint}
          </Text>
        </View>

        <View style={s.noticeCard}>
          <Text style={s.noticeTitle}>What comes back</Text>
          <Text style={s.noticeBody}>
            Your identity — the same address and keys, so your contacts recognise you.
          </Text>
          <Text style={s.noticeTitle}>What doesn't</Text>
          <Text style={s.noticeBody}>
            Past messages, files and contacts stay on your old device. GhostLink never
            stores copies of them anywhere.
          </Text>
        </View>

        <TextInput
          style={s.nameInput}
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="Display name (optional)"
          placeholderTextColor={theme.textMuted}
          maxLength={24}
          autoCorrect={false}
          accessibilityLabel="Display name"
        />

        <TouchableOpacity
          style={[s.primaryBtn, busy && s.btnDisabled]}
          onPress={handleConfirm}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Yes, restore this identity">
          {busy ? (
            <ActivityIndicator color={theme.bg} />
          ) : (
            <Text style={s.primaryBtnText}>Yes, this is mine</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={s.secondaryBtn}
          onPress={() => setPreview(null)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Go back and check the words">
          <Text style={s.secondaryBtnText}>Let me check the words</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={s.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>Enter your recovery phrase</Text>
        <Text style={s.body}>
          The {SEED_PHRASE_WORDS} words you wrote down, in order. You can paste the whole
          phrase into any box.
        </Text>

        <View style={s.grid}>
          {words.map((word, i) => {
            const isUnknown = validation.unknown.includes(i);
            return (
              <View key={i} style={s.cell}>
                <Text style={s.cellIndex}>{i + 1}</Text>
                <TextInput
                  ref={el => (inputs.current[i] = el)}
                  style={[s.cellInput, isUnknown && s.cellInputBad]}
                  value={word}
                  onChangeText={v => setWord(i, v)}
                  onFocus={() => setFocused(i)}
                  onSubmitEditing={() => inputs.current[i + 1]?.focus()}
                  returnKeyType={i === SEED_PHRASE_WORDS - 1 ? 'done' : 'next'}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="none"
                  importantForAutofill="no"
                  spellCheck={false}
                  keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
                  accessibilityLabel={`Word ${i + 1}${isUnknown ? ', not in the wordlist' : ''}`}
                />
              </View>
            );
          })}
        </View>

        {suggestions.length > 0 ? (
          <View style={s.suggestRow}>
            {suggestions.map(w => (
              <TouchableOpacity
                key={w}
                style={s.suggestChip}
                onPress={() => acceptSuggestion(w)}
                accessibilityRole="button"
                accessibilityLabel={`Use the word ${w}`}>
                <Text style={s.suggestText}>{w}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {validation.unknown.length > 0 ? (
          <Text style={s.error}>
            {validation.unknown.length === 1
              ? `Word ${validation.unknown[0] + 1} isn't in the list.`
              : `Words ${validation.unknown.map(i => i + 1).join(', ')} aren't in the list.`}
          </Text>
        ) : validation.missing > 0 ? (
          <Text style={s.hint}>
            {validation.missing} more {validation.missing === 1 ? 'word' : 'words'} to go.
          </Text>
        ) : null}

        <TouchableOpacity
          style={[s.primaryBtn, (!validation.ok || busy) && s.btnDisabled]}
          onPress={handleDerive}
          disabled={!validation.ok || busy}
          accessibilityRole="button"
          accessibilityState={{disabled: !validation.ok || busy}}
          accessibilityLabel="Continue and show the identity these words produce">
          {busy ? <ActivityIndicator color={theme.bg} /> : <Text style={s.primaryBtnText}>Continue</Text>}
        </TouchableOpacity>

        <TouchableOpacity
          style={s.secondaryBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Go back">
          <Text style={s.secondaryBtnText}>Back</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = (theme, scale) =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: theme.bg},
    content: {padding: 20, paddingBottom: 48},
    title: {color: theme.text, fontSize: 22, fontWeight: '700', marginBottom: 8},
    body: {color: theme.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 20},
    grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
    cell: {width: '31%', flexDirection: 'row', alignItems: 'center'},
    cellIndex: {color: theme.textMuted, fontSize: 11, width: 18},
    cellInput: {
      flex: 1,
      minHeight: 48,
      backgroundColor: theme.bgTertiary,
      borderColor: theme.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 8,
      color: theme.text,
      fontSize: 14,
    },
    cellInputBad: {borderColor: theme.danger},
    suggestRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12},
    suggestChip: {
      minHeight: 40,
      justifyContent: 'center',
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: theme.bgTertiary,
      borderWidth: 1,
      borderColor: theme.border,
    },
    suggestText: {color: theme.accent, fontSize: 14},
    error: {color: theme.danger, fontSize: 13, marginTop: 14},
    hint: {color: theme.textMuted, fontSize: 13, marginTop: 14},
    primaryBtn: {
      marginTop: 24,
      minHeight: 52,
      borderRadius: 12,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryBtnText: {color: theme.bg, fontSize: 16, fontWeight: '700'},
    btnDisabled: {opacity: 0.4},
    secondaryBtn: {marginTop: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center'},
    secondaryBtnText: {color: theme.textSecondary, fontSize: 14},
    addressCard: {
      backgroundColor: theme.bgSecondary,
      borderColor: theme.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
    },
    addressLabel: {color: theme.textMuted, fontSize: 10, letterSpacing: 1, marginBottom: 4},
    address: {color: theme.accent, fontSize: 20, fontWeight: '700', marginBottom: 14},
    fingerprint: {color: theme.textSecondary, fontSize: 13, fontFamily: 'monospace'},
    noticeCard: {
      backgroundColor: theme.bgSecondary,
      borderColor: theme.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
    },
    noticeTitle: {color: theme.text, fontSize: 13, fontWeight: '700', marginBottom: 4},
    noticeBody: {color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: 12},
    nameInput: {
      minHeight: 48,
      backgroundColor: theme.bgTertiary,
      borderColor: theme.border,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      color: theme.text,
      fontSize: 15,
    },
  });
