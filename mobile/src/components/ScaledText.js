/**
 * GhostLink Mobile — text that honours the user's chosen size.
 *
 * The app has ~236 font sizes written as literals inside StyleSheet.create,
 * which runs at module load where a hook value cannot reach. Converting each
 * by hand would mean 236 edits that drift the moment anyone adds a screen, so
 * the scaling happens here instead: every size stays written at its design
 * value and is multiplied on the way through.
 *
 * Swap the import in a screen and the whole screen scales:
 *
 *   -import {Text, TextInput} from 'react-native';
 *   +import {Text, TextInput} from '../components/ScaledText';
 *
 * Styles without a fontSize pass through untouched, so this is safe to apply
 * broadly.
 */

import React, {useMemo} from 'react';
import {Text as RNText, TextInput as RNTextInput} from 'react-native';
import {useTheme} from '../context/ThemeContext';
import {scaleStyle} from '../utils/scale-style';

export function Text({style, ...props}) {
  const {fontScale} = useTheme();
  const scaled = useMemo(() => scaleStyle(style, fontScale), [style, fontScale]);
  return <RNText {...props} style={scaled} />;
}

export function TextInput({style, ...props}) {
  const {fontScale} = useTheme();
  const scaled = useMemo(() => scaleStyle(style, fontScale), [style, fontScale]);
  return <RNTextInput {...props} style={scaled} />;
}

export {scaleStyle};
