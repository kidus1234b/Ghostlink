/**
 * Regression tests for the at-rest message vault (index.html).
 * The vault source is extracted from index.html so the test exercises the
 * shipped code rather than a copy.
 * Run with: node test/message-vault.test.js
 */
'use strict';

const assert = require('assert');
// Values cross the vm realm boundary, so compare structurally.
const plain = (v) => JSON.parse(JSON.stringify(v));
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ── Extract MessageVault + deriveStorageKey from index.html ────────────────
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function slice(startMarker, endMarker) {
  const i = html.indexOf(startMarker);
  assert.ok(i > -1, `could not find ${JSON.stringify(startMarker)} in index.html`);
  const j = html.indexOf(endMarker, i);
  assert.ok(j > -1, `could not find ${JSON.stringify(endMarker)} after it`);
  return html.slice(i, j);
}

const deriveSrc = slice('  async deriveStorageKey(words) {', '\n  },\n');
const vaultSrc = slice('const SECURE_STORAGE_KEYS =', '\n// ==================== END-TO-END MESSAGE SEALING');

const store = {};
const sandbox = {
  crypto: require('crypto').webcrypto,
  console,
  TextEncoder, TextDecoder,
  MSG_STORAGE_KEY: 'gl_messages',
  CHAIN_STORAGE_KEY: 'gl_chain',
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  CryptoEngine: {},
};
vm.createContext(sandbox);
// `const` in a vm script creates a lexical binding, not a global property —
// export it explicitly.
vm.runInContext(
  `CryptoEngine = { ${deriveSrc} } };\n${vaultSrc}\nglobalThis.__vault = MessageVault;`,
  sandbox
);
const MessageVault = sandbox.__vault;
assert.ok(MessageVault, 'failed to extract MessageVault from index.html');

const PHRASE = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'.split(' ');
const OTHER = 'zulu yankee xray whiskey victor uniform tango sierra romeo quebec papa oscar'.split(' ');
const HISTORY = { peerA: [{ content: 'secret message', meta: { img: 'base64data' } }] };

// ── Tests ──────────────────────────────────────────────────────────────────

test('round-trips history through seal/open', async () => {
  assert.ok(await MessageVault.unlock(PHRASE));
  assert.ok(await MessageVault.save('gl_messages', HISTORY));
  const res = await MessageVault.load('gl_messages', {});
  assert.strictEqual(res.state, 'ok');
  assert.deepStrictEqual(plain(res.value), HISTORY);
});

test('nothing readable is left in storage', () => {
  const raw = store['gl_messages'];
  assert.ok(!raw.includes('secret message'), 'plaintext body found in localStorage');
  assert.ok(!raw.includes('base64data'), 'image data found in localStorage');
  assert.strictEqual(JSON.parse(raw).__glenc, 1);
});

test('a locked vault cannot read history', async () => {
  MessageVault.lock();
  const res = await MessageVault.load('gl_messages', {});
  assert.strictEqual(res.state, 'locked');
  assert.deepStrictEqual(plain(res.value), {});
});

test('a locked vault refuses to write (cannot clobber history)', async () => {
  const before = store['gl_messages'];
  assert.strictEqual(await MessageVault.save('gl_messages', {}), false);
  assert.strictEqual(store['gl_messages'], before, 'history was overwritten while locked');
});

test('a wrong phrase is rejected and leaves the vault locked', async () => {
  assert.strictEqual(await MessageVault.unlock(OTHER), false);
  assert.strictEqual(MessageVault.isUnlocked(), false);
  // and therefore still cannot overwrite
  assert.strictEqual(await MessageVault.save('gl_messages', {}), false);
  assert.ok(store['gl_messages'].length > 0);
});

test('the correct phrase still opens history after a failed attempt', async () => {
  assert.ok(await MessageVault.unlock(PHRASE));
  const res = await MessageVault.load('gl_messages', {});
  assert.deepStrictEqual(plain(res.value), HISTORY);
});

test('legacy plaintext is detected and readable for migration', async () => {
  store['gl_chain'] = JSON.stringify([{ index: 0, content: 'old block' }]);
  const res = await MessageVault.load('gl_chain', []);
  assert.strictEqual(res.state, 'legacy');
  assert.strictEqual(res.value[0].content, 'old block');
  // re-saving seals it
  assert.ok(await MessageVault.save('gl_chain', res.value));
  assert.ok(!store['gl_chain'].includes('old block'));
  assert.strictEqual((await MessageVault.load('gl_chain', [])).state, 'ok');
});

test('unlock succeeds against legacy plaintext (no envelope to verify)', async () => {
  store['gl_messages'] = JSON.stringify({ peerB: [{ content: 'plain' }] });
  delete store['gl_chain']; // no sealed store left to verify against
  MessageVault.lock();
  assert.ok(await MessageVault.unlock(OTHER), 'legacy store should not block unlock');
  MessageVault.lock();
});

test('missing keys report empty, not error', async () => {
  delete store['gl_messages'];
  await MessageVault.unlock(PHRASE);
  const res = await MessageVault.load('gl_messages', {});
  assert.strictEqual(res.state, 'empty');
});

test('corrupted ciphertext reports error without throwing', async () => {
  store['gl_messages'] = JSON.stringify({ __glenc: 1, iv: 'aa'.repeat(12), data: 'bb'.repeat(40) });
  const res = await MessageVault.load('gl_messages', { fallback: true });
  assert.strictEqual(res.state, 'error');
  assert.deepStrictEqual(plain(res.value), { fallback: true });
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { failures++; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
  }
  if (failures) { process.stdout.write(`\n${failures} test(s) failed\n`); process.exit(1); }
  process.stdout.write('\nAll message-vault tests passed\n');
})();
