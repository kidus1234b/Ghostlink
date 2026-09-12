/**
 * LAN Discovery — a local directory of Ghost Addresses, over UDP multicast.
 *
 * A Ghost Address is resolved by looking up a NodeID the node already knows
 * about. On the open internet those NodeIDs arrive through topology flooding
 * from a shared public peer. On a LAN with no internet — or with every public
 * peer unreachable — nothing would ever announce, so two machines sitting on
 * the same Wi-Fi could not find each other at all. This closes that hole
 * without any infrastructure.
 *
 * WHAT THIS DOES NOT DO: it does not connect to anybody. It only records
 * "NodeID X is at 192.168.1.5:49500", which is exactly the information the
 * mesh would have supplied. Sessions are still only ever opened when the user
 * pastes an address and asks for one. That distinction matters — auto-dialling
 * every GhostLink on a café network would hand strangers a chat window.
 *
 * The beacon carries a NodeID and a port. Both are public information (a
 * NodeID is a hash of a public key), and neither is trusted: the GMP handshake
 * authenticates the peer cryptographically when a connection is actually made,
 * so a forged beacon can at worst point a dial at an address where the
 * handshake then fails.
 */

import dgram from 'dgram';
import { EventEmitter } from 'events';
import logger from './logger.js';

export const DEFAULT_DISCOVERY_PORT = 49599;
export const DEFAULT_MULTICAST_GROUP = '239.255.42.99';

const PROTOCOL = 'ghostlink-lan-v1';
const DEFAULT_ANNOUNCE_INTERVAL_MS = 5000;
// Peers stop being offered for resolution once their beacon goes quiet. Long
// enough to ride out a few dropped multicast packets, short enough that a
// laptop that left the network is not still advertised half an hour later.
const DEFAULT_PEER_TTL_MS = 30000;

export class LanDiscovery extends EventEmitter {
  constructor(node, options = {}) {
    super();
    this.node = node;
    this.port = options.port || DEFAULT_DISCOVERY_PORT;
    this.group = options.group || DEFAULT_MULTICAST_GROUP;
    this.announceIntervalMs = options.announceIntervalMs || DEFAULT_ANNOUNCE_INTERVAL_MS;
    this.peerTtlMs = options.peerTtlMs || DEFAULT_PEER_TTL_MS;

    /** @type {Map<string, {nodeId: string, address: string, port: number, lastSeen: number}>} */
    this.peers = new Map();

    this.socket = null;
    this.announceTimer = null;
    this.started = false;
  }

  start() {
    if (this.started) return Promise.resolve(false);
    this.started = true;

    return new Promise((resolve) => {
      let socket;
      try {
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      } catch (e) {
        this.started = false;
        resolve(false);
        return;
      }
      this.socket = socket;

      // Discovery is a convenience, never a reason to fail startup: a machine
      // with multicast blocked, no network, or the port already taken simply
      // goes without it.
      const giveUp = (err) => {
        logger.warn('lan-discovery', 'unavailable',
          `LAN discovery disabled: ${err.message}. Peers on this network will only be findable through the mesh.`,
          { error: err.message });
        try { socket.close(); } catch (e) {}
        this.socket = null;
        this.started = false;
        resolve(false);
      };

      socket.once('error', giveUp);

      socket.bind(this.port, () => {
        socket.removeListener('error', giveUp);
        socket.on('error', (err) => {
          logger.warn('lan-discovery', 'socket-error', `LAN discovery socket error: ${err.message}`, { error: err.message });
        });

        try {
          socket.addMembership(this.group);
          socket.setMulticastTTL(1); // this subnet only — never leaves the LAN
          // Loopback stays ON so two GhostLink instances on one machine can
          // find each other, which is how most people test. Our own beacon
          // comes back to us as a result; _onBeacon drops it by NodeID.
          socket.setMulticastLoopback(true);
        } catch (e) {
          // Bound but not multicasting (common in containers). Still useful:
          // we can receive directed beacons even if we cannot join the group.
          logger.warn('lan-discovery', 'multicast-unavailable',
            `Could not join multicast group: ${e.message}`, { error: e.message });
        }

        socket.on('message', (buf, rinfo) => this._onBeacon(buf, rinfo));
        if (socket.unref) socket.unref();

        this.announce();
        this.announceTimer = setInterval(() => this.announce(), this.announceIntervalMs);
        if (this.announceTimer.unref) this.announceTimer.unref();

        logger.info('lan-discovery', 'started',
          `LAN discovery active on ${this.group}:${this.port}`,
          { group: this.group, port: this.port });
        resolve(true);
      });
    });
  }

  announce() {
    if (!this.socket || !this.node.identity) return;
    const beacon = JSON.stringify({
      p: PROTOCOL,
      nodeId: this.node.identity.nodeIdHex,
      port: this.node.port
    });
    try {
      this.socket.send(beacon, this.port, this.group);
    } catch (e) {
      // A transient send failure (interface down, no route) is not worth
      // logging every few seconds.
    }
  }

  _onBeacon(buf, rinfo) {
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch (e) {
      return;
    }

    if (!msg || msg.p !== PROTOCOL) return;
    if (typeof msg.nodeId !== 'string' || !/^[0-9a-f]{128}$/i.test(msg.nodeId)) return;
    if (!Number.isInteger(msg.port) || msg.port <= 0 || msg.port > 65535) return;

    const nodeId = msg.nodeId.toLowerCase();
    if (this.node.identity && nodeId === this.node.identity.nodeIdHex) return; // our own echo

    const known = this.peers.get(nodeId);
    this.peers.set(nodeId, {
      nodeId,
      address: rinfo.address,
      port: msg.port,
      lastSeen: Date.now()
    });

    if (!known) {
      logger.info('lan-discovery', 'peer-seen',
        `Found ${nodeId.slice(0, 16)}… on the local network at ${rinfo.address}:${msg.port}`,
        { nodeId, address: rinfo.address, port: msg.port });
      this.emit('peer-discovered', { nodeId, address: rinfo.address, port: msg.port });
    }
  }

  /** Drop beacons we have not heard in a while. */
  _prune() {
    const cutoff = Date.now() - this.peerTtlMs;
    for (const [nodeId, entry] of this.peers) {
      if (entry.lastSeen < cutoff) this.peers.delete(nodeId);
    }
  }

  /** NodeIDs currently visible on this network. */
  getNodeIds() {
    this._prune();
    return Array.from(this.peers.keys());
  }

  /** Where a locally-visible NodeID can be dialled, or null. */
  getPeer(nodeId) {
    this._prune();
    return this.peers.get(String(nodeId).toLowerCase()) || null;
  }

  close() {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch (e) {}
      this.socket = null;
    }
    this.peers.clear();
    this.started = false;
  }
}
