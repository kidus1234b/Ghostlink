/**
 * Restoring from a recovery phrase.
 *
 * The phrase was unenterable before this: twelve words written down and
 * nowhere in the app that would accept them. These cover the parsing and
 * validation the screen depends on, plus that the entry points exist.
 *
 * The wordlist is a curated 575-word list with no BIP-39 checksum, so a phrase
 * cannot be proved correct — only that every word is in the list. Confirming
 * the derived Ghost Address is what stands in for a checksum.
 */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {splitPhrase, validatePhrase, suggestWords} from '../src/utils/phrase-entry.js';
import {WORDLIST, SEED_PHRASE_WORDS} from '../src/utils/wordlist.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = p => fs.readFileSync(path.join(here, '..', p), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };

const REAL = WORDLIST.slice(0, SEED_PHRASE_WORDS);

// ── Pasting ────────────────────────────────────────────────────────────────
ok(splitPhrase(REAL.join(' ')).length === 12, 'A pasted phrase separated by spaces is split into 12 words');
ok(splitPhrase(REAL.join('\n')).length === 12, 'Newlines work too — people paste from notes');
ok(splitPhrase(REAL.join(', ')).length === 12, 'So does a comma-separated list');
ok(splitPhrase(REAL.join(' ').toUpperCase())[0] === REAL[0].toLowerCase(),
   'Case is normalised, so a capitalised phrase still matches');
ok(splitPhrase('  ' + REAL.join('   ') + '  ').length === 12, 'Stray whitespace is ignored');

// ── Validation ─────────────────────────────────────────────────────────────
ok(validatePhrase(REAL).ok, 'A phrase of twelve real words is accepted');

const short = validatePhrase(REAL.slice(0, 9));
ok(!short.ok && short.missing === 3, 'An incomplete phrase reports how many words are missing');

const typo = [...REAL.slice(0, 11), 'notarealword'];
const typoResult = validatePhrase(typo);
ok(!typoResult.ok && typoResult.unknown.includes(11),
   'A word that is not in the list is identified by position, so the user knows which to check');

const twoBad = validatePhrase(['xxxx', ...REAL.slice(1, 11), 'yyyy']);
ok(twoBad.unknown.length === 2, 'Every unknown word is reported, not just the first');

ok(validatePhrase(REAL.map(w => w.toUpperCase())).ok,
   'Validation is case-insensitive');

// ── Autocomplete ───────────────────────────────────────────────────────────
const sugg = suggestWords(REAL[0].slice(0, 3));
ok(sugg.length > 0 && sugg.every(w => w.toLowerCase().startsWith(REAL[0].slice(0, 3).toLowerCase())),
   'Suggestions all start with what was typed');
ok(suggestWords('a').length === 0, 'A single letter suggests nothing — the list would be useless');
ok(suggestWords('zzzzzz').length === 0, 'A prefix matching nothing suggests nothing');
ok(suggestWords(REAL[0].slice(0, 2)).length <= 5, 'Suggestions are capped so the row stays usable');

// ── The entry points must exist ────────────────────────────────────────────
const setup = read('src/screens/SetupScreen.js');
ok(setup.includes("navigation.navigate('RestoreIdentity')"),
   'Setup offers a way to restore an existing identity');
ok(setup.includes('I already have an identity'),
   'The restore option is labelled in the words a returning user would look for');
ok(setup.includes('Create new identity'),
   'Creating a new identity is still offered alongside it');

const nav = read('src/navigation/MainNavigator.js');
ok(nav.includes('RestoreIdentity'), 'The restore screen is reachable from the auth stack');

// ── The phrase must never be screenshot-able ───────────────────────────────
const restore = read('src/screens/RestoreIdentityScreen.js');
ok(restore.includes('useSecureScreen'), 'The restore entry screen blocks screenshots');
ok(setup.includes('useSecureScreenWhen(phraseVisible)'),
   'The setup flow blocks screenshots while the phrase and quiz are on screen');
ok(/autoComplete="off"/.test(restore) && /autoCorrect=\{false\}/.test(restore),
   'The phrase inputs do not offer autocomplete or autocorrect');
ok(/importantForAutofill="no"/.test(restore),
   'The phrase inputs are kept out of autofill');
ok(/visible-password/.test(restore),
   'Android uses a keyboard that does not learn what is typed');

// ── It must be honest about what does not come back ────────────────────────
ok(/Past messages, files and contacts stay on your old device/.test(restore),
   'The screen says plainly that messages do not come back');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
