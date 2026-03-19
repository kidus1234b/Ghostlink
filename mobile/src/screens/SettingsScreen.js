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
} from 'react-native';
import Animated, {FadeInDown} from 'react-native-reanimated';
import QRCode from 'react-native-qrcode-svg';
import {useTheme, THEMES} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';

const AUTO_WIPE_OPTIONS = [
  {label: 'Off', value: 0},
  {label: '5 min', value: 5},
  {label: '15 min', value: 15},
  {label: '30 min', value: 30},
  {label: '1 hour', value: 60},
  {label: '24 hours', value: 1440},
];

export default function SettingsScreen({navigation}) {
  const {theme, themeName, setThemeName} = useTheme();
  const {state, dispatch, wipeAll} = useApp();
  const [showQR, setShowQR] = useState(false);

  const handleThemeChange = useCallback(
    (name) => {
      Vibration.vibrate(15);
      setThemeName(name);
    },
    [setThemeName],
  );

  const handleNotificationToggle = useCallback(
    (value) => {
      Vibration.vibrate(10);
      dispatch({type: 'SET_NOTIFICATIONS', payload: value});
    },
    [dispatch],
  );

  const handleBiometricToggle = useCallback(
    (value) => {
      Vibration.vibrate(10);
      dispatch({type: 'SET_BIOMETRIC', payload: value});
    },
    [dispatch],
  );

  const handleAutoWipe = useCallback(
    (minutes) => {
      Vibration.vibrate(15);
      dispatch({type: 'SET_AUTO_WIPE', payload: minutes});
    },
    [dispatch],
  );

  const handleExport = useCallback(() => {
    Vibration.vibrate(20);
    const exportData = {
      displayName: state.displayName,
      messages: state.messages,
      chain: state.chain,
      rooms: state.rooms,
      exportedAt: new Date().toISOString(),
    };
    Clipboard.setString(JSON.stringify(exportData));
    Alert.alert('Exported', 'Chain and message data copied to clipboard.');
  }, [state]);

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
              'Are you sure?',
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

  const renderSection = (title, delay, children) => (
    <Animated.View
      entering={FadeInDown.delay(delay).duration(300)}
      style={[styles.section, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
      <Text style={[styles.sectionTitle, {color: theme.textMuted}]}>{title}</Text>
      {children}
    </Animated.View>
  );

  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      <View style={[styles.header, {backgroundColor: theme.bgSecondary, borderBottomColor: theme.border}]}>
        <Text style={[styles.headerTitle, {color: theme.text}]}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {state.identity && (
          <Animated.View
            entering={FadeInDown.duration(300)}
            style={[styles.identityCard, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
            <View style={[styles.identityAvatar, {backgroundColor: theme.accentDim}]}>
              <Text style={[styles.identityInitial, {color: theme.accent}]}>
                {(state.displayName || 'G').charAt(0).toUpperCase()}
              </Text>
            </View>
            <Text style={[styles.identityName, {color: theme.text}]}>{state.displayName}</Text>
            <Text style={[styles.identityFingerprint, {color: theme.textMuted}]}>
              {state.identity.fingerprint}
            </Text>
            <TouchableOpacity
              style={[styles.qrToggle, {backgroundColor: theme.bgTertiary}]}
              onPress={() => {
                setShowQR(q => !q);
                Vibration.vibrate(10);
              }}>
              <Text style={[styles.qrToggleText, {color: theme.accent}]}>
                {showQR ? 'Hide QR' : 'Show Identity QR'}
              </Text>
            </TouchableOpacity>
            {showQR && (
              <View style={[styles.qrContainer, {backgroundColor: '#fff'}]}>
                <QRCode
                  value={JSON.stringify({
                    name: state.displayName,
                    fingerprint: state.identity.fingerprint,
                    pubKey: state.identity.publicKeyHex?.slice(0, 32),
                  })}
                  size={180}
                  color="#000"
                  backgroundColor="#fff"
                  ecl="M"
                />
              </View>
            )}
          </Animated.View>
        )}

        {renderSection('THEME', 100, (
          <View style={styles.themeGrid}>
            {Object.entries(THEMES).map(([key, t]) => (
              <TouchableOpacity
                key={key}
                style={[
                  styles.themeOption,
                  {
                    backgroundColor: t.bg,
                    borderColor: themeName === key ? t.accent : theme.border,
                    borderWidth: themeName === key ? 2 : 1,
                  },
                ]}
                onPress={() => handleThemeChange(key)}>
                <View style={[styles.themeAccentDot, {backgroundColor: t.accent}]} />
                <Text style={[styles.themeName, {color: t.text}]}>{t.name}</Text>
                {themeName === key && (
                  <Text style={[styles.themeCheck, {color: t.accent}]}>{'\u2713'}</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        ))}

        {renderSection('NOTIFICATIONS', 200, (
          <View style={styles.settingRow}>
            <View>
              <Text style={[styles.settingLabel, {color: theme.text}]}>Push Notifications</Text>
              <Text style={[styles.settingDesc, {color: theme.textMuted}]}>
                Get notified of new messages
              </Text>
            </View>
            <Switch
              value={state.notifications}
              onValueChange={handleNotificationToggle}
              trackColor={{false: theme.bgTertiary, true: theme.accent + '50'}}
              thumbColor={state.notifications ? theme.accent : theme.textMuted}
            />
          </View>
        ))}

        {renderSection('SECURITY', 300, (
          <>
            <View style={[styles.settingRow, {borderBottomColor: theme.border, borderBottomWidth: 1}]}>
              <View>
                <Text style={[styles.settingLabel, {color: theme.text}]}>Biometric Lock</Text>
                <Text style={[styles.settingDesc, {color: theme.textMuted}]}>
                  Require fingerprint/face to open
                </Text>
              </View>
              <Switch
                value={state.biometricEnabled}
                onValueChange={handleBiometricToggle}
                trackColor={{false: theme.bgTertiary, true: theme.accent + '50'}}
                thumbColor={state.biometricEnabled ? theme.accent : theme.textMuted}
              />
            </View>
            <View style={styles.settingSection}>
              <Text style={[styles.settingLabel, {color: theme.text, marginBottom: 10}]}>
                Auto-Wipe Timer
              </Text>
              <Text style={[styles.settingDesc, {color: theme.textMuted, marginBottom: 12}]}>
                Automatically wipe all data after inactivity
              </Text>
              <View style={styles.wipeOptions}>
                {AUTO_WIPE_OPTIONS.map(opt => (
                  <TouchableOpacity
                    key={opt.value}
                    style={[
                      styles.wipeOption,
                      {
                        backgroundColor:
                          state.autoWipeMinutes === opt.value
                            ? theme.danger + '20'
                            : theme.bgTertiary,
                        borderColor:
                          state.autoWipeMinutes === opt.value
                            ? theme.danger
                            : theme.border,
                      },
                    ]}
                    onPress={() => handleAutoWipe(opt.value)}>
                    <Text
                      style={{
                        color:
                          state.autoWipeMinutes === opt.value
                            ? theme.danger
                            : theme.textSecondary,
                        fontSize: 12,
                        fontWeight: '600',
                      }}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </>
        ))}

        {renderSection('DATA', 400, (
          <>
            <TouchableOpacity
              style={[styles.actionBtn, {borderBottomColor: theme.border, borderBottomWidth: 1}]}
              onPress={handleExport}>
              <Text style={[styles.actionBtnText, {color: theme.accent}]}>Export Chain & Messages</Text>
              <Text style={[styles.actionArrow, {color: theme.textMuted}]}>{'\u203A'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => {
                Vibration.vibrate(15);
                Alert.alert('Import', 'Import functionality would open file picker');
              }}>
              <Text style={[styles.actionBtnText, {color: theme.accent}]}>Import Data</Text>
              <Text style={[styles.actionArrow, {color: theme.textMuted}]}>{'\u203A'}</Text>
            </TouchableOpacity>
          </>
        ))}

        {renderSection('RECOVERY', 450, (
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => {
              Vibration.vibrate(15);
              navigation.navigate('Recovery');
            }}>
            <Text style={[styles.actionBtnText, {color: theme.accent}]}>Recovery System</Text>
            <Text style={[styles.actionArrow, {color: theme.textMuted}]}>{'\u203A'}</Text>
          </TouchableOpacity>
        ))}

        <Animated.View entering={FadeInDown.delay(500).duration(300)}>
          <TouchableOpacity
            style={[styles.dangerBtn, {backgroundColor: theme.danger + '15', borderColor: theme.danger + '40'}]}
            onPress={handleWipeAll}>
            <Text style={[styles.dangerBtnText, {color: theme.danger}]}>Wipe All Data</Text>
          </TouchableOpacity>
        </Animated.View>

        <View style={styles.footer}>
          <Text style={[styles.footerText, {color: theme.textMuted}]}>
            GhostLink v2.0.0
          </Text>
          <Text style={[styles.footerText, {color: theme.textMuted}]}>
            Zero Trust. Zero Trace.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    paddingTop: 48,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '800',
  },
  scroll: {
    padding: 16,
    paddingBottom: 40,
  },
  identityCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
    alignItems: 'center',
    marginBottom: 16,
  },
  identityAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  identityInitial: {
    fontSize: 28,
    fontWeight: '800',
  },
  identityName: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 4,
  },
  identityFingerprint: {
    fontSize: 12,
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  qrToggle: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  qrToggleText: {
    fontSize: 13,
    fontWeight: '700',
  },
  qrContainer: {
    marginTop: 16,
    padding: 16,
    borderRadius: 12,
  },
  section: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 12,
  },
  themeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  themeOption: {
    width: '47%',
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
  },
  themeAccentDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    marginRight: 10,
  },
  themeName: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  themeCheck: {
    fontSize: 14,
    fontWeight: '800',
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  settingSection: {
    paddingTop: 14,
  },
  settingLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  settingDesc: {
    fontSize: 12,
    marginTop: 2,
  },
  wipeOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  wipeOption: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  actionBtn: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
  },
  actionBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
  actionArrow: {
    fontSize: 22,
    fontWeight: '300',
  },
  dangerBtn: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    alignItems: 'center',
    marginBottom: 20,
  },
  dangerBtnText: {
    fontSize: 15,
    fontWeight: '700',
  },
  footer: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  footerText: {
    fontSize: 12,
    marginBottom: 4,
  },
});
