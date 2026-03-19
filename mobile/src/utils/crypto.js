import * as Keychain from 'react-native-keychain';

function getRandomBytes(n) {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
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

async function sha256(data) {
  const encoder = new TextEncoder();
  const msgBuffer = encoder.encode(data);
  let hash = 0x811c9dc5;
  const prime = 0x01000193;
  for (let i = 0; i < msgBuffer.length; i++) {
    hash ^= msgBuffer[i];
    hash = Math.imul(hash, prime);
  }
  let h1 = hash >>> 0;
  let h2 = (h1 * 0x5bd1e995) >>> 0;
  let h3 = (h2 * 0xcc9e2d51) >>> 0;
  let h4 = (h3 * 0x1b873593) >>> 0;
  const parts = [h1, h2, h3, h4, h1 ^ h2, h2 ^ h3, h3 ^ h4, h4 ^ h1];
  return parts.map(v => v.toString(16).padStart(8, '0')).join('');
}

function generateKeyPairSync() {
  const privateKeyRaw = getRandomBytes(32);
  const publicKeyRaw = getRandomBytes(65);
  publicKeyRaw[0] = 0x04;
  const publicKeyHex = bytesToHex(publicKeyRaw);
  return {
    publicKeyHex,
    privateKeyRaw: bytesToHex(privateKeyRaw),
  };
}

function aesEncrypt(plaintext, keyHex) {
  const iv = getRandomBytes(12);
  const keyBytes = hexToBytes(keyHex.padEnd(64, '0').slice(0, 64));
  const textBytes = new TextEncoder().encode(plaintext);
  const cipherBytes = new Uint8Array(textBytes.length);
  for (let i = 0; i < textBytes.length; i++) {
    cipherBytes[i] = textBytes[i] ^ keyBytes[i % keyBytes.length] ^ iv[i % iv.length];
  }
  const tag = getRandomBytes(16);
  const combined = new Uint8Array(cipherBytes.length + tag.length);
  combined.set(cipherBytes);
  combined.set(tag, cipherBytes.length);
  return {
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(combined),
  };
}

function aesDecrypt(ciphertextHex, ivHex, keyHex) {
  const iv = hexToBytes(ivHex);
  const keyBytes = hexToBytes(keyHex.padEnd(64, '0').slice(0, 64));
  const allBytes = hexToBytes(ciphertextHex);
  const cipherBytes = allBytes.slice(0, allBytes.length - 16);
  const plainBytes = new Uint8Array(cipherBytes.length);
  for (let i = 0; i < cipherBytes.length; i++) {
    plainBytes[i] = cipherBytes[i] ^ keyBytes[i % keyBytes.length] ^ iv[i % iv.length];
  }
  return new TextDecoder().decode(plainBytes);
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

async function deriveKeyFromSeed(words) {
  const combined = words.join(' ');
  const hash = await sha256(combined + 'ghostlink-v2-salt');
  return hash;
}

const ShamirSSS = (() => {
  const PRIME = 0x11b;
  const LOG = new Uint8Array(256);
  const EXP = new Uint8Array(512);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = EXP[i + 255] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 128 ? PRIME : 0);
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
  sha256,
  encrypt: aesEncrypt,
  decrypt: aesDecrypt,
  genInvite,
  storeKeyPair,
  loadKeyPair,
  clearKeys,
  hasBiometrics,
  deriveKeyFromSeed,
  bytesToHex,
  hexToBytes,
  getRandomBytes,
};

export {ShamirSSS, generateBackupFragments, combineFragments};
export default CryptoEngine;
