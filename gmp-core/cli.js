#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import http from 'http';
import readline from 'readline';
import { Writable } from 'stream';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import config, { loadConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getMetricsPort() {
  return config.GMP_METRICS_PORT || 9090;
}

function askQuestion(query, silent = false) {
  return new Promise((resolve) => {
    let mutableStdout = new Writable({
      write: function(chunk, encoding, callback) {
        if (!this.muted) {
          process.stdout.write(chunk, encoding);
        } else {
          const str = chunk.toString();
          if (str.includes(query)) {
            process.stdout.write(chunk, encoding);
          } else if (str === '\n' || str === '\r\n') {
            process.stdout.write(chunk, encoding);
          } else {
            // Mask input
            process.stdout.write('*');
          }
        }
        callback();
      }
    });
    mutableStdout.muted = false;

    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true
    });

    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });

    if (silent) {
      mutableStdout.muted = true;
    }
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Status Code: ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function postJson(url, data) {
  return new Promise((resolve, reject) => {
    const dataStr = JSON.stringify(data);
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataStr)
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
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

function formatUptime(uptimeSeconds) {
  if (uptimeSeconds < 60) return `${uptimeSeconds}s`;
  const minutes = Math.floor(uptimeSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${uptimeSeconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// BIP-39 word subset for safe local key rotation demonstration
const BIP39_WORDS = [
  "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse", "access", "accident",
  "account", "accuse", "achieve", "acid", "acoustic", "acquire", "across", "act", "action", "active", "actor", "actress",
  "actual", "adapt", "add", "addict", "address", "adjust", "admit", "adult", "advance", "advice", "advise", "aerobic",
  "affair", "afford", "afraid", "again", "age", "agent", "agree", "ahead", "aim", "air", "airport", "alarm", "album",
  "alcohol", "alert", "alien", "all", "alley", "allow", "almost", "alone", "alpha", "already", "also", "alter", "always",
  "amateur", "amazing", "among", "amount", "amuse", "analyst", "anchor", "ancient", "anger", "angle", "angry", "animal",
  "ankle", "announce", "annual", "another", "answer", "antenna", "antique", "anxiety", "any", "apart", "apology", "appear",
  "apple", "approve", "april", "arch", "arctic", "area", "arena", "argue", "arm", "armed", "armor", "army", "around"
];

function generateSeedPhrase() {
  const words = [];
  for (let i = 0; i < 12; i++) {
    const idx = Math.floor(Math.random() * BIP39_WORDS.length);
    words.push(BIP39_WORDS[idx]);
  }
  return words.join(' ');
}

function generateCryptoSeedPhrase() {
  const words = [];
  const randomValues = new Uint32Array(12);
  const webCrypto = globalThis.crypto || crypto.webcrypto;
  webCrypto.getRandomValues(randomValues);
  for (let i = 0; i < 12; i++) {
    const idx = randomValues[i] % BIP39_WORDS.length;
    words.push(BIP39_WORDS[idx]);
  }
  return words.join(' ');
}

async function startNode(isPublic = false) {
  // Check if seed phrase is in environment variable
  let seedPhrase = process.env.GMP_SEED_PHRASE;

  if (seedPhrase) {
    const logger = (await import('./logger.js')).default;
    logger.info('cli', 'env-seed-phrase', 'Using seed phrase from GMP_SEED_PHRASE environment variable');
  } else {
    // Fall back to the existing interactive prompt behavior exactly as it works now
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

  // Import manager dynamically to support fast CLI commands without loading Nobel crypto
  const { GMPNodeManager } = await import('./gmp-node-manager.js');
  const { startBridge } = await import('./gmp-bridge.js');

  const options = { seedPhrase };
  if (isPublic) {
    options.isPublicPeer = true;
  }

  console.log(`Starting Ghost Link Node (isPublicPeer=${isPublic || false})...`);
  const manager = new GMPNodeManager(options);
  
  try {
    const status = await manager.start();
    console.log(`GMP Node successfully started. NodeID: ${status.nodeId}`);

    // Start WebSocket bridge
    startBridge(manager, config.GMP_BRIDGE_PORT, config.GMP_BRIDGE_HOST);

    // Register cleanup
    const shutdown = async () => {
      console.log('\nShutting down GMP node gracefully...');
      await manager.stop();
      console.log('GMP node stopped.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (e) {
    console.error('Failed to start GMP Node:', e.message);
    process.exit(1);
  }
}

async function main() {
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
        const data = await getJson(`${metricsUrl}/metrics`);
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
        const peers = await getJson(`${metricsUrl}/peers`);
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
        // First check if node is running
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
        const res = await postJson(`${metricsUrl}/rotate-key`, { newSeedPhrase: newSeed });
        console.log(`\nSuccess! Node identity successfully rotated.`);
        console.log(`New NodeID: ${res.newNodeId}`);
        console.log('The rotation certificate has been flooded. Your configuration files have been updated.');
      } catch (e) {
        console.error('Rotation failed:', e.message);
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
        const res = await postJson(`${metricsUrl}/ping`, { targetNodeId: target });
        console.log(`Ping success! RTT = ${res.rtt}ms, Hops = ${res.hops}`);
      } catch (e) {
        console.error(`Ping failed: ${e.message}`);
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

function printHelp() {
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

main().catch(err => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
