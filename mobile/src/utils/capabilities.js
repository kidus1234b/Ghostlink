/**
 * GhostLink Mobile — what this build can actually do.
 *
 * One place to answer "is this feature reachable?", so a control that leads
 * nowhere is disabled at the source rather than in each screen that happens to
 * render it, and so a test can assert the gate rather than trusting a reviewer
 * to notice.
 *
 * The rule these encode: a control that appears to work and does not is worse
 * than no control. Each flag below is false because the path behind it is
 * known-broken, and each carries the reason and what would flip it.
 *
 * When a capability lands, flip the flag here and the UI follows.
 */

/**
 * Voice and video calls.
 *
 * The call path cannot complete. `WebRTCService.createConnection()` has no
 * rendezvous — the signaling servers were removed and the web client has no
 * SDP-paste fallback to copy — so an offer is created and nothing ever answers
 * it. CallScreen then marks the call connected regardless. On the mesh path
 * `createConnection` hands back a placeholder peer whose `pc` has only
 * `close()`, so `addMediaStream()` fails with "addTrack is not a function".
 * The screen also renders placeholder views rather than RTCView, so even a
 * connected call would show nothing.
 *
 * Flips when the direct path has a rendezvous and the mesh path exposes a
 * media-capable peer connection.
 */
export const CALLS_AVAILABLE = false;

/** Shown on a disabled call control, and used as its accessibility label. */
export const CALLS_UNAVAILABLE_REASON =
  'Calls unavailable until direct connection is supported';

/**
 * The Ghost Mesh setup modal.
 *
 * Its "Verify & Continue" calls `CryptoService.deriveYggdrasilIdentity()`,
 * which reaches for `react-native-quick-crypto`. That package is not in this
 * build, and CryptoService stands a Proxy in its place that throws on any
 * property access — deliberately, so it cannot silently return wrong bytes.
 * The result is a crash the user can trigger from Settings.
 *
 * Flips when the native crypto dependency is included, or when mesh identity
 * derivation moves onto the @noble implementation in utils/crypto.js that the
 * rest of the app already uses.
 */
export const MESH_SETUP_AVAILABLE = false;

export const MESH_SETUP_UNAVAILABLE_REASON =
  'Ghost Mesh setup is unavailable in this build';

/**
 * Guardian (Shamir) social recovery.
 *
 * Reaching a guardian needs a rendezvous, and the signaling dial it used was
 * removed with the servers. The distribution modal also reads an empty peer
 * list that nothing populates.
 *
 * Flips when there is a transport a guardian can be reached over.
 */
export const GUARDIAN_RECOVERY_AVAILABLE = false;

export const GUARDIAN_RECOVERY_UNAVAILABLE_REASON =
  'Guardian recovery needs a peer connection, which this build cannot make yet';
