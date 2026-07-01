/**
 * GMP Identity Module — Phase 1
 * Platform-independent X25519/Ed25519 key derivation for Ghost Mesh Protocol.
 *
 * Uses @noble/curves (audited, pure-JS) for all elliptic curve operations.
 * Must produce byte-for-byte identical output on web, Electron, and mobile.
 *
 * Key derivation matches the existing GhostLink Yggdrasil identity scheme:
 *   PBKDF2(seedPhrase, salt, 100k, SHA-256) → 32-byte seed → X25519 keypair → NodeID
 *
 * Additionally derives Ed25519 signing keys (separate from X25519 identity keys)
 * for GMP handshake signatures (see PROTOCOL_SPEC.md Section 4.6).
 */

import { x25519 } from '@noble/curves/ed25519';
import { ed25519 } from '@noble/curves/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { hkdf } from '@noble/hashes/hkdf';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import crypto from 'crypto';

const GHOST_MESH_SALT = 'ghostlink-yggdrasil-v1';
const GHOST_MESH_ITERATIONS = 100000;
const SEED_LENGTH = 32;
const SIGNING_KEY_INFO = 'ed25519-signing';

function stringToBytes(str) {
  return new TextEncoder().encode(str);
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export async function deriveIdentityFromSeedPhrase(seedPhrase) {
  /**
   * Step 1: PBKDF2 → 32-byte seed
   */
  const saltBytes = stringToBytes(GHOST_MESH_SALT);
  const phraseBytes = stringToBytes(seedPhrase);

  const seed = pbkdf2(sha512, phraseBytes, saltBytes, { c: GHOST_MESH_ITERATIONS, dkLen: SEED_LENGTH });

  /**
   * Step 2: X25519 keypair from seed (static identity)
   */
  const staticPrivKey = seed;
  const staticPubKey = x25519.getPublicKey(staticPrivKey);

  /**
   * Step 3: NodeID = SHA-512(staticPubKey)
   */
  const nodeId = sha512(staticPubKey);

  /**
   * Step 4: Derive Ed25519 signing keypair from the same seed
   * Ed25519Priv = HMAC-SHA512("ed25519-signing", seed)
   */
  const ed25519PrivKey = hmac(sha512, stringToBytes(SIGNING_KEY_INFO), seed);
  const signingPrivKey = ed25519PrivKey.slice(0, 32);
  const signingPubKey = ed25519.getPublicKey(signingPrivKey);

  return {
    seed,
    staticPrivKey,
    staticPubKey,
    nodeId,
    signingPrivKey,
    signingPubKey,
    nodeIdHex: bytesToHex(nodeId),
    staticPubKeyHex: bytesToHex(staticPubKey),
    signingPubKeyHex: bytesToHex(signingPubKey),
    staticPrivKeyHex: bytesToHex(staticPrivKey),
    signingPrivKeyHex: bytesToHex(signingPrivKey),
  };
}

export function generateEphemeralKeyPair() {
  /**
   * Generate a fresh X25519 ephemeral keypair for a single connection.
   * Must be unique per connection to provide forward secrecy.
   */
  const ephemeralPriv = crypto.randomBytes(32);
  const ephemeralPub = x25519.getPublicKey(new Uint8Array(ephemeralPriv));
  return { ephemeralPriv, ephemeralPub };
}

export function x25519DeriveSharedSecret(localPrivKey, remotePubKey) {
  /**
   * X25519 ECDH: compute shared secret from local private and remote public.
   * Returns a 32-byte shared secret.
   */
  return x25519.getSharedSecret(new Uint8Array(localPrivKey), new Uint8Array(remotePubKey));
}

export function deriveSessionKeys(sharedSecret, initiatorNodeId, responderNodeId) {
  /**
   * Derive initiatorKey and responderKey from shared secret using HKDF.
   * info binds the keys to the specific pair of NodeIDs and their roles.
   *
   * HKDF parameters (per @noble/hashes):
   *   hkdf(hash, ikm, salt?, info?, length?)
   * - ikm: Input Key Material (the shared secret from X25519 ECDH)
   * - salt: Randomizing factor (we use null for no salt, using only IKM)
   * - info: Context-specific info (we bind the NodeIDs and role here)
   *
   * initiatorKey is derived with info = "ghost-mesh-hkdf-phase1-initiator" || initiatorNodeId || responderNodeId
   * responderKey is derived with info = "ghost-mesh-hkdf-phase1-responder" || initiatorNodeId || responderNodeId
   */
  // Convert sharedSecret to Uint8Array if it isn't already (ensure type correctness)
  const ikm = sharedSecret instanceof Uint8Array ? sharedSecret : new Uint8Array(sharedSecret);

  const initiatorInfo = stringToBytes(
    'ghost-mesh-hkdf-phase1-initiator' +
    bytesToHex(initiatorNodeId) +
    bytesToHex(responderNodeId)
  );

  const responderInfo = stringToBytes(
    'ghost-mesh-hkdf-phase1-responder' +
    bytesToHex(initiatorNodeId) +
    bytesToHex(responderNodeId)
  );

  // HKDF: hash=sha512, ikm=sharedSecret, salt=undefined (use default), info=initiatorInfo, length=32
  // Note: passing null for salt would cause toBytes(null) to throw; must use undefined to trigger default salt
  const initiatorKey = hkdf(sha512, ikm, undefined, initiatorInfo, 32);
  const responderKey = hkdf(sha512, ikm, undefined, responderInfo, 32);

  return { initiatorKey, responderKey };
}

export function signMessage(privKey, message) {
  /**
   * Ed25519 sign a message using the node's signing private key.
   */
  return ed25519.sign(new Uint8Array(message), new Uint8Array(privKey));
}

export function verifySignature(pubKey, message, signature) {
  /**
   * Ed25519 verify a signature.
   * Returns true if valid, false if invalid.
   */
  return ed25519.verify(new Uint8Array(signature), new Uint8Array(message), new Uint8Array(pubKey));
}

export function deriveEphemeralKeyPairFromPriv(ephemeralPriv) {
  const ephemeralPub = x25519.getPublicKey(new Uint8Array(ephemeralPriv));
  return { ephemeralPriv: new Uint8Array(ephemeralPriv), ephemeralPub: new Uint8Array(ephemeralPub) };
}

export function bytesToHexString(bytes) {
  return bytesToHex(bytes);
}

export function hexStringToBytes(hex) {
  return hexToBytes(hex);
}

export { bytesToHex, hexToBytes, concatBytes, stringToBytes, sha512 };
