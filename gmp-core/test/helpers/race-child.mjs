/**
 * Child for the concurrent-claim race: both children claim the SAME
 * fingerprint, synchronised on a wall-clock start time so they pass the
 * unlocked has() check before either reaches the lock.
 */
import { NonceStore } from '../../dist/nonce-store.js';

const [stateFile, seed, fingerprint, startAt] = process.argv.slice(2);

const store = new NonceStore({ stateFile, seedPhrase: seed });
store.load();   // both load an empty log: neither sees the other's claim yet

const wait = Number(startAt) - Date.now();
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);

const result = store.claimSessionKey(Buffer.alloc(64, 4), fingerprint);
store.close();
process.send?.({ valid: result.valid, reason: result.reason ?? null });
process.exit(0);
