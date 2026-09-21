/**
 * GhostLink Mobile — app-layer session encryption for the direct WebRTC path.
 *
 * WHY THIS EXISTS
 *
 * A message can reach a peer two ways. Through the Ghost Mesh bridge it is
 * encrypted by GMP end to end and this module is not involved. Through a direct
 * WebRTC data channel it is not: WebRTC gives DTLS, which protects each hop,
 * so anything relaying the connection — a TURN server, or whoever runs it —
 * handles plaintext. That is not end-to-end, and a chat that showed a padlock
 * over it would be lying.
 *
 * So the direct path gets its own layer, and the padlock follows the path the
 * message actually took rather than the app in general.
 *
 * WHY NOT REUSE THE WEB'S KeyManager VERBATIM
 *
 * src/crypto/key-manager.js derives its session keys as
 *
 *     PBKDF2(masterKey, salt = `ghostlink-send-${peerId}-${Date.now()}`)
 *
 * The timestamp is taken locally at initSession(), so two peers deriving
 * independently get different keys and can never read each other. It works
 * there because each side encrypts for storage rather than for the other side.
 * The primitive and the wire shape are reused exactly — AES-256-GCM, a fresh
 * 12-byte IV per message, PBKDF2-HMAC-SHA256 at 100,000 iterations — but the
 * salt is replaced with something both ends can compute:
 *
 *     shared  = X25519(ourPrivate, theirPublic)          // same on both sides
 *     lo, hi  = the two node ids, sorted                 // same on both sides
 *     key A→B = PBKDF2(shared, `ghostlink-v1-${lo}->${hi}`)
 *     key B→A = PBKDF2(shared, `ghostlink-v1-${hi}->${lo}`)
 *
 * Sorting the ids is what makes the pair symmetric without either side needing
 * to know which of them "started" — each takes the arrow pointing away from
 * itself as its send key, and the other as its receive key, and the two agree.
 *
 * WHAT THIS IS NOT
 *
 * There is no forward secrecy and no ratchet: one key pair per session, derived
 * once. It is the floor that makes the padlock honest on the direct path, not a
 * replacement for GMP, which remains the path with the real guarantees.
 */

import {x25519} from '@noble/curves/ed25519';
import {pbkdf2Async} from '@noble/hashes/pbkdf2';
import {sha256} from '@noble/hashes/sha256';
import {gcm} from '@noble/ciphers/aes';

/** Matches the web client's KeyManager.deriveKey. */
const PBKDF2_ITERATIONS = 100000;
/** AES-GCM standard nonce length. Also what the web client uses. */
const IV_BYTES = 12;
/** Bumped if the derivation or the wire shape ever changes. */
const WIRE_VERSION = 1;

const encoder = new TextEncoder();

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new Error('expected an even-length hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) throw new Error('invalid hex');
    out[i] = byte;
  }
  return out;
}

/** A fresh X25519 keypair for one session. */
export function generateSessionKeyPair() {
  const privateKey = x25519.utils.randomPrivateKey();
  return {privateKey, publicKey: x25519.getPublicKey(privateKey), publicKeyHex: toHex(x25519.getPublicKey(privateKey))};
}

/**
 * Derive the directional keys for a peer pair.
 *
 * Both sides call this with their own private key and the other's public key
 * and arrive at the same two keys, mirrored: our send key is their receive key.
 *
 * @param {Uint8Array} ourPrivateKey
 * @param {Uint8Array|string} theirPublicKey raw bytes or hex
 * @param {string} ourId our node id / peer id
 * @param {string} theirId their node id / peer id
 * @returns {Promise<{sendKey: Uint8Array, recvKey: Uint8Array}>}
 */
export async function deriveSessionKeys(ourPrivateKey, theirPublicKey, ourId, theirId) {
  if (!ourId || !theirId) throw new Error('both peer ids are required to derive session keys');
  if (ourId === theirId) throw new Error('refusing to derive a session with ourselves');

  const theirKey = typeof theirPublicKey === 'string' ? fromHex(theirPublicKey) : theirPublicKey;
  const shared = x25519.getSharedSecret(ourPrivateKey, theirKey);

  // Sorted so that neither side needs to know who dialled whom.
  const [lo, hi] = ourId < theirId ? [ourId, theirId] : [theirId, ourId];
  const forward = `ghostlink-v${WIRE_VERSION}-${lo}->${hi}`;
  const backward = `ghostlink-v${WIRE_VERSION}-${hi}->${lo}`;

  const [forwardKey, backwardKey] = await Promise.all([
    pbkdf2Async(sha256, shared, encoder.encode(forward), {c: PBKDF2_ITERATIONS, dkLen: 32}),
    pbkdf2Async(sha256, shared, encoder.encode(backward), {c: PBKDF2_ITERATIONS, dkLen: 32}),
  ]);

  // We send along the arrow that points away from us.
  return ourId === lo
    ? {sendKey: forwardKey, recvKey: backwardKey}
    : {sendKey: backwardKey, recvKey: forwardKey};
}

/**
 * Seal a string for the peer.
 *
 * @param {string} plaintext
 * @param {Uint8Array} sendKey
 * @returns {{v: number, iv: string, ct: string}} safe to JSON.stringify onto the wire
 */
export function encryptMessage(plaintext, sendKey) {
  if (!sendKey) throw new Error('no session key: refusing to send unencrypted');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = gcm(sendKey, iv).encrypt(encoder.encode(String(plaintext)));
  return {v: WIRE_VERSION, iv: toHex(iv), ct: toHex(ciphertext)};
}

/**
 * Open a sealed envelope from the peer.
 *
 * Throws rather than returning anything on failure — a frame that will not
 * authenticate is either tampered with or from a session we do not hold, and
 * both cases have to reach the caller rather than surface as a message.
 *
 * @param {{v: number, iv: string, ct: string}} envelope
 * @param {Uint8Array} recvKey
 * @returns {string}
 */
export function decryptMessage(envelope, recvKey) {
  if (!recvKey) throw new Error('no session key for this peer');
  if (!envelope || typeof envelope !== 'object') throw new Error('not an encrypted envelope');
  if (envelope.v !== WIRE_VERSION) throw new Error(`unsupported envelope version ${envelope.v}`);
  const plaintext = gcm(recvKey, fromHex(envelope.iv)).decrypt(fromHex(envelope.ct));
  return new TextDecoder().decode(plaintext);
}

/** Is this object one of our sealed envelopes? */
export function isEncryptedEnvelope(value) {
  return !!value && typeof value === 'object' && value.v === WIRE_VERSION &&
    typeof value.iv === 'string' && typeof value.ct === 'string';
}

export const WIRE = {VERSION: WIRE_VERSION, IV_BYTES, PBKDF2_ITERATIONS};
