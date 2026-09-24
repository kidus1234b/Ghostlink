/**
 * What this build can actually do.
 *
 * A feature whose UI is present but whose implementation does not work is
 * worse than a missing feature: it costs the user time, and in a messenger it
 * can cost them their identity or their privacy while looking like it
 * succeeded. When something cannot be relied on, it is disabled here and the
 * control says why, rather than being left reachable.
 *
 * Mirrors mobile/src/utils/capabilities.js. Keep the two in step.
 */
(function (exports) {
  'use strict';

  /**
   * The manual Yggdrasil / Ghost Mesh setup dialog.
   *
   * The dialog asks for a Yggdrasil IPv6 address and a recovery phrase, then
   * claims "Cryptographic Matching Confirmed!" when its own derivation of the
   * phrase matches the pasted address. Two things about that derivation are
   * unverified against a real Yggdrasil node:
   *
   *   - It derives the address from SHA-512 of an *X25519* public key.
   *     Yggdrasil derives it from the *Ed25519* key. If that is right, a user
   *     pasting their genuine address always fails verification, and the only
   *     way to reach the success screen is to paste back the address the app
   *     printed in its own failure toast — the app verifying itself.
   *
   *   - The success screen then hands out that X25519 keypair to be pasted
   *     into Yggdrasil's Ed25519 `PrivateKeyHex` field, which would not
   *     produce the address shown and could break a working node's config.
   *
   * Disabled until it is checked against `yggdrasilctl getSelf` on a real
   * node. The derivation itself is kept — see CryptoEngine.deriveLegacyYggdrasilIP
   * and test/ghost-address-kdf.test.mjs — so that check can be done without
   * reconstructing anything.
   *
   * Flips when the address scheme is confirmed to match a real node, or when
   * it is corrected to.
   */
  var MESH_SETUP_AVAILABLE = false;

  var MESH_SETUP_UNAVAILABLE_REASON =
    'Yggdrasil setup is unverified against a real node and is disabled.';

  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.Capabilities = {
    MESH_SETUP_AVAILABLE: MESH_SETUP_AVAILABLE,
    MESH_SETUP_UNAVAILABLE_REASON: MESH_SETUP_UNAVAILABLE_REASON
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
