/**
 * Controls that lead nowhere must not be reachable.
 *
 * The call path has no rendezvous and the Ghost Mesh setup modal calls into a
 * crypto proxy that throws, so both are gated in utils/capabilities.js. These
 * check the gates are actually applied at the entry points — a flag nothing
 * reads is not a gate.
 *
 * Source inspection rather than a mounted render: these screens need the React
 * Native runtime, and what matters here is structural — that the entry point
 * cannot be taken while the capability is false.
 */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {
  CALLS_AVAILABLE,
  CALLS_UNAVAILABLE_REASON,
  MESH_SETUP_AVAILABLE,
  GUARDIAN_RECOVERY_AVAILABLE,
} from '../src/utils/capabilities.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = p => fs.readFileSync(path.join(here, '..', p), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };

const chat = read('src/screens/ChatScreen.js');
const settings = read('src/screens/SettingsScreen.js');

// ── Calls ──────────────────────────────────────────────────────────────────
ok(CALLS_AVAILABLE === false,
   'Calls are marked unavailable in this build');

const callButtons = chat.match(/navigation\.navigate\('Call'/g) || [];
ok(callButtons.length === 2, `Both call entry points are accounted for (found ${callButtons.length})`);

ok((chat.match(/disabled=\{!CALLS_AVAILABLE\}/g) || []).length === callButtons.length,
   'Every call button is disabled while calls are unavailable');

ok((chat.match(/if \(!CALLS_AVAILABLE\) return;/g) || []).length === callButtons.length,
   'Every call handler refuses to navigate while calls are unavailable');

ok(chat.includes('accessibilityLabel={CALLS_AVAILABLE ?'),
   'A disabled call button announces why it is disabled');

ok(CALLS_UNAVAILABLE_REASON === 'Calls unavailable until direct connection is supported',
   'The reason given to screen readers is the agreed wording');

// ── Ghost Mesh setup ───────────────────────────────────────────────────────
ok(MESH_SETUP_AVAILABLE === false,
   'Ghost Mesh setup is marked unavailable in this build');

ok(settings.includes('disabled={!MESH_SETUP_AVAILABLE}'),
   'The Ghost Mesh setup row is disabled while mesh setup is unavailable');

ok(settings.includes('if (!MESH_SETUP_AVAILABLE) return;'),
   'The Ghost Mesh setup handler refuses to open the modal');

ok(settings.includes('visible={MESH_SETUP_AVAILABLE && showMeshSetup}'),
   'The modal cannot become visible even if its state flag is set some other way');

// ── Guardian recovery ──────────────────────────────────────────────────────
ok(GUARDIAN_RECOVERY_AVAILABLE === false,
   'Guardian recovery is marked unavailable in this build');

// ── The gate must be honest about itself ───────────────────────────────────
const caps = read('src/utils/capabilities.js');
for (const flag of ['CALLS_AVAILABLE', 'MESH_SETUP_AVAILABLE', 'GUARDIAN_RECOVERY_AVAILABLE']) {
  const idx = caps.indexOf(`export const ${flag}`);
  ok(idx > 0 && caps.lastIndexOf('*/', idx) > caps.lastIndexOf('export const', idx - 1),
     `${flag} carries a documented reason, so it can be flipped deliberately`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
