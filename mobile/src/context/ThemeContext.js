import React, {createContext, useContext, useState, useCallback} from 'react';

const THEMES = {
  phantom: {
    name: 'Phantom',
    bg: '#0a0a0f',
    bgSecondary: '#12121a',
    bgTertiary: '#1a1a25',
    accent: '#00ffa3',
    accentDim: 'rgba(0,255,163,0.15)',
    text: '#e0e0e0',
    textSecondary: '#8a8a9a',
    textMuted: '#5a5a6a',
    border: 'rgba(255,255,255,0.06)',
    danger: '#ff4466',
    success: '#00ffa3',
    warning: '#ffaa00',
  },
  crimson: {
    name: 'Crimson',
    bg: '#0f0a0a',
    bgSecondary: '#1a1212',
    bgTertiary: '#251a1a',
    accent: '#ff4466',
    accentDim: 'rgba(255,68,102,0.15)',
    text: '#e0e0e0',
    textSecondary: '#8a8a9a',
    textMuted: '#5a5a6a',
    border: 'rgba(255,255,255,0.06)',
    danger: '#ff4466',
    success: '#00ffa3',
    warning: '#ffaa00',
  },
  arctic: {
    name: 'Arctic',
    bg: '#0a0d0f',
    bgSecondary: '#121518',
    bgTertiary: '#1a1e22',
    accent: '#44ddff',
    accentDim: 'rgba(68,221,255,0.15)',
    text: '#e0e0e0',
    textSecondary: '#8a8a9a',
    textMuted: '#5a5a6a',
    border: 'rgba(255,255,255,0.06)',
    danger: '#ff4466',
    success: '#00ffa3',
    warning: '#ffaa00',
  },
  void: {
    name: 'Void',
    bg: '#050508',
    bgSecondary: '#0d0d12',
    bgTertiary: '#15151c',
    accent: '#8866ff',
    accentDim: 'rgba(136,102,255,0.15)',
    text: '#e0e0e0',
    textSecondary: '#8a8a9a',
    textMuted: '#5a5a6a',
    border: 'rgba(255,255,255,0.06)',
    danger: '#ff4466',
    success: '#00ffa3',
    warning: '#ffaa00',
  },
};

const ThemeContext = createContext();

export function ThemeProvider({children}) {
  const [themeName, setThemeName] = useState('phantom');

  const theme = THEMES[themeName];

  const cycleTheme = useCallback(() => {
    const keys = Object.keys(THEMES);
    const idx = keys.indexOf(themeName);
    setThemeName(keys[(idx + 1) % keys.length]);
  }, [themeName]);

  return (
    <ThemeContext.Provider value={{theme, themeName, setThemeName, cycleTheme, THEMES}}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be inside ThemeProvider');
  return ctx;
}

export {THEMES};
export default ThemeContext;
