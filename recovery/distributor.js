/**
 * recovery/distributor.js
 * Fragment distribution and recovery coordinator.
 *
 * Depends on: ./shamir.js, ./blob.js (for tag helpers)
 * Transport: injected — wire up WebRTC, WebSocket, or MockTransport.
 *
 * ─── Architecture ────────────────────────────────────────────────────────────
 *
 * Every device runs both roles simultaneously:
 *
 *   CLIENT role — distributes own fragments to peers, recovers from them.
 *   PEER role   — receives, holds, and returns fragments for others.
 *
 * Distributor handles both via a single message handler.
 *
 * ─── What gets split ─────────────────────────────────────────────────────────
 *
 * Shamir splits the raw encrypted blob bytes (not the key).
 * Reconstruction produces the encrypted blob → caller decrypts with seed.
 * No peer can read anything — they hold an opaque byte slice.
 *
 * ─── Message protocol ────────────────────────────────────────────────────────
 *
 *   gl:store        client → peer   store this fragment for tag
 *   gl:store:ack    peer → client   stored / rejected
 *   gl:fetch        client → peer   return fragment for tag
 *   gl:fetch:res    peer → client   fragment | null
 *   gl:exists       client → peer   do you hold anything for tag?
 *   gl:exists:res   peer → client   { exists: bool }
 *   gl:revoke       client → peer   delete all fragments for tag
 *   gl:revoke:ack   peer → client   deleted count
 *
 * All messages: { type, id, payload }
 * id is a random hex string for correlating request/response pairs.
 *
 * ─── Transport interface ─────────────────────────────────────────────────────
 *
 * Implement ITransport to connect any underlying channel:
 *
 *   interface ITransport {
 *     // Fire-and-forget. Throws if peer is unreachable.
 *     send(peerId: string, message: object): Promise<void>
 *
 *     // Send message, await response or timeout.
 *     // Resolves with response payload. Rejects on timeout or send error.
 *     request(peerId: string, message: object, timeoutMs?: number): Promise<object>
 *
 *     // Register handler for ALL incoming messages from any peer.
 *     // handler(peerId: string, message: object) => object | undefined
 *     // Return value is sent back as the response (for request/response pairs).
 *     onMessage(handler: Function): void
 *   }
 *
 * See MockTransport below for a reference implementation.
 *
 * ─── Public API ──────────────────────────────────────────────────────────────
 *
 *   Distributor.useTransport(transport)
 *   Distributor.distribute(encryptedBlob, peers, opts) → DistributeResult
 *   Distributor.recover(tag, peers, opts)              → EncryptedBlob
 *   Distributor.probe(tag, peers, opts)                → ProbeResult[]
 *   Distributor.revoke(tag, peers)                     → RevokeResult
 */

import Shamir from "./shamir.js";

// ─── protocol constants ───────────────────────────────────────────────────────

export const MSG = Object.freeze({
  STORE:      "gl:store",
  STORE_ACK:  "gl:store:ack",
  FETCH:      "gl:fetch",
  FETCH_RES:  "gl:fetch:res",
  EXISTS:     "gl:exists",
  EXISTS_RES: "gl:exists:res",
  REVOKE:     "gl:revoke",
  REVOKE_ACK: "gl:revoke:ack",
});

const DEFAULT_TTL     = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
const DEFAULT_TIMEOUT = 6000;                       // ms per request

// ─── helpers ─────────────────────────────────────────────────────────────────

function msgId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function blobToBytes(encryptedBlob) {
  return enc.encode(JSON.stringify(encryptedBlob));
}

function bytesToBlob(bytes) {
  return JSON.parse(dec.decode(bytes));
}

// ─── FragmentStore (peer-side storage) ───────────────────────────────────────
//
// Holds other users' Shamir fragments. The peer cannot read the content —
// each entry is an opaque encoded string tagged with the owner's pubkey hash.
//
// Pluggable backend: pass a StorageAdapter to persist across sessions.
// Default: in-memory (lost on page reload — wire up IndexedDB for production).
//
// StorageAdapter interface:
//   get(key: string): any | undefined
//   set(key: string, value: any): void
//   delete(key: string): void
//   keys(): string[]

class FragmentStore {
  constructor(adapter = null) {
    this._mem = new Map();
    this._adapter = adapter;

    // Restore from adapter if provided
    if (adapter) {
      for (const key of adapter.keys()) {
        if (key.startsWith("gl:frag:")) {
          this._mem.set(key.slice(8), adapter.get(key));
        }
      }
    }
  }

  /** Store an encoded fragment string for a given tag + x-coordinate. */
  store(tag, encodedFragment, ttl = DEFAULT_TTL) {
    const entry = { encodedFragment, storedAt: Date.now(), expiresAt: Date.now() + ttl };
    const key = `${tag}:${_xFromEncoded(encodedFragment)}`;
    this._mem.set(key, entry);
    this._adapter?.set(`gl:frag:${key}`, entry);
  }

  /** Return all encoded fragment strings held for a tag. */
  fetchAll(tag) {
    return [...this._mem.entries()]
      .filter(([k]) => k.startsWith(`${tag}:`))
      .filter(([, v]) => Date.now() < v.expiresAt)  // skip expired
      .map(([, v]) => v.encodedFragment);
  }

  /** True if this store holds at least one non-expired fragment for tag. */
  has(tag) {
    return [...this._mem.entries()]
      .some(([k, v]) => k.startsWith(`${tag}:`) && Date.now() < v.expiresAt);
  }

  /** Delete all fragments for tag. Returns number deleted. */
  revoke(tag) {
    let count = 0;
    for (const key of [...this._mem.keys()]) {
      if (key.startsWith(`${tag}:`)) {
        this._mem.delete(key);
        this._adapter?.delete(`gl:frag:${key}`);
        count++;
      }
    }
    return count;
  }

  /** Remove all expired entries. Call periodically. */
  prune() {
    const now = Date.now();
    for (const [key, val] of [...this._mem.entries()]) {
      if (now >= val.expiresAt) {
        this._mem.delete(key);
        this._adapter?.delete(`gl:frag:${key}`);
      }
    }
  }

  /** Total fragment count (for diagnostics). */
  get size() { return this._mem.size; }
}

/** Extract the x-coordinate from an encoded share without full decode. */
function _xFromEncoded(hex) {
  // Wire format: [version=0x01][x][n][k]... — x is byte index 1
  return parseInt(hex.slice(2, 4), 16);
}

// ─── Distributor ─────────────────────────────────────────────────────────────

const Distributor = {
  _transport: null,
  _store: new FragmentStore(),

  /**
   * Inject a transport implementation.
   * Must be called before distribute() or recover().
   * Safe to call again to swap transports (e.g. reconnect).
   */
  useTransport(transport) {
    this._transport = transport;
    transport.onMessage((peerId, msg) => this._handleIncoming(peerId, msg));
  },

  /**
   * Replace the fragment store (e.g. to wire up IndexedDB persistence).
   * Call before useTransport().
   */
  useStore(store) {
    this._store = store;
  },

  /**
   * Split an encrypted blob and distribute fragments to peers.
   *
   * encryptedBlob : output of BlobEngine.pack()
   * peers         : array of { id: string, name: string, ... }
   * opts.n        : total fragments to create (default 5)
   * opts.k        : reconstruction threshold (default 3)
   * opts.ttl      : fragment lifetime in ms on each peer (default 30 days)
   * opts.timeout  : per-peer request timeout in ms (default 6s)
   *
   * Returns DistributeResult:
   * {
   *   ok: bool,          — true if at least k fragments were stored
   *   stored: number,    — how many peers accepted
   *   needed: number,    — k (minimum to recover)
   *   failed: PeerError[], — peers that rejected or timed out
   * }
   *
   * Does NOT throw if some peers fail — partial success is expected.
   * Throws only on misconfiguration (no transport, n > peers.length, etc.).
   */
  async distribute(encryptedBlob, peers, opts = {}) {
    this._assertTransport();

    const {
      n       = 5,
      k       = 3,
      ttl     = DEFAULT_TTL,
      timeout = DEFAULT_TIMEOUT,
    } = opts;

    if (peers.length < n) {
      throw new RangeError(
        `distribute() needs ${n} peers but only ${peers.length} provided. ` +
        `Lower n or connect more peers.`
      );
    }
    if (k > n) throw new RangeError(`k (${k}) cannot exceed n (${n})`);

    const tag       = encryptedBlob.tag;
    const blobBytes = blobToBytes(encryptedBlob);
    const fragments = Shamir.split(blobBytes, n, k, tag);

    // Distribute one fragment per peer (first n peers)
    const chosen  = peers.slice(0, n);
    const results = await Promise.allSettled(
      chosen.map(async (peer, i) => {
        const encoded = Shamir.encode(fragments[i]);
        await this._transport.request(
          peer.id,
          { type: MSG.STORE, id: msgId(), payload: { tag, fragment: encoded, ttl } },
          timeout
        );
        return peer.id;
      })
    );

    const stored = results.filter(r => r.status === "fulfilled");
    const failed = results
      .map((r, i) => r.status === "rejected"
        ? { peerId: chosen[i].id, reason: r.reason?.message || "unknown" }
        : null)
      .filter(Boolean);

    return {
      ok:     stored.length >= k,
      stored: stored.length,
      needed: k,
      failed,
    };
  },

  /**
   * Collect fragments from peers and reconstruct the encrypted blob.
   *
   * tag      : encryptedBlob.tag (SHA256 of owner's publicKeyHex)
   * peers    : array of { id: string, ... } — all known peers to query
   * opts.k   : reconstruction threshold (must match what was used in distribute)
   * opts.timeout : per-peer request timeout (default 6s)
   *
   * Returns the reconstructed EncryptedBlob object.
   * Caller then decrypts it with BlobEngine.unpack(blob, seedBytes).
   *
   * Throws if fewer than k fragments are collected.
   */
  async recover(tag, peers, opts = {}) {
    this._assertTransport();

    const {
      k       = 3,
      timeout = DEFAULT_TIMEOUT,
    } = opts;

    // Ask all peers in parallel — don't stop on individual failures
    const fragments = [];

    await Promise.allSettled(
      peers.map(async (peer) => {
        try {
          const res = await this._transport.request(
            peer.id,
            { type: MSG.FETCH, id: msgId(), payload: { tag } },
            timeout
          );
          if (res?.payload?.fragment) {
            fragments.push(Shamir.decode(res.payload.fragment));
          }
        } catch {
          // Peer offline, timed out, or holds no fragment for this tag — skip
        }
      })
    );

    if (fragments.length < k) {
      throw new Error(
        `Recovery failed: collected ${fragments.length} fragment(s), need ${k}. ` +
        `Ensure at least ${k} peers that received fragments are online.`
      );
    }

    // Use exactly k fragments (extra are redundant)
    const blobBytes = Shamir.reconstruct(fragments.slice(0, k));
    return bytesToBlob(blobBytes);
  },

  /**
   * Ask peers whether they hold a fragment for a given tag.
   * Useful for diagnostics and recovery UI ("3 of 5 peers reachable").
   *
   * Returns ProbeResult[]:
   * [{ peerId, reachable: bool, hasFragment: bool, latencyMs: number }, ...]
   */
  async probe(tag, peers, opts = {}) {
    this._assertTransport();
    const { timeout = DEFAULT_TIMEOUT } = opts;

    return Promise.all(
      peers.map(async (peer) => {
        const start = Date.now();
        try {
          const res = await this._transport.request(
            peer.id,
            { type: MSG.EXISTS, id: msgId(), payload: { tag } },
            timeout
          );
          return {
            peerId:      peer.id,
            reachable:   true,
            hasFragment: !!res?.payload?.exists,
            latencyMs:   Date.now() - start,
          };
        } catch {
          return {
            peerId:      peer.id,
            reachable:   false,
            hasFragment: false,
            latencyMs:   Date.now() - start,
          };
        }
      })
    );
  },

  /**
   * Ask peers to delete all fragments they hold for a tag.
   * Call this on explicit account wipe or key rotation.
   * Best-effort — offline peers keep their fragments until TTL expires.
   *
   * Returns { revoked: number, total: number, failed: PeerError[] }.
   */
  async revoke(tag, peers, opts = {}) {
    this._assertTransport();
    const { timeout = DEFAULT_TIMEOUT } = opts;

    const results = await Promise.allSettled(
      peers.map(peer =>
        this._transport.request(
          peer.id,
          { type: MSG.REVOKE, id: msgId(), payload: { tag } },
          timeout
        )
      )
    );

    const revoked = results.filter(r => r.status === "fulfilled").length;
    const failed  = results
      .map((r, i) => r.status === "rejected"
        ? { peerId: peers[i].id, reason: r.reason?.message || "unknown" }
        : null)
      .filter(Boolean);

    return { revoked, total: peers.length, failed };
  },

  // ── incoming message handler (peer role) ────────────────────────────────

  /**
   * Handle an incoming protocol message from another peer.
   * Called by the transport's onMessage callback.
   * Returns a response object that the transport sends back.
   */
  _handleIncoming(peerId, msg) {
    if (!msg?.type) return null;

    switch (msg.type) {
      case MSG.STORE: {
        const { tag, fragment, ttl } = msg.payload;
        this._store.store(tag, fragment, ttl);
        return { type: MSG.STORE_ACK, id: msg.id, payload: { ok: true } };
      }

      case MSG.FETCH: {
        const { tag } = msg.payload;
        const fragments = this._store.fetchAll(tag);
        // Return the first one we have (one fragment per peer by design)
        const fragment = fragments[0] ?? null;
        return { type: MSG.FETCH_RES, id: msg.id, payload: { fragment } };
      }

      case MSG.EXISTS: {
        const { tag } = msg.payload;
        return { type: MSG.EXISTS_RES, id: msg.id, payload: { exists: this._store.has(tag) } };
      }

      case MSG.REVOKE: {
        const { tag } = msg.payload;
        const count = this._store.revoke(tag);
        return { type: MSG.REVOKE_ACK, id: msg.id, payload: { deleted: count } };
      }

      default:
        return null;
    }
  },

  _assertTransport() {
    if (!this._transport) {
      throw new Error(
        "No transport configured. Call Distributor.useTransport(t) first.\n" +
        "For testing use MockTransport. For production wire up WebRTC."
      );
    }
  },
};

// ─── MockTransport ────────────────────────────────────────────────────────────
//
// Reference ITransport implementation for testing and local dev.
// Simulates a network of Distributor instances in the same JS process.
//
// Usage:
//   const net = new MockNetwork();
//   const t1 = net.join("alice");
//   const t2 = net.join("bob");
//   Distributor.useTransport(t1);
//   // now Distributor can reach "bob" via t1.request("bob", msg)

class MockTransport {
  constructor(ownId, network) {
    this._id       = ownId;
    this._network  = network; // shared MockNetwork registry
    this._handler  = null;
    this._offline  = false;   // set true to simulate disconnect
    this._latencyMs = 0;      // set > 0 to simulate network delay
  }

  /** Simulate going offline (requests to this peer will timeout). */
  goOffline()  { this._offline = true;  }
  goOnline()   { this._offline = false; }
  setLatency(ms) { this._latencyMs = ms; }

  async send(peerId, message) {
    const peer = this._network._get(peerId);
    if (!peer || peer._offline) throw new Error(`Peer ${peerId} unreachable`);
    if (peer._latencyMs) await _sleep(peer._latencyMs);
    peer._handler?.(this._id, message);
  }

  async request(peerId, message, timeoutMs = DEFAULT_TIMEOUT) {
    const peer = this._network._get(peerId);
    if (!peer || peer._offline) throw new Error(`Peer ${peerId} unreachable`);

    return Promise.race([
      (async () => {
        if (peer._latencyMs) await _sleep(peer._latencyMs);
        return peer._handler?.(this._id, message);
      })(),
      _sleep(timeoutMs).then(() => { throw new Error(`Request to ${peerId} timed out`); }),
    ]);
  }

  onMessage(handler) {
    this._handler = handler;
  }
}

class MockNetwork {
  constructor() { this._peers = new Map(); }

  /** Add a peer to the network and return its MockTransport. */
  join(peerId) {
    const transport = new MockTransport(peerId, this);
    this._peers.set(peerId, transport);
    return transport;
  }

  leave(peerId) { this._peers.delete(peerId); }

  _get(peerId) { return this._peers.get(peerId) ?? null; }
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export default Distributor;
export { FragmentStore, MockTransport, MockNetwork };
