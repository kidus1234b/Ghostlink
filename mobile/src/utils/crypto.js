import * as Keychain from 'react-native-keychain';
import {sha256 as nobleSha256} from '@noble/hashes/sha256';
import {hmac as nobleHmac} from '@noble/hashes/hmac';
import {pbkdf2Async} from '@noble/hashes/pbkdf2';
import {gcm} from '@noble/ciphers/aes';
import {p256} from '@noble/curves/p256';
import {x25519} from '@noble/curves/ed25519';
import {sha512} from '@noble/hashes/sha512';
import {WORDLIST, SEED_PHRASE_WORDS} from './wordlist';
import {ghostAddressFromNodeId} from './ghost-address';

/**
 * React Native ships no Web Crypto. Every primitive below comes from @noble —
 * audited, pure JS, and already a dependency for the curve maths.
 *
 * The randomness comes from the platform CSPRNG via
 * react-native-get-random-values, which polyfills crypto.getRandomValues onto
 * globalThis from Android's SecureRandom / iOS's SecRandomCopyBytes. That
 * polyfill is imported once at the app entry point (index.js) and must stay
 * there: it has to run before any of this module is used.
 */
function getSecureRandomValues(array) {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    // Never fall back to Math.random. A predictable "random" value here is a
    // predictable private key, nonce, or secret share — a silent, total
    // compromise that looks exactly like a working app. Fail instead.
    throw new Error(
      '[GhostLink:crypto] No secure random source. ' +
        "Ensure `import 'react-native-get-random-values';` runs at app startup " +
        '(index.js) before any crypto is used.',
    );
  }
  return c.getRandomValues(array);
}

function getRandomBytes(n) {
  return getSecureRandomValues(new Uint8Array(n));
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex) {
  const matched = hex.match(/.{2}/g);
  if (!matched) return new Uint8Array(0);
  return new Uint8Array(matched.map(b => parseInt(b, 16)));
}

const utf8 = str => new TextEncoder().encode(str);

/**
 * SHA-256 over the UTF-8 bytes of `data`, hex encoded.
 *
 * Kept async because every caller awaits it, and because that matches the web
 * app's crypto.subtle.digest-based CryptoEngine.sha256 — fingerprints computed
 * here have to equal the ones computed there, or peers cannot verify each other.
 */
async function sha256(data) {
  return bytesToHex(nobleSha256(typeof data === 'string' ? utf8(data) : data));
}

function hmacSha256(key, message) {
  const keyBytes = typeof key === 'string' ? utf8(key) : key;
  const msgBytes = typeof message === 'string' ? utf8(message) : message;
  return bytesToHex(nobleHmac(nobleSha256, keyBytes, msgBytes));
}

/**
 * AES-256-GCM.
 *
 * What was here before was a hand-written AES-CTR with a GHASH routine that was
 * never actually applied: aesGcmEncrypt returned an all-zero "tag" and
 * aesGcmDecrypt never checked one, so ciphertext was malleable and any
 * corruption decrypted silently to garbage. @noble/ciphers computes and
 * verifies the tag properly, so decrypt now throws on tampering.
 *
 * Wire format matches the web app's CryptoEngine: a 12-byte IV, and a
 * ciphertext that carries the 16-byte auth tag appended — the same layout
 * crypto.subtle.encrypt produces — both hex encoded.
 */
const GCM_IV_BYTES = 12;

/**
 * Key material for the AES functions below.
 *
 * A 64-character hex string is taken as the 32 raw key bytes it encodes. That
 * is what deriveKeyFromSeed returns, and it uses the full 256 bits of the
 * derived key. Anything else is treated the way the web app treats it — padded
 * or truncated to 32 characters and used as UTF-8 — so a passphrase-style key
 * behaves identically on both platforms.
 */
function resolveAesKey(key) {
  if (key instanceof Uint8Array) {
    if (key.length !== 32) throw new Error('AES key must be 32 bytes');
    return key;
  }
  if (typeof key !== 'string') throw new Error('AES key must be a string or Uint8Array');
  if (/^[0-9a-fA-F]{64}$/.test(key)) return hexToBytes(key);
  return utf8(key.padEnd(32, '0').slice(0, 32));
}

function aesGcmEncrypt(plaintext, key) {
  const iv = getRandomBytes(GCM_IV_BYTES);
  const sealed = gcm(resolveAesKey(key), iv).encrypt(utf8(plaintext));
  return {
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(sealed),
  };
}

function aesGcmDecrypt(ciphertextHex, ivHex, key) {
  const iv = hexToBytes(ivHex);
  if (iv.length !== GCM_IV_BYTES) throw new Error('AES-GCM IV must be 12 bytes');
  // Throws if the tag does not verify. Callers must let that propagate:
  // swallowing it is what turns a detected forgery back into silent acceptance.
  const opened = gcm(resolveAesKey(key), iv).decrypt(hexToBytes(ciphertextHex));
  return new TextDecoder().decode(opened);
}

/**
 * An ECDH P-256 keypair, matching the web app's
 * crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}).
 *
 * The previous implementation returned 32 random bytes as the "private key" and
 * a *separate, unrelated* 65 random bytes as the "public key". They were not a
 * pair, so no shared secret could ever be agreed — key exchange could not have
 * worked at all. The public key here is the real uncompressed point (0x04 ‖ X ‖ Y),
 * the same "raw" encoding the web app exports, so the two sides interoperate.
 */
function generateKeyPairSync() {
  const privateKeyRaw = p256.utils.randomPrivateKey();
  const publicKeyRaw = p256.getPublicKey(privateKeyRaw, false); // uncompressed
  return {
    publicKeyHex: bytesToHex(publicKeyRaw),
    privateKeyRaw: bytesToHex(privateKeyRaw),
  };
}

/**
 * The uncompressed P-256 public key for a private key, hex encoded.
 *
 * Recovery uses this to prove an unwrapped private key really belongs to the
 * identity being restored, instead of trusting a public key that travelled
 * alongside it in the same blob.
 */
function publicKeyFromPrivate(privateKeyHex) {
  return bytesToHex(p256.getPublicKey(hexToBytes(privateKeyHex), false));
}

/**
 * ECDH shared secret with a peer's uncompressed P-256 public key, hashed to a
 * 32-byte AES key. Returns hex, ready to hand to the AES functions above.
 */
function deriveSharedKey(privateKeyHex, peerPublicKeyHex) {
  const shared = p256.getSharedSecret(hexToBytes(privateKeyHex), hexToBytes(peerPublicKeyHex), true);
  // Drop the leading format byte and hash the X coordinate, which is what
  // WebCrypto's ECDH deriveBits yields before its own KDF step.
  return bytesToHex(nobleSha256(shared.slice(1)));
}

/**
 * The Ghost Mesh identity for a recovery phrase, and the Ghost Address that
 * names it.
 *
 * This is the same derivation gmp-core/identity.js performs, so the same phrase
 * yields the same address on mobile, desktop and the web app — which is the
 * whole point of the address being a name for *you* rather than for a device:
 *
 *   seed      = PBKDF2-HMAC-SHA512(phrase, "ghostlink-yggdrasil-v1", 100k, 32)
 *   staticPub = X25519(seed)
 *   nodeId    = SHA-512(staticPub)
 *   address   = first 45 bits of nodeId, Crockford base32
 *
 * Note the SHA-512: mobile's old CryptoService sketched this with SHA-256,
 * which would have produced a different seed and therefore a different address
 * from every other GhostLink client.
 *
 * Deliberately slow — 100,000 PBKDF2 iterations — so derive once at setup and
 * keep the result, rather than recomputing it to render a screen.
 */
async function deriveGhostIdentity(words) {
  const phrase = Array.isArray(words) ? words.join(' ') : String(words);
  const seed = await pbkdf2Async(sha512, utf8(phrase), utf8('ghostlink-yggdrasil-v1'), {
    c: 100000,
    dkLen: 32,
  });
  const staticPubKey = x25519.getPublicKey(seed);
  const nodeId = sha512(staticPubKey);
  const nodeIdHex = bytesToHex(nodeId);
  return {
    nodeIdHex,
    staticPubKeyHex: bytesToHex(staticPubKey),
    ghostAddress: ghostAddressFromNodeId(nodeIdHex),
  };
}

/**
 * A recovery phrase drawn uniformly from the shared wordlist.
 *
 * Both screens previously built this with Math.random(). That is the single
 * most sensitive value in the app — every other key derives from it — and
 * Math.random is a fast non-cryptographic PRNG whose internal state can be
 * recovered from a handful of outputs, so the phrase, the wrapping key, and the
 * private key behind it were all predictable no matter how strong the KDF was.
 *
 * Rejection sampling keeps the draw uniform: taking a random byte pair modulo
 * the list length would bias toward the first (65536 % 575) words.
 */
function generateSeedPhrase(wordCount = SEED_PHRASE_WORDS, wordlist = WORDLIST) {
  const n = wordlist.length;
  if (!n) throw new Error('Wordlist is empty');
  const limit = Math.floor(65536 / n) * n; // largest unbiased multiple
  const words = [];
  while (words.length < wordCount) {
    const b = getRandomBytes(2);
    const value = (b[0] << 8) | b[1];
    if (value >= limit) continue; // discard, do not fold
    words.push(wordlist[value % n]);
  }
  return words;
}

function genInvite() {
  const b = getRandomBytes(16);
  const c = bytesToHex(b);
  return `GL-${c.slice(0, 8)}-${c.slice(8, 16)}-${c.slice(16, 24)}-${c.slice(24, 32)}`.toUpperCase();
}

async function storeKeyPair(publicKeyHex, privateKeyRaw) {
  try {
    await Keychain.setGenericPassword('ghostlink_keypair', JSON.stringify({publicKeyHex, privateKeyRaw}), {
      service: 'com.ghostlink.keys',
      accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return true;
  } catch (_e) {
    return false;
  }
}

async function loadKeyPair() {
  try {
    const credentials = await Keychain.getGenericPassword({service: 'com.ghostlink.keys'});
    if (credentials) {
      return JSON.parse(credentials.password);
    }
    return null;
  } catch (_e) {
    return null;
  }
}

async function clearKeys() {
  try {
    await Keychain.resetGenericPassword({service: 'com.ghostlink.keys'});
    return true;
  } catch (_e) {
    return false;
  }
}

async function hasBiometrics() {
  try {
    const type = await Keychain.getSupportedBiometryType();
    return type !== null;
  } catch (_e) {
    return false;
  }
}

/**
 * The 256-bit key wrapping the private key at rest, derived from the recovery
 * phrase.
 *
 * PBKDF2-HMAC-SHA256, salt "ghostlink-v2-salt", 100,000 iterations — the exact
 * parameters the web app passes to crypto.subtle.deriveKey, so the same phrase
 * yields the same bytes on both platforms.
 *
 * This replaces a single unsalted pass of a non-SHA-256 hash, which offered no
 * work factor at all: a phrase guess cost one cheap hash to test.
 *
 * pbkdf2Async yields between blocks so 100k iterations of pure-JS PBKDF2 do not
 * freeze the UI thread. It is deliberately slow — that is the entire point of
 * a KDF — so call it once at setup or unlock and keep the result in memory.
 */
async function deriveKeyFromSeed(words) {
  const phrase = Array.isArray(words) ? words.join(' ') : String(words);
  const bits = await pbkdf2Async(nobleSha256, utf8(phrase), utf8('ghostlink-v2-salt'), {
    c: 100000,
    dkLen: 32,
  });
  return bytesToHex(bits);
}

/**
 * The key for message history at rest. A separate derivation from
 * deriveKeyFromSeed — different salt, higher work factor — so the key that
 * wraps the private key and the key that encrypts stored messages are never the
 * same bytes. Mirrors the web app's deriveStorageKey.
 */
async function deriveStorageKey(words) {
  const phrase = Array.isArray(words) ? words.join(' ') : String(words);
  const bits = await pbkdf2Async(nobleSha256, utf8(phrase), utf8('ghostlink-storage-v1'), {
    c: 200000,
    dkLen: 32,
  });
  return bytesToHex(bits);
}

const ShamirSSS = (() => {
  // GF(2^8) with AES's reduction polynomial 0x11b.
  //
  // The log/exp tables were previously built by repeatedly doubling from 1,
  // i.e. treating 0x02 as a generator. It is not one in this field — it has
  // order 51, so the tables covered only a fifth of the elements and the rest
  // of LOG stayed zero. Multiplication was wrong for most inputs (mul(1,3)
  // returned 1), which meant shares did not reconstruct: every recovery
  // fragment this produced was unusable. 0x03 is a primitive element, so
  // stepping by 3 walks all 255 non-zero values.
  const xtime = a => ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;

  const LOG = new Uint8Array(256);
  const EXP = new Uint8Array(512);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = EXP[i + 255] = x;
    LOG[x] = i;
    x = (xtime(x) ^ x) & 0xff; // x *= 3
  }

  const mul = (a, b) => (!a || !b ? 0 : EXP[LOG[a] + LOG[b]]);
  const div = (a, b) => (!a ? 0 : EXP[(LOG[a] - LOG[b] + 255) % 255]);
  const eval_ = (c, xv) => {
    let r = 0;
    for (let i = c.length - 1; i >= 0; i--) {
      r = mul(r, xv) ^ c[i];
    }
    return r;
  };

  return {
    split(secret, n, k) {
      const shares = Array.from({length: n}, (_, i) => ({
        x: i + 1,
        y: new Uint8Array(secret.length),
      }));
      for (let i = 0; i < secret.length; i++) {
        const c = new Uint8Array(k);
        c[0] = secret[i];
        for (let j = 1; j < k; j++) {
          c[j] = getRandomBytes(1)[0];
        }
        shares.forEach(s => {
          s.y[i] = eval_(Array.from(c), s.x);
        });
      }
      return shares;
    },
    combine(shares) {
      const len = shares[0].y.length;
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let j = 0; j < shares.length; j++) {
          let n = shares[j].y[i];
          let d = 1;
          for (let m = 0; m < shares.length; m++) {
            if (m !== j) {
              n = mul(n, shares[m].x);
              d = mul(d, shares[j].x ^ shares[m].x);
            }
          }
          s ^= div(n, d);
        }
        out[i] = s;
      }
      return out;
    },
  };
})();

function generateBackupFragments(blobStr) {
  const dataBytes = new TextEncoder().encode(blobStr);
  const shares = ShamirSSS.split(dataBytes, 7, 3);
  return shares.map(share => {
    const encoded = [share.x, ...share.y].map(b => b.toString(16).padStart(2, '0')).join('');
    return {
      id: share.x,
      label: `Fragment ${share.x} of 7`,
      data: encoded,
      check: encoded.slice(0, 8),
      distributed: false,
      peerName: '',
    };
  });
}

function combineFragments(fragmentHexArray) {
  if (fragmentHexArray.length < 3) {
    return {success: false, error: `Need at least 3 fragments, got ${fragmentHexArray.length}`};
  }
  try {
    const shares = fragmentHexArray.map(hex => {
      const bytes = hex
        .trim()
        .match(/.{2}/g)
        .map(b => parseInt(b, 16));
      return {x: bytes[0], y: new Uint8Array(bytes.slice(1))};
    });
    const reconstructed = ShamirSSS.combine(shares);
    const blob = JSON.parse(new TextDecoder().decode(reconstructed));
    return {success: true, blob};
  } catch (e) {
    return {success: false, error: 'Fragment reconstruction failed'};
  }
}

export const CryptoEngine = {
  generateKeyPair: generateKeyPairSync,
  deriveSharedKey,
  publicKeyFromPrivate,
  deriveGhostIdentity,
  sha256,
  hmacSha256,
  encrypt: aesGcmEncrypt,
  decrypt: aesGcmDecrypt,
  // encryptLegacy/decryptLegacy are gone. They were a XOR of plaintext against
  // the key and IV with a random, never-verified 16-byte "tag" appended —
  // trivially breakable and not encryption in any useful sense. Nothing called
  // them. Anything that needs symmetric encryption uses encrypt/decrypt above.
  generateSeedPhrase,
  genInvite,
  storeKeyPair,
  loadKeyPair,
  clearKeys,
  hasBiometrics,
  deriveKeyFromSeed,
  deriveStorageKey,
  bytesToHex,
  hexToBytes,
  getRandomBytes,
};

export {ShamirSSS, generateBackupFragments, combineFragments, hmacSha256, sha256, generateSeedPhrase, deriveGhostIdentity};
export default CryptoEngine;
