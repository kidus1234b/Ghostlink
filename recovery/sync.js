/**
 * recovery/sync.js
 * Epoch-based snapshot — wires BlobEngine + Distributor together.
 *
 * Trigger conditions:
 *   - Every MESSAGE_EPOCH (50) messages
 *   - On page hide / beforeunload (app close / background)
 *   - Manual backup() call
 *   - After onPeerAdded() — with debounce
 *
 * ─── Lifecycle ────────────────────────────────────────────────────────────────
 *
 *   1. App calls SyncEngine.init({ identity, seedBytes, peers, transport, … })
 *   2. SyncEngine registers visibilitychange + beforeunload listeners
 *   3. App calls SyncEngine.onMessage() for each message sent or received
 *   4. At MESSAGE_EPOCH → auto backup
 *   5. App close / page hide → flush if msgCount > 0
 *   6. SyncEngine.onPeerAdded(peer) → backup after PEER_DEBOUNCE_MS
 *   7. await SyncEngine.backup() → manual backup
 *
 * ─── Concurrency ─────────────────────────────────────────────────────────────
 *
 *   At most one backup runs at a time.
 *   A second trigger while in-flight sets _pending; one more run follows.
 *
 * ─── Security ────────────────────────────────────────────────────────────────
 *
 *   seedBytes is NEVER persisted. Only msgCount + lastBackup timestamps
 *   are written to optional IStorage. Caller holds seedBytes in memory.
 *
 * ─── Public API ──────────────────────────────────────────────────────────────
 *
 *   SyncEngine.init(opts)             — configure and activate
 *   SyncEngine.setIdentity(payload)   — swap identity payload
 *   SyncEngine.setSeedBytes(bytes)    — swap seed (e.g. after unlock)
 *   SyncEngine.setPeers(peers)        — swap peer list
 *   SyncEngine.onMessage()            — call per message; counts toward epoch
 *   SyncEngine.onPeerAdded(peer)      — triggers backup after debounce
 *   SyncEngine.backup({ force? })     — manual backup; returns SyncResult
 *   SyncEngine.status()               — read-only state snapshot
 *   SyncEngine.teardown()             — remove listeners, clear secrets
 *
 * @typedef {object} SyncResult
 * @property {boolean}  ok          — stored >= k
 * @property {number}   stored      — peers that accepted their fragment
 * @property {number}   needed      — k (threshold)
 * @property {string[]} failed      — peer IDs that rejected/timed out
 * @property {string}   triggeredBy — "manual" | "epoch" | "peer-added" | …
 * @property {number}   backupAt    — unix ms timestamp of this run
 */

import BlobEngine from "./blob.js";
import Distributor, { FragmentStore } from "./distributor.js";

// ─── constants ────────────────────────────────────────────────────────────────

/** Messages between automatic backups. */
const MESSAGE_EPOCH    = 50;

/** Debounce window after onPeerAdded before triggering backup. */
const PEER_DEBOUNCE_MS = 3_000;

// Persistence keys (written to IStorage if provided)
const SK_MSG_COUNT  = "gl:sync:msgCount";
const SK_LAST_AT    = "gl:sync:lastBackupAt";

// ─── SyncEngine ───────────────────────────────────────────────────────────────

const SyncEngine = {

  // ── internal state ─────────────────────────────────────────────────────────

  _identity:    null,   // IdentityPayload
  _seedBytes:   null,   // Uint8Array[64] — never persisted
  _peers:       null,   // Peer[]
  _transport:   null,   // ITransport
  _storage:     null,   // IStorage (optional)
  _n:           5,      // fragments to distribute
  _k:           3,      // threshold
  _timeout:     10_000, // per-peer ms

  _msgCount:    0,      // messages since last backup
  _inFlight:    false,  // backup currently running
  _pending:     false,  // another trigger arrived while in-flight
  _peerTimer:   null,   // debounce handle for onPeerAdded

  _visChange:   null,   // bound listener references for teardown
  _beforeUnload: null,

  // ── init ───────────────────────────────────────────────────────────────────

  /**
   * Configure and activate automatic backup triggers.
   *
   * @param {object}         opts
   * @param {object}         opts.identity    — IdentityPayload to snapshot
   * @param {Uint8Array}     opts.seedBytes   — 64-byte seed for blob encryption
   * @param {object[]}       opts.peers       — peer list [{ id, name }]
   * @param {object}         opts.transport   — ITransport implementation
   * @param {object}         [opts.storage]   — IStorage for persisting counters
   * @param {number}         [opts.n=5]       — total fragments to distribute
   * @param {number}         [opts.k=3]       — recovery threshold
   * @param {number}         [opts.timeout=10000] — per-peer timeout ms
   */
  init({ identity, seedBytes, peers, transport, storage = null,
         n = 5, k = 3, timeout = 10_000 }) {
    this._identity  = identity;
    this._seedBytes = seedBytes;
    this._peers     = peers ?? [];
    this._transport = transport;
    this._storage   = storage;
    this._n         = n;
    this._k         = k;
    this._timeout   = timeout;
    this._inFlight  = false;
    this._pending   = false;

    // Restore persisted message count so epoch survives page reloads
    const saved = this._load(SK_MSG_COUNT);
    this._msgCount = saved !== null ? Math.max(0, Number(saved)) : 0;

    // Register browser lifecycle hooks (no-op outside of browser contexts)
    if (typeof document !== "undefined") {
      this._visChange = () => {
        if (document.visibilityState === "hidden" && this._msgCount > 0) {
          this._trigger("visibility-hidden");
        }
      };
      this._beforeUnload = () => {
        if (this._msgCount > 0) this._trigger("beforeunload");
      };
      document.addEventListener("visibilitychange", this._visChange);
      window.addEventListener("beforeunload", this._beforeUnload);
    }
  },

  // ── identity / peer / seed updates ─────────────────────────────────────────

  /** Swap identity payload (e.g. after profile edit). */
  setIdentity(identity) { this._identity = identity; },

  /** Swap seed bytes (e.g. after re-unlock). Never stored. */
  setSeedBytes(seedBytes) { this._seedBytes = seedBytes; },

  /** Replace peer list entirely. */
  setPeers(peers) { this._peers = peers ?? []; },

  // ── trigger hooks ──────────────────────────────────────────────────────────

  /**
   * Call for every message sent or received.
   * Counts toward MESSAGE_EPOCH; resets on trigger.
   */
  onMessage() {
    this._msgCount++;
    this._save(SK_MSG_COUNT, String(this._msgCount));

    if (this._msgCount >= MESSAGE_EPOCH) {
      this._msgCount = 0;
      this._save(SK_MSG_COUNT, "0");
      this._trigger("epoch");
    }
  },

  /**
   * Call after a new peer is added to the peer list.
   * Appends peer if not already present, then schedules a backup
   * after PEER_DEBOUNCE_MS to catch multiple rapid additions.
   *
   * @param {{ id: string, name: string }} peer
   */
  onPeerAdded(peer) {
    if (peer && !this._peers.find(p => p.id === peer.id)) {
      this._peers.push(peer);
    }

    if (this._peerTimer !== null) clearTimeout(this._peerTimer);
    this._peerTimer = setTimeout(() => {
      this._peerTimer = null;
      this._trigger("peer-added");
    }, PEER_DEBOUNCE_MS);
  },

  // ── manual backup ──────────────────────────────────────────────────────────

  /**
   * Run a backup immediately and return the result.
   *
   * @param {object}  [opts]
   * @param {boolean} [opts.force=false] — bypass in-flight guard
   * @returns {Promise<SyncResult>}
   */
  async backup({ force = false } = {}) {
    return this._runBackup("manual", force);
  },

  // ── status ─────────────────────────────────────────────────────────────────

  /**
   * Read-only snapshot of current sync state.
   *
   * @returns {{ lastBackupAt: number|null, msgCount: number, peers: number,
   *             n: number, k: number, inFlight: boolean }}
   */
  status() {
    const raw = this._load(SK_LAST_AT);
    return {
      lastBackupAt: raw !== null ? Number(raw) : null,
      msgCount:     this._msgCount,
      peers:        this._peers ? this._peers.length : 0,
      n:            this._n,
      k:            this._k,
      inFlight:     this._inFlight,
    };
  },

  // ── teardown ───────────────────────────────────────────────────────────────

  /**
   * Detach all event listeners and zero out sensitive references.
   * Call on logout or component unmount.
   */
  teardown() {
    if (typeof document !== "undefined") {
      if (this._visChange)    document.removeEventListener("visibilitychange", this._visChange);
      if (this._beforeUnload) window.removeEventListener("beforeunload", this._beforeUnload);
    }
    this._visChange    = null;
    this._beforeUnload = null;

    if (this._peerTimer !== null) {
      clearTimeout(this._peerTimer);
      this._peerTimer = null;
    }

    // Zero out secrets — GC can collect them but we help it along
    this._seedBytes = null;
    this._identity  = null;
  },

  // ── internal ───────────────────────────────────────────────────────────────

  /**
   * Queue or start a backup.
   * Safe to call from event handlers — swallows async errors.
   */
  _trigger(reason) {
    if (this._inFlight) {
      this._pending = true;
      return;
    }
    this._runBackup(reason, false).catch(() => {});
  },

  /**
   * Core backup cycle: pack → distribute → persist timestamp.
   *
   * @param {string}  reason
   * @param {boolean} force  — skip in-flight guard
   * @returns {Promise<SyncResult>}
   */
  async _runBackup(reason, force) {
    if (this._inFlight && !force) {
      this._pending = true;
      throw new Error("Backup already in flight");
    }

    // Prerequisites
    if (!this._identity)  throw new Error("SyncEngine: identity not set — call init() first");
    if (!this._seedBytes) throw new Error("SyncEngine: seedBytes not set — call init() first");
    if (!this._transport) throw new Error("SyncEngine: transport not set — call init() first");
    if (!this._peers || this._peers.length < this._k) {
      throw new Error(
        `SyncEngine: need at least k=${this._k} peers, have ${this._peers ? this._peers.length : 0}`
      );
    }

    this._inFlight = true;

    let result;
    try {
      // 1. Pack identity → EncryptedBlob
      const blob = await BlobEngine.pack(this._identity, this._seedBytes);

      // 2. Distribute — use up to n peers
      const peersToUse  = this._peers.slice(0, this._n);
      const distributor = this._makeDistributor();
      const distResult  = await distributor.distribute(blob, peersToUse, {
        n:       peersToUse.length,
        k:       this._k,
        timeout: this._timeout,
      });

      // 3. Persist last-backup timestamp
      const backupAt = Date.now();
      this._save(SK_LAST_AT, String(backupAt));

      result = {
        ok:          distResult.ok,
        stored:      distResult.stored,
        needed:      distResult.needed,
        failed:      distResult.failed,
        triggeredBy: reason,
        backupAt,
      };
    } finally {
      this._inFlight = false;

      // Drain one pending trigger
      if (this._pending) {
        this._pending = false;
        Promise.resolve().then(() => this._trigger("queued"));
      }
    }

    return result;
  },

  /**
   * Build a client-only Distributor instance wired to the current transport.
   * Uses Object.create to match the instantiation pattern in distributor.js.
   */
  _makeDistributor() {
    const d       = Object.create(Distributor);
    d._store      = new FragmentStore();
    d._transport  = this._transport;
    return d;
  },

  // ── storage helpers ────────────────────────────────────────────────────────

  _save(key, value) {
    if (!this._storage) return;
    try { this._storage.set(key, value); } catch { /* non-fatal */ }
  },

  _load(key) {
    if (!this._storage) return null;
    try { return this._storage.get(key) ?? null; } catch { return null; }
  },

};

export default SyncEngine;
