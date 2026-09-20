/**
 * Child process for the multi-process claim test: claims one fingerprint
 * against a shared state file, then exits. Run concurrently with siblings.
 */
import { NonceStore } from '../../dist/nonce-store.js';

const [stateFile, seed, fingerprint, holdMs] = process.argv.slice(2);

const store = new NonceStore({ stateFile, seedPhrase: seed });
// Load up front, as link.js does at startup, then sit on that snapshot — this
// is what makes the unsynchronised read-modify-write lose data.
store.load();

if (Number(holdMs) > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
}

const result = store.claimSessionKey(Buffer.alloc(64, 9), fingerprint);
store.close();

process.send?.({ fingerprint, valid: result.valid });
process.exit(result.valid ? 0 : 1);
