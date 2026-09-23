#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import http from 'http';
import readline from 'readline';
import { Writable } from 'stream';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import config, { loadConfig } from './config.js';
import type { GMPNodeManagerOptions } from './types.js';
import { BIP39_WORDS } from './bip39-english.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getMetricsPort(): number {
  return config.GMP_METRICS_PORT || 9090;
}

/** stdout wrapper that can blank out what it echoes, for password entry. */
interface MutableStdout extends Writable {
  muted: boolean;
}

function askQuestion(query: string, silent: boolean = false): Promise<string> {
  return new Promise((resolve) => {
    const mutableStdout = new Writable({
      // `this` inside a Writable's write() is the stream itself, which the
      // built-in type says is a plain Writable. The muted flag is ours, added
      // just below, so the callback has to be told what `this` really is.
      write: function(this: MutableStdout, chunk: Buffer | string, encoding: BufferEncoding, callback: () => void): void {
        const str = chunk.toString();
        if (this.muted || (!this.muted && str.includes(query))) {
          process.stdout.write(chunk, encoding);
        } else if (str === '\n' || str === '\r\n') {
          process.stdout.write(chunk, encoding);
        } else {
          process.stdout.write('*');
        }
        callback();
      }
    }) as MutableStdout;
    mutableStdout.muted = false;

    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true
    });

    rl.question(query, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });

    if (silent) {
      mutableStdout.muted = true;
    }
  });
}

interface JsonResponse {
  [key: string]: unknown;
}

/**
 * The caller names the shape it expects. JSON.parse returns `any`, so one
 * assertion at the parse boundary is unavoidable; doing it here, once, is
 * better than each call site casting a JsonResponse into an unrelated type.
 */
function getJson<T = JsonResponse>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(url, (res: http.IncomingMessage) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Status Code: ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function postJson<T = JsonResponse>(url: string, data: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const dataStr = JSON.stringify(data);
    const parsedUrl = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataStr)
      }
    };

    const req = http.request(options, (res: http.IncomingMessage) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as T & JsonResponse;
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error((parsed.error as string) || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(dataStr);
    req.end();
  });
}

function formatUptime(uptimeSeconds: number): string {
  if (uptimeSeconds < 60) return `${uptimeSeconds}s`;
  const minutes = Math.floor(uptimeSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${uptimeSeconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatNumber(num: number): string {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}


/**
 * Uniform random index in [0, max) from the platform CSPRNG.
 *
 * Rejection sampling rather than `% max`: 2^32 is not a multiple of the word
 * list length, so the plain modulo made the first (2^32 % max) words more
 * likely than the rest and shaved entropy off every phrase it generated.
 */
function secureRandomIndex(max: number): number {
  const webCrypto = globalThis.crypto || (crypto as unknown as { webcrypto: Crypto }).webcrypto;
  if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') {
    // A predictable seed phrase is a predictable identity key. There is no
    // safe degraded mode here, so fail loudly instead of producing one.
    throw new Error('No secure random source available — refusing to generate a seed phrase.');
  }
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  let v: number;
  do {
    webCrypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return v % max;
}

/**
 * Generate a 12-word recovery phrase.
 *
 * This is the node's master identity: whoever can reproduce the phrase can
 * reproduce the key. It previously had a second, Math.random-backed
 * implementation that `rotate-key` called, which made a rotated identity
 * predictable from the PRNG state. There is now one generator, and it is
 * CSPRNG-backed.
 */
function generateSeedPhrase(): string {
  const words: string[] = [];
  for (let i = 0; i < 12; i++) {
    words.push(BIP39_WORDS[secureRandomIndex(BIP39_WORDS.length)]);
  }
  return words.join(' ');
}

const generateCryptoSeedPhrase = generateSeedPhrase;

async function startNode(isPublic: boolean = false): Promise<void> {
  let seedPhrase: string | undefined = process.env.GMP_SEED_PHRASE;

  if (seedPhrase) {
    const loggerModule = await import('./logger.js');
    const logger = loggerModule.default;
    logger.info('cli', 'env-seed-phrase', 'Using seed phrase from GMP_SEED_PHRASE environment variable');
  } else {
    seedPhrase = config.GMP_SEED_PHRASE;
    if (!seedPhrase) {
      console.log('No seed phrase configured.');
      seedPhrase = await askQuestion('Enter 12-word seed phrase: ', true);
    }
    if (!seedPhrase || seedPhrase.split(/\s+/).length !== 12) {
      console.error('Invalid seed phrase. Must be exactly 12 words.');
      process.exit(1);
    }
  }

  const { GMPNodeManager } = await import('./gmp-node-manager.js');
  const { startBridge } = await import('./gmp-bridge.js');

  const options: Record<string, unknown> = { seedPhrase };
  if (isPublic) {
    options.isPublicPeer = true;
    if (process.env.PORT) {
      const port = parseInt(process.env.PORT, 10);
      options.GMP_PORT = port;
      const loggerModule = await import('./logger.js');
      const logger = loggerModule.default;
      logger.info('cli', 'port-select', `Using port ${port} from PORT environment variable for GMP public-peer`);
    } else {
      const port = config.GMP_PORT || 49500;
      options.GMP_PORT = port;
      const loggerModule = await import('./logger.js');
      const logger = loggerModule.default;
      logger.info('cli', 'port-select', `Using port ${port} for GMP public-peer`);
    }
  } else {
    const port = config.GMP_PORT || 49500;
    options.GMP_PORT = port;
    const loggerModule = await import('./logger.js');
    const logger = loggerModule.default;
    logger.info('cli', 'port-select', `Using port ${port} for GMP node`);
  }

  console.log(`Starting Ghost Link Node (isPublicPeer=${isPublic || false})...`);
  const manager = new GMPNodeManager(options as GMPNodeManagerOptions);

  try {
    const status = await manager.start();
    console.log(`GMP Node successfully started. NodeID: ${status.nodeId}`);

    startBridge(manager, config.GMP_BRIDGE_PORT, config.GMP_BRIDGE_HOST);

    const shutdown = async (): Promise<void> => {
      console.log('\nShutting down GMP node gracefully...');
      await manager.stop();
      console.log('GMP node stopped.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (e) {
    const err = e as Error;
    console.error('Failed to start GMP Node:', err.message);
    process.exit(1);
  }
}

interface MetricsData {
  node: { nodeId: string; uptimeSeconds: number };
  peers: { current: number };
  routing: { tableSize: number; messagesForwarded: number };
  bootstrap: { status: string };
}

interface PeersData {
  nodeId: string;
  address: string;
  port: number;
  type: string;
  isVirtual: boolean;
}

interface RotateResponse {
  newNodeId: string;
}

interface PingResponse {
  rtt: number;
  hops: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const metricsUrl = `http://127.0.0.1:${getMetricsPort()}`;

  switch (command) {
    case 'generate-seed': {
      const seed = generateCryptoSeedPhrase();
      console.log(seed);
      break;
    }
    case 'start': {
      await startNode(false);
      break;
    }
    case 'public-peer': {
      await startNode(true);
      break;
    }
    case 'status': {
      try {
        const data = await getJson<MetricsData>(`${metricsUrl}/metrics`);
        const uptimeStr = formatUptime(data.node.uptimeSeconds);
        const peersCount = `${data.peers.current} connected`;
        const routesCount = `${data.routing.tableSize} known`;
        const forwardedStr = `${formatNumber(data.routing.messagesForwarded)} messages`;
        const statusStr = data.bootstrap.status.charAt(0).toUpperCase() + data.bootstrap.status.slice(1);

        console.log('┌─────────────────────────────┐');
        console.log('│ GhostLink Node Status       │');
        console.log('├─────────────────────────────┤');
        console.log(`│ NodeID:    ${data.node.nodeId.slice(0, 12)}...     │`);
        console.log(`│ Uptime:    ${uptimeStr.padEnd(17)} │`);
        console.log(`│ Peers:     ${peersCount.padEnd(17)} │`);
        console.log(`│ Routes:    ${routesCount.padEnd(17)} │`);
        console.log(`│ Forwarded: ${forwardedStr.padEnd(17)} │`);
        console.log(`│ Status:    ${statusStr.padEnd(17)} │`);
        console.log('└─────────────────────────────┘');
      } catch (e) {
        console.error('No GMP node running. Start with: gmp start');
      }
      break;
    }
    case 'peers': {
      try {
        const peers = await getJson<PeersData[]>(`${metricsUrl}/peers`);
        if (peers.length === 0) {
          console.log('No active peer connections.');
          return;
        }
        console.log(`Connected Peers (${peers.length}):`);
        console.log('─'.repeat(70));
        for (const p of peers) {
          const nodeIdTrunc = p.nodeId.slice(0, 16) + '...';
          const typeStr = p.type.toUpperCase();
          const virtualStr = p.isVirtual ? ' (VIRTUAL)' : '';

          let addrStr = p.address;
          if (addrStr && addrStr.includes('.')) {
            const parts = addrStr.split('.');
            if (parts.length >= 3) addrStr = parts.slice(0, 3).join('.') + '.x';
          } else if (addrStr && addrStr.includes(':')) {
            const parts = addrStr.split(':');
            if (parts.length >= 3) addrStr = parts.slice(0, 3).join(':') + ':x';
          }

          const fullAddr = p.isVirtual ? 'virtual' : `${addrStr}:${p.port}`;
          console.log(`NodeID: ${nodeIdTrunc.padEnd(20)} | Address: ${fullAddr.padEnd(24)} | Type: ${typeStr}${virtualStr}`);
        }
        console.log('─'.repeat(70));
      } catch (e) {
        console.error('No GMP node running. Start with: gmp start');
      }
      break;
    }
    case 'rotate-key': {
      try {
        await getJson(`${metricsUrl}/health`);
      } catch (e) {
        console.error('No GMP node running. Start the node before rotating keys.');
        return;
      }

      console.log('=== GhostLink Key Rotation ===');
      console.log('Generating new 12-word seed phrase...');
      const newSeed = generateSeedPhrase();
      console.log('\n----------------------------------------');
      console.log('Your new seed phrase is:');
      console.log(newSeed);
      console.log('----------------------------------------');
      console.log('\nIMPORTANT: Write down this new seed phrase. It will replace your current static key.');

      const written = await askQuestion('\nHave you written this phrase down securely? (y/n): ');
      if (written.toLowerCase() !== 'y') {
        console.log('Rotation aborted.');
        return;
      }

      const confirm = await askQuestion('Are you sure you want to rotate your identity keys now? (y/n): ');
      if (confirm.toLowerCase() !== 'y') {
        console.log('Rotation aborted.');
        return;
      }

      try {
        console.log('Initiating rotation flood across the mesh...');
        const res = await postJson<RotateResponse>(`${metricsUrl}/rotate-key`, { newSeedPhrase: newSeed });
        console.log(`\nSuccess! Node identity successfully rotated.`);
        console.log(`New NodeID: ${res.newNodeId}`);
        console.log('The rotation certificate has been flooded. Your configuration files have been updated.');
      } catch (e) {
        const err = e as Error;
        console.error('Rotation failed:', err.message);
      }
      break;
    }
    case 'ping': {
      const target = args[1];
      if (!target) {
        console.error('Usage: gmp ping <nodeId>');
        return;
      }
      try {
        console.log(`Sending virtual ping to ${target.slice(0, 16)}...`);
        const res = await postJson<PingResponse>(`${metricsUrl}/ping`, { targetNodeId: target });
        console.log(`Ping success! RTT = ${res.rtt}ms, Hops = ${res.hops}`);
      } catch (e) {
        const err = e as Error;
        console.error(`Ping failed: ${err.message}`);
      }
      break;
    }
    default: {
      console.error(`Unknown command: ${command}`);
      printHelp();
      break;
    }
  }
}

function printHelp(): void {
  console.log('GhostMesh Protocol (GMP) Operator CLI');
  console.log('\nUsage:');
  console.log('  gmp start           Starts the GMP node and client bridge');
  console.log('  gmp public-peer     Starts the node as a Public Peer');
  console.log('  gmp status          Queries local node metrics and prints status box');
  console.log('  gmp peers           Lists currently connected peers');
  console.log('  gmp rotate-key      Walks through seed generation and rotating identity keys');
  console.log('  gmp ping <nodeId>   Pings a NodeID through the multi-hop mesh');
  console.log('  gmp generate-seed   Generates a cryptographically random 12-word seed phrase');
}

main().catch((err: unknown) => {
  const error = err as Error;
  console.error('Fatal CLI Error:', error);
  process.exit(1);
});