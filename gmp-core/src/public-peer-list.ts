import fs from 'fs';
import path from 'path';
import type { PublicPeerEntry, BindingResponse } from './types.js';
import logger from './logger.js';
import { PUBLIC_PEERS_FILE } from './paths.js';

const DEFAULT_PEERS_FILE = PUBLIC_PEERS_FILE;

interface GMPNodeLike {
  dial(address: string, port: number, options?: { tls?: boolean }): Promise<DialResult>;
}

interface DialResult {
  connId: string;
  link: GMPLinkLike;
  peerNodeId: string;
}

interface GMPLinkLike {
  on(event: string, handler: (...args: unknown[]) => void): this;
  once(event: string, handler: (...args: unknown[]) => void): this;
  destroy(error?: Error): void;
  sendBindingRequest(): void;
}

export function loadPublicPeers(filePath: string = DEFAULT_PEERS_FILE): PublicPeerEntry[] {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data) as PublicPeerEntry[];
    }
  } catch (e: unknown) {
    const err = e as Error;
    logger.error('public-peer-list', 'load-failed', `Failed to load public peers: ${err.message}`, { err: err.message });
  }
  return [];
}

export function savePublicPeers(peers: PublicPeerEntry[], filePath: string = DEFAULT_PEERS_FILE): boolean {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(peers, null, 2), 'utf8');
    return true;
  } catch (e: unknown) {
    const err = e as Error;
    logger.error('public-peer-list', 'save-failed', `Failed to save public peers: ${err.message}`, { err: err.message });
    return false;
  }
}

export async function querySinglePeer(
  node: GMPNodeLike,
  peer: PublicPeerEntry,
  timeoutMs: number = 5000
): Promise<BindingResponse> {
  return new Promise((resolve, reject) => {
    let link: GMPLinkLike | null = null;
    let finished = false;

    const timeoutTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      if (link) {
        link.destroy(new Error('Query timeout'));
      }
      reject(new Error(`Timeout querying peer ${peer.address}:${peer.port}`));
    }, timeoutMs);

    node.dial(peer.address, peer.port, { tls: peer.tls === true || peer.port === 443 })
      .then(({ link: activeLink }) => {
        if (finished) {
          activeLink.destroy();
          return;
        }
        link = activeLink;

        activeLink.once('binding-response', (info: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutTimer);
          link!.destroy();
          resolve(info as BindingResponse);
        });

        activeLink.once('error', (err: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutTimer);
          link!.destroy();
          reject(err as Error);
        });

        activeLink.once('close', () => {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutTimer);
          reject(new Error('Connection closed before binding response'));
        });

        try {
          activeLink.sendBindingRequest();
        } catch (e: unknown) {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutTimer);
          link!.destroy();
          reject(e as Error);
        }
      })
      .catch((err: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutTimer);
        reject(err as Error);
      });
  });
}

interface QueryResult {
  success: boolean;
  res?: BindingResponse;
  err?: Error;
}

export async function queryPublicAddress(
  node: GMPNodeLike,
  peers: PublicPeerEntry[],
  timeoutMs: number = 5000
): Promise<{ address: string; port: number }> {
  if (!peers || peers.length === 0) {
    throw new Error('No public peers specified for query');
  }

  const promises: Promise<QueryResult>[] = peers.map(peer =>
    querySinglePeer(node, peer, timeoutMs)
      .then(res => ({ success: true, res }))
      .catch(err => ({ success: false, err }))
  );

  const results = await Promise.all(promises);
  const successful: BindingResponse[] = results
    .filter((r): r is { success: true; res: BindingResponse } => r.success && r.res !== undefined)
    .map(r => r.res);

  if (successful.length === 0) {
    throw new Error('All public peer queries failed');
  }

  const agreementCounts: Record<string, number> = {};
  for (const res of successful) {
    const key = `${res.address}:${res.port}`;
    agreementCounts[key] = (agreementCounts[key] || 0) + 1;
  }

  let bestKey: string | null = null;
  let maxCount = 0;
  for (const [key, count] of Object.entries(agreementCounts)) {
    if (count > maxCount) {
      maxCount = count;
      bestKey = key;
    }
  }

  if (maxCount >= Math.min(successful.length, 2) && bestKey !== null) {
    const lastColonIndex = bestKey.lastIndexOf(':');
    const parsedAddress = bestKey.slice(0, lastColonIndex);
    const parsedPort = parseInt(bestKey.slice(lastColonIndex + 1), 10);
    return { address: parsedAddress, port: parsedPort };
  }

  throw new Error('Public peers disagreed on public address');
}