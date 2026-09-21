/**
 * Session crypto for the direct WebRTC path: the layer that makes the padlock
 * honest when a message does not go through the Ghost Mesh.
 */
import {generateSessionKeyPair, deriveSessionKeys, encryptMessage, decryptMessage, isEncryptedEnvelope}
  from '../src/utils/session-crypto.js';

let pass=0, fail=0;
const ok=(c,m)=>{ c?(pass++,console.log('  ✓ '+m)):(fail++,console.error('  ✗ '+m)); };

const alice = generateSessionKeyPair();
const bob   = generateSessionKeyPair();
const A='aaa111', B='bbb222';

// Derive from each side independently, as the two devices would.
const aKeys = await deriveSessionKeys(alice.privateKey, bob.publicKey,   A, B);
const bKeys = await deriveSessionKeys(bob.privateKey,   alice.publicKey, B, A);

const hex=u8=>Buffer.from(u8).toString('hex');
ok(hex(aKeys.sendKey)===hex(bKeys.recvKey), "Alice's send key is Bob's receive key");
ok(hex(aKeys.recvKey)===hex(bKeys.sendKey), "Bob's send key is Alice's receive key");
ok(hex(aKeys.sendKey)!==hex(aKeys.recvKey), 'The two directions use different keys');

// Order of arguments must not matter to the outcome.
const aKeys2 = await deriveSessionKeys(alice.privateKey, bob.publicKeyHex, A, B);
ok(hex(aKeys2.sendKey)===hex(aKeys.sendKey), 'Hex and raw public keys derive identically');

const env = encryptMessage('the eagle lands at dawn', aKeys.sendKey);
ok(isEncryptedEnvelope(env), 'Produces a recognisable envelope');
ok(!JSON.stringify(env).includes('eagle'), 'The plaintext does not appear on the wire');
ok(decryptMessage(env, bKeys.recvKey)==='the eagle lands at dawn', 'Bob reads what Alice sent');

// Every message gets its own IV.
const ivs = new Set(Array.from({length:50},()=>encryptMessage('x', aKeys.sendKey).iv));
ok(ivs.size===50, 'A fresh IV per message (50/50 unique)');

// Tampering must fail loudly, not silently.
const bad = {...env, ct: (env.ct[0]==='a'?'b':'a')+env.ct.slice(1)};
let threw=false; try{ decryptMessage(bad, bKeys.recvKey); }catch{ threw=true; }
ok(threw, 'A tampered ciphertext is rejected');

// A third party with their own session cannot read it.
const eve = generateSessionKeyPair();
const eKeys = await deriveSessionKeys(eve.privateKey, alice.publicKey, 'eve999', A);
threw=false; try{ decryptMessage(env, eKeys.recvKey); }catch{ threw=true; }
ok(threw, 'An unrelated peer cannot decrypt it');

threw=false; try{ await deriveSessionKeys(alice.privateKey, alice.publicKey, A, A); }catch{ threw=true; }
ok(threw, 'Refuses to derive a session with ourselves');

threw=false; try{ encryptMessage('x', null); }catch{ threw=true; }
ok(threw, 'Refuses to encrypt without a key rather than sending plaintext');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
