import { x25519 } from '@noble/curves/ed25519';
import { ed25519 } from '@noble/curves/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { hkdf } from '@noble/hashes/hkdf';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import type { NodeIdentity, EphemeralKeypair, RawSessionKeys } from './types.js';

const GHOST_MESH_SALT = 'ghostlink-yggdrasil-v1';
const GHOST_MESH_ITERATIONS = 100000;
const SEED_LENGTH = 32;
const SIGNING_KEY_INFO = 'ed25519-signing';

export function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export async function deriveIdentityFromSeedPhrase(seedPhrase: string): Promise<NodeIdentity> {
  const saltBytes = stringToBytes(GHOST_MESH_SALT);
  const phraseBytes = stringToBytes(seedPhrase);

  const seed = pbkdf2(sha512, phraseBytes, saltBytes, { c: GHOST_MESH_ITERATIONS, dkLen: SEED_LENGTH });

  const staticPrivKey = seed;
  const staticPubKey = x25519.getPublicKey(staticPrivKey);

  const nodeId = sha512(staticPubKey);

  const ed25519PrivKey = hmac(sha512, stringToBytes(SIGNING_KEY_INFO), seed);
  const signingPrivKey = ed25519PrivKey.slice(0, 32);
  const signingPubKey = ed25519.getPublicKey(signingPrivKey);

  return {
    seed,
    staticPrivKey,
    staticPubKey,
    signingPrivKey,
    signingPubKey,
    nodeId,
    nodeIdHex: bytesToHex(nodeId),
    staticPubKeyHex: bytesToHex(staticPubKey),
    signingPubKeyHex: bytesToHex(signingPubKey),
    staticPrivKeyHex: bytesToHex(staticPrivKey),
    signingPrivKeyHex: bytesToHex(signingPrivKey),
  };
}

export function generateEphemeralKeyPair(): EphemeralKeypair {
  const ephemeralPriv = crypto.getRandomValues(new Uint8Array(32));
  const ephemeralPub = x25519.getPublicKey(new Uint8Array(ephemeralPriv));
  return { ephemeralPriv, ephemeralPub };
}

export function x25519DeriveSharedSecret(localPrivKey: Uint8Array, remotePubKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(localPrivKey, remotePubKey);
}

export function deriveSessionKeys(sharedSecret: Uint8Array, initiatorNodeId: Uint8Array, responderNodeId: Uint8Array): RawSessionKeys {
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

  const initiatorKey = hkdf(sha512, ikm, undefined, initiatorInfo, 32);
  const responderKey = hkdf(sha512, ikm, undefined, responderInfo, 32);

  return { initiatorKey, responderKey };
}

export function signMessage(privKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, privKey);
}

export function verifySignature(pubKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  return ed25519.verify(signature, message, pubKey);
}

export function deriveEphemeralKeyPairFromPriv(ephemeralPriv: Uint8Array): EphemeralKeypair {
  const ephemeralPub = x25519.getPublicKey(new Uint8Array(ephemeralPriv));
  return { ephemeralPriv: new Uint8Array(ephemeralPriv), ephemeralPub: new Uint8Array(ephemeralPub) };
}

export function bytesToHexString(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

export function hexStringToBytes(hex: string): Uint8Array {
  return hexToBytes(hex);
}

export { sha512 };