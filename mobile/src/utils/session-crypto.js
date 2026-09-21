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
 * RELATION TO THE WEB CLIENT
 *
 * The web seals each chat payload with sealPayload() — ephemeral-static ECIES
 * to the recipient's P-256 key (index.html:1139) — applied by the caller before
 * the transport sees it. This module is a *session* layer instead, applied by
 * the transport, because mobile needs the direct channel itself to be safe
 * rather than trusting every caller to remember to seal.
 *
 * That means the two are NOT wire-compatible for message bodies: a web client
 * and a mobile client on a direct data channel would each encrypt in a form the
 * other does not read. Closing that is a separate piece of work — mobile would
 * adopt the ECIES seal — and is noted in MOBILE_BUILD.md.
 *
 * Note that src/crypto/key-manager.js is NOT the web's peer encryption. It
 * derives with `PBKDF2(masterKey, salt = ...-${Date.now()})`, which two peers
 * could never agree on; it is used only by the self-test and the licensing
 * code, never on the messaging path.
 *
 * The cipher and the wire shape follow the web's — AES-256-GCM with a fresh
 * 12-byte IV per message. The key derivation does not: the input here is an
 * X25519 shared secret, already uniformly random, so HKDF is the right
 * primitive and a PBKDF2 iteration count would buy nothing but latency.
 *
 *     shared  = X25519(ourPrivate, theirPublic)          // same on both sides
 *     lo, hi  = the two node ids, sorted                 // same on both sides
 *     key A→B = HKDF-SHA256(shared, salt, info = `ghostlink-v2-${lo}->${hi}`)
 *     key B→A = HKDF-SHA256(shared, salt, info = `ghostlink-v2-${hi}->${lo}`)
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
import {hkdf} from '@noble/hashes/hkdf';
import {sha256} from '@noble/hashes/sha256';
import {gcm} from '@noble/ciphers/aes';

/** AES-GCM standard nonce length. Also what the web client uses. */
const IV_BYTES = 12;
/**
 * Bumped when the derivation or the wire shape changes.
 *
 *   1 — PBKDF2-HMAC-SHA256, 100k iterations
 *   2 — HKDF-SHA256 (current)
 *
 * A v1 peer and a v2 peer derive different keys, so raising this is what makes
 * the mismatch fail cleanly at the version check instead of surfacing as an
 * authentication error on every frame.
 */
const WIRE_VERSION = 2;
/** Domain separation for the HKDF extract step. */
const HKDF_SALT = 'ghostlink-session-v2';

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

  // HKDF, not PBKDF2. PBKDF2's iteration count exists to make guessing a
  // low-entropy password expensive; an X25519 shared secret has nothing to
  // guess, so the work was pure latency on every session. HKDF is the
  // primitive for this job: extract the secret to a uniform key, then expand
  // it once per direction with the peer pair in the info field.
  const salt = encoder.encode(HKDF_SALT);
  const forwardKey = hkdf(sha256, shared, salt, encoder.encode(forward), 32);
  const backwardKey = hkdf(sha256, shared, salt, encoder.encode(backward), 32);

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

/**
 * Is this object one of our sealed envelopes — of ANY version?
 *
 * Deliberately shape-based, not version-based. Matching on WIRE_VERSION meant a
 * peer still on v1 produced frames this predicate rejected, so the transport
 * took them for ordinary traffic and emitted the ciphertext object as a chat
 * message tagged `webrtc-plain`. A rolling upgrade would have surfaced protocol
 * frames in the conversation instead of failing cleanly.
 *
 * Recognising the shape keeps every envelope on the encrypted path;
 * decryptMessage() stays the single authority on which versions are readable.
 */
export function isEncryptedEnvelope(value) {
  return !!value && typeof value === 'object' &&
    typeof value.v === 'number' &&
    typeof value.iv === 'string' && typeof value.ct === 'string';
}

export const WIRE = {VERSION: WIRE_VERSION, IV_BYTES, KDF: 'HKDF-SHA256'};
