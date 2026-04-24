import React, {useEffect} from 'react';
import {View, Text, StyleSheet, StatusBar} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSequence,
  withDelay,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';

export default function SplashScreen({navigation}) {
  const {theme} = useTheme();
  const {state} = useApp();

  const logoScale = useSharedValue(0.3);
  const logoOpacity = useSharedValue(0);
  const titleOpacity = useSharedValue(0);
  const subtitleOpacity = useSharedValue(0);
  const containerOpacity = useSharedValue(1);

  useEffect(() => {
    logoOpacity.value = withTiming(1, {duration: 600, easing: Easing.out(Easing.ease)});
    logoScale.value = withSequence(
      withTiming(1.1, {duration: 500, easing: Easing.out(Easing.back)}),
      withTiming(1, {duration: 200}),
    );
    titleOpacity.value = withDelay(400, withTiming(1, {duration: 500}));
    subtitleOpacity.value = withDelay(700, withTiming(1, {duration: 500}));

    const timeout = setTimeout(() => {
      containerOpacity.value = withTiming(0, {duration: 300}, () => {
        runOnJS(navigateAway)();
      });
    }, 2200);

    return () => clearTimeout(timeout);
  }, []);

  function navigateAway() {
    if (state.isSetupComplete) {
      navigation.reset({index: 0, routes: [{name: 'Main'}]});
    } else {
      navigation.reset({index: 0, routes: [{name: 'Setup'}]});
    }
  }

  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{scale: logoScale.value}],
  }));

  const titleStyle = useAnimatedStyle(() => ({opacity: titleOpacity.value}));
  const subtitleStyle = useAnimatedStyle(() => ({opacity: subtitleOpacity.value}));
  const containerStyle = useAnimatedStyle(() => ({opacity: containerOpacity.value}));

  return (
    <Animated.View style={[styles.container, {backgroundColor: theme.bg}, containerStyle]}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <Animated.View style={[styles.logoWrap, logoStyle]}>
        <View style={[styles.logoBorder, {borderColor: theme.accent + '40'}]}>
          <Text style={[styles.logoText, {color: theme.accent}]}>G</Text>
        </View>
      </Animated.View>
      <Animated.Text style={[styles.title, {color: theme.text}, titleStyle]}>
        GhostLink
      </Animated.Text>
      <Animated.Text style={[styles.subtitle, {color: theme.textSecondary}, subtitleStyle]}>
        Zero Trust {'\u00B7'} Zero Trace
      </Animated.Text>
      <Animated.View style={[styles.footer, subtitleStyle]}>
        <View style={[styles.encBar, {backgroundColor: theme.accent + '15'}]}>
          <View style={[styles.encDot, {backgroundColor: theme.accent}]} />
          <Text style={[styles.encText, {color: theme.accent}]}>
            AES-256 {'\u00B7'} ECDH P-256 {'\u00B7'} SHA-256
          </Text>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoWrap: {
    marginBottom: 20,
  },
  logoBorder: {
    width: 90,
    height: 90,
    borderRadius: 45,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoText: {
    fontSize: 42,
    fontWeight: '900',
    letterSpacing: 2,
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 2,
  },
  subtitle: {
    fontSize: 14,
    letterSpacing: 3,
    marginTop: 6,
    textTransform: 'uppercase',
  },
  footer: {
    position: 'absolute',
    bottom: 50,
  },
  encBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  encDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 8,
  },
  encText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
