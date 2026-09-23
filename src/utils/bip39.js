/**
 * The web app's view of the recovery-phrase wordlist.
 *
 * The list itself lives in shared/wordlist.js, which every client imports —
 * see that file for why there is exactly one copy. This module only re-exports
 * it under the name index.html already loads.
 */
export {
  BIP39_WORDS,
  LEGACY_ONLY_WORDS,
  ACCEPTED_WORDS,
  SEED_PHRASE_WORDS,
  SEED_PHRASE_BITS,
  isAcceptedWord,
  isLegacyOnlyWord,
} from '../../shared/wordlist.js';
