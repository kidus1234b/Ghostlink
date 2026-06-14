// GhostLink Crypto Worker — Offloaded heavy crypto operations from main thread
// Handles: AES-GCM encryption/decryption, SHA-256 hashing, key derivation, key wrapping
// Communication: postMessage / onmessage

var GhostLinkCryptoWorker = (function() {
  'use strict';

  function arrayBufferToBase64(buffer) {
    var binary = '';
    var bytes = new Uint8Array(buffer);
    for (var i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function base64ToString(base64) {
    return decodeURIComponent(Array.from(atob(base64)).map(function(c) {
      return '%' + c.charCodeAt(0).toString(16).padStart(2, '0');
    }).join(''));
  }

  function stringToBase64(str) {
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(_, p1) {
      return String.fromCharCode(parseInt(p1, 16));
    }));
  }

  function uid() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  self.onmessage = async function(e) {
    var msg = e.data;
    var id = msg.id || uid();

    try {
      switch (msg.op) {
        case 'encrypt': {
          var key = await crypto.subtle.importKey('raw', base64ToArrayBuffer(msg.key), { name: 'AES-GCM' }, false, ['encrypt']);
          var iv = crypto.getRandomValues(new Uint8Array(12));
          var data = typeof msg.data === 'string' ? new TextEncoder().encode(msg.data) : msg.data;
          var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
          self.postMessage({ id: id, op: 'encrypt', ok: true,
            result: { iv: arrayBufferToBase64(iv), ciphertext: arrayBufferToBase64(ct) } });
          break;
        }

        case 'decrypt': {
          var key2 = await crypto.subtle.importKey('raw', base64ToArrayBuffer(msg.key), { name: 'AES-GCM' }, false, ['decrypt']);
          var iv2 = base64ToArrayBuffer(msg.iv);
          var ct2 = base64ToArrayBuffer(msg.ciphertext);
          var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv2 }, key2, ct2);
          var str = new TextDecoder().decode(pt);
          self.postMessage({ id: id, op: 'decrypt', ok: true, result: str });
          break;
        }

        case 'hash': {
          var buf = typeof msg.data === 'string' ? new TextEncoder().encode(msg.data) : msg.data;
          var h = await crypto.subtle.digest('SHA-256', buf);
          var hex = Array.from(new Uint8Array(h)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
          self.postMessage({ id: id, op: 'hash', ok: true, result: hex });
          break;
        }

        case 'sha256': {
          var data3 = typeof msg.data === 'string' ? new TextEncoder().encode(msg.data) : msg.data;
          var hash3 = await crypto.subtle.digest('SHA-256', data3);
          var hex3 = Array.from(new Uint8Array(hash3)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
          self.postMessage({ id: id, op: 'sha256', ok: true, result: hex3 });
          break;
        }

        case 'deriveKey': {
          var km = await crypto.subtle.importKey('raw', base64ToArrayBuffer(msg.masterKey), 'PBKDF2', false, ['deriveKey']);
          var salt = msg.salt ? (typeof msg.salt === 'string' ? new TextEncoder().encode(msg.salt) : msg.salt) : new Uint8Array(16);
          var derivedKey = await crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: salt, iterations: msg.iterations || 100000, hash: 'SHA-256' },
            km,
            { name: 'AES-GCM', length: 256 },
            false,
            msg.permissions || ['encrypt', 'decrypt']
          );
          var raw = await crypto.subtle.exportKey('raw', derivedKey);
          self.postMessage({ id: id, op: 'deriveKey', ok: true, result: arrayBufferToBase64(raw) });
          break;
        }

        case 'generateKey': {
          var key4 = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
          var raw4 = await crypto.subtle.exportKey('raw', key4);
          self.postMessage({ id: id, op: 'generateKey', ok: true, result: arrayBufferToBase64(raw4) });
          break;
        }

        case 'encryptFile': {
          var key5 = await crypto.subtle.importKey('raw', base64ToArrayBuffer(msg.key), { name: 'AES-GCM' }, false, ['encrypt']);
          var iv5 = crypto.getRandomValues(new Uint8Array(12));
          var chunkData = msg.data;
          var ct5 = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv5 }, key5, chunkData);
          self.postMessage({ id: id, op: 'encryptFile', ok: true,
            result: { iv: arrayBufferToBase64(iv5), data: ct5 } }, [ct5]);
          break;
        }

        case 'decryptFile': {
          var key6 = await crypto.subtle.importKey('raw', base64ToArrayBuffer(msg.key), { name: 'AES-GCM' }, false, ['decrypt']);
          var iv6 = base64ToArrayBuffer(msg.iv);
          var ct6 = msg.ciphertext;
          var pt6 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv6 }, key6, ct6);
          self.postMessage({ id: id, op: 'decryptFile', ok: true, result: pt6 }, [pt6]);
          break;
        }

        case 'batchHash': {
          var hashes = [];
          for (var i = 0; i < msg.files.length; i++) {
            var h2 = await crypto.subtle.digest('SHA-256', msg.files[i].data);
            hashes.push({ index: msg.files[i].index, hash: Array.from(new Uint8Array(h2)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('') });
          }
          self.postMessage({ id: id, op: 'batchHash', ok: true, result: hashes });
          break;
        }

        default:
          self.postMessage({ id: id, op: msg.op, ok: false, error: 'Unknown operation: ' + msg.op });
      }
    } catch (err) {
      self.postMessage({ id: id, op: msg.op, ok: false, error: err.message });
    }
  };

  return { name: 'GhostLinkCryptoWorker' };
})();