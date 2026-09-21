/**
 * Upgrading over an existing install must not cost the user their settings.
 *
 * These run the real migration against the shapes actually found on devices:
 * a v1 store from the shipped app, a store carrying keys this build removed,
 * a store from a newer build, and junk.
 */
import {migrateSettings, SETTINGS_VERSION, DEFAULT_SETTINGS, parseStoredState} from '../src/utils/settings-migration.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };

// What versionCode 5 actually wrote: no settingsVersion, and encLevel present.
const v1 = {
  theme: 'blood',
  fontSize: 20,
  notifications: false,
  sounds: true,
  readReceipts: true,
  encLevel: 'triple',
  p2pRelay: false,
};

const m = migrateSettings(v1);
ok(m.settingsVersion === SETTINGS_VERSION, `An unversioned store is treated as v1 and brought to v${SETTINGS_VERSION}`);
ok(!('theme' in m), 'The removed theme choice is dropped — one palette now');
ok(m.fontSize === 20, 'A chosen font size survives the upgrade (it is real)');
ok(!('sounds' in m) && !('p2pRelay' in m), 'The other dead toggles are dropped too');
ok(!('notifications' in m), 'The dead notifications toggle is dropped');
ok(!('readReceipts' in m), 'The dead readReceipts toggle is dropped');
ok(!('encLevel' in m), 'The removed encLevel key is dropped');
ok(m.meshBridgeUrl === '', 'The new meshBridgeUrl key gets its default');

// A key this build has never heard of must not be discarded.
const withUnknown = migrateSettings({...v1, somethingFromLater: 'keep me'});
ok(withUnknown.somethingFromLater === 'keep me', 'An unrecognised key is preserved, not dropped');

// A theme that no longer exists must not crash; ThemeContext falls back.
const goneTheme = migrateSettings({...v1, theme: 'sunset-that-was-removed'});
ok(!('theme' in goneTheme), 'A theme name from any build — known or not — is dropped silently, never a crash');

// Downgrade: a newer store read by an older build.
const newer = migrateSettings({settingsVersion: 99, theme: 'neon', futureThing: 1});
ok(newer.futureThing === 1, 'A newer store keeps its values on downgrade');
ok(newer.settingsVersion === 99, 'and its version is not forced backwards');

// Already current: idempotent.
const twice = migrateSettings(migrateSettings(v1));
ok(JSON.stringify(twice) === JSON.stringify(m), 'Migrating twice changes nothing');

// Junk must yield defaults rather than throwing into the hydrate.
for (const [label, input] of [['null', null], ['a string', 'nonsense'], ['an array', [1, 2]]]) {
  let threw = false, out = null;
  try { out = migrateSettings(input); } catch { threw = true; }
  ok(!threw && out && out.theme === DEFAULT_SETTINGS.theme, `${label} yields defaults instead of throwing`);
}

// A failing step must not hand back a half-migrated object.
const real = {...v1};
const frozen = JSON.stringify(real);
migrateSettings(real);
ok(JSON.stringify(real) === frozen, 'The stored object is never mutated in place');


// ── Case A: a corrupt value must not cost the user their identity ──────────
const toMap = o => new Map(Object.entries(o));
const goodIdentity = JSON.stringify({name: 'Existing User', fingerprint: 'ab12cd34'});

{
  // The exact upgrade hazard: messages half-written when the app was killed.
  const {restored, lost} = parseStoredState({
    identity: goodIdentity,
    messages: '{"room1":[{"id":"m1","text":"hel',   // truncated
    settings: JSON.stringify({theme: 'ocean', fontSize: 18}),   // a real v1 store
    peers: JSON.stringify({p1: {name: 'Peer'}}),
  }, toMap);

  ok(restored.identity?.name === 'Existing User', 'A corrupt messages blob does NOT cost the user their identity');
  ok(lost.includes('messages'), 'The unreadable key is named');
  ok(restored.settings?.fontSize === 18, 'and the other keys still restore, migrated to v3');
  ok(restored.peers instanceof Map, 'including the peer list');
  ok(!('messages' in restored), 'The corrupt key is simply absent, not guessed at');
}

{
  // Nothing stored at all — a genuinely new user.
  const {restored, lost} = parseStoredState({}, toMap);
  ok(Object.keys(restored).length === 0 && lost.length === 0, 'A fresh install restores nothing and reports no loss');
}

{
  // Everything unreadable: still must not throw.
  let threw = false;
  try { parseStoredState({identity: '{{{', messages: 'nope'}, toMap); } catch { threw = true; }
  ok(!threw, 'Even an entirely unreadable store does not throw into the hydrate');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
