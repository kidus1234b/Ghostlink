/**
 * GhostLink Mobile — Main Stack Navigator
 *
 * Conditional rendering: no identity -> Setup screen, else -> main stack.
 * Main stack: ChatList (home), Chat, Call, Settings, Recovery.
 * Dark theme throughout, no default headers, slide-from-right transitions.
 */

import React from 'react';
import {StyleSheet} from 'react-native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';

import {useApp} from '../context/AppContext';

// Screen imports — lazy require so navigator can be created before screens exist
import SetupScreen from '../screens/SetupScreen';
import ChatListScreen from '../screens/ChatListScreen';
import ChatScreen from '../screens/ChatScreen';
import CallScreen from '../screens/CallScreen';
import SettingsScreen from '../screens/SettingsScreen';
import RecoveryScreen from '../screens/RecoveryScreen';

const AuthStack = createNativeStackNavigator();
const MainStack = createNativeStackNavigator();

// ─── Shared Screen Options ──────────────────────────────────

const SHARED_OPTIONS = {
  headerShown: false,
  animation: 'slide_from_right',
  gestureEnabled: true,
  gestureDirection: 'horizontal',
  animationDuration: 250,
};

// ─── Auth Flow (no identity) ─────────────────────────────────

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={SHARED_OPTIONS}>
      <AuthStack.Screen name="Setup" component={SetupScreen} />
    </AuthStack.Navigator>
  );
}

// ─── Main Flow (identity established) ────────────────────────

function MainNavigator() {
  return (
    <MainStack.Navigator screenOptions={SHARED_OPTIONS}>
      <MainStack.Screen name="ChatList" component={ChatListScreen} />
      <MainStack.Screen name="Chat" component={ChatScreen} />
      <MainStack.Screen
        name="Call"
        component={CallScreen}
        options={{
          animation: 'slide_from_bottom',
          presentation: 'fullScreenModal',
          gestureDirection: 'vertical',
        }}
      />
      <MainStack.Screen name="Settings" component={SettingsScreen} />
      <MainStack.Screen name="Recovery" component={RecoveryScreen} />
    </MainStack.Navigator>
  );
}

// ─── Root Switch ─────────────────────────────────────────────

function RootNavigator() {
  const {identity} = useApp();

  if (!identity) {
    return <AuthNavigator />;
  }

  return <MainNavigator />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export {AuthNavigator, MainNavigator};
export default RootNavigator;
