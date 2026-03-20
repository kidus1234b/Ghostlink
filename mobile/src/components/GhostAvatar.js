/**
 * GhostLink Mobile — GhostAvatar Component
 *
 * A reusable avatar circle that displays the first letter of the user's name
 * on a deterministic gradient-like background derived from the name hash.
 * Includes an optional online status indicator dot.
 *
 * @example
 * <GhostAvatar name="Kidus" size={48} isOnline />
 * <GhostAvatar name="Alice" size={32} color="#8B5CF6" isOnline={false} />
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';

// ─── Color Palette ──────────────────────────────────────────────────────────

// Curated palette — high-contrast, accessible colors that look good as avatar
// backgrounds with white text.
const PALETTE = [
  '#6366F1', // indigo
  '#8B5CF6', // violet
  '#A855F7', // purple
  '#EC4899', // pink
  '#EF4444', // red
  '#F97316', // orange
  '#EAB308', // yellow
  '#22C55E', // green
  '#14B8A6', // teal
  '#06B6D4', // cyan
  '#3B82F6', // blue
  '#2563EB', // dark blue
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Simple deterministic hash of a string, producing a positive integer.
 * @param {string} str
 * @returns {number}
 */
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Pick a deterministic color from the palette based on the name.
 * @param {string} name
 * @returns {string} Hex color.
 */
function colorFromName(name) {
  return PALETTE[hashString(name) % PALETTE.length];
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {string} props.name         Display name (first letter is shown).
 * @param {number} [props.size=40]    Diameter of the avatar circle in dp.
 * @param {string} [props.color]      Override the background color.
 * @param {boolean} [props.isOnline]  Show a green dot if true, gray if false.
 *                                     Omit or pass undefined to hide the dot.
 * @param {object} [props.style]      Additional styles on the outer container.
 */
const GhostAvatar = ({ name, size = 40, color, isOnline, style }) => {
  const bgColor = useMemo(
    () => color || colorFromName(name || '?'),
    [name, color],
  );

  const initial = (name || '?').charAt(0).toUpperCase();
  const fontSize = Math.round(size * 0.44);
  const statusSize = Math.max(Math.round(size * 0.28), 8);
  const statusBorder = Math.max(Math.round(statusSize * 0.25), 2);
  const showStatus = typeof isOnline === 'boolean';

  return (
    <View style={[styles.container, { width: size, height: size }, style]}>
      <View
        style={[
          styles.circle,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: bgColor,
          },
        ]}
      >
        <Text
          style={[
            styles.initial,
            {
              fontSize,
              lineHeight: size,
            },
          ]}
          numberOfLines={1}
        >
          {initial}
        </Text>
      </View>

      {showStatus && (
        <View
          style={[
            styles.statusDot,
            {
              width: statusSize,
              height: statusSize,
              borderRadius: statusSize / 2,
              borderWidth: statusBorder,
              backgroundColor: isOnline ? '#22C55E' : '#9CA3AF',
              // Position at bottom-right of the avatar
              bottom: 0,
              right: 0,
            },
          ]}
        />
      )}
    </View>
  );
};

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    position: 'relative',
  },
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  initial: {
    color: '#FFFFFF',
    fontWeight: '700',
    textAlign: 'center',
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  statusDot: {
    position: 'absolute',
    borderColor: '#0F0F0F', // matches dark background of GhostLink
  },
});

export default React.memo(GhostAvatar);
