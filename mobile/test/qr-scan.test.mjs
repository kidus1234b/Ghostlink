/**
 * What the scanner does with whatever a camera hands it.
 *
 * classifyScan decides whether a scanned string is a Ghost Address, an older
 * GL- invite, or something that is not ours at all. Getting this wrong either
 * refuses a valid peer or silently adds a garbage one, and neither shows up
 * until someone is standing in front of a phone — so it is tested here rather
 * than on a device.
 */
import fs from 'fs';

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n}`)); };

// The screen imports React Native and a camera; lift the pure function out.
const src = fs.readFileSync(new URL('../src/screens/QRScannerScreen.js', import.meta.url), 'utf8');
const start = src.indexOf('const INVITE_CODE_REGEX');
const end = src.indexOf('export default function QRScannerScreen');
const body = src.slice(start, end)
  .replace('export function classifyScan', 'function classifyScan')
  .replace(/const \{width: SCREEN_WIDTH\}[\s\S]*?;\n/, '')
  .replace(/const QR_SIZE[\s\S]*?;\n/, '');
const modPath = new URL('./.qr-scan.mjs', import.meta.url);
fs.writeFileSync(modPath,
  `import {normalizeGhostAddress} from '../src/utils/ghost-address.js';\n${body}\nexport {classifyScan};\n`);
const {classifyScan} = await import(modPath.href);

console.log('\n[1] Ghost Addresses');
{
  const addr = 'GHOST-7K2-M4Q-8ZB';
  for (const input of [addr, addr.toLowerCase(), '7K2M4Q8ZB', 'ghost7k2m4q8zb', `  ${addr}  `]) {
    const r = classifyScan(input);
    ok(`${JSON.stringify(input)} -> ${r.address}`, r.kind === 'ghost' && r.address === addr);
  }
  // Crockford folding: O->0, I/L->1, U->V.
  const folded = classifyScan('GHOST-OKI-M4Q-8ZB');
  ok('ambiguous characters fold (O->0, I->1)', folded.kind === 'ghost' && folded.address === 'GHOST-0K1-M4Q-8ZB');
}

console.log('\n[2] Legacy GL- invite codes');
{
  const code = 'GL-A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6';
  ok('uppercase code', classifyScan(code).kind === 'invite');
  ok('lowercase code is accepted', classifyScan(code.toLowerCase()).code === code);
  ok('a truncated code is not an invite', classifyScan('GL-A1B2C3D4').kind === 'unknown');
}

console.log('\n[3] JSON invite payloads');
{
  const withAddr = JSON.stringify({ghostAddress: 'GHOST-7K2-M4Q-8ZB', name: 'Ada'});
  const r1 = classifyScan(withAddr);
  ok('JSON carrying an address resolves to it', r1.kind === 'ghost' && r1.address === 'GHOST-7K2-M4Q-8ZB');
  ok('and keeps the name', r1.name === 'Ada');

  const withCode = JSON.stringify({code: 'GL-A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6', n: 'Bob'});
  const r2 = classifyScan(withCode);
  ok('JSON carrying a legacy code resolves to it', r2.kind === 'invite' && r2.name === 'Bob');

  ok('JSON with neither is unknown', classifyScan(JSON.stringify({hello: 'world'})).kind === 'unknown');
  ok('malformed JSON is unknown, not a crash', classifyScan('{not json').kind === 'unknown');
}

console.log('\n[4] Anything else is refused, never guessed at');
{
  for (const junk of ['', '   ', 'https://example.com', 'WIFI:S:net;P:pw;;', 'hello world', '12345']) {
    const r = classifyScan(junk);
    ok(`${JSON.stringify(junk)} -> ${r.kind}`, r.kind === 'unknown' || r.kind === 'empty');
  }
  for (const bad of [null, undefined, 0]) {
    ok(`${String(bad)} handled without throwing`, classifyScan(bad).kind === 'empty');
  }
  // A near-miss must not be coerced into a valid address.
  ok('8 characters is not an address', classifyScan('GHOST-7K2-M4Q-8Z').kind === 'unknown');
  ok('10 characters is not an address', classifyScan('GHOST-7K2-M4Q-8ZBB').kind === 'unknown');
}

fs.unlinkSync(modPath);
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
