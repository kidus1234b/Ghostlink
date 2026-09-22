/**
 * Recovery-phrase entry: splitting, validating, autocompleting.
 *
 * Apart from the screen so it can be tested directly — this is the code
 * standing between a user and their identity, and it has to be right whether
 * or not anyone can render a React tree.
 *
 * The wordlist is a curated 575-word list, NOT BIP-39, and carries no
 * checksum. So a phrase cannot be proved correct here: all that can be checked
 * is that every word is in the list. A typo landing on another valid word
 * produces a different identity, silently — which is why the screen shows the
 * derived Ghost Address and asks the user to confirm it. That confirmation is
 * what stands in for a checksum.
 */

import {WORDLIST, SEED_PHRASE_WORDS} from './wordlist.js';

/** Lowercased set for O(1) membership checks while typing. */
const WORD_SET = new Set(WORDLIST.map(w => w.toLowerCase()));

/** Split pasted text into candidate words, tolerating punctuation and case. */
export function splitPhrase(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/**
 * What is wrong with this phrase, if anything.
 *
 * Deliberately not a boolean: the user needs to know which word to look at.
 * Membership is all that can be checked — see the note on verification above.
 */
export function validatePhrase(words) {
  const filled = words.filter(w => w && w.trim());
  if (filled.length < SEED_PHRASE_WORDS) {
    return {ok: false, missing: SEED_PHRASE_WORDS - filled.length, unknown: []};
  }
  const unknown = [];
  words.forEach((w, i) => {
    if (!WORD_SET.has(String(w).trim().toLowerCase())) unknown.push(i);
  });
  return {ok: unknown.length === 0, missing: 0, unknown};
}

/** Up to five suggestions for a partially typed word. */
export function suggestWords(prefix, limit = 5) {
  const p = String(prefix || '').trim().toLowerCase();
  if (p.length < 2) return [];
  const out = [];
  for (const w of WORDLIST) {
    if (w.toLowerCase().startsWith(p)) {
      out.push(w);
      if (out.length >= limit) break;
    }
  }
  return out;
}

