import type { NatType, PublicPeerEntry } from './types.js';
// The node/link shapes come from public-peer-list, which owns querySinglePeer.
// This file used to declare its own narrower copies; they omitted
// sendBindingRequest(), so the two definitions were structurally incompatible
// and every call below failed to type-check.
import { querySinglePeer, type GMPNodeLike } from './public-peer-list.js';
import logger from './logger.js';

interface QueryResult {
  address: string;
  port: number;
}

export function classifyNAT(q1: QueryResult | null, q2: QueryResult | null, q3: QueryResult | null): NatType {
  if (!q1 || !q2 || !q3) return 'UNKNOWN';

  const ip1_1 = q1.address;
  const port1_1 = q1.port;
  const ip1_2 = q2.address;
  const port1_2 = q2.port;
  const ip2 = q3.address;
  const port2 = q3.port;

  if (ip1_1 !== ip1_2 || ip1_1 !== ip2) {
    if (port1_1 !== port1_2) {
      return 'SYMMETRIC';
    }
    return 'UNKNOWN';
  }

  if (port1_1 !== port1_2) {
    return 'SYMMETRIC';
  }

  if (port1_1 === port2) {
    return 'NO_NAT_OR_FULL_CONE';
  } else {
    return 'RESTRICTED_CONE';
  }
}

export async function detectNATType(
  node: GMPNodeLike,
  publicPeers: PublicPeerEntry[],
  timeoutMs: number = 5000
): Promise<NatType> {
  if (!publicPeers || publicPeers.length < 2) {
    throw new Error('NAT type detection requires at least 2 distinct public peers');
  }

  const peer1 = publicPeers[0];
  const peer2 = publicPeers[1];

  let q1: QueryResult | null = null;
  let q2: QueryResult | null = null;
  let q3: QueryResult | null = null;

  try {
    q1 = await querySinglePeer(node, peer1, timeoutMs) as QueryResult;
  } catch (e: unknown) {
    const err = e as Error;
    logger.warn('nat-detector', 'query-failed', `Query 1 to ${peer1.address}:${peer1.port} failed: ${err.message}`, {
      address: peer1.address,
      port: peer1.port,
      err: err.message
    });
  }

  try {
    q2 = await querySinglePeer(node, peer1, timeoutMs) as QueryResult;
  } catch (e: unknown) {
    const err = e as Error;
    logger.warn('nat-detector', 'query-failed', `Query 2 to ${peer1.address}:${peer1.port} failed: ${err.message}`, {
      address: peer1.address,
      port: peer1.port,
      err: err.message
    });
  }

  try {
    q3 = await querySinglePeer(node, peer2, timeoutMs) as QueryResult;
  } catch (e: unknown) {
    const err = e as Error;
    logger.warn('nat-detector', 'query-failed', `Query 3 to ${peer2.address}:${peer2.port} failed: ${err.message}`, {
      address: peer2.address,
      port: peer2.port,
      err: err.message
    });
  }

  const type = classifyNAT(q1, q2, q3);
  return type;
}