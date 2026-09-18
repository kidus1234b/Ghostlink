// ── Message Types ──────────────────────────────────

export const enum MessageType {
  HELLO             = 0x01,
  HELLO_ACK         = 0x02,
  DATA              = 0x03,
  PING              = 0x04,
  PONG              = 0x05,
  BINDING_REQUEST   = 0x06,
  BINDING_RESPONSE  = 0x07,
  TOPOLOGY_ANNOUNCE = 0x08,
  PEER_REQUEST      = 0x09,
  PEER_RESPONSE     = 0x0A,
  KEY_ROTATION      = 0x0B,
}

export const PROTOCOL_VERSION = 0x01;

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

// ── Identity ────────────────────────────────────────

export interface NodeKeypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface NodeIdentity {
  seed: Uint8Array;
  staticPrivKey: Uint8Array;
  staticPubKey: Uint8Array;
  signingPrivKey: Uint8Array;
  signingPubKey: Uint8Array;
  nodeId: Uint8Array;
  nodeIdHex: string;
  staticPubKeyHex: string;
  signingPubKeyHex: string;
  staticPrivKeyHex: string;
  signingPrivKeyHex: string;
}

export interface EphemeralKeypair {
  ephemeralPriv: Uint8Array;
  ephemeralPub: Uint8Array;
}

// ── Session ─────────────────────────────────────────

export interface RawSessionKeys {
  initiatorKey: Uint8Array;
  responderKey: Uint8Array;
}

export interface PeerSession {
  peerNodeId: string;
  isInitiator: boolean;
  sessionKeys: RawSessionKeys;
  sendNonce: number;
  recvNonce: number;
  establishedAt: number;
}

// ── Wire Protocol ───────────────────────────────────

export interface HelloPayload {
  version: number;
  nodeId: string;
  ephemeralPubKey: Uint8Array;
  timestamp: number;
  signature: Uint8Array;
  encryptedProof: Uint8Array;
}

export interface HelloAckPayload {
  version: number;
  nodeId: string;
  ephemeralPubKey: Uint8Array;
  timestamp: number;
  signature: Uint8Array;
  encryptedProof: Uint8Array;
}

export interface DataPayload {
  isRouted: boolean;
  sourceNodeId?: string;
  finalDestinationNodeId?: string;
  hopCount?: number;
  encryptedData: Uint8Array;
}

export interface BindingResponse {
  address: string;
  port: number;
}

export interface TopologyAnnouncePayload {
  announcerNodeId: string;
  connectedToNodeId: string;
  sequenceNumber: number;
  timestamp: number;
  withdrawn: boolean;
  ttl: number;
}

export interface PeerInfo {
  nodeId: string;
  address: string;
  port: number;
  lastSeen: number;
}

export interface PeerRequestPayload {
  maxPeers: number;
}

export interface PeerResponsePayload {
  peers: PeerInfo[];
}

export interface KeyRotationPayload {
  oldNodeId: string;
  /**
   * Hex, not bytes. rotateKey() sets this from signingPubKeyHex, the verifier
   * concatenates it into the signed message as a string, and PeerCache stores
   * it as a string. It was declared Uint8Array, which matched none of those.
   */
  newPublicKey: string;
  newNodeId: string;
  rotationTimestamp: number;
  /** Hex, for the same reason: rotateKey() runs the signature through bytesToHex. */
  signature: string;
}

// ── Routing ─────────────────────────────────────────

export interface RouteEntry {
  destinationNodeId: string;
  nextHopNodeId: string;
  hopCount: number;
  lastUpdated: number;
}

// ── Peer Cache ──────────────────────────────────────

export interface CachedPeer {
  nodeId: string;
  address: string;
  port: number;
  firstSeen: number;
  lastSeen: number;
  connectionCount: number;
  lastFailedAt: number | null;
  failureCount: number;
}

export interface PublicPeerEntry {
  address: string;
  port: number;
  tls?: boolean;
  nodeId: string;
  addedAt: number;
  lastVerified: number;
}

// ── NAT ─────────────────────────────────────────────

export type NatType =
  | 'NO_NAT_OR_FULL_CONE'
  | 'RESTRICTED_CONE'
  | 'SYMMETRIC'
  | 'UNKNOWN';

// ── Config ──────────────────────────────────────────

export interface GMPConfig {
  GMP_PORT: number;
  GMP_BRIDGE_PORT: number;
  GMP_BRIDGE_HOST: string;
  GMP_MIN_PEERS: number;
  GMP_MAX_PEERS: number;
  GMP_MAX_CONNECTIONS: number;
  GMP_HELLO_TIMEOUT_MS: number;
  GMP_HANDSHAKE_TIMEOUT_MS: number;
  GMP_PING_INTERVAL_MS: number;
  GMP_PING_TIMEOUT_MS: number;
  GMP_TIMESTAMP_WINDOW_MS: number;
  GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS: number;
  GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS: number;
  GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS: number;
  GMP_RATE_LIMIT_WINDOW_MS: number;
  GMP_RATE_LIMIT_MAX_PER_IP: number;
  GMP_RATE_LIMIT_MAX_GLOBAL: number;
  GMP_FORWARD_RATE_LIMIT_PER_SOURCE: number;
  GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS: number;
  GMP_SESSION_KEY_LRU_SIZE: number;
  GMP_SEQUENCE_NUM_LRU_SIZE: number;
  GMP_NONCE_PRUNE_AGE_MS: number;
  GMP_ROUTE_EXPIRY_MS: number;
  GMP_TOPOLOGY_TTL: number;
  GMP_MESSAGE_HOP_LIMIT: number;
  GMP_REANNOUNCE_INTERVAL_MS: number;
  GMP_PEER_CACHE_MAX_SIZE: number;
  GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD: number;
  GMP_PEER_CACHE_PRUNE_AGE_DAYS: number;
  GMP_METRICS_PORT: number;
  GMP_LOG_LEVEL: LogLevel;
  GMP_LOG_TO_FILE: boolean;
  GMP_LOG_TO_CONSOLE: boolean;
  /**
   * Refuse to run on a state file that exists but cannot be authenticated,
   * instead of discarding it and continuing. Off by default so a corrupt file
   * does not brick a user's client; turn it on for public peers and anything
   * unattended, where silently losing replay protection is the worse outcome.
   */
  GMP_STRICT_STATE: boolean;
  GMP_BAN_DURATION_MS: number;
  GMP_REPUTATION_RECOVERY_INTERVAL_MS: number;

  /**
   * Seed phrase the identity is derived from.
   *
   * Optional because it has no default and is not always configured: the CLI
   * reads process.env.GMP_SEED_PHRASE first and prompts for one if neither is
   * set. Note that loadConfig only copies keys present in DEFAULTS, so a
   * GMP_SEED_PHRASE in a config file is currently dropped — the env variable
   * and the constructor option are the paths that work.
   */
  GMP_SEED_PHRASE?: string;
}

/**
 * What GMPNodeManager's constructor accepts: any config override, plus the two
 * shorthand names the bridge's 'start' message and the CLI actually send.
 * These are aliases resolved in start(), not config keys in their own right,
 * which is why they are not on GMPConfig.
 */
export interface GMPNodeManagerOptions extends Partial<GMPConfig> {
  seedPhrase?: string;
  port?: number;
}

/**
 * The option bag GMPNodeManager hands to GMPNode.
 *
 * Only seven of these are read by GMPNode's constructor: port, minPeers,
 * pingIntervalMs, pongTimeoutMs, timestampWindowMs, noncePruneAgeMs and
 * seedPhrase. The other twenty-one are destructured nowhere and silently
 * dropped. They are not dead settings — the modules that consume them (rate
 * limiter, forwarder, peer cache, bootstrap, topology) import the shared config
 * module directly, so a value set through the environment or config.json does
 * take effect. What does NOT take effect is a per-instance override handed to
 * `new GMPNodeManager({...})`: it lands in this.config, gets forwarded here,
 * and GMPNode ignores it.
 *
 * They are kept in the call because they state the intended contract and start
 * working the moment GMPNode's constructor accepts them. Declaring the shape
 * here is what lets the compiler see the call instead of tripping over an
 * excess-property check on an untyped literal.
 */
export interface GMPNodeConstructorOptions {
  port?: number;
  minPeers?: number;
  maxPeers?: number;
  maxConnections?: number;
  helloTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  timestampWindowMs?: number;
  stage1TimeoutMs?: number;
  stage2TimeoutMs?: number;
  rebootstrapBackoffInitialMs?: number;
  rateLimitWindowMs?: number;
  rateLimitMaxPerIp?: number;
  rateLimitMaxGlobal?: number;
  forwardRateLimitPerSource?: number;
  peerRequestRateLimitIntervalMs?: number;
  sessionKeyLruSize?: number;
  sequenceNumLruSize?: number;
  noncePruneAgeMs?: number;
  routeExpiryMs?: number;
  topologyTtl?: number;
  messageHopLimit?: number;
  reannounceIntervalMs?: number;
  peerCacheMaxSize?: number;
  peerCachePruneFailureThreshold?: number;
  peerCachePruneAgeDays?: number;
  seedPhrase?: string;
}

// ── Events ──────────────────────────────────────────

export type GMPNodeEventName =
  | 'connected'
  | 'disconnected'
  | 'message'
  | 'error'
  | 'rate-limited'
  | 'forwarded'
  | 'no-route'
  | 'ttl-expired'
  | 'clock-skew-detected'
  | 'bootstrap-complete'
  | 'bootstrap-failed'
  | 'routing-degraded';

export interface GMPNodeEventPayloads {
  'connected': [peerNodeId: string, address: string, port: number];
  'disconnected': [peerNodeId: string];
  'message': [fromNodeId: string, data: Uint8Array];
  'error': [error: Error];
  'rate-limited': [ip: string, reason: string];
  'forwarded': [fromNodeId: string, toNodeId: string];
  'no-route': [destinationNodeId: string];
  'ttl-expired': [destinationNodeId: string];
  'clock-skew-detected': [peerNodeId: string, deltaMs: number];
  'bootstrap-complete': [peersConnected: number];
  'bootstrap-failed': [peersConnected: number];
  'routing-degraded': [];
}

// ── Health ──────────────────────────────────────────

export type NodeHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'isolated'
  | 'bootstrapping';

export interface HealthReport {
  status: NodeHealthStatus;
  currentPeerCount: number;
  peakPeerCount: number;
  messagesForwarded: number;
  messagesDroppedNoRoute: number;
  messagesDroppedTTL: number;
  uptimeSeconds: number;
  bootstrapAttempts: number;
}

// ── Reputation ──────────────────────────────────────

export type ReputationEvent =
  | 'signature-failure'
  | 'malformed-message'
  | 'rate-limit-hit'
  | 'forged-node-id'
  | 'clock-skew';

export type PeerTrustLevel =
  | 'trusted'
  | 'suspicious'
  | 'untrusted'
  | 'banned';

// ── Wire framing helpers ─────────────────────────────

export interface WireFrame {
  messageType: MessageType;
  payload: Uint8Array;
}

export interface HandshakeProps {
  nodeId: string;
  address: string;
  port: number;
  isInitiator: boolean;
  stage: 'connecting' | 'hello' | 'hello_ack' | 'complete' | 'failed';
  ephemeralPriv?: Uint8Array;
  ephemeralPub?: Uint8Array;
  peerEphemeralPub?: Uint8Array;
  sharedSecret?: Uint8Array;
  initiatorKey?: Uint8Array;
  responderKey?: Uint8Array;
  sendCipherState?: CipherState;
  recvCipherState?: CipherState;
}

export interface CipherState {
  key: Uint8Array;
  nonce: number;
}

export interface NonceEntry {
  nonce: number;
  sequenceNum: number;
  expiresAt: number;
}

export interface ForwarderStats {
  messagesForwarded: number;
  messagesDroppedNoRoute: number;
  messagesDroppedTTL: number;
}

// ── Socket helpers ──────────────────────────────────

export type SocketSide = 'client' | 'server';

// ── Logger interface ────────────────────────────────

export interface LogMeta {
  [key: string]: unknown;
}

// ── TLS / IPC bridge types ───────────────────────────

export interface BridgeMessage {
  type: string;
  [key: string]: unknown;
}

export interface OriginCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Thrown when a state file exists but cannot be authenticated and
 * GMP_STRICT_STATE says to refuse rather than discard it.
 *
 * It has its own type because the load() paths wrap everything in a broad
 * try/catch that logs and starts fresh — exactly the behaviour strict mode
 * exists to prevent — so that catch has to be able to recognise this and
 * rethrow instead of swallowing it.
 */
export class StateAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateAuthenticationError';
  }
}
