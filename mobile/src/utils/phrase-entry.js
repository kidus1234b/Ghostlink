/**
 * Recovery-phrase entry: splitting, validating, autocompleting.
 *
 * Apart from the screen so it can be tested directly — this is the code
 * standing between a user and their identity, and it has to be right whether
 * or not anyone can render a React tree.
 *
 * Entry accepts more than it produces. New phrases are BIP-39 only, but a
 * phrase written down from an older build may contain one of the fifteen
 * words that existed only in this app's previous 575-word list. Those are
 * still valid identities, so validation runs against ACCEPTED_WORDS (the
 * union) while autocomplete only ever offers BIP-39 words — there is no
 * reason to steer anyone toward a word that can no longer be generated.
 *
 * A phrase still cannot be *proved* correct here: BIP-39's checksum does not
 * apply, because legacy phrases were not built with one and the derivation
 * treats the phrase as an opaque PBKDF2 input either way. A typo landing on
 * another valid word produces a different identity, silently — which is why
 * the screen shows the derived Ghost Address and asks the user to confirm it.
 * That confirmation is what stands in for a checksum.
 */

import {
  BIP39_WORDS,
  SEED_PHRASE_WORDS,
  isAcceptedWord,
  isLegacyOnlyWord,
} from './wordlist.js';

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
 * `legacy` lists the positions holding a word that is accepted but no longer
 * generated, so the screen can say "this phrase is from an older version"
 * rather than leaving it unexplained.
 */
export function validatePhrase(words) {
  const filled = words.filter(w => w && w.trim());
  if (filled.length < SEED_PHRASE_WORDS) {
    return {ok: false, missing: SEED_PHRASE_WORDS - filled.length, unknown: [], legacy: []};
  }
  const unknown = [];
  const legacy = [];
  words.forEach((w, i) => {
    if (!isAcceptedWord(w)) unknown.push(i);
    else if (isLegacyOnlyWord(w)) legacy.push(i);
  });
  return {ok: unknown.length === 0, missing: 0, unknown, legacy};
}

/**
 * Up to five suggestions for a partially typed word.
 *
 * BIP-39 only. A legacy-only word still validates if typed in full, but
 * offering one would push a user toward a word no current build produces.
 */
export function suggestWords(prefix, limit = 5) {
  const p = String(prefix || '').trim().toLowerCase();
  if (p.length < 2) return [];
  const out = [];
  for (const w of BIP39_WORDS) {
    if (w.toLowerCase().startsWith(p)) {
      out.push(w);
      if (out.length >= limit) break;
    }
  }
  return out;
}
