import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * The gmp-core package root, found by walking up from this module until a
 * package.json appears. This module is compiled to dist/, so a naive
 * `path.join(__dirname, 'data')` resolves to dist/data — a directory that does
 * not hold the checked-in peer list. Walking to the package root gives the same
 * answer whether the caller is running dist/*.js, src/*.ts under ts-node, or an
 * installed copy under node_modules, and it does not depend on process.cwd():
 * the bridge is launched from the repo root, from electron/, and from Railway's
 * container, and all three must read one file.
 */
function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No package.json anywhere above us: dist/ and src/ are both one level down
  // from the root, so the parent is the best available guess.
  return path.resolve(start, '..');
}

export const PACKAGE_ROOT = findPackageRoot(__dirname);

/**
 * Where the node's mutable state lives. GMP_DATA_DIR moves the whole directory
 * — useful for a container with a mounted volume, and for tests that must not
 * touch the developer's real peer cache.
 */
export const DATA_DIR = process.env.GMP_DATA_DIR
  ? path.resolve(process.env.GMP_DATA_DIR)
  : path.join(PACKAGE_ROOT, 'data');

export function dataPath(...segments: string[]): string {
  return path.join(DATA_DIR, ...segments);
}

/**
 * The public peer list. GMP_PUBLIC_PEERS_PATH overrides it outright — the app's
 * own "no public peer" guidance tells the user to set this, so it has to work.
 */
export const PUBLIC_PEERS_FILE = process.env.GMP_PUBLIC_PEERS_PATH
  ? path.resolve(process.env.GMP_PUBLIC_PEERS_PATH)
  : dataPath('public-peers.json');

export const PEER_CACHE_FILE = process.env.GMP_PEER_CACHE_PATH
  ? path.resolve(process.env.GMP_PEER_CACHE_PATH)
  : dataPath('peer-cache.json');

export const NONCE_STATE_FILE = process.env.GMP_NONCE_STATE_PATH
  ? path.resolve(process.env.GMP_NONCE_STATE_PATH)
  : dataPath('nonce-state.json');

export const CONFIG_FILE = process.env.GMP_CONFIG_PATH
  ? path.resolve(process.env.GMP_CONFIG_PATH)
  : dataPath('config.json');
