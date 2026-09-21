/**
 * GhostLink Mobile — settings schema and migration.
 *
 * Kept out of AppContext so it can be tested directly: an upgrade path that
 * is only exercised by installing one APK over another is an upgrade path
 * nobody checks until it has already lost somebody's preferences.
 */

export const DEFAULT_SETTINGS = {
  settingsVersion: 3,
  /**
   * Ghost Mesh bridge, e.g. ws://192.168.1.15:3002. Empty means no mesh.
   *
   * One bridge process serves one identity (see gmp-bridge.ts), so this must
   * point at a bridge started with THIS phone's seed — never the desktop's, or
   * the two become the same node instead of two peers. An interop-testing
   * facility, not a shipping feature; see MOBILE_BUILD.md.
   */
  meshBridgeUrl: '',
  /**
   * Base text size. Real: it drives the chat bubbles and the rest of the UI
   * through ThemeContext, not just this screen.
   */
  fontSize: 16,
};


/**
 * Settings schema version. Bump when the SHAPE or the MEANING of a stored
 * value changes, and add a step to SETTINGS_MIGRATIONS for it.
 *
 *   1 — original: theme, fontSize, notifications, sounds, readReceipts,
 *       encLevel, p2pRelay
 *   2 — meshBridgeUrl added; encLevel removed (it named three modes the
 *       crypto never had)
 *   3 — the five mobile themes collapse to the single product palette, and
 *       the toggles with no implementation behind them are dropped:
 *       readReceipts (needs a peer-facing protocol message and there is no
 *       transport yet), sounds and notifications (push is a no-op without
 *       Firebase), p2pRelay (never read by anything).
 */
export const SETTINGS_VERSION = 3;

/**
 * One function per version step, applied in order. Each takes the settings as
 * the previous version understood them and returns the next version's shape.
 *
 * Steps must be total: an upgrade runs against whatever is actually on the
 * device, which includes values this build has never heard of. Nothing here
 * may throw on an unexpected key — migrateSettings() falls back to defaults if
 * one does, and falling back means the user silently loses their preferences.
 */
export const SETTINGS_MIGRATIONS = {
  // v1 → v2
  2: prev => {
    const {encLevel, ...rest} = prev;
    return {...rest, meshBridgeUrl: typeof prev.meshBridgeUrl === 'string' ? prev.meshBridgeUrl : ''};
  },

  /**
   * v2 → v3
   *
   * GhostLink is one product on every platform, so mobile drops its five
   * palettes for the one the web and PC use. Whatever the user had chosen —
   * phantom, neon, blood, ocean, cyber, or something a future build invented —
   * is simply forgotten; there is one palette now and nothing to choose.
   *
   * The dropped toggles are the ones the audit found had no consumer: each
   * wrote a value that nothing ever read, so removing them changes no
   * behaviour at all. They return when the thing behind them exists.
   */
  3: prev => {
    const {theme, readReceipts, sounds, notifications, p2pRelay, ...rest} = prev;
    return rest;
  },
};

/**
 * Bring a stored settings object up to the current schema.
 *
 * Unrecognised keys are kept rather than dropped: a value this build does not
 * know may belong to a newer build the user downgraded from, and throwing it
 * away would lose their preference permanently. Unrecognised *values* are the
 * caller's problem to validate — see ThemeContext, which falls back to the
 * default palette for a theme name it does not have.
 */
export function migrateSettings(stored) {
  if (!stored || typeof stored !== 'object') return {...DEFAULT_SETTINGS};

  let working = {...stored};
  const from = Number.isInteger(working.settingsVersion) ? working.settingsVersion : 1;

  if (from > SETTINGS_VERSION) {
    // Downgrade: this build cannot know what a newer key means. Merge over
    // defaults and keep everything, rather than discarding the user's state.
    console.warn(
      `[AppContext] settings are version ${from}, this build understands ${SETTINGS_VERSION}. ` +
      'Keeping the stored values and filling in anything missing.',
    );
    return {...DEFAULT_SETTINGS, ...working, settingsVersion: from};
  }

  for (let v = from + 1; v <= SETTINGS_VERSION; v++) {
    const step = SETTINGS_MIGRATIONS[v];
    if (!step) continue;
    try {
      working = step(working);
    } catch (err) {
      // Non-destructive: the stored copy on disk is untouched, and the next
      // launch will try again. Better to run on defaults for this session than
      // to write a half-migrated object back over good data.
      console.error(`[AppContext] settings migration to v${v} failed; using defaults this session:`, err);
      return {...DEFAULT_SETTINGS};
    }
  }

  return {...DEFAULT_SETTINGS, ...working, settingsVersion: SETTINGS_VERSION};
}


/**
 * Turn the five raw storage values into state, without letting one bad value
 * cost the user the other four.
 *
 * Previously these were parsed inside a single try whose last statement was the
 * dispatch, so one unparseable value — a messages blob from a write interrupted
 * by a kill — meant nothing at all was applied. A user with a perfectly good
 * identity on disk was dropped onto the setup screen as if they were new.
 *
 * Returns what could be read and names what could not. Nothing is deleted:
 * unreadable bytes may still be recoverable, and discarding them is not a
 * decision to take silently.
 *
 * @param {{identity?: string, messages?: string, settings?: string, peers?: string, ghostMesh?: string}} raw
 * @param {(obj: object) => Map} toMap how the caller turns a plain object back into a Map
 * @returns {{restored: object, lost: string[]}}
 */
export function parseStoredState(raw, toMap) {
  const restored = {};
  const lost = [];

  const take = (key, value, parse) => {
    if (!value) return;
    try {
      restored[key] = parse(value);
    } catch (err) {
      lost.push(key);
      console.error(`[AppContext] could not restore ${key}; the stored copy is left untouched:`, err);
    }
  };

  take('identity', raw.identity, JSON.parse);
  take('messages', raw.messages, v => toMap(JSON.parse(v)));
  take('settings', raw.settings, v => migrateSettings(JSON.parse(v)));
  take('peers', raw.peers, v => toMap(JSON.parse(v)));
  take('ghostMesh', raw.ghostMesh, JSON.parse);

  return {restored, lost};
}
