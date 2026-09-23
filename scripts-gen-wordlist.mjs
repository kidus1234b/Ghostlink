/**
 * Regenerates gmp-core/src/bip39-english.ts from shared/wordlist.js.
 *
 * gmp-core ships as a standalone npm package (@ghostlink/gmp-core), so it
 * cannot import across the repo root the way the web and mobile clients do.
 * This is the one permitted copy, and wordlist-parity.test.js fails if it ever
 * drifts from the shared source.
 *
 * Run: node scripts-gen-wordlist.mjs
 */
import {BIP39_WORDS, LEGACY_ONLY_WORDS} from './shared/wordlist.js';
import fs from 'fs';

const fmt = (words, indent = '  ', width = 96) => {
  const lines = [];
  let cur = indent;
  for (const w of words) {
    const tok = JSON.stringify(w) + ', ';
    if (cur.length + tok.length > width) { lines.push(cur.trimEnd()); cur = indent; }
    cur += tok;
  }
  if (cur.trim()) lines.push(cur.trimEnd().replace(/,$/, ''));
  return lines.join('\n');
};

const out = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts-gen-wordlist.mjs
//
// gmp-core publishes as a standalone package, so it cannot import
// shared/wordlist.js across the repo root the way the web and mobile clients
// do. This is that single permitted copy; test/wordlist-parity.test.js fails
// if it drifts from the shared source.

/** The canonical BIP-39 English wordlist. The only source for new phrases. */
export const BIP39_WORDS: readonly string[] = Object.freeze([
${fmt(BIP39_WORDS)}
]);

/**
 * Words from the pre-2.1 mobile list that are not BIP-39. Accepted when a
 * phrase is entered so older identities still restore; never generated.
 */
export const LEGACY_ONLY_WORDS: readonly string[] = Object.freeze([
${fmt(LEGACY_ONLY_WORDS)}
]);

/** Every word accepted when restoring a phrase, lower-cased. */
export const ACCEPTED_WORDS: ReadonlySet<string> = Object.freeze(
  new Set([...BIP39_WORDS, ...LEGACY_ONLY_WORDS].map((w) => w.toLowerCase()))
);

/** True if \`word\` may appear in a phrase being restored. */
export function isAcceptedWord(word: string): boolean {
  return ACCEPTED_WORDS.has(String(word || '').trim().toLowerCase());
}
`;

fs.writeFileSync('gmp-core/src/bip39-english.ts', out);
console.log(`wrote gmp-core/src/bip39-english.ts (${BIP39_WORDS.length} + ${LEGACY_ONLY_WORDS.length} words)`);
