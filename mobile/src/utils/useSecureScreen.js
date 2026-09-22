/**
 * Block screenshots while sensitive content is on screen.
 *
 * Wraps the SecureScreenModule native module, which sets FLAG_SECURE on the
 * activity window: Android then refuses to screenshot it, excludes it from
 * screen recording, and shows a blank card in the recent-apps switcher rather
 * than a live preview.
 *
 * Used on every screen that puts a recovery phrase in front of the user — the
 * reveal, the restore entry, and the verification quiz. On all three the
 * phrase is the whole identity in plain text, and a screenshot of any of them
 * sitting in a gallery that syncs to a cloud hands that identity to whoever
 * can read the gallery.
 *
 * iOS has no equivalent flag, so this is Android-only by nature. Callers get
 * back whether protection is actually in place rather than assuming it.
 */

import {useEffect, useState} from 'react';
import {NativeModules, Platform} from 'react-native';

const {SecureScreen} = NativeModules;

/** Is the native module present in this build? */
export const SECURE_SCREEN_AVAILABLE =
  Platform.OS === 'android' && !!SecureScreen && typeof SecureScreen.acquire === 'function';

/**
 * Hold the screen secure for as long as the component is mounted.
 *
 * @returns {{secured: boolean, available: boolean}} whether protection is
 *   actually applied, so a screen can warn the user if it is not rather than
 *   implying a guarantee it has not got.
 */
export function useSecureScreen() {
  return useSecureScreenWhen(true);
}

/**
 * Hold the screen secure only while `active` is true.
 *
 * A hook cannot be called conditionally, so screens that show a phrase for
 * part of their life — the setup flow reveals it on two of three steps — pass
 * the condition in rather than calling this from inside a branch.
 */
export function useSecureScreenWhen(active) {
  const [secured, setSecured] = useState(false);

  useEffect(() => {
    if (!SECURE_SCREEN_AVAILABLE || !active) {
      setSecured(false);
      return undefined;
    }

    let cancelled = false;
    SecureScreen.acquire()
      .then(() => {
        if (!cancelled) setSecured(true);
      })
      .catch(() => {
        // No activity, or the window refused the flag. Report honestly.
        if (!cancelled) setSecured(false);
      });

    return () => {
      cancelled = true;
      // Reference counted natively, so releasing here cannot drop the flag
      // while another secure screen is still mounted.
      SecureScreen.release().catch(() => {});
    };
  }, [active]);

  return {secured, available: SECURE_SCREEN_AVAILABLE};
}

export default useSecureScreen;
