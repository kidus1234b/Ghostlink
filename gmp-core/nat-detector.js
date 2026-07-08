import { querySinglePeer } from './public-peer-list.js';
import logger from './logger.js';

/**
 * Heuristically classify the NAT type based on 3 public peer queries.
 * 
 * Heuristic rules:
 * 1. Query Public Peer 1 (twice, Q1 and Q2) and Public Peer 2 (once, Q3).
 * 2. If the observed public IPs do not match, NAT status is unpredictable/UNKNOWN.
 * 3. If the ports observed by Peer 1 across Q1 and Q2 are different (port1_1 !== port1_2), 
 *    the NAT is mapping connections dynamically. This indicates SYMMETRIC NAT.
 * 4. If the ports are identical (port1_1 === port1_2), the mapping is destination-independent (cone NAT):
 *    - If the port observed by Peer 2 (Q3) is the same (port1_1 === port2),
 *      it maps the same port for all destinations. This is NO_NAT_OR_FULL_CONE.
 *    - If the port observed by Peer 2 (Q3) is different (port1_1 !== port2),
 *      it maps different ports for different destinations, but is stable for the same destination.
 *      This is RESTRICTED_CONE.
 * 
 * @param {Object} q1 { address, port }
 * @param {Object} q2 { address, port }
 * @param {Object} q3 { address, port }
 * @returns {string} One of: 'NO_NAT_OR_FULL_CONE', 'RESTRICTED_CONE', 'SYMMETRIC', 'UNKNOWN'
 */
export function classifyNAT(q1, q2, q3) {
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

/**
 * Perform queries to classify the local node's NAT type.
 * Requires at least 2 distinct Public Peers.
 * 
 * @param {GMPNode} node Local node instance
 * @param {Array} publicPeers List of public peer objects [{ address, port, nodeId }]
 * @param {number} timeoutMs Timeout per query
 * @returns {Promise<string>} Classified NAT type
 */
export async function detectNATType(node, publicPeers, timeoutMs = 5000) {
  if (!publicPeers || publicPeers.length < 2) {
    throw new Error('NAT type detection requires at least 2 distinct public peers');
  }

  const peer1 = publicPeers[0];
  const peer2 = publicPeers[1];

  let q1 = null;
  let q2 = null;
  let q3 = null;

  try {
    q1 = await querySinglePeer(node, peer1, timeoutMs);
  } catch (e) {
    logger.warn('nat-detector', 'query-failed', `Query 1 to ${peer1.address}:${peer1.port} failed: ${e.message}`, {
      address: peer1.address,
      port: peer1.port,
      err: e.message
    });
  }

  try {
    q2 = await querySinglePeer(node, peer1, timeoutMs);
  } catch (e) {
    logger.warn('nat-detector', 'query-failed', `Query 2 to ${peer1.address}:${peer1.port} failed: ${e.message}`, {
      address: peer1.address,
      port: peer1.port,
      err: e.message
    });
  }

  try {
    q3 = await querySinglePeer(node, peer2, timeoutMs);
  } catch (e) {
    logger.warn('nat-detector', 'query-failed', `Query 3 to ${peer2.address}:${peer2.port} failed: ${e.message}`, {
      address: peer2.address,
      port: peer2.port,
      err: e.message
    });
  }

  const type = classifyNAT(q1, q2, q3);
  return type;
}
