/**
 * The recovery wordlist must be one list.
 *
 * A phrase written down on one device has to restore on every other. That
 * broke once already: web generated from the 2048-word BIP-39 list, mobile
 * validated against a curated 575, and the CLI drew from a 99-word excerpt,
 * so a perfectly correct phrase was rejected as invalid on a different
 * client — data loss in the feature whose only job is preventing it.
 *
 * shared/wordlist.js is now the single source. This file asserts that every
 * client really does use it, that the one permitted copy (gmp-core, which
 * publishes standalone and cannot import across the repo root) has not
 * drifted, and that generation and validation follow the two rules:
 * generate BIP-39 only, accept the union.
 *
 * Run with: node test/wordlist-parity.test.mjs
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const shared = await import(path.join(root, 'shared/wordlist.js'));
const web = await import(path.join(root, 'src/utils/bip39.js'));
const mobile = await import(path.join(root, 'mobile/src/utils/wordlist.js'));
const phraseEntry = await import(path.join(root, 'mobile/src/utils/phrase-entry.js'));

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the shared list is the canonical BIP-39 list', () => {
  assert.strictEqual(shared.BIP39_WORDS.length, 2048);
  assert.strictEqual(shared.BIP39_WORDS[0], 'abandon');
  assert.strictEqual(shared.BIP39_WORDS[2047], 'zoo');
  assert.strictEqual(new Set(shared.BIP39_WORDS).size, 2048, 'no duplicates');
});

test('web and mobile import the shared list rather than copying it', () => {
  // Identity, not deep equality: a copy would fail this.
  assert.strictEqual(web.BIP39_WORDS, shared.BIP39_WORDS);
  assert.strictEqual(mobile.WORDLIST, shared.BIP39_WORDS);
  assert.strictEqual(mobile.BIP39_WORDS, shared.BIP39_WORDS);
  assert.strictEqual(mobile.ACCEPTED_WORDS, shared.ACCEPTED_WORDS);
});

test('no client keeps its own wordlist array', () => {
  // A long inline array of quoted words is what the old copies looked like.
  for (const rel of ['src/utils/bip39.js', 'mobile/src/utils/wordlist.js',
                     'mobile/src/utils/phrase-entry.js']) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const quoted = (text.match(/'[a-z]{3,}'|"[a-z]{3,}"/g) || []).length;
    assert.ok(quoted < 40, `${rel} looks like it carries its own wordlist (${quoted} quoted words)`);
  }
});

test("gmp-core's generated copy has not drifted from the shared source", () => {
  const ts = fs.readFileSync(path.join(root, 'gmp-core/src/bip39-english.ts'), 'utf8');
  const grab = (name) => {
    const m = new RegExp(`export const ${name}[^=]*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`).exec(ts);
    assert.ok(m, `${name} not found in generated file`);
    return m[1].split(',').map(w => w.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  };
  assert.deepStrictEqual(grab('BIP39_WORDS'), [...shared.BIP39_WORDS],
    'run: node scripts-gen-wordlist.mjs');
  assert.deepStrictEqual(grab('LEGACY_ONLY_WORDS'), [...shared.LEGACY_ONLY_WORDS],
    'run: node scripts-gen-wordlist.mjs');
});

test('the CLI draws from the shared list and keeps no excerpt', () => {
  const cli = fs.readFileSync(path.join(root, 'gmp-core/src/cli.ts'), 'utf8');
  assert.ok(/from '\.\/bip39-english\.js'/.test(cli), 'cli.ts must import the generated list');
  assert.ok(!/const BIP39_WORDS[^=]*=\s*\[/.test(cli), 'cli.ts must not declare its own wordlist');
  assert.ok(!/Math\.random/.test(cli.split('function secureRandomIndex')[0] + (cli.split('}')[0] || '')),
    'seed generation must not use Math.random');
});

test('legacy-only words are exactly the 15 non-BIP-39 words from the old mobile list', () => {
  assert.strictEqual(shared.LEGACY_ONLY_WORDS.length, 15);
  const bip = new Set(shared.BIP39_WORDS);
  for (const w of shared.LEGACY_ONLY_WORDS) {
    assert.ok(!bip.has(w), `${w} is a BIP-39 word and should not be listed as legacy-only`);
    assert.ok(shared.isAcceptedWord(w), `${w} must still be accepted on entry`);
    assert.ok(shared.isLegacyOnlyWord(w), `${w} must be flagged legacy-only`);
  }
  assert.strictEqual(shared.ACCEPTED_WORDS.size, 2048 + 15);
});

test('legacy-only words are never generated or suggested', () => {
  for (const w of shared.LEGACY_ONLY_WORDS) {
    assert.ok(!shared.BIP39_WORDS.includes(w), `${w} must not be generatable`);
    const suggestions = phraseEntry.suggestWords(w.slice(0, 4), 20);
    assert.ok(!suggestions.includes(w), `${w} must not be autocompleted`);
  }
});

test('a phrase of legacy-only words still validates, and is flagged as legacy', () => {
  const words = shared.LEGACY_ONLY_WORDS.slice(0, 12);
  const res = phraseEntry.validatePhrase(words);
  assert.strictEqual(res.ok, true, 'an old phrase must still restore');
  assert.deepStrictEqual(res.unknown, []);
  assert.strictEqual(res.legacy.length, 12, 'the screen must be able to say these are legacy words');
});

test('a plain BIP-39 phrase validates with nothing flagged', () => {
  const res = phraseEntry.validatePhrase(shared.BIP39_WORDS.slice(0, 12));
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.unknown, []);
  assert.deepStrictEqual(res.legacy, []);
});

test('a word in neither list is still rejected', () => {
  const words = [...shared.BIP39_WORDS.slice(0, 11), 'zzzznotaword'];
  const res = phraseEntry.validatePhrase(words);
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.unknown, [11]);
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}
if (failures) { console.error(`\n${failures} wordlist-parity test(s) failed`); process.exit(1); }
console.log('\nAll wordlist-parity tests passed');
