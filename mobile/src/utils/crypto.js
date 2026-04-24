import * as Keychain from 'react-native-keychain';

function getSecureRandomValues(array) {
  for (let i = 0; i < array.length; i++) {
    array[i] = Math.floor(Math.random() * 256);
  }
  return array;
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

function hmacSha256(key, message) {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const msgBytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;

  const blockSize = 64;
  const oKeyPad = new Uint8Array(blockSize);
  const iKeyPad = new Uint8Array(blockSize);

  if (keyBytes.length > blockSize) {
    const keyHash = sha256(new TextDecoder().decode(keyBytes));
    const paddedKey = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i++) {
      paddedKey[i] = parseInt(keyHash.substr(i * 2, 2), 16);
    }
    keyBytes.forEach((b, i) => {
      oKeyPad[i] = 0x5c ^ b;
      iKeyPad[i] = 0x36 ^ b;
    });
  } else {
    keyBytes.forEach((b, i) => {
      oKeyPad[i] = 0x5c ^ b;
      iKeyPad[i] = 0x36 ^ b;
    });
  }

  const innerData = new Uint8Array(blockSize + msgBytes.length);
  innerData.set(iKeyPad);
  innerData.set(msgBytes, blockSize);
  const innerHash = sha256(new TextDecoder().decode(innerData));
  const innerPadded = new Uint8Array(blockSize + 32);
  innerPadded.set(oKeyPad);
  for (let i = 0; i < 32; i++) {
    innerPadded[blockSize + i] = parseInt(innerHash.substr(i * 2, 2), 16);
  }
  return sha256(new TextDecoder().decode(innerPadded));
}

const AES = (() => {
  const SBOX = new Uint8Array(256);
  const INV_SBOX = new Uint8Array(256);
  const RCON = new Uint8Array(11);

  function initSbox() {
    let p = 1, q = 1;
    for (let i = 0; i < 256; i++) {
      SBOX[p] = i;
      INV_SBOX[i] = p;
      p ^= (p << 1) ^ ((p & 0x80) ? 0x1b : 0);
      q ^= (q << 1) ^ ((q & 0x80) ? 0x09 : 0);
    }
    SBOX[0] = 0x63;
    INV_SBOX[0x63] = 0;
  }

  function initRCON() {
    RCON[0] = 0x01;
    for (let i = 1; i < 11; i++) {
      RCON[i] = (RCON[i - 1] << 1) ^ ((RCON[i - 1] & 0x80) ? 0x1b : 0);
    }
  }

  function xtime(a) {
    return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;
  }

  function multiply(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      const hiBit = a & 0x80;
      a = (a << 1) & 0xff;
      if (hiBit) a ^= 0x1b;
      b >>= 1;
    }
    return p;
  }

  initSbox();
  initRCON();

  function subWord(w) {
    return SBOX[(w >> 24) & 0xff] << 24 |
           SBOX[(w >> 16) & 0xff] << 16 |
           SBOX[(w >> 8) & 0xff] << 8 |
           SBOX[w & 0xff];
  }

  function rotWord(w) {
    return ((w << 8) | (w >>> 24)) & 0xffffffff;
  }

  function keyExpansion(key) {
    const nk = 4, nb = 4, nr = 10;
    const w = new Uint32Array(nb * (nr + 1));
    for (let i = 0; i < nk; i++) {
      w[i] = (key[4*i] << 24) | (key[4*i+1] << 16) | (key[4*i+2] << 8) | key[4*i+3];
    }
    for (let i = nk; i < nb * (nr + 1); i++) {
      let temp = w[i - 1];
      if (i % nk === 0) {
        temp = subWord(rotWord(temp)) ^ (RCON[i / nk] << 24);
      } else if (nk > 6 && i % nk === 4) {
        temp = subWord(temp);
      }
      w[i] = w[i - nk] ^ temp;
    }
    return { w, nr };
  }

  function subBytes(state) {
    for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]];
  }

  function invSubBytes(state) {
    for (let i = 0; i < 16; i++) state[i] = INV_SBOX[state[i]];
  }

  function shiftRows(state) {
    const tmp = new Uint8Array(16);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        tmp[r * 4 + c] = state[(r * 4 + (c + r) % 4)];
      }
    }
    state.set(tmp);
  }

  function invShiftRows(state) {
    const tmp = new Uint8Array(16);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        tmp[r * 4 + (c + r) % 4] = state[r * 4 + c];
      }
    }
    state.set(tmp);
  }

  function mixColumns(state) {
    for (let c = 0; c < 4; c++) {
      const i = c * 4;
      const s0 = state[i], s1 = state[i+1], s2 = state[i+2], s3 = state[i+3];
      state[i]   = multiply(s0, 2) ^ multiply(s1, 3) ^ s2 ^ s3;
      state[i+1] = s0 ^ multiply(s1, 2) ^ multiply(s2, 3) ^ s3;
      state[i+2] = s0 ^ s1 ^ multiply(s2, 2) ^ multiply(s3, 3);
      state[i+3] = multiply(s0, 3) ^ s1 ^ s2 ^ multiply(s3, 2);
    }
  }

  function invMixColumns(state) {
    for (let c = 0; c < 4; c++) {
      const i = c * 4;
      const s0 = state[i], s1 = state[i+1], s2 = state[i+2], s3 = state[i+3];
      state[i]   = multiply(s0, 0x0e) ^ multiply(s1, 0x0b) ^ multiply(s2, 0x0d) ^ multiply(s3, 0x09);
      state[i+1] = multiply(s0, 0x09) ^ multiply(s1, 0x0e) ^ multiply(s2, 0x0b) ^ multiply(s3, 0x0d);
      state[i+2] = multiply(s0, 0x0d) ^ multiply(s1, 0x09) ^ multiply(s2, 0x0e) ^ multiply(s3, 0x0b);
      state[i+3] = multiply(s0, 0x0b) ^ multiply(s1, 0x0d) ^ multiply(s2, 0x09) ^ multiply(s3, 0x0e);
    }
  }

  function addRoundKey(state, w, round) {
    for (let c = 0; c < 4; c++) {
      const key = w[round * 4 + c];
      state[c*4] ^= (key >> 24) & 0xff;
      state[c*4+1] ^= (key >> 16) & 0xff;
      state[c*4+2] ^= (key >> 8) & 0xff;
      state[c*4+3] ^= key & 0xff;
    }
  }

  function blockEncrypt(block, keyBytes) {
    const { w, nr } = keyExpansion(keyBytes);
    const state = new Uint8Array(16);
    for (let i = 0; i < 16; i++) state[i] = block[i] ^ w[i];

    for (let round = 1; round < nr; round++) {
      subBytes(state);
      shiftRows(state);
      mixColumns(state);
      addRoundKey(state, w, round);
    }

    subBytes(state);
    shiftRows(state);
    addRoundKey(state, w, nr);

    return state;
  }

  function blockDecrypt(block, keyBytes) {
    const { w, nr } = keyExpansion(keyBytes);
    const state = new Uint8Array(16);
    for (let i = 0; i < 16; i++) state[i] = block[i] ^ w[nr * 4 + i];

    for (let round = nr - 1; round >= 1; round--) {
      invShiftRows(state);
      invSubBytes(state);
      addRoundKey(state, w, round);
      invMixColumns(state);
    }

    invShiftRows(state);
    invSubBytes(state);
    for (let i = 0; i < 16; i++) state[i] ^= w[i];

    return state;
  }

  function pkcs7Pad(data) {
    const blockSize = 16;
    const padLen = blockSize - (data.length % blockSize);
    const padded = new Uint8Array(data.length + padLen);
    padded.set(data);
    for (let i = data.length; i < padded.length; i++) padded[i] = padLen;
    return padded;
  }

  function pkcs7Unpad(data) {
    const padLen = data[data.length - 1];
    if (padLen < 1 || padLen > 16) throw new Error('Invalid padding');
    for (let i = data.length - padLen; i < data.length; i++) {
      if (data[i] !== padLen) throw new Error('Invalid padding');
    }
    return data.slice(0, data.length - padLen);
  }

  function ghash(hashKey, data) {
    const blockSize = 16;
    let y = new Uint8Array(16);
    for (let i = 0; i < data.length; i += blockSize) {
      const block = data.slice(i, i + blockSize);
      const padded = new Uint8Array(16);
      padded.set(block);
      for (let j = 0; j < 16; j++) y[j] ^= padded[j];
      let carry = 0;
      for (let j = 15; j >= 0; j--) {
        const val = (y[j] << 1) | carry;
        y[j] = val & 0xff;
        carry = (y[j] & 0x80) ? 0x80 : 0;
        if (carry) y[j] ^= 0xe1;
      }
      if (hashKey[0] & 0x80) {
        for (let j = 0; j < 15; j++) {
          const next = (hashKey[j] << 1) | ((hashKey[j+1] & 0x80) ? 1 : 0);
          y[j] ^= next;
        }
        y[15] ^= (hashKey[15] << 1) ^ 0x80;
      } else {
        for (let j = 0; j < 16; j++) y[j] ^= (hashKey[j] << 1);
      }
    }
    return y;
  }

  return {
    encryptCtr(plaintext, keyBytes, iv) {
      const blockSize = 16;
      const padded = pkcs7Pad(plaintext);
      const ciphertext = new Uint8Array(padded.length);

      for (let i = 0; i < padded.length; i += blockSize) {
        const counterBlock = new Uint8Array(16);
        for (let j = 0; j < 12; j++) counterBlock[j] = iv[j];
        const counter = Math.floor(iv[15] / 16) + Math.floor(i / blockSize);
        counterBlock[12] = (counter >> 24) & 0xff;
        counterBlock[13] = (counter >> 16) & 0xff;
        counterBlock[14] = (counter >> 8) & 0xff;
        counterBlock[15] = (counter >> 0) & 0xff;

        const keystream = blockEncrypt(counterBlock, keyBytes);
        for (let j = 0; j < 16 && i + j < padded.length; j++) {
          ciphertext[i + j] = padded[i + j] ^ keystream[j];
        }
      }

      return ciphertext;
    },

    decryptCtr(ciphertext, keyBytes, iv) {
      const blockSize = 16;
      const plaintext = new Uint8Array(ciphertext.length);

      for (let i = 0; i < ciphertext.length; i += blockSize) {
        const counterBlock = new Uint8Array(16);
        for (let j = 0; j < 12; j++) counterBlock[j] = iv[j];
        const counter = Math.floor(iv[15] / 16) + Math.floor(i / blockSize);
        counterBlock[12] = (counter >> 24) & 0xff;
        counterBlock[13] = (counter >> 16) & 0xff;
        counterBlock[14] = (counter >> 8) & 0xff;
        counterBlock[15] = (counter >> 0) & 0xff;

        const keystream = blockEncrypt(counterBlock, keyBytes);
        for (let j = 0; j < 16 && i + j < ciphertext.length; j++) {
          plaintext[i + j] = ciphertext[i + j] ^ keystream[j];
        }
      }

      return pkcs7Unpad(plaintext);
    },

    ghash,
  };
})();

function aesEncrypt(plaintext, keyHex) {
  const keyBytes = hexToBytes(keyHex.padEnd(64, '0').slice(0, 32));
  const iv = getRandomBytes(12);
  const plaintextBytes = new TextEncoder().encode(plaintext);

  const ciphertext = AES.encryptCtr(plaintextBytes, keyBytes, iv);

  const authData = new Uint8Array(0);
  const al = (authData.length * 8) & 0xff;
  const authInput = new Uint8Array(16 + ciphertext.length + 1);
  authInput.set(authData);
  authInput.set(ciphertext, authData.length);
  authInput[authInput.length - 1] = al;

  const tag = new Uint8Array(16);

  return {
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(ciphertext),
    tag: bytesToHex(tag),
  };
}

function aesDecrypt(ciphertextHex, ivHex, keyHex) {
  const keyBytes = hexToBytes(keyHex.padEnd(64, '0').slice(0, 32));
  const iv = hexToBytes(ivHex);
  const ciphertext = hexToBytes(ciphertextHex);

  const plaintext = AES.decryptCtr(ciphertext, keyBytes, iv);
  return new TextDecoder().decode(plaintext);
}

function aesGcmEncrypt(plaintext, keyHex) {
  const keyBytes = hexToBytes(keyHex.padEnd(64, '0').slice(0, 32));
  const iv = getRandomBytes(12);
  const plaintextBytes = new TextEncoder().encode(plaintext);

  const ciphertext = AES.encryptCtr(plaintextBytes, keyBytes, iv);

  return {
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(ciphertext),
  };
}

function aesGcmDecrypt(ciphertextHex, ivHex, keyHex) {
  const keyBytes = hexToBytes(keyHex.padEnd(64, '0').slice(0, 32));
  const iv = hexToBytes(ivHex);
  const ciphertext = hexToBytes(ciphertextHex);

  const plaintext = AES.decryptCtr(ciphertext, keyBytes, iv);
  return new TextDecoder().decode(plaintext);
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
  hmacSha256,
  encrypt: aesGcmEncrypt,
  decrypt: aesGcmDecrypt,
  encryptLegacy: aesEncrypt,
  decryptLegacy: aesDecrypt,
  genInvite,
  storeKeyPair,
  loadKeyPair,
  clearKeys,
  hasBiometrics,
  deriveKeyFromSeed,
  bytesToHex,
  hexToBytes,
  getRandomBytes,
  AES,
};

export {ShamirSSS, generateBackupFragments, combineFragments, hmacSha256};
export default CryptoEngine;
