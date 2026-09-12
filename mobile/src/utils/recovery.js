/**
 * GhostLink Mobile — identity recovery.
 *
 * Both restore paths funnel through one bundle shape and one unlock routine.
 * They used to be written separately and had drifted: the fragment path read
 * `blob.pubKeyHex` while setup wrote `publicKeyHex`, so it restored an identity
 * with an empty public key, and the phrase path ignored the stored key
 * altogether and minted a brand-new random identity — which looked like a
 * successful recovery while silently replacing the user's identity with one
 * none of their peers had ever seen.
 *
 * The private key is never stored unprotected. It lives wrapped in AES-256-GCM
 * under a key derived from the recovery phrase with PBKDF2, so the phrase is
 * what unlocks it, and the GCM tag is what proves the phrase was right.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {CryptoEngine, combineFragments} from './crypto';

export const RECOVERY_BUNDLE_VERSION = 1;
export const BUNDLE_STORAGE_KEY = 'gl_recovery_bundle';
export const FRAGMENTS_STORAGE_KEY = 'gl_shamir_fragments';
export const RECOVERY_TAG_PREFIX = 'ghostlink:recovery:';

/**
 * Errors carry a `code` so the UI can say which of these actually happened
 * instead of collapsing them into one "recovery failed".
 */
export const RecoveryError = {
  NO_LOCAL_BUNDLE: 'NO_LOCAL_BUNDLE',
  WRONG_PHRASE: 'WRONG_PHRASE',
  BAD_FRAGMENTS: 'BAD_FRAGMENTS',
  KEY_MISMATCH: 'KEY_MISMATCH',
  MALFORMED_BUNDLE: 'MALFORMED_BUNDLE',
};

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * The object stored on device and split into Shamir fragments. One shape for
 * both, so the two restore paths cannot disagree about field names again.
 */
export function createRecoveryBundle({wrappedKey, publicKeyHex, name, ghostAddress}) {
  return {
    v: RECOVERY_BUNDLE_VERSION,
    wrappedKey,
    publicKeyHex,
    name: name || '',
    // Carried rather than re-derived: deriving it costs another 100,000 PBKDF2
    // iterations, and it is a public name, not a secret.
    ghostAddress: ghostAddress || '',
  };
}

/**
 * Wrap a freshly generated private key under the recovery phrase and return the
 * bundle to store and to split. Used at setup.
 */
export async function wrapIdentity({privateKeyRaw, publicKeyHex, name, ghostAddress}, words) {
  const wrapKey = await CryptoEngine.deriveKeyFromSeed(words);
  const wrappedKey = CryptoEngine.encrypt(privateKeyRaw, wrapKey);
  return createRecoveryBundle({wrappedKey, publicKeyHex, name, ghostAddress});
}

/**
 * Turn a bundle plus a phrase back into a usable identity.
 *
 * A wrong phrase derives a different AES key, the GCM tag fails to verify, and
 * decrypt throws — that is the phrase check, and it costs an attacker a full
 * PBKDF2 run per guess. (Setup used to also store a bare SHA-256 of the phrase
 * beside the wrapped key, which let anyone with the device test guesses at one
 * cheap hash each and made the 100,000 PBKDF2 iterations pointless. It is gone.)
 */
export async function unlockBundle(bundle, words) {
  if (!bundle || !bundle.wrappedKey || !bundle.wrappedKey.iv || !bundle.wrappedKey.ciphertext) {
    throw fail(RecoveryError.MALFORMED_BUNDLE, 'This recovery data is missing the wrapped key.');
  }

  const wrapKey = await CryptoEngine.deriveKeyFromSeed(words);

  let privateKeyRaw;
  try {
    privateKeyRaw = CryptoEngine.decrypt(bundle.wrappedKey.ciphertext, bundle.wrappedKey.iv, wrapKey);
  } catch (_e) {
    throw fail(RecoveryError.WRONG_PHRASE, 'That recovery phrase does not unlock this identity.');
  }

  // Derive the public key from what we just unwrapped rather than trusting the
  // copy that travelled in the same blob. If they disagree, the bundle was
  // tampered with or assembled from fragments of two different identities.
  let derivedPublicKey;
  try {
    derivedPublicKey = CryptoEngine.publicKeyFromPrivate(privateKeyRaw);
  } catch (_e) {
    throw fail(RecoveryError.KEY_MISMATCH, 'The recovered private key is not a valid P-256 key.');
  }

  if (bundle.publicKeyHex && bundle.publicKeyHex !== derivedPublicKey) {
    throw fail(
      RecoveryError.KEY_MISMATCH,
      'The recovered key does not match the identity it claims to belong to.',
    );
  }

  const fingerprint = await CryptoEngine.sha256(derivedPublicKey);
  return {
    name: bundle.name || 'Restored',
    publicKeyHex: derivedPublicKey,
    privateKeyRaw,
    fingerprint: fingerprint.slice(0, 16),
    ghostAddress: bundle.ghostAddress || '',
  };
}

/**
 * The lookup key peers store a backup under, and the one a recovering device
 * asks for. Both sides derive it from the recovery phrase, which is the only
 * thing a blank device has.
 *
 * It is deliberately not the phrase itself and not a cheap hash of it. The
 * phrase would travel the network as a plaintext lookup key; a fast hash would
 * let anyone who saw a tag guess phrases at one hash apiece, undoing the
 * 100,000 PBKDF2 iterations exactly the way the old stored seed hash did.
 * Deriving through the PBKDF2 key means recovering the phrase from a tag costs
 * the same as attacking the wrapped key directly, so the tag adds no new
 * weakness. The prefix keeps it domain-separated from the key itself.
 *
 * Deriving the identity's public key instead would not work here: the device
 * doing the recovering has no identity yet — that is what it is recovering —
 * so every blank device would ask for the same constant tag.
 */
export async function deriveRecoveryTag(words) {
  const key = await CryptoEngine.deriveKeyFromSeed(words);
  const digest = await CryptoEngine.sha256('ghostlink-recovery-tag-v1:' + key);
  return RECOVERY_TAG_PREFIX + digest.slice(0, 32);
}

export async function saveRecoveryBundle(bundle) {
  await AsyncStorage.setItem(BUNDLE_STORAGE_KEY, JSON.stringify(bundle));
}

export async function loadRecoveryBundle() {
  const raw = await AsyncStorage.getItem(BUNDLE_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

/**
 * Same-device restore: the wrapped key is already here, the phrase unlocks it.
 */
export async function restoreFromPhrase(words) {
  const bundle = await loadRecoveryBundle();
  if (!bundle) {
    throw fail(
      RecoveryError.NO_LOCAL_BUNDLE,
      'There is no saved identity on this device. Restore with your recovery fragments instead.',
    );
  }
  const identity = await unlockBundle(bundle, words);
  await CryptoEngine.storeKeyPair(identity.publicKeyHex, identity.privateKeyRaw);
  return identity;
}

/**
 * New-device restore: 3 of the 7 fragments rebuild the bundle, then the phrase
 * unlocks it. Both are required — fragments alone carry only the wrapped key,
 * and the phrase alone has nothing on a fresh device to unwrap.
 */
export async function restoreFromFragments(fragmentHexes, words) {
  const combined = combineFragments(fragmentHexes);
  if (!combined.success) {
    throw fail(
      RecoveryError.BAD_FRAGMENTS,
      combined.error || 'Those fragments did not reconstruct a recovery bundle.',
    );
  }

  const identity = await unlockBundle(combined.blob, words);

  // The device is now set up: keep the bundle so a later restore here needs
  // only the phrase, and put the key in the keychain for normal use.
  await saveRecoveryBundle(createRecoveryBundle({
    wrappedKey: combined.blob.wrappedKey,
    publicKeyHex: identity.publicKeyHex,
    name: identity.name,
    ghostAddress: identity.ghostAddress,
  }));
  await CryptoEngine.storeKeyPair(identity.publicKeyHex, identity.privateKeyRaw);
  return identity;
}
