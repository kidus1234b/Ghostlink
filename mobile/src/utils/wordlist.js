/**
 * The mobile app's view of the recovery-phrase wordlist.
 *
 * The list itself lives in shared/wordlist.js at the repo root, which every
 * client imports — see that file for why there is exactly one copy. Metro
 * watches the repo root (see metro.config.js watchFolders), so this resolves
 * in the bundler as well as in Node.
 *
 * This app used to carry its own 575-word list. Phrases generated from it are
 * still accepted on entry: the fifteen of those words that are not BIP-39 are
 * LEGACY_ONLY_WORDS in the shared module. WORDLIST — what new phrases are
 * drawn from — is BIP-39 only.
 */
export {
  BIP39_WORDS as WORDLIST,
  BIP39_WORDS,
  LEGACY_ONLY_WORDS,
  ACCEPTED_WORDS,
  SEED_PHRASE_WORDS,
  SEED_PHRASE_BITS,
  isAcceptedWord,
  isLegacyOnlyWord,
} from '../../../shared/wordlist.js';

export {BIP39_WORDS as default} from '../../../shared/wordlist.js';
