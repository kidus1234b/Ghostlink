import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULTS = {
  GMP_PORT: 49500,
  GMP_BRIDGE_PORT: 3002,
  // Interface the bridge WebSocket server binds to. Default '127.0.0.1'
  // (localhost only). Set to '0.0.0.0' to opt into LAN access for testing;
  // see gmp-bridge.js for the accompanying RFC1918-only origin allowance.
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
  GMP_NONCE_PRUNE_AGE_MS: 7776000000, // 90 days
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
  GMP_BAN_DURATION_MS: 86400000,
  GMP_REPUTATION_RECOVERY_INTERVAL_MS: 60000,
};

export function loadConfig(customOptions = {}) {
  // 1. Hardcoded defaults
  const config = { ...DEFAULTS };

  // 2. Load from config.json (file config)
  let fileConfig = {};
  try {
    // Try multiple possible paths for config.json
    const pathsToTry = [
      path.join(process.cwd(), 'gmp-core', 'data', 'config.json'),
      path.join(process.cwd(), 'data', 'config.json'),
      path.join(__dirname, 'data', 'config.json'),
    ];

    for (const p of pathsToTry) {
      if (fs.existsSync(p)) {
        const fileContent = fs.readFileSync(p, 'utf8');
        fileConfig = JSON.parse(fileContent);
        break;
      }
    }
  } catch (e) {
    // Fail silently during initial load, fallback to defaults
  }

  // Merge file configuration
  for (const [key, value] of Object.entries(fileConfig)) {
    if (config[key] !== undefined) {
      config[key] = value;
    }
  }

  // 3. Load from process.env (env variables)
  const envConfig = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (process.env[key] !== undefined) {
      const val = process.env[key];
      if (typeof DEFAULTS[key] === 'number') {
        envConfig[key] = Number(val);
      } else if (typeof DEFAULTS[key] === 'boolean') {
        envConfig[key] = val === 'true' || val === '1';
      } else {
        envConfig[key] = val;
      }
    }
  }

  // Merge env configuration
  for (const [key, value] of Object.entries(envConfig)) {
    config[key] = value;
  }

  // 4. Merge constructor/runtime options
  for (const [key, value] of Object.entries(customOptions)) {
    if (value !== undefined) {
      // Map option keys if they don't match GMP_ prefix
      const gmpKey = key.startsWith('GMP_') ? key : `GMP_${key.toUpperCase()}`;
      if (config[gmpKey] !== undefined) {
        config[gmpKey] = value;
      } else {
        // Also allow passing raw key name (e.g. minPeers mapping to GMP_MIN_PEERS)
        const mappedKey = mapOptionToConfigKey(key);
        if (mappedKey && config[mappedKey] !== undefined) {
          config[mappedKey] = value;
        }
      }
    }
  }

  return config;
}

function mapOptionToConfigKey(key) {
  const mapping = {
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
    banDurationMs: 'GMP_BAN_DURATION_MS',
    recoveryIntervalMs: 'GMP_REPUTATION_RECOVERY_INTERVAL_MS',
  };
  return mapping[key];
}

const config = loadConfig();
export default config;
