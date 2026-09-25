# Security Policy — GhostLink

This file covers the GhostLink apps (web, desktop, mobile). The mesh transport
has its own policy in [`gmp-core/SECURITY.md`](gmp-core/SECURITY.md).

---

## Accepted limitations

### Licensing is an honesty mechanism, not a cryptographic control

Pro and Enterprise licenses are verified entirely on the user's device
(`src/license/license-core.js`). The verification key is an HMAC secret that
ships inside the client, lightly obfuscated, and the signature on a license key
is 40 bits. It follows that:

- anyone who reads the client can mint valid license keys offline;
- anyone can patch the check out of their own copy of the app.

This is not fixable while GhostLink keeps its zero-server design: a check that
runs only on the user's machine can always be bypassed by that user, and
verifying licenses against a server would contradict the "zero servers"
promise. We accept it deliberately.

What this means in practice:

- A license key tells you what someone paid for. It does not prevent use of
  paid features, and nothing in GhostLink's security relies on it.
- Paid tiers gate convenience features only. No encryption, key handling,
  or privacy protection depends on license state, and none ever should — a
  change that makes a security property depend on the license tier is a bug.
- License bugs that let a user unlock features on their own device are not
  treated as security vulnerabilities. Bugs where one user's license actions
  affect another user are.

What we did remove, because it made forging trivial rather than merely
possible: a `window.generateLicense` console helper that shipped in the
production bundle, and trust in the cached license tier and expiry stored in
`localStorage` (the stored key is now re-verified on every load).

---

## Disabled features

### Guardian (social) recovery

Splitting a recovery backup into fragments held by trusted contacts is
**disabled** on web and mobile. The receiving side never stored fragments, so
a backup could be reported as "safe" while no guardian actually held
anything. Until a transport exists that delivers, stores and returns fragments,
the feature is gated off on both the sending and receiving side, and the app
never reports a guardian backup as complete. Use the recovery phrase.

---

## Reporting a vulnerability

Please report security issues privately to ghostlink@proton.me rather than in a
public issue. Include the affected component (web, desktop, mobile, gmp-core),
the version or commit, and steps to reproduce.
