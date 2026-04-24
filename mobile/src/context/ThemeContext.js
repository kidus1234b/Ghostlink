/**
 * GhostLink Mobile — Theme Context
 *
 * Five dark themes matching the web app exactly.
 * Reads/writes theme preference via AppContext settings for persistence.
 */

import React, {createContext, useContext, useCallback, useMemo} from 'react';
import {useApp} from './AppContext';

// ═══════════════════════════════════════════════════════════════
//  THEME DEFINITIONS — match web app exactly
// ═══════════════════════════════════════════════════════════════

const THEMES = {
  phantom: {
    name: 'Phantom',
    accent: '#00ffa3',
    accent2: '#b347ff',
    accent3: '#00d4ff',
    bg: '#0a0a0f',
    bgSecondary: '#12121a',
    bgTertiary: '#1a1a25',
    accentDim: 'rgba(0,255,163,0.15)',
    text: '#e0e0e0',
    textSecondary: '#8a8a9a',
    textMuted: '#5a5a6a',
    border: 'rgba(255,255,255,0.06)',
    danger: '#ff4466',
    success: '#00ffa3',
    warning: '#ffaa00',
  },
  neon: {
    name: 'Neon',
    accent: '#ff00ff',
    accent2: '#00ffff',
    accent3: '#ffff00',
    bg: '#0a000a',
    bgSecondary: '#14001a',
    bgTertiary: '#1e0028',
    accentDim: 'rgba(255,0,255,0.15)',
    text: '#e0e0e0',
    textSecondary: '#8a8a9a',
    textMuted: '#5a5a6a',
    border: 'rgba(255,255,255,0.06)',
    danger: '#ff4466',
    success: '#00ff87',
    warning: '#ffaa00',
  },
  blood: {
    name: 'Blood',
    accent: '#ff2244',
    accent2: '#ff6600',
    accent3: '#ff0088',
    bg: '#0f0a0a',
    bgSecondary: '#1a1212',
    bgTertiary: '#251a1a',
    accentDim: 'rgba(255,34,68,0.15)',
    text: '#e0e0e0',
    textSecondary: '#8a8a9a',
    textMuted: '#5a5a6a',
    border: 'rgba(255,255,255,0.06)',
    danger: '#ff2244',
    success: '#00ffa3',
    warning: '#ff6600',
  },
  ocean: {
    name: 'Ocean',
    accent: '#00b4d8',
    accent2: '#0077b6',
    accent3: '#90e0ef',
    bg: '#0a0d12',
    bgSecondary: '#121820',
    bgTertiary: '#1a222e',
    accentDim: 'rgba(0,180,216,0.15)',
    text: '#e0e0e0',
    textSecondary: '#8a8a9a',
    textMuted: '#5a5a6a',
    border: 'rgba(255,255,255,0.06)',
    danger: '#ff4466',
    success: '#00ffa3',
    warning: '#ffaa00',
  },
  cyber: {
    name: 'Cyber',
    accent: '#f5d300',
    accent2: '#ff6b35',
    accent3: '#00ff87',
    bg: '#0d0d00',
    bgSecondary: '#1a1a0d',
    bgTertiary: '#26261a',
    accentDim: 'rgba(245,211,0,0.15)',
    text: '#e0e0e0',
    textSecondary: '#8a8a9a',
    textMuted: '#5a5a6a',
    border: 'rgba(255,255,255,0.06)',
    danger: '#ff4466',
    success: '#00ff87',
    warning: '#f5d300',
  },
};

// ─── Context ─────────────────────────────────────────────────

const ThemeContext = createContext(null);

function ThemeProvider({children}) {
  const {settings, updateSettings} = useApp();
  const themeName = settings.theme || 'phantom';

  const theme = useMemo(
    () => THEMES[themeName] || THEMES.phantom,
    [themeName],
  );

  const setThemeName = useCallback(
    name => {
      if (THEMES[name]) {
        updateSettings({theme: name});
      }
    },
    [updateSettings],
  );

  const cycleTheme = useCallback(() => {
    const keys = Object.keys(THEMES);
    const idx = keys.indexOf(themeName);
    const nextIdx = (idx + 1) % keys.length;
    updateSettings({theme: keys[nextIdx]});
  }, [themeName, updateSettings]);

  const value = useMemo(
    () => ({theme, themeName, setThemeName, cycleTheme, THEMES}),
    [theme, themeName, setThemeName, cycleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}

export {ThemeProvider, useTheme, THEMES};
export default ThemeContext;
