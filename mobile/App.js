import React from 'react';
import {View, Text, StyleSheet, StatusBar, Platform} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {GestureHandlerRootView} from 'react-native-gesture-handler';

import {ThemeProvider, useTheme} from './src/context/ThemeContext';
import {AppProvider} from './src/context/AppContext';

import SplashScreen from './src/screens/SplashScreen';
import SetupScreen from './src/screens/SetupScreen';
import ChatScreen from './src/screens/ChatScreen';
import CallScreen from './src/screens/CallScreen';
import FilesScreen from './src/screens/FilesScreen';
import ChainScreen from './src/screens/ChainScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import RecoveryScreen from './src/screens/RecoveryScreen';
import QRScannerScreen from './src/screens/QRScannerScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function TabIcon({label, focused, color}) {
  const icons = {
    Chat: '\u{1F4AC}',
    Calls: '\u{1F4DE}',
    Files: '\u{1F4C1}',
    Chain: '\u{26D3}',
    Settings: '\u{2699}',
  };
  return (
    <View style={tabStyles.iconContainer}>
      <Text style={[tabStyles.icon, {opacity: focused ? 1 : 0.5}]}>
        {icons[label] || '\u25CF'}
      </Text>
      {focused && <View style={[tabStyles.activeDot, {backgroundColor: color}]} />}
    </View>
  );
}

function MainTabs() {
  const {theme} = useTheme();

  return (
    <Tab.Navigator
      screenOptions={({route}) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: theme.bgSecondary,
          borderTopColor: theme.border,
          borderTopWidth: 1,
          height: Platform.OS === 'ios' ? 85 : 65,
          paddingBottom: Platform.OS === 'ios' ? 25 : 8,
          paddingTop: 8,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textMuted,
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '600',
          letterSpacing: 0.5,
          marginTop: 2,
        },
        tabBarIcon: ({focused, color}) => (
          <TabIcon label={route.name} focused={focused} color={color} />
        ),
      })}>
      <Tab.Screen name="Chat" component={ChatScreen} />
      <Tab.Screen name="Calls" component={CallHistoryScreen} />
      <Tab.Screen name="Files" component={FilesScreen} />
      <Tab.Screen name="Chain" component={ChainScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

function CallHistoryScreen({navigation}) {
  const {theme} = useTheme();

  const recentCalls = [
    {id: 1, name: 'Phantom Node', type: 'voice', direction: 'outgoing', time: Date.now() - 3600000, duration: 245},
    {id: 2, name: 'Cipher', type: 'video', direction: 'incoming', time: Date.now() - 7200000, duration: 132},
    {id: 3, name: 'Specter', type: 'voice', direction: 'missed', time: Date.now() - 86400000, duration: 0},
  ];

  function formatCallTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ts).toLocaleDateString([], {month: 'short', day: 'numeric'});
  }

  function formatDuration(sec) {
    if (!sec) return 'Missed';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  return (
    <View style={[styles.callHistory, {backgroundColor: theme.bg}]}>
      <View style={[styles.callHeader, {backgroundColor: theme.bgSecondary, borderBottomColor: theme.border}]}>
        <Text style={[styles.callHeaderTitle, {color: theme.text}]}>Calls</Text>
      </View>
      <View style={styles.callActions}>
        <TouchableOpacityRow
          theme={theme}
          icon={'\u{1F4DE}'}
          label="New Voice Call"
          onPress={() => navigation.navigate('ActiveCall', {video: false})}
        />
        <TouchableOpacityRow
          theme={theme}
          icon={'\u{1F4F9}'}
          label="New Video Call"
          onPress={() => navigation.navigate('ActiveCall', {video: true})}
        />
      </View>
      {recentCalls.map(call => (
        <View
          key={call.id}
          style={[styles.callItem, {borderBottomColor: theme.border}]}>
          <View style={[styles.callAvatar, {backgroundColor: theme.accentDim}]}>
            <Text style={{color: theme.accent, fontSize: 18}}>
              {call.name.charAt(0)}
            </Text>
          </View>
          <View style={styles.callInfo}>
            <Text style={[styles.callName, {color: theme.text}]}>{call.name}</Text>
            <View style={styles.callMeta}>
              <Text
                style={{
                  color:
                    call.direction === 'missed' ? theme.danger : theme.textSecondary,
                  fontSize: 12,
                }}>
                {call.direction === 'outgoing' ? '\u2197' : call.direction === 'incoming' ? '\u2199' : '\u2717'}{' '}
                {call.type === 'video' ? 'Video' : 'Voice'}
              </Text>
              <Text style={[styles.callDot, {color: theme.textMuted}]}>{'\u00B7'}</Text>
              <Text style={{color: theme.textMuted, fontSize: 12}}>
                {formatDuration(call.duration)}
              </Text>
            </View>
          </View>
          <Text style={{color: theme.textMuted, fontSize: 12}}>
            {formatCallTime(call.time)}
          </Text>
        </View>
      ))}
      <View style={styles.callEmpty}>
        <Text style={[styles.callEmptyText, {color: theme.textMuted}]}>
          All calls are end-to-end encrypted via WebRTC.
        </Text>
      </View>
    </View>
  );
}

function TouchableOpacityRow({theme, icon, label, onPress}) {
  const React = require('react');
  const {TouchableOpacity, Text, View, Vibration} = require('react-native');
  return (
    <TouchableOpacity
      style={[styles.callActionBtn, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}
      onPress={() => {
        Vibration.vibrate(15);
        onPress();
      }}>
      <Text style={{fontSize: 20, marginRight: 8}}>{icon}</Text>
      <Text style={{color: theme.accent, fontWeight: '700', fontSize: 14}}>{label}</Text>
    </TouchableOpacity>
  );
}

function AppNavigator() {
  const {theme} = useTheme();

  const navigationTheme = {
    dark: true,
    colors: {
      primary: theme.accent,
      background: theme.bg,
      card: theme.bgSecondary,
      text: theme.text,
      border: theme.border,
      notification: theme.accent,
    },
  };

  return (
    <NavigationContainer theme={navigationTheme}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} translucent={false} />
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          animation: 'fade',
          contentStyle: {backgroundColor: theme.bg},
        }}>
        <Stack.Screen name="Splash" component={SplashScreen} />
        <Stack.Screen name="Setup" component={SetupScreen} />
        <Stack.Screen name="Main" component={MainTabs} />
        <Stack.Screen
          name="ActiveCall"
          component={CallScreen}
          options={{
            animation: 'slide_from_bottom',
            presentation: 'fullScreenModal',
          }}
        />
        <Stack.Screen
          name="QRScanner"
          component={QRScannerScreen}
          options={{animation: 'slide_from_right'}}
        />
        <Stack.Screen
          name="Recovery"
          component={RecoveryScreen}
          options={{animation: 'slide_from_right'}}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AppProvider>
            <AppNavigator />
          </AppProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const tabStyles = StyleSheet.create({
  iconContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 20,
  },
  activeDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginTop: 3,
  },
});

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  callHistory: {
    flex: 1,
  },
  callHeader: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    paddingTop: 48,
    borderBottomWidth: 1,
  },
  callHeaderTitle: {
    fontSize: 22,
    fontWeight: '800',
  },
  callActions: {
    flexDirection: 'row',
    padding: 12,
    gap: 10,
  },
  callActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  callItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  callAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  callInfo: {
    flex: 1,
    marginLeft: 12,
  },
  callName: {
    fontSize: 15,
    fontWeight: '600',
  },
  callMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
    gap: 4,
  },
  callDot: {
    fontSize: 10,
  },
  callEmpty: {
    alignItems: 'center',
    paddingVertical: 30,
  },
  callEmptyText: {
    fontSize: 12,
  },
});
