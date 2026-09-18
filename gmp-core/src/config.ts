import fs from 'fs';
import path from 'path';
import { CONFIG_FILE } from './paths.js';
import type { GMPConfig, LogLevel } from './types.js';


export const DEFAULTS: GMPConfig = {
  GMP_PORT: 49500,
  GMP_BRIDGE_PORT: 3002,
  GMP_BRIDGE_HOST: '127.0.0.1',
  GMP_MIN_PEERS: 3,
  GMP_MAX_PEERS: 100,
  GMP_MAX_CONNECTIONS: 100,
  GMP_HELLO_TIMEOUT_MS: 10000,
  GMP_HANDSHAKE_TIMEOUT_MS: 10000,
  GMP_PING_INTERVAL_MS: 30000,
  GMP_PING_TIMEOUT_MS: 10000,
  GMP_TIMESTAMP_WINDOW_MS: 120000,
  GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS: 10000,
  GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS: 15000,
  GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS: 30000,
  GMP_RATE_LIMIT_WINDOW_MS: 60000,
  GMP_RATE_LIMIT_MAX_PER_IP: 10,
  GMP_RATE_LIMIT_MAX_GLOBAL: 100,
  GMP_FORWARD_RATE_LIMIT_PER_SOURCE: 500,
  GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS: 60000,
  GMP_SESSION_KEY_LRU_SIZE: 50,
  GMP_SEQUENCE_NUM_LRU_SIZE: 1000,
  GMP_NONCE_PRUNE_AGE_MS: 7776000000,
  GMP_ROUTE_EXPIRY_MS: 300000,
  GMP_TOPOLOGY_TTL: 16,
  GMP_MESSAGE_HOP_LIMIT: 16,
  GMP_REANNOUNCE_INTERVAL_MS: 60000,
  GMP_PEER_CACHE_MAX_SIZE: 500,
  GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD: 10,
  GMP_PEER_CACHE_PRUNE_AGE_DAYS: 30,
  GMP_METRICS_PORT: 9090,
  GMP_LOG_LEVEL: 'INFO',
  GMP_LOG_TO_FILE: false,
  GMP_LOG_TO_CONSOLE: true,
  GMP_STRICT_STATE: false,
  GMP_BAN_DURATION_MS: 86400000,
  GMP_REPUTATION_RECOVERY_INTERVAL_MS: 60000,
};

type DefaultKeys = keyof typeof DEFAULTS;

/**
 * Narrow a runtime string to a real config key.
 *
 * `key in DEFAULTS` does not narrow a plain `string` on its own, so without
 * this the call sites below had to cast. Going through a guard means the
 * assignment is checked against the actual key union instead.
 */
function isDefaultKey(key: string): key is DefaultKeys {
  return key in DEFAULTS;
}

/**
 * Write a config value whose key is only known at runtime.
 *
 * GMPConfig is an interface, so it has no implicit index signature and cannot
 * be indexed by a computed key. The key has already been narrowed to one that
 * exists in DEFAULTS, so the write is sound; this helper is the single place
 * that reasoning lives, rather than a cast repeated at each call site.
 */
function setConfigValue(target: GMPConfig, key: DefaultKeys, value: unknown): void {
  (target as Record<DefaultKeys, unknown>)[key] = value;
}

function envInt(key: DefaultKeys, fallback: number): number {
  const val = process.env[key];
  if (val !== undefined) {
    const parsed = Number(val);
    return isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
}

function envBool(key: DefaultKeys, fallback: boolean): boolean {
  const val = process.env[key];
  if (val !== undefined) {
    return val === 'true' || val === '1';
  }
  return fallback;
}

function envStr(key: DefaultKeys, fallback: string): string {
  const val = process.env[key];
  return val !== undefined ? val : fallback;
}

function envLogLevel(key: DefaultKeys, fallback: LogLevel): LogLevel {
  const val = process.env[key];
  if (val !== undefined) {
    const upper = val.toUpperCase();
    if (upper === 'TRACE' || upper === 'DEBUG' || upper === 'INFO' ||
        upper === 'WARN' || upper === 'ERROR' || upper === 'CRITICAL') {
      return upper;
    }
  }
  return fallback;
}

export function loadConfig(customOptions: Partial<GMPConfig> = {}): GMPConfig {
  const config: GMPConfig = { ...DEFAULTS };

  let fileConfig: Partial<Record<DefaultKeys, unknown>> = {};
  try {
    const pathsToTry = [
      path.join(process.cwd(), 'gmp-core', 'data', 'config.json'),
      path.join(process.cwd(), 'data', 'config.json'),
      CONFIG_FILE,
    ];

    for (const p of pathsToTry) {
      if (fs.existsSync(p)) {
        const fileContent = fs.readFileSync(p, 'utf8');
        fileConfig = JSON.parse(fileContent) as Partial<Record<DefaultKeys, unknown>>;
        break;
      }
    }
  } catch {
    // Fail silently during initial load, fallback to defaults
  }

  for (const [key, value] of Object.entries(fileConfig)) {
    if (isDefaultKey(key) && value !== undefined) {
      setConfigValue(config, key, value);
    }
  }

  config.GMP_PORT = envInt('GMP_PORT', DEFAULTS.GMP_PORT);
  config.GMP_BRIDGE_PORT = envInt('GMP_BRIDGE_PORT', DEFAULTS.GMP_BRIDGE_PORT);
  config.GMP_BRIDGE_HOST = envStr('GMP_BRIDGE_HOST', DEFAULTS.GMP_BRIDGE_HOST);
  config.GMP_MIN_PEERS = envInt('GMP_MIN_PEERS', DEFAULTS.GMP_MIN_PEERS);
  config.GMP_MAX_PEERS = envInt('GMP_MAX_PEERS', DEFAULTS.GMP_MAX_PEERS);
  config.GMP_MAX_CONNECTIONS = envInt('GMP_MAX_CONNECTIONS', DEFAULTS.GMP_MAX_CONNECTIONS);
  config.GMP_HELLO_TIMEOUT_MS = envInt('GMP_HELLO_TIMEOUT_MS', DEFAULTS.GMP_HELLO_TIMEOUT_MS);
  config.GMP_HANDSHAKE_TIMEOUT_MS = envInt('GMP_HANDSHAKE_TIMEOUT_MS', DEFAULTS.GMP_HANDSHAKE_TIMEOUT_MS);
  config.GMP_PING_INTERVAL_MS = envInt('GMP_PING_INTERVAL_MS', DEFAULTS.GMP_PING_INTERVAL_MS);
  config.GMP_PING_TIMEOUT_MS = envInt('GMP_PING_TIMEOUT_MS', DEFAULTS.GMP_PING_TIMEOUT_MS);
  config.GMP_TIMESTAMP_WINDOW_MS = envInt('GMP_TIMESTAMP_WINDOW_MS', DEFAULTS.GMP_TIMESTAMP_WINDOW_MS);
  config.GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS = envInt('GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS', DEFAULTS.GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS);
  config.GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS = envInt('GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS', DEFAULTS.GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS);
  config.GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS = envInt('GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS', DEFAULTS.GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS);
  config.GMP_RATE_LIMIT_WINDOW_MS = envInt('GMP_RATE_LIMIT_WINDOW_MS', DEFAULTS.GMP_RATE_LIMIT_WINDOW_MS);
  config.GMP_RATE_LIMIT_MAX_PER_IP = envInt('GMP_RATE_LIMIT_MAX_PER_IP', DEFAULTS.GMP_RATE_LIMIT_MAX_PER_IP);
  config.GMP_RATE_LIMIT_MAX_GLOBAL = envInt('GMP_RATE_LIMIT_MAX_GLOBAL', DEFAULTS.GMP_RATE_LIMIT_MAX_GLOBAL);
  config.GMP_FORWARD_RATE_LIMIT_PER_SOURCE = envInt('GMP_FORWARD_RATE_LIMIT_PER_SOURCE', DEFAULTS.GMP_FORWARD_RATE_LIMIT_PER_SOURCE);
  config.GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS = envInt('GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS', DEFAULTS.GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS);
  config.GMP_SESSION_KEY_LRU_SIZE = envInt('GMP_SESSION_KEY_LRU_SIZE', DEFAULTS.GMP_SESSION_KEY_LRU_SIZE);
  config.GMP_SEQUENCE_NUM_LRU_SIZE = envInt('GMP_SEQUENCE_NUM_LRU_SIZE', DEFAULTS.GMP_SEQUENCE_NUM_LRU_SIZE);
  config.GMP_NONCE_PRUNE_AGE_MS = envInt('GMP_NONCE_PRUNE_AGE_MS', DEFAULTS.GMP_NONCE_PRUNE_AGE_MS);
  config.GMP_ROUTE_EXPIRY_MS = envInt('GMP_ROUTE_EXPIRY_MS', DEFAULTS.GMP_ROUTE_EXPIRY_MS);
  config.GMP_TOPOLOGY_TTL = envInt('GMP_TOPOLOGY_TTL', DEFAULTS.GMP_TOPOLOGY_TTL);
  config.GMP_MESSAGE_HOP_LIMIT = envInt('GMP_MESSAGE_HOP_LIMIT', DEFAULTS.GMP_MESSAGE_HOP_LIMIT);
  config.GMP_REANNOUNCE_INTERVAL_MS = envInt('GMP_REANNOUNCE_INTERVAL_MS', DEFAULTS.GMP_REANNOUNCE_INTERVAL_MS);
  config.GMP_PEER_CACHE_MAX_SIZE = envInt('GMP_PEER_CACHE_MAX_SIZE', DEFAULTS.GMP_PEER_CACHE_MAX_SIZE);
  config.GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD = envInt('GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD', DEFAULTS.GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD);
  config.GMP_PEER_CACHE_PRUNE_AGE_DAYS = envInt('GMP_PEER_CACHE_PRUNE_AGE_DAYS', DEFAULTS.GMP_PEER_CACHE_PRUNE_AGE_DAYS);
  config.GMP_METRICS_PORT = envInt('GMP_METRICS_PORT', DEFAULTS.GMP_METRICS_PORT);
  config.GMP_LOG_LEVEL = envLogLevel('GMP_LOG_LEVEL', DEFAULTS.GMP_LOG_LEVEL);
  config.GMP_LOG_TO_FILE = envBool('GMP_LOG_TO_FILE', DEFAULTS.GMP_LOG_TO_FILE);
  config.GMP_LOG_TO_CONSOLE = envBool('GMP_LOG_TO_CONSOLE', DEFAULTS.GMP_LOG_TO_CONSOLE);
  config.GMP_STRICT_STATE = envBool('GMP_STRICT_STATE', DEFAULTS.GMP_STRICT_STATE);
  config.GMP_BAN_DURATION_MS = envInt('GMP_BAN_DURATION_MS', DEFAULTS.GMP_BAN_DURATION_MS);
  config.GMP_REPUTATION_RECOVERY_INTERVAL_MS = envInt('GMP_REPUTATION_RECOVERY_INTERVAL_MS', DEFAULTS.GMP_REPUTATION_RECOVERY_INTERVAL_MS);

  for (const [key, value] of Object.entries(customOptions)) {
    if (value !== undefined) {
      const gmpKey = key.startsWith('GMP_') ? key : `GMP_${key.toUpperCase()}`;
      if (isDefaultKey(gmpKey)) {
        setConfigValue(config, gmpKey, value);
      } else {
        const mappedKey = mapOptionToConfigKey(key);
        if (mappedKey && isDefaultKey(mappedKey)) {
          setConfigValue(config, mappedKey, value);
        }
      }
    }
  }

  return config;
}

function mapOptionToConfigKey(key: string): string | undefined {
  const mapping: Record<string, DefaultKeys> = {
    port: 'GMP_PORT',
    bridgePort: 'GMP_BRIDGE_PORT',
    bridgeHost: 'GMP_BRIDGE_HOST',
    minPeers: 'GMP_MIN_PEERS',
    maxPeers: 'GMP_MAX_PEERS',
    maxConnections: 'GMP_MAX_CONNECTIONS',
    helloTimeoutMs: 'GMP_HELLO_TIMEOUT_MS',
    handshakeTimeoutMs: 'GMP_HANDSHAKE_TIMEOUT_MS',
    pingIntervalMs: 'GMP_PING_INTERVAL_MS',
    pongTimeoutMs: 'GMP_PING_TIMEOUT_MS',
    timestampWindowMs: 'GMP_TIMESTAMP_WINDOW_MS',
    stage1TimeoutMs: 'GMP_BOOTSTRAP_STAGE1_TIMEOUT_MS',
    stage2TimeoutMs: 'GMP_BOOTSTRAP_STAGE2_TIMEOUT_MS',
    rebootstrapBackoffInitialMs: 'GMP_REBOOTSTRAP_BACKOFF_INITIAL_MS',
    rateLimitWindowMs: 'GMP_RATE_LIMIT_WINDOW_MS',
    rateLimitMaxPerIp: 'GMP_RATE_LIMIT_MAX_PER_IP',
    rateLimitMaxGlobal: 'GMP_RATE_LIMIT_MAX_GLOBAL',
    forwardRateLimitPerSource: 'GMP_FORWARD_RATE_LIMIT_PER_SOURCE',
    peerRequestRateLimitIntervalMs: 'GMP_PEER_REQUEST_RATE_LIMIT_INTERVAL_MS',
    sessionKeyLruSize: 'GMP_SESSION_KEY_LRU_SIZE',
    sequenceNumLruSize: 'GMP_SEQUENCE_NUM_LRU_SIZE',
    noncePruneAgeMs: 'GMP_NONCE_PRUNE_AGE_MS',
    routeExpiryMs: 'GMP_ROUTE_EXPIRY_MS',
    topologyTtl: 'GMP_TOPOLOGY_TTL',
    messageHopLimit: 'GMP_MESSAGE_HOP_LIMIT',
    reannounceIntervalMs: 'GMP_REANNOUNCE_INTERVAL_MS',
    peerCacheMaxSize: 'GMP_PEER_CACHE_MAX_SIZE',
    peerCachePruneFailureThreshold: 'GMP_PEER_CACHE_PRUNE_FAILURE_THRESHOLD',
    peerCachePruneAgeDays: 'GMP_PEER_CACHE_PRUNE_AGE_DAYS',
    metricsPort: 'GMP_METRICS_PORT',
    logLevel: 'GMP_LOG_LEVEL',
    logToFile: 'GMP_LOG_TO_FILE',
    logToConsole: 'GMP_LOG_TO_CONSOLE',
    strictState: 'GMP_STRICT_STATE',
    banDurationMs: 'GMP_BAN_DURATION_MS',
    recoveryIntervalMs: 'GMP_REPUTATION_RECOVERY_INTERVAL_MS',
  };
  return mapping[key];
}

const config = loadConfig();
export default config;