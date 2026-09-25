/**
 * Point this test process's node state at a throwaway directory.
 *
 * paths.ts resolves DATA_DIR once, at import time, from GMP_DATA_DIR — and
 * falls back to the real gmp-core/data. Suites run directly (the root
 * `npm test` does this) therefore wrote nonce claim logs, nonce-state.json and
 * peer-cache.json into the developer's own data directory. Import this module
 * FIRST: ES modules evaluate in import order, so the variable is set before
 * any dist module reads it. An explicit GMP_DATA_DIR (run-all.mjs sets one per
 * suite) is left alone.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

if (!process.env.GMP_DATA_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmp-test-data-'));
  process.env.GMP_DATA_DIR = dir;
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}
