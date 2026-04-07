# Testing GhostLink

## Local Development Setup

1. Install server dependencies: `cd server && npm install`
2. Start signaling server: `cd server && node index.js`
3. App available at `http://localhost:3001`, signaling at `ws://localhost:3001`
4. Server serves static files from repo root

## Testing with Playwright

Chrome exposes CDP on `http://localhost:29229`. Connect Playwright:

```js
const { chromium } = require('playwright');
const browser = await chromium.connectOverCDP('http://localhost:29229');
const page = browser.contexts()[0].pages()[0];
```

Install Playwright if needed: `npm install playwright`

## Identity Lifecycle

- **Fresh creation** (`index.html` line ~936): `CryptoEngine.generateKeyPair()` produces real CryptoKey pair with `['deriveKey']` usage. `identity.keyPair` has `{privateKey, publicKey}` as CryptoKey objects.
- **localStorage restoration** (`index.html` line ~555): Only restores `{publicKeyHex, fingerprint, name, wrappedPrivKey}` — NO `keyPair`. So `identity.keyPair` is `undefined` after page refresh.
- **Seed recovery** (`index.html` line ~963): Unwraps private key, sets `keyPair: { privateKey }` (no publicKey CryptoKey).

## RTCPeerManager & Crypto

- `RTCPeerManager` is instantiated with `keyPair: identity.keyPair || null`
- `_deriveSharedKey()` requires a real CryptoKey private key for ECDH — uses `deriveKey` (not `deriveBits`)
- `_exportPublicKey()` exports CryptoKey as JWK, falls back to hex string if not a CryptoKey
- Peers exchange public keys via signaling messages as JWK strings

## Key Test Scenarios

1. **Happy path**: Two RTCPeerManagers with fresh CryptoKey pairs → `_deriveSharedKey` succeeds, cross-encrypt/decrypt works
2. **No private key**: `keyPair: null` → `security-error` event emitted, connection refused
3. **Bad peer key**: Hex string instead of JWK → `security-error` event emitted, connection refused
4. **Empty peer key**: Empty string → `security-error` event emitted, connection refused

## Notes

- Port 3000 WebSocket errors in console are from offline queue module — unrelated to P2P
- Two browser tabs share same localStorage, so true two-peer testing needs separate profiles
- No CI configured for this repo
- No lint or test commands configured
