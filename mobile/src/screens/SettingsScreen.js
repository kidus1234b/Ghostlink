import React, {useState, useCallback} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Switch,
  Alert,
  Vibration,
  Clipboard,
  Platform,
} from 'react-native';
import Slider from '@react-native-community/slider';
import {useTheme, THEMES} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';

const SECURITY_INFO = [
  {label: 'Encryption Level', value: 'AES-256-GCM'},
  {label: 'Connection Type', value: 'P2P Direct'},
  {label: 'Key Exchange', value: 'ECDH P-256'},
  {label: 'Hash Algorithm', value: 'SHA-256'},
];

export default function SettingsScreen({navigation}) {
  const {theme, themeName, setThemeName} = useTheme();
  const {identity, settings, messages, updateSettings, wipeAll} = useApp();
  const [pubKeyCopied, setPubKeyCopied] = useState(false);

  // ── Handlers ──

  const handleThemeChange = useCallback(
    (name) => {
      Vibration.vibrate(15);
      setThemeName(name);
      updateSettings({theme: name});
    },
    [setThemeName, updateSettings],
  );

  const handleToggle = useCallback(
    (key, value) => {
      Vibration.vibrate(10);
      updateSettings({[key]: value});
    },
    [updateSettings],
  );

  const handleFontSizeChange = useCallback(
    (value) => {
      updateSettings({fontSize: Math.round(value)});
    },
    [updateSettings],
  );

  const handleCopyPublicKey = useCallback(() => {
    if (identity?.publicKeyHex) {
      Clipboard.setString(identity.publicKeyHex);
      setPubKeyCopied(true);
      Vibration.vibrate(15);
      setTimeout(() => setPubKeyCopied(false), 2000);
    }
  }, [identity]);

  const handleExport = useCallback(() => {
    Vibration.vibrate(20);
    const allMessages = {};
    if (messages && typeof messages.forEach === 'function') {
      messages.forEach((msgs, roomId) => {
        allMessages[roomId] = msgs;
      });
    }
    const exportData = {
      displayName: identity?.name || 'Unknown',
      messages: allMessages,
      exportedAt: new Date().toISOString(),
    };
    Clipboard.setString(JSON.stringify(exportData));
    Alert.alert('Exported', 'Chat history copied to clipboard.');
  }, [identity, messages]);

  const handleWipeAll = useCallback(() => {
    Alert.alert(
      'Wipe All Data',
      'This will permanently delete all messages, keys, and identity. This action cannot be undone.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Wipe Everything',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Are you absolutely sure?',
              'Last chance. All data will be permanently destroyed.',
              [
                {text: 'Cancel', style: 'cancel'},
                {
                  text: 'Confirm Wipe',
                  style: 'destructive',
                  onPress: async () => {
                    Vibration.vibrate([0, 100, 50, 100, 50, 200]);
                    await wipeAll();
                    navigation.reset({
                      index: 0,
                      routes: [{name: 'Setup'}],
                    });
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }, [wipeAll, navigation]);

  // ── Derived values ──

  const displayName = identity?.name || 'Anonymous';

  const truncatedFingerprint = identity?.fingerprint
    ? identity.fingerprint.length > 16
      ? identity.fingerprint.slice(0, 16) + '\u2026'
      : identity.fingerprint
    : 'N/A';

  const truncatedPubKey = identity?.publicKeyHex
    ? identity.publicKeyHex.slice(0, 24) + '\u2026' + identity.publicKeyHex.slice(-8)
    : 'N/A';

  const fontSize = settings.fontSize || 14;

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
        <Text style={[styles.headerTitle, {color: theme.text}]}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">

        {/* ── Identity Card ── */}
        {identity && (
          <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
            {/* Avatar — gradient circle with initial */}
            <View style={[styles.avatarOuter, {backgroundColor: theme.accentDim}]}>
              <View style={[styles.avatarInner, {borderColor: theme.accent}]}>
                <Text style={[styles.avatarLetter, {color: theme.accent}]}>
                  {displayName.charAt(0).toUpperCase()}
                </Text>
              </View>
            </View>

            <Text style={[styles.displayName, {color: theme.text}]}>{displayName}</Text>

            <Text style={[styles.fingerprint, {color: theme.textMuted}]}>
              {truncatedFingerprint}
            </Text>

            {/* Public key — tap to copy */}
            <TouchableOpacity
              style={[styles.pubKeyBox, {backgroundColor: theme.bgTertiary}]}
              onPress={handleCopyPublicKey}
              activeOpacity={0.7}>
              <Text style={[styles.pubKeyLabel, {color: theme.textMuted}]}>PUBLIC KEY</Text>
              <Text style={[styles.pubKeyValue, {color: theme.textSecondary}]}>
                {truncatedPubKey}
              </Text>
              <Text style={[styles.pubKeyCopyHint, {color: theme.accent}]}>
                {pubKeyCopied ? 'Copied!' : 'Tap to copy full key'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Theme Selector (2-col grid, 5 themes) ── */}
        <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
          <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>THEME</Text>
          <View style={styles.themeGrid}>
            {Object.entries(THEMES).map(([key, t]) => {
              const isSelected = themeName === key;
              return (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.themeCard,
                    {
                      backgroundColor: t.bg,
                      borderColor: isSelected ? t.accent : theme.border,
                      borderWidth: isSelected ? 2 : 1,
                    },
                  ]}
                  onPress={() => handleThemeChange(key)}
                  activeOpacity={0.7}>
                  <View style={styles.swatchRow}>
                    {(t.swatches || [t.accent, t.bg, t.bgSecondary]).map((c, i) => (
                      <View key={i} style={[styles.swatch, {backgroundColor: c}]} />
                    ))}
                  </View>
                  <Text style={[styles.themeName, {color: t.text}]}>{t.name}</Text>
                  {isSelected && (
                    <View style={[styles.selectedDot, {backgroundColor: t.accent}]} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* ── Security Section ── */}
        <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
          <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>SECURITY</Text>
          {SECURITY_INFO.map((item, idx) => (
            <View
              key={item.label}
              style={[
                styles.secRow,
                idx < SECURITY_INFO.length - 1 && {
                  borderBottomWidth: 1,
                  borderBottomColor: theme.border,
                },
              ]}>
              <Text style={[styles.secLabel, {color: theme.textSecondary}]}>{item.label}</Text>
              <Text style={[styles.secValue, {color: theme.accent}]}>{item.value}</Text>
            </View>
          ))}
        </View>

        {/* ── Preferences (toggles) ── */}
        <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
          <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>PREFERENCES</Text>

          <View style={[styles.toggleRow, {borderBottomWidth: 1, borderBottomColor: theme.border}]}>
            <Text style={[styles.toggleLabel, {color: theme.text}]}>Notifications</Text>
            <Switch
              value={!!settings.notifications}
              onValueChange={(v) => handleToggle('notifications', v)}
              trackColor={{false: theme.bgTertiary, true: theme.accent + '50'}}
              thumbColor={settings.notifications ? theme.accent : theme.textMuted}
            />
          </View>

          <View style={[styles.toggleRow, {borderBottomWidth: 1, borderBottomColor: theme.border}]}>
            <Text style={[styles.toggleLabel, {color: theme.text}]}>Sounds</Text>
            <Switch
              value={!!settings.sounds}
              onValueChange={(v) => handleToggle('sounds', v)}
              trackColor={{false: theme.bgTertiary, true: theme.accent + '50'}}
              thumbColor={settings.sounds ? theme.accent : theme.textMuted}
            />
          </View>

          <View style={styles.toggleRow}>
            <Text style={[styles.toggleLabel, {color: theme.text}]}>Read Receipts</Text>
            <Switch
              value={!!settings.readReceipts}
              onValueChange={(v) => handleToggle('readReceipts', v)}
              trackColor={{false: theme.bgTertiary, true: theme.accent + '50'}}
              thumbColor={settings.readReceipts ? theme.accent : theme.textMuted}
            />
          </View>
        </View>

        {/* ── Font Size Slider ── */}
        <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
          <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>FONT SIZE</Text>
          <View style={styles.sliderRow}>
            <Text style={[styles.sliderEdge, {color: theme.textMuted}]}>11</Text>
            <Slider
              style={styles.slider}
              minimumValue={11}
              maximumValue={18}
              step={1}
              value={fontSize}
              onValueChange={handleFontSizeChange}
              minimumTrackTintColor={theme.accent}
              maximumTrackTintColor={theme.bgTertiary}
              thumbTintColor={theme.accent}
            />
            <Text style={[styles.sliderEdge, {color: theme.textMuted}]}>18</Text>
          </View>
          <Text style={[styles.sliderPreview, {color: theme.text, fontSize}]}>
            Preview text at {fontSize}px
          </Text>
        </View>

        {/* ── Action Buttons ── */}
        <View style={[styles.card, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
          <Text style={[styles.sectionLabel, {color: theme.textMuted}]}>ACTIONS</Text>

          <TouchableOpacity
            style={[styles.actionRow, {borderBottomWidth: 1, borderBottomColor: theme.border}]}
            onPress={handleExport}
            activeOpacity={0.7}>
            <Text style={[styles.actionText, {color: theme.accent}]}>Export Data</Text>
            <Text style={[styles.actionArrow, {color: theme.textMuted}]}>{'\u203A'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionRow, {borderBottomWidth: 1, borderBottomColor: theme.border}]}
            onPress={() => {
              Vibration.vibrate(15);
              navigation.navigate('Recovery');
            }}
            activeOpacity={0.7}>
            <Text style={[styles.actionText, {color: theme.accent}]}>Backup Identity</Text>
            <Text style={[styles.actionArrow, {color: theme.textMuted}]}>{'\u203A'}</Text>
          </TouchableOpacity>
        </View>

        {/* ── Destructive Wipe Button ── */}
        <TouchableOpacity
          style={[styles.dangerBtn, {backgroundColor: theme.danger + '15', borderColor: theme.danger + '40'}]}
          onPress={handleWipeAll}
          activeOpacity={0.7}>
          <Text style={[styles.dangerBtnLabel, {color: theme.danger}]}>Wipe All Data</Text>
        </TouchableOpacity>

        {/* ── Footer ── */}
        <View style={styles.footer}>
          <Text style={[styles.footerText, {color: theme.textMuted}]}>
            GhostLink v2.0 {'\u00B7'} Zero Trust {'\u00B7'} Zero Trace
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
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
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  headerSpacer: {
    width: 40,
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

  /* Identity */
  avatarOuter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginBottom: 14,
  },
  avatarInner: {
    width: 66,
    height: 66,
    borderRadius: 33,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarLetter: {
    fontSize: 30,
    fontWeight: '800',
  },
  displayName: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 4,
  },
  fingerprint: {
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 1.5,
    textAlign: 'center',
    marginBottom: 14,
  },
  pubKeyBox: {
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  pubKeyLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  pubKeyValue: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  pubKeyCopyHint: {
    fontSize: 11,
    fontWeight: '700',
  },

  /* Theme Grid */
  themeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
  },
  themeCard: {
    width: '47%',
    borderRadius: 12,
    padding: 12,
    position: 'relative',
  },
  swatchRow: {
    flexDirection: 'row',
    marginBottom: 8,
    gap: 6,
  },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  themeName: {
    fontSize: 13,
    fontWeight: '700',
  },
  selectedDot: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  /* Security */
  secRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  secLabel: {
    fontSize: 13,
    fontWeight: '500',
  },
  secValue: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  /* Toggles */
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  toggleLabel: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },

  /* Font Size */
  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  slider: {
    flex: 1,
    height: 40,
    marginHorizontal: 8,
  },
  sliderEdge: {
    fontSize: 12,
    fontWeight: '600',
    width: 22,
    textAlign: 'center',
  },
  sliderPreview: {
    textAlign: 'center',
    fontWeight: '500',
  },

  /* Action Rows */
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
  },
  actionText: {
    fontSize: 15,
    fontWeight: '600',
  },
  actionArrow: {
    fontSize: 22,
    fontWeight: '300',
  },

  /* Danger */
  dangerBtn: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    alignItems: 'center',
    marginBottom: 20,
  },
  dangerBtnLabel: {
    fontSize: 15,
    fontWeight: '700',
  },

  /* Footer */
  footer: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  footerText: {
    fontSize: 12,
    letterSpacing: 0.5,
  },
});
