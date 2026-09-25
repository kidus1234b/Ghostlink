/**
 * Runs every assertion suite and reports all of them.
 *
 * `test:all` used to be one long `&&` chain, so the first failure stopped the
 * run and everything after it silently never executed — at one point nine
 * suites were being skipped because an early one broke. This runs each suite
 * regardless and fails at the end if any did.
 */
import {readdirSync, mkdtempSync, rmSync} from 'fs';
import os from 'os';
import {spawnSync} from 'child_process';
import {fileURLToPath} from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));

// The run-manual-* and simulate-* scripts are interactive or long-running
// demonstrations, not assertion suites.
const suites = readdirSync(here)
  .filter(f => f.endsWith('-test.js') && !f.startsWith('run-manual') && !f.startsWith('simulate'))
  .sort();

const results = [];
for (const suite of suites) {
  // NODE_ENV=test turns on the internal invariant assertions (see
  // ASSERT_BOUNDARIES in claim-log.ts), so a suite that trips one fails loudly
  // rather than carrying on with a broken offset.
  //
  // GMP_DATA_DIR gives each suite its own throwaway state directory. Without
  // it every suite that builds a node wrote nonce claim logs, nonce-state.json
  // and peer-cache.json into the developer's real gmp-core/data (one new claim
  // log pair per identity per run), and suites could see each other's state.
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'gmp-suite-'));
  const r = spawnSync(process.execPath, [path.join(here, suite)], {
    encoding: 'utf8',
    timeout: 180000,
    env: {...process.env, NODE_ENV: 'test', GMP_DATA_DIR: dataDir},
  });
  rmSync(dataDir, {recursive: true, force: true});
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/Results: (\d+) passed, (\d+) failed/) || out.match(/=== (\d+)\/(\d+) passed/);
  const skipped = /=== skipped ===/.test(out);
  results.push({
    suite,
    ok: r.status === 0,
    passed: m ? Number(m[1]) : 0,
    skipped,
    out,
  });
}

let total = 0;
const failed = [];
for (const r of results) {
  total += r.passed;
  const label = r.skipped ? 'SKIP' : r.ok ? 'ok  ' : 'FAIL';
  if (!r.ok) failed.push(r);
  console.log(`  ${label}  ${r.suite.padEnd(34)} ${r.passed ? r.passed + ' assertions' : ''}`);
}

console.log(`\n  ${results.length} suites, ${total} assertions, ${failed.length} failing`);
for (const f of failed) {
  console.log(`\n──── ${f.suite} ────`);
  console.log(f.out.split('\n').filter(l => !l.includes('"component":')).slice(-14).join('\n'));
}
process.exit(failed.length ? 1 : 0);
