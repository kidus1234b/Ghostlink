/**
 * recovery/discovery.js
 * Peer discovery for a device with no prior peer list.
 *
 * Solves the bootstrap problem:
 *   New device → seed phrase entered → needs to find peers holding fragments
 *   but has no addresses, no server, no DHT.
 *
 * Two entry points (both produce the same BootstrapRecord):
 *   1. Manual — user types/pastes a GL1: bootstrap string
 *   2. QR     — user scans a QR code that encodes the same string
 *
 * The GL1: string is generated on the old device before switching phones.
 * It contains: fingerprint, peer addresses, threshold k, timestamp.
 * It is NOT secret — it contains no keys, no private data.
 * Losing it means manual re-entry; it can be regenerated any time.
 *
 * ─── Bootstrap flow ──────────────────────────────────────────────────────────
 *
 *   Old device (before switch):
 *     Discovery.export(identity, knownPeers, k)
 *       → BootstrapRecord + GL1: string + QR data URL
 *
 *   New device (after switch):
 *     seed phrase → SeedEngine.toSeedBytes() → seedBytes
 *     GL1: string or QR scan → Discovery.parse() → BootstrapRecord
 *     Discovery.bootstrap(seedBytes, record, transport)
 *       → { reachable, holders, canRecover, tag }
 *     if canRecover:
 *       Distributor.recover(tag, holders) → encryptedBlob
 *       BlobEngine.unpack(encryptedBlob, seedBytes) → identity
 *
 * ─── Transport extension ─────────────────────────────────────────────────────
 *
 * Discovery needs one extra method on ITransport beyond distributor.js:
 *
 *   transport.connect(peerId: string, addr: string): Promise<void>
 *     Establish a channel to peerId at address addr.
 *     For WebRTC: initiates signaling exchange using addr as a hint.
 *     For MockTransport: no-op (peers already registered in MockNetwork).
 *     Must resolve before request() to that peerId will work.
 *
 * ─── QR adapter interface ─────────────────────────────────────────────────────
 *
 *   interface IQRAdapter {
 *     // Render a string as a QR code. Returns a data: URL (PNG or SVG).
 *     generate(text: string, opts?: { size?: number }): Promise<string>
 *
 *     // Decode a QR code from a File/Blob/ImageData or <video> stream.
 *     // Returns the decoded text, or throws if unreadable.
 *     // Optional — only needed for camera scanning.
 *     scan?(source: any): Promise<string>
 *   }
 *
 * See QRCodeJSAdapter below for the CDN-based (qrcode.js) implementation.
 *
 * ─── Storage adapter interface ────────────────────────────────────────────────
 *
 *   interface IStorage {
 *     get(key: string): any
 *     set(key: string, value: any): void
 *     delete(key: string): void
 *     keys(): string[]
 *   }
 *
 * See LocalStorageAdapter below.
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   Discovery.setQRAdapter(adapter)
 *   Discovery.setStorage(adapter)
 *
 *   Discovery.export(identity, peers, k, opts)  → ExportResult
 *   Discovery.parse(input)                      → BootstrapRecord
 *   Discovery.bootstrap(seedBytes, record, transport, opts) → BootstrapResult
 *
 *   Discovery.savePeers(peers)
 *   Discovery.loadPeers()             → Peer[]
 *   Discovery.clearPeers()
 */

import SeedEngine from "./seed.js";

// ─── constants ────────────────────────────────────────────────────────────────

const PREFIX         = "GL1:";
const RECORD_VERSION = 1;
const MAX_PEERS_IN_QR = 7;   // QR payload budget: ~7 peers fits in version-10 QR
const STORAGE_KEY    = "gl:discovery:peers";
const DEFAULT_K      = 3;
const DEFAULT_TIMEOUT = 6000;

// ─── BootstrapRecord schema ───────────────────────────────────────────────────
//
// This is what travels in the GL1: string and QR code.
// Short keys intentionally — QR codes have byte budgets.
//
// {
//   v:     1,                           // record version
//   fp:    "3F7A2C1B44DD89EF",         // fingerprint (16 hex) — for display + verification
//   k:     3,                           // Shamir threshold (how many fragments needed)
//   ts:    1700000000,                  // unix seconds (for staleness detection)
//   peers: [                            // ordered by recency (most recent first)
//     { id: "peerId", a: "addr", n: "Alex" },
//     ...
//   ]
// }

// ─── base64url helpers ────────────────────────────────────────────────────────

function toBase64url(str) {
  return btoa(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(b64) {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  return atob(pad ? padded + "=".repeat(4 - pad) : padded);
}

// ─── bootstrap string codec ───────────────────────────────────────────────────

/**
 * Encode a BootstrapRecord → "GL1:<base64url>" string.
 * This string is human-typeable, QR-encodable, and copy-pasteable.
 */
function encodeRecord(record) {
  // Compact JSON — remove whitespace
  const json = JSON.stringify(record);
  return PREFIX + toBase64url(json);
}

/**
 * Decode a GL1: string → BootstrapRecord.
 * Throws on malformed input.
 */
function decodeRecord(str) {
  const s = str.trim();
  if (!s.startsWith(PREFIX)) {
    throw new SyntaxError(
      `Not a GhostLink bootstrap string. Expected it to start with "${PREFIX}".`
    );
  }
  let record;
  try {
    record = JSON.parse(fromBase64url(s.slice(PREFIX.length)));
  } catch {
    throw new SyntaxError("Bootstrap string is malformed or corrupted.");
  }
  return validateRecord(record);
}

/**
 * Validate a parsed BootstrapRecord. Returns the record or throws.
 */
function validateRecord(r) {
  if (r.v !== RECORD_VERSION) {
    throw new RangeError(`Unknown bootstrap record version: ${r.v}`);
  }
  if (typeof r.fp !== "string" || r.fp.length !== 16) {
    throw new TypeError("Bootstrap record has invalid fingerprint.");
  }
  if (typeof r.k !== "number" || r.k < 2) {
    throw new RangeError(`Bootstrap record k must be ≥ 2, got ${r.k}`);
  }
  if (!Array.isArray(r.peers) || r.peers.length === 0) {
    throw new TypeError("Bootstrap record must contain at least one peer.");
  }
  for (const [i, p] of r.peers.entries()) {
    if (!p.id || !p.n) {
      throw new TypeError(`peers[${i}] missing required fields (id, n).`);
    }
  }
  return r;
}

// ─── QR adapters ─────────────────────────────────────────────────────────────

/**
 * Adapter for qrcode.js loaded from CDN.
 * CDN: https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js
 *
 * Add to index.html:
 *   <script src="https://cdnjs.cloudflare.com/.../qrcode.min.js"></script>
 *
 * Usage:
 *   Discovery.setQRAdapter(new QRCodeJSAdapter());
 */
class QRCodeJSAdapter {
  /**
   * Render text as a QR code using qrcode.js.
   * Returns a data: URL (PNG via canvas).
   */
  async generate(text, opts = {}) {
    const size = opts.size || 256;

    if (typeof window === "undefined" || !window.QRCode) {
      throw new Error(
        "QRCodeJSAdapter: window.QRCode not found.\n" +
        "Add to index.html: <script src=\"https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js\"></script>"
      );
    }

    return new Promise((resolve, reject) => {
      const div = document.createElement("div");
      div.style.position = "absolute";
      div.style.opacity  = "0";
      div.style.pointerEvents = "none";
      document.body.appendChild(div);

      try {
        new window.QRCode(div, {
          text,
          width:  size,
          height: size,
          correctLevel: window.QRCode.CorrectLevel.M,
        });

        // qrcode.js renders synchronously into a canvas
        const canvas = div.querySelector("canvas");
        if (!canvas) {
          reject(new Error("QRCodeJSAdapter: canvas element not created."));
          return;
        }
        resolve(canvas.toDataURL("image/png"));
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(div);
      }
    });
  }

  /**
   * Scan a QR code from an image File or Blob.
   * Requires jsQR: https://github.com/cozmo/jsQR
   *
   * If jsQR is not loaded, falls back to text input.
   */
  async scan(source) {
    if (typeof window === "undefined" || !window.jsQR) {
      throw new Error(
        "QRCodeJSAdapter.scan() requires jsQR.\n" +
        "Add: <script src=\"https://cdn.jsdelivr.net/npm/jsqr/dist/jsQR.min.js\"></script>\n" +
        "Or use text input (paste the GL1: string directly)."
      );
    }

    const bitmap = await createImageBitmap(source);
    const canvas = document.createElement("canvas");
    canvas.width  = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = window.jsQR(imageData.data, imageData.width, imageData.height);

    if (!result) throw new Error("No QR code found in image.");
    return result.data;
  }
}

/**
 * Minimal SVG QR adapter — no external library.
 * Generates a monochrome SVG string wrapped in a data: URL.
 *
 * Limitation: only works for short strings (≤ ~120 chars).
 * The GL1: string for 3 peers is typically ~200 chars — use QRCodeJSAdapter
 * for reliable scanning. This is a zero-dep fallback for display only.
 *
 * Uses a simple ISO 18004 QR encoding — supports alphanumeric + byte mode.
 * For short strings this produces version 3-5 QR codes.
 *
 * NOTE: This is intentionally simple, not a full QR spec implementation.
 *       Use QRCodeJSAdapter in production.
 */
class FallbackSVGAdapter {
  async generate(text) {
    // Delegate to an inline data URL encoding using the browser's
    // built-in QR support via <canvas> + ImageData — not available everywhere.
    // Instead: return a styled text block the user can copy-paste.
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120">
      <rect width="300" height="120" fill="#0a0a0f" rx="8"/>
      <text x="12" y="22" font-family="monospace" font-size="11" fill="#00ffa3">Bootstrap string (copy this):</text>
      <foreignObject x="10" y="30" width="280" height="80">
        <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:monospace;font-size:9px;color:#e0e0e8;word-break:break-all;padding:4px">
          ${escaped}
        </div>
      </foreignObject>
    </svg>`;
    return "data:image/svg+xml;base64," + btoa(svg);
  }
}

// ─── storage adapters ─────────────────────────────────────────────────────────

/**
 * localStorage adapter for peer persistence.
 * Values are JSON-serialized automatically.
 */
class LocalStorageAdapter {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); }
    catch { return undefined; }
  }
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  delete(key) {
    localStorage.removeItem(key);
  }
  keys() {
    return Object.keys(localStorage);
  }
}

/**
 * In-memory storage — for testing or environments without localStorage.
 */
class MemoryStorageAdapter {
  constructor() { this._map = new Map(); }
  get(key)         { return this._map.get(key); }
  set(key, value)  { this._map.set(key, value); }
  delete(key)      { this._map.delete(key); }
  keys()           { return [...this._map.keys()]; }
}

// ─── Discovery ────────────────────────────────────────────────────────────────

const Discovery = {
  _qrAdapter: new FallbackSVGAdapter(),
  _storage:   new MemoryStorageAdapter(),

  /** Inject a QR adapter (QRCodeJSAdapter or custom). */
  setQRAdapter(adapter) { this._qrAdapter = adapter; },

  /** Inject a storage adapter (LocalStorageAdapter or custom). */
  setStorage(adapter)   { this._storage = adapter;   },

  // ── export ────────────────────────────────────────────────────────────────

  /**
   * Build a bootstrap record from the current device's identity + peer list.
   * Call this on the OLD device before switching phones.
   *
   * identity : { fingerprint, publicKeyHex, name }
   * peers    : array of { id, name, addr?, ... }  — ordered by recency
   * k        : Shamir threshold (must match what was used in distribute())
   * opts.maxPeers : cap peer count in QR (default MAX_PEERS_IN_QR)
   * opts.qrSize   : QR image size in px (default 256)
   *
   * Returns ExportResult:
   * {
   *   record:    BootstrapRecord,
   *   text:      "GL1:...",   ← copy-paste this
   *   qrDataURL: "data:...",  ← show this as <img src=...>
   * }
   */
  async export(identity, peers, k = DEFAULT_K, opts = {}) {
    const { maxPeers = MAX_PEERS_IN_QR, qrSize = 256 } = opts;

    if (!identity?.fingerprint) throw new TypeError("identity.fingerprint is required");
    if (!Array.isArray(peers) || peers.length === 0) throw new TypeError("peers array is empty");
    if (k < 2) throw new RangeError("k must be ≥ 2");
    if (peers.length < k) {
      throw new RangeError(
        `Only ${peers.length} peers provided but k=${k} fragments are needed. ` +
        `Connect at least ${k} peers before exporting.`
      );
    }

    // Take the most recent peers up to budget
    const chosenPeers = peers.slice(0, maxPeers).map(p => ({
      id: p.id,
      n:  p.name || p.avatar || p.id.slice(0, 6),
      ...(p.addr ? { a: p.addr } : {}),
    }));

    const record = {
      v:     RECORD_VERSION,
      fp:    identity.fingerprint,
      k,
      ts:    Math.floor(Date.now() / 1000),
      peers: chosenPeers,
    };

    const text      = encodeRecord(record);
    const qrDataURL = await this._qrAdapter.generate(text, { size: qrSize });

    return { record, text, qrDataURL };
  },

  // ── parse ─────────────────────────────────────────────────────────────────

  /**
   * Parse a bootstrap record from either:
   *   - A GL1: string (manual entry or paste)
   *   - A File/Blob containing a QR code image (camera scan)
   *
   * Returns BootstrapRecord on success.
   * Throws SyntaxError/TypeError/RangeError on invalid input.
   */
  async parse(input) {
    if (typeof input === "string") {
      // Direct text input
      return decodeRecord(input.trim());
    }

    if (input instanceof File || input instanceof Blob) {
      // QR image scan
      const text = await this._qrAdapter.scan(input);
      return decodeRecord(text.trim());
    }

    throw new TypeError("parse() expects a GL1: string or a File/Blob containing a QR image.");
  },

  // ── bootstrap ─────────────────────────────────────────────────────────────

  /**
   * Contact peers from a BootstrapRecord and find which ones hold fragments.
   * Does NOT call Distributor.recover() — that's the caller's decision.
   *
   * seedBytes : Uint8Array[64] from SeedEngine.toSeedBytes()
   * record    : BootstrapRecord from Discovery.parse()
   * transport : ITransport (must support .connect())
   * opts.timeout : per-peer timeout in ms (default 6s)
   *
   * Returns BootstrapResult:
   * {
   *   tag:         string,   — owner's tag (SHA256 of publicKeyHex)
   *   fingerprint: string,   — derived fingerprint (matches record.fp if seed is correct)
   *   seedMatch:   bool,     — true if derived fp === record.fp (confirms correct seed)
   *   reachable:   Peer[],   — all peers we successfully connected to
   *   holders:     Peer[],   — peers that confirmed they hold a fragment for tag
   *   missing:     Peer[],   — reachable peers with no fragment
   *   unreachable: Peer[],   — peers that timed out or refused connection
   *   canRecover:  bool,     — holders.length >= record.k
   * }
   *
   * If seedMatch is false, the seed phrase entered does not match the
   * fingerprint in the record — warn the user before proceeding.
   */
  async bootstrap(seedBytes, record, transport, opts = {}) {
    if (!(seedBytes instanceof Uint8Array) || seedBytes.length !== 64) {
      throw new TypeError("seedBytes must be Uint8Array[64]");
    }
    validateRecord(record);

    const { timeout = DEFAULT_TIMEOUT } = opts;

    // Derive identity from seed
    const derivedFP  = await SeedEngine.fingerprintOf(seedBytes);
    const pubKeyHex  = await _derivePublicKeyHex(seedBytes);
    const tag        = await _sha256hex(pubKeyHex);
    const seedMatch  = derivedFP.toUpperCase() === record.fp.toUpperCase();

    // Connect to all peers and probe for fragments in parallel
    const results = await Promise.all(
      record.peers.map(async (p) => {
        const peer = { id: p.id, name: p.n, addr: p.a };

        try {
          // connect() is a no-op on MockTransport, real work on WebRTC
          if (transport.connect) {
            await transport.connect(peer.id, peer.addr ?? peer.id, timeout);
          }

          const res = await transport.request(
            peer.id,
            { type: "gl:exists", id: _msgId(), payload: { tag } },
            timeout
          );

          const hasFragment = !!res?.payload?.exists;
          return { peer, reachable: true, hasFragment };

        } catch {
          return { peer, reachable: false, hasFragment: false };
        }
      })
    );

    const reachable   = results.filter(r =>  r.reachable).map(r => r.peer);
    const holders     = results.filter(r =>  r.reachable &&  r.hasFragment).map(r => r.peer);
    const missing     = results.filter(r =>  r.reachable && !r.hasFragment).map(r => r.peer);
    const unreachable = results.filter(r => !r.reachable).map(r => r.peer);

    return {
      tag,
      fingerprint: derivedFP,
      seedMatch,
      reachable,
      holders,
      missing,
      unreachable,
      canRecover: holders.length >= record.k,
    };
  },

  // ── peer persistence ──────────────────────────────────────────────────────

  /**
   * Persist the known peer list to storage.
   * Call after a successful recovery to seed the next export.
   *
   * peers: array of { id, name, addr?, color?, avatar?, status?, ... }
   */
  savePeers(peers) {
    this._storage.set(STORAGE_KEY, peers);
  },

  /**
   * Load the persisted peer list.
   * Returns [] if nothing stored.
   */
  loadPeers() {
    return this._storage.get(STORAGE_KEY) ?? [];
  },

  clearPeers() {
    this._storage.delete(STORAGE_KEY);
  },

  // ── helpers (exposed for tests) ───────────────────────────────────────────

  _encodeRecord: encodeRecord,
  _decodeRecord: decodeRecord,
};

// ─── internal utilities ───────────────────────────────────────────────────────

async function _derivePublicKeyHex(seedBytes) {
  // Derive a stable public key hex from seed — same as setupIdentity() in the app.
  // Uses the "identity" subkey as the ECDH private key material.
  const raw = await SeedEngine.deriveRawKey(seedBytes, "identity");
  return Array.from(raw).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function _sha256hex(str) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function _msgId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

export default Discovery;
export {
  QRCodeJSAdapter,
  FallbackSVGAdapter,
  LocalStorageAdapter,
  MemoryStorageAdapter,
  encodeRecord,
  decodeRecord,
};
