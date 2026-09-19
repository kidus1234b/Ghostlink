import { EventEmitter } from 'events';
import { loadPublicPeers } from './public-peer-list.js';
import { PUBLIC_PEERS_FILE } from './paths.js';
import config from './config.js';
import logger from './logger.js';
import metrics from './metrics.js';
import type {
  CachedPeer,
  GMPNodeLike,
  GMPLinkLike,
  PeerCacheLike,
} from './types.js';

/** The minimum a bootstrap dial needs; both CachedPeer and PublicPeerEntry satisfy it. */
type DialableCandidate = Pick<CachedPeer, 'nodeId' | 'address' | 'port'>;

export class BootstrapManager extends EventEmitter {
  private node: GMPNodeLike;
  private minPeers: number;
  private parallelCount: number;
  /**
   * Private so only this class decides whether to bootstrap; metrics reads it
   * through the getter below to avoid reporting a node as unhealthy when
   * bootstrapping was deliberately switched off (tests, public peers).
   */
  private _disableBootstrap: boolean;
  private publicPeersPath: string | null;
  private stage1TimeoutMs: number;
  private stage2TimeoutMs: number;
  private rebootstrapBackoffInitialMs: number;
  /**
   * Private so only the bootstrap flow moves it; metrics reads it through the
   * `stage` getter below to decide whether to report the node as degraded.
   */
  private _stage: 'stage1' | 'stage2' | 'failed' | 'sufficient';
  private isBootstrapping: boolean;
  private failureCount: number;
  private dialingNodeIds: Set<string>;
  private failedAttempts: Set<string>;
  private rebootstrapTimer: NodeJS.Timeout | null;
  private closeListener: () => void;
  private attemptLog: DialAttempt[];
  private publicPeersSeen: number;

  constructor(node: GMPNodeLike, options: {
    minPeers?: number;
    parallelCount?: number;
    disableBootstrap?: boolean;
    publicPeersPath?: string | null;
    stage1TimeoutMs?: number;
    stage2TimeoutMs?: number;
    rebootstrapBackoffInitialMs?: number;
  } = {}) {
    super();
    this.node = node;

    this.minPeers = options.minPeers ?? config.GMP_MIN_PEERS;
    this.parallelCount = options.parallelCount ?? 5;
    this._disableBootstrap = options.disableBootstrap ?? false;
    this.publicPeersPath = options.publicPeersPath ?? null;
    this.stage1TimeoutMs = options.stage1TimeoutMs ?? config.GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS;
    this.stage2TimeoutMs = options.stage2TimeoutMs ?? config.GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS;
    this.rebootstrapBackoffInitialMs = options.rebootstrapBackoffInitialMs ?? config.GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS;

    this._stage = 'failed';
    this.isBootstrapping = false;
    this.failureCount = 0;

    this.dialingNodeIds = new Set();
    this.failedAttempts = new Set();
    this.rebootstrapTimer = null;
    this.attemptLog = [];
    this.publicPeersSeen = 0;

    this.closeListener = () => {
      this.checkAndTriggerRebootstrap();
    };
    this.node.on('close', this.closeListener);
  }

  /** Read-only view of the bootstrap stage, for metrics reporting. */
  get stage(): 'stage1' | 'stage2' | 'failed' | 'sufficient' {
    return this._stage;
  }

  /**
   * Whether bootstrapping is switched off. Readable for metrics, and writable
   * because it is legitimately toggled after construction: GMPNode defaults it
   * to IS_TEST_PROCESS, and a test that does want bootstrapping turns it back
   * on once the node is up.
   */
  get disableBootstrap(): boolean {
    return this._disableBootstrap;
  }

  set disableBootstrap(value: boolean) {
    this._disableBootstrap = value;
  }

  getDirectConnectionCount(): number {
    return Array.from(this.node.connections.values())
      .filter((link: GMPLinkLike) => link.state === 'connected' && !link.isVirtual).length;
  }

  async start(): Promise<void> {
    if (this._disableBootstrap || this.isBootstrapping) return;

    if (this.rebootstrapTimer) {
      clearTimeout(this.rebootstrapTimer);
      this.rebootstrapTimer = null;
    }

    this.isBootstrapping = true;
    this.dialingNodeIds.clear();
    this.failedAttempts.clear();
    this.attemptLog = [];
    this.publicPeersSeen = 0;

    metrics.increment('bootstrap.attempts');
    // Epoch ms, not an ISO string: both the Registry entry and the
    // lastAttemptAt field in the metrics JSON are declared number | null, and
    // this was the only place emitting a string into them.
    metrics.set('bootstrap.lastAttemptAt', Date.now());

    this._stage = 'stage1';
    const candidates = this.node.peerCache.getCandidates() || [];
    const topN = candidates.slice(0, this.parallelCount);

    logger.info('bootstrap', 'stage1-start', `Starting bootstrap stage 1 with ${topN.length} candidates`, {
      candidatesCount: topN.length
    });

    if (topN.length > 0) {
      topN.forEach(c => this.dialCandidate(c));
    }

    let startTime = Date.now();
    while (Date.now() - startTime < this.stage1TimeoutMs) {
      if (this.getDirectConnectionCount() >= this.minPeers) {
        this._stage = 'sufficient';
        this.isBootstrapping = false;
        this.failureCount = 0;
        const count = this.getDirectConnectionCount();
        logger.info('bootstrap', 'complete', `Bootstrap complete with ${count} peers in Stage 1`, { peersConnected: count });
        this.emit('bootstrap-complete', count);
        this.node.emit('bootstrap-complete', count);
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    this._stage = 'stage2';
    const publicPeers = loadPublicPeers(this.publicPeersPath || undefined);
    this.publicPeersSeen = publicPeers.length;
    const availablePublic = publicPeers.filter(p => !this.node.getLinkByNodeId(p.nodeId));
    const nextBatch = availablePublic.slice(0, this.parallelCount);

    logger.info('bootstrap', 'stage2-start', `Stage 1 timed out. Starting bootstrap stage 2 with ${nextBatch.length} public peers`, {
      publicPeersCount: nextBatch.length
    });

    if (nextBatch.length > 0) {
      nextBatch.forEach(p => this.dialCandidate(p));
    }

    startTime = Date.now();
    while (Date.now() - startTime < this.stage2TimeoutMs) {
      if (this.getDirectConnectionCount() >= this.minPeers) {
        this._stage = 'sufficient';
        this.isBootstrapping = false;
        this.failureCount = 0;
        const count = this.getDirectConnectionCount();
        logger.info('bootstrap', 'complete', `Bootstrap complete with ${count} peers in Stage 2`, { peersConnected: count });
        this.emit('bootstrap-complete', count);
        this.node.emit('bootstrap-complete', count);
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    this._stage = 'failed';
    this.isBootstrapping = false;
    const count = this.getDirectConnectionCount();

    const diagnosis = this.diagnose();
    logger.warn('bootstrap', 'failed', `Bootstrap finished without sufficient peers (connected: ${count}, required: ${this.minPeers}) — ${diagnosis.reason}`, {
      peersConnected: count,
      reason: diagnosis.reason,
      publicPeersConfigured: diagnosis.publicPeersConfigured,
      peersFile: diagnosis.peersFile
    });
    this.emit('bootstrap-failed', count, diagnosis);
    this.node.emit('bootstrap-failed', count, diagnosis);

    if (count < this.minPeers / 2) {
      const backoffInitial = this.rebootstrapBackoffInitialMs;
      const backoffs = [backoffInitial, backoffInitial * 2, backoffInitial * 4, backoffInitial * 10];
      const delay = backoffs[Math.min(this.failureCount, backoffs.length - 1)];
      this.failureCount++;

      logger.info('bootstrap', 'retry-scheduled', `Scheduling bootstrap retry in ${delay}ms`, { delay, failureCount: this.failureCount });

      this.rebootstrapTimer = setTimeout(() => {
        this.rebootstrapTimer = null;
        this.start();
      }, delay);

      if (this.rebootstrapTimer && this.rebootstrapTimer.unref) {
        this.rebootstrapTimer.unref();
      }
    }
  }

  /**
   * Takes only the three fields a dial actually needs. It was typed CachedPeer,
   * but stage 2 hands it PublicPeerEntry, which carries no cache bookkeeping —
   * and nothing in here ever looked at that bookkeeping anyway.
   */
  async dialCandidate(candidate: DialableCandidate): Promise<void> {
    if (!candidate || !candidate.nodeId) return;

    const nodeIdHex = candidate.nodeId;
    if (this.node.identity && nodeIdHex === this.node.identity.nodeIdHex) return;

    if (this.node.getLinkByNodeId(nodeIdHex)) return;
    if (this.dialingNodeIds.has(nodeIdHex)) return;
    if (this.failedAttempts.has(nodeIdHex)) return;

    this.dialingNodeIds.add(nodeIdHex);

    try {
      await this.node.dial(candidate.address, candidate.port);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      // Keep why it failed, not just that it did. "cannot reach the host" and
      // "reached it but it would not complete a handshake" send the user to
      // completely different fixes, and the UI is expected to say which.
      this.attemptLog.push({
        address: candidate.address,
        port: candidate.port,
        nodeId: nodeIdHex,
        stage: this._stage === 'stage2' ? 'public' : 'cached',
        kind: classifyDialError(err),
        message: err && err.message ? err.message : String(e)
      });
      this.failedAttempts.add(nodeIdHex);
      this.node.peerCache.recordFailure(nodeIdHex);
    } finally {
      this.dialingNodeIds.delete(nodeIdHex);
    }
  }

  /**
   * Turn this run's failures into the single thing the user most needs to be
   * told. Ordered by which explanation is most actionable: an empty peer list
   * is a configuration problem, a handshake rejection means the far end is a
   * peer but disagrees with us, and an unreachable host is a network or
   * deployment problem.
   */
  diagnose(): BootstrapDiagnosis {
    const publicAttempts = this.attemptLog.filter(a => a.stage === 'public');
    const connected = this.getDirectConnectionCount();

    let reason: BootstrapFailureReason;
    if (connected > 0) {
      // Peers were reached, just fewer than minPeers. The node can route and
      // resolve addresses on this many, so this is a thin mesh, not a broken
      // one — and with the shipped list holding a single public peer against a
      // default minPeers of 3, it is also the normal outcome of a completely
      // healthy bootstrap. Reporting it as unreachable is what made a working
      // peer look like a missing one.
      reason = 'insufficient-peers';
    } else if (this.publicPeersSeen === 0) {
      reason = 'no-public-peers-configured';
    } else if (publicAttempts.length === 0) {
      // The list was non-empty but nothing was dialled: every entry was already
      // linked, or the batch was empty after filtering.
      reason = 'no-public-peers-attempted';
    } else if (publicAttempts.some(a => a.kind === 'handshake')) {
      reason = 'handshake-failed';
    } else {
      reason = 'peers-unreachable';
    }

    return {
      reason,
      peersConnected: connected,
      publicPeersConfigured: this.publicPeersSeen,
      peersFile: this.publicPeersPath || PUBLIC_PEERS_FILE,
      attempts: this.attemptLog.slice(0, 8)
    };
  }

  attemptCandidates(): void {
    if (!this.isBootstrapping) return;
    if (this.getDirectConnectionCount() >= this.minPeers) return;

    const candidates = this.node.peerCache.getCandidates() || [];
    const active = candidates.filter(c => !this.dialingNodeIds.has(c.nodeId) && !this.failedAttempts.has(c.nodeId) && !this.node.getLinkByNodeId(c.nodeId));

    if (active.length > 0) {
      const toDial = active.slice(0, this.parallelCount - this.dialingNodeIds.size);
      toDial.forEach(c => this.dialCandidate(c));
    }
  }

  checkAndTriggerRebootstrap(): void {
    if (this._disableBootstrap || this.isBootstrapping || this.rebootstrapTimer) return;
    const count = this.getDirectConnectionCount();
    if (count < this.minPeers / 2) {
      this.failureCount = 0;
      const delay = this.rebootstrapBackoffInitialMs;
      logger.info('bootstrap', 'trigger-rebootstrap', `Peers below critical threshold (${count} < ${this.minPeers / 2}). Scheduling re-bootstrap in ${delay}ms.`, { peersConnected: count });
      this.rebootstrapTimer = setTimeout(() => {
        this.rebootstrapTimer = null;
        this.start();
      }, delay);
      if (this.rebootstrapTimer && this.rebootstrapTimer.unref) {
        this.rebootstrapTimer.unref();
      }
    }
  }

  close(): void {
    this.node.off('close', this.closeListener);
    if (this.rebootstrapTimer) {
      clearTimeout(this.rebootstrapTimer);
      this.rebootstrapTimer = null;
    }
  }
}

export type BootstrapFailureReason =
  | 'insufficient-peers'
  | 'no-public-peers-configured'
  | 'no-public-peers-attempted'
  | 'handshake-failed'
  | 'peers-unreachable';

export interface DialAttempt {
  address: string;
  port: number;
  nodeId: string;
  stage: 'cached' | 'public';
  kind: 'unreachable' | 'handshake' | 'unknown';
  message: string;
}

export interface BootstrapDiagnosis {
  reason: BootstrapFailureReason;
  peersConnected: number;
  publicPeersConfigured: number;
  peersFile: string;
  attempts: DialAttempt[];
}

/**
 * A dial fails either before or after the TCP connection is established, and
 * the two look nothing alike to a user. Socket-level errno codes mean we never
 * reached the peer; everything the handshake itself raises means we did.
 */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
  'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE', 'ERR_SOCKET_CONNECTION_TIMEOUT'
]);

export function classifyDialError(err: NodeJS.ErrnoException | null | undefined): DialAttempt['kind'] {
  if (!err) return 'unknown';
  if (err.code && UNREACHABLE_CODES.has(err.code)) return 'unreachable';
  const msg = (err.message || '').toLowerCase();
  if (!msg) return 'unknown';
  if (msg.includes('connection timeout') || msg.includes('dial timeout')) return 'unreachable';
  if (
    msg.includes('handshake') ||
    msg.includes('hello') ||
    msg.includes('protocol version') ||
    msg.includes('signature') ||
    msg.includes('nodeid') ||
    msg.includes('timestamp')
  ) return 'handshake';
  return 'unknown';
}
