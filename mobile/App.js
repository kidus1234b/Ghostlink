/**
 * GhostLink Mobile — Root App Entry Point
 *
 * React Navigation native stack with conditional auth flow.
 * Deep link handling for ghostlink:// URLs (invite codes, room joins).
 * Global state via AppContext. Theme system matching the web app
 * (phantom / neon / blood / ocean / cyber). Push notification setup.
 * Dark StatusBar styling.
 */

import React, {useEffect, useMemo} from 'react';
import {StyleSheet, StatusBar, Platform, Linking} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {GestureHandlerRootView} from 'react-native-gesture-handler';

import {AppProvider} from './src/context/AppContext';
import {ThemeProvider, useTheme} from './src/context/ThemeContext';
import RootNavigator from './src/navigation/MainNavigator';

// ═══════════════════════════════════════════════════════════════
//  DEEP LINKING — ghostlink:// URL scheme
// ═══════════════════════════════════════════════════════════════

const DEEP_LINK_CONFIG = {
  prefixes: ['ghostlink://', 'https://ghostlink.app'],
  config: {
    screens: {
      Setup: 'setup',
      ChatList: 'chats',
      Chat: {
        path: 'chat/:roomId',
        parse: {
          roomId: String,
        },
      },
      Call: {
        path: 'call/:peerId',
        parse: {
          peerId: String,
        },
      },
      Settings: 'settings',
      Recovery: 'recovery',
    },
  },
};

/**
 * Parse and handle a ghostlink:// deep link.
 *
 * Supported formats:
 *   ghostlink://invite/<code>
 *   ghostlink://join/<roomId>
 *   ghostlink://call/<peerId>
 *   ghostlink://recovery
 */
function handleDeepLink(url) {
  if (!url) {
    return;
  }

  try {
    // Normalise custom scheme to a parseable URL
    const normalised = url.replace('ghostlink://', 'https://ghostlink.app/');
    const parsed = new URL(normalised);
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (segments.length === 0) {
      return;
    }

    const action = segments[0];
    const param = segments[1] || null;

    switch (action) {
      case 'invite':
        if (param) {
          console.log('[DeepLink] invite code:', param);
        }
        break;
      case 'join':
        if (param) {
          console.log('[DeepLink] room join:', param);
        }
        break;
      case 'call':
        if (param) {
          console.log('[DeepLink] incoming call:', param);
        }
        break;
      case 'recovery':
        console.log('[DeepLink] recovery flow');
        break;
      default:
        console.log('[DeepLink] unhandled:', url);
    }
  } catch (err) {
    console.warn('[DeepLink] parse error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS — placeholder setup
// ═══════════════════════════════════════════════════════════════

/**
 * Bring up push notifications, or carry on without them.
 *
 * react-native-push-notification pulls in firebase-messaging, and its
 * configure() asks Firebase for a token. With no google-services.json in the
 * build — which is the case today — that throws "Default FirebaseApp is not
 * initialized in this process" out of Java, which React Native surfaces as an
 * unhandled exception and Android reports as "GhostLink closed because this app
 * has a bug". It happens during first render, so the app dies before it draws
 * anything.
 *
 * Notifications are not load-bearing: every screen works without them, and the
 * handlers below are still placeholders. So the module is required lazily and
 * the whole setup is best-effort. When Firebase is configured this starts
 * working with no further change; until then the app boots.
 */
function configurePushNotifications() {
  let PushNotification;
  try {
    PushNotification = require('react-native-push-notification');
    PushNotification = PushNotification.default ?? PushNotification;
    if (!PushNotification || typeof PushNotification.configure !== 'function') {
      throw new Error('native module unavailable');
    }
  } catch (err) {
    console.warn('[Push] notifications unavailable, continuing without them:', err?.message);
    return;
  }

  PushNotification.configure({
    onRegister(token) {
      // TODO: send token to signaling server for push relay
      console.log('[Push] registered:', token);
    },

    onNotification(notification) {
      // TODO: navigate to relevant chat / call screen
      console.log('[Push] received:', notification);
    },

    onAction(notification) {
      // TODO: handle reply / dismiss / accept-call actions
      console.log('[Push] action:', notification.action);
    },

    onRegistrationError(err) {
      console.warn('[Push] registration error:', err);
    },

    channelId: 'ghostlink-default',

    permissions: {
      alert: true,
      badge: true,
      sound: true,
    },

    popInitialNotification: true,
    requestPermissions: Platform.OS === 'ios',
  });

  // Android notification channels
  if (Platform.OS === 'android') {
    PushNotification.createChannel(
      {
        channelId: 'ghostlink-default',
        channelName: 'GhostLink Messages',
        channelDescription: 'Encrypted message notifications',
        playSound: true,
        soundName: 'default',
        importance: 4, // IMPORTANCE_HIGH
        vibrate: true,
      },
      () => {},
    );

    PushNotification.createChannel(
      {
        channelId: 'ghostlink-calls',
        channelName: 'GhostLink Calls',
        channelDescription: 'Incoming encrypted call notifications',
        playSound: true,
        soundName: 'default',
        importance: 5, // IMPORTANCE_MAX — heads-up display
        vibrate: true,
      },
      () => {},
    );
  }
}

// ═══════════════════════════════════════════════════════════════
//  APP NAVIGATOR — NavigationContainer + theme + deep links
// ═══════════════════════════════════════════════════════════════

function AppNavigator() {
  const {theme} = useTheme();

  // Map our theme to React Navigation's theme shape
  const navigationTheme = useMemo(
    () => ({
      dark: true,
      colors: {
        primary: theme.accent,
        background: theme.bg,
        card: theme.bgSecondary,
        text: theme.text,
        border: theme.border,
        notification: theme.accent,
      },
    }),
    [theme],
  );

  // Deep link listener for URLs arriving while the app is open
  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({url}) => {
      handleDeepLink(url);
    });

    // Check for a cold-start deep link
    Linking.getInitialURL().then(url => {
      if (url) {
        handleDeepLink(url);
      }
    });

    return () => subscription.remove();
  }, []);

  return (
    <NavigationContainer
      theme={navigationTheme}
      linking={DEEP_LINK_CONFIG}
      fallback={null}>
      <StatusBar
        barStyle="light-content"
        backgroundColor={theme.bg}
        translucent={false}
      />
      <RootNavigator />
    </NavigationContainer>
  );
}

// ═══════════════════════════════════════════════════════════════
//  ROOT COMPONENT
// ═══════════════════════════════════════════════════════════════

export default function App() {
  // Initialise push notifications once
  useEffect(() => {
    try {
      configurePushNotifications();
    } catch (err) {
      // Belt and braces: nothing about notifications is worth a failed launch.
      console.warn('[Push] setup failed, continuing without notifications:', err?.message);
    }
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <AppProvider>
          <ThemeProvider>
            <AppNavigator />
          </ThemeProvider>
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// ═══════════════════════════════════════════════════════════════
//  STYLES
// ═══════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0a0a0f',
  },
});
