import net from 'net';
import logger from './logger.js';

/**
 * Attempts direct P2P connection, falling back to simultaneous-open hole punching.
 * 
 * @param {Object} params
 * @param {GMPNode} params.node The local GMPNode instance
 * @param {string} params.peerNodeId Hex string of the target peer's NodeID
 * @param {Object} [params.previouslyKnownAddress] Fast path target { address, port }
 * @param {Object} params.peerObservedAddress The peer's external IP:port { address, port }
 * @param {number} params.attemptTimestamp Target Epoch timestamp (ms) to start hole punching
 * @param {number} [params.retryIntervalMs=200] Interval between raw connect attempts
 * @param {number} [params.timeoutMs=5000] Maximum duration to attempt hole punching
 * @returns {Promise<{ connId, link, peerNodeId }>} Established GMP link details
 */
export async function holePunchConnect({
  node,
  peerNodeId,
  previouslyKnownAddress,
  peerObservedAddress,
  attemptTimestamp,
  retryIntervalMs = 200,
  timeoutMs = 5000,
}) {
  if (!peerObservedAddress || !peerObservedAddress.address || !peerObservedAddress.port) {
    throw new Error("Cannot initiate hole punching: peer's observed address is missing or invalid.");
  }

  // Fast path: try direct connection first
  if (previouslyKnownAddress) {
    try {
      logger.info('hole-punch', 'direct-connect-attempt', `Fast path: Attempting direct connection to ${previouslyKnownAddress.address}:${previouslyKnownAddress.port}`, {
        peerNodeId,
        address: previouslyKnownAddress.address,
        port: previouslyKnownAddress.port
      });
      const result = await node.dial(previouslyKnownAddress.address, previouslyKnownAddress.port);
      return result;
    } catch (e) {
      logger.info('hole-punch', 'direct-connect-failed', `Fast path direct connection failed: ${e.message}. Proceeding to simultaneous-open hole punching.`, {
        peerNodeId,
        err: e.message
      });
    }
  }

  // Coordinated timing
  const now = Date.now();
  const waitMs = attemptTimestamp - now;
  if (waitMs > 0) {
    logger.info('hole-punch', 'waiting-timestamp', `Waiting ${waitMs}ms until coordinated timestamp ${attemptTimestamp} to start hole punching...`, {
      peerNodeId,
      waitMs,
      attemptTimestamp
    });
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  logger.info('hole-punch', 'simultaneous-open-start', `Starting simultaneous-open TCP connections to ${peerObservedAddress.address}:${peerObservedAddress.port}...`, {
    peerNodeId,
    address: peerObservedAddress.address,
    port: peerObservedAddress.port
  });

  return new Promise((resolve, reject) => {
    const sockets = [];
    let isFinished = false;

    // Timeout timer for overall hole punching attempt
    const overallTimeout = setTimeout(() => {
      cleanup(new Error("Direct connection failed — this can happen with strict (symmetric) NAT on one or both sides. Falling back to QR/paste signaling or the optional relay."));
    }, timeoutMs);

    // Interval to spawn new connection attempts
    const intervalTimer = setInterval(() => {
      attemptConnect();
    }, retryIntervalMs);

    function cleanup(err) {
      if (isFinished) return;
      isFinished = true;
      clearInterval(intervalTimer);
      clearTimeout(overallTimeout);

      // Close all sockets that are not successful
      for (const socket of sockets) {
        socket.destroy();
      }

      if (err) {
        reject(err);
      }
    }

    function attemptConnect() {
      if (isFinished) return;

      const socket = new net.Socket();
      sockets.push(socket);

      socket.once('connect', () => {
        if (isFinished) {
          socket.destroy();
          return;
        }

        // We got a raw connection! Remove this socket from the list so it doesn't get destroyed on cleanup.
        const idx = sockets.indexOf(socket);
        if (idx !== -1) {
          sockets.splice(idx, 1);
        }

        logger.info('hole-punch', 'tcp-established', `TCP connection established! Running GMP handshake...`, {
          peerNodeId,
          address: peerObservedAddress.address,
          port: peerObservedAddress.port
        });
        cleanup(null); // Cleanup other pending sockets

        // Hand over the connected socket to GMPNode to run the handshake
        node.dialWithSocket(socket)
          .then((res) => {
            resolve(res);
          })
          .catch((err) => {
            socket.destroy();
            reject(err);
          });
      });

      socket.once('error', (err) => {
        // Socket failed, just clean it up locally
        socket.destroy();
        const idx = sockets.indexOf(socket);
        if (idx !== -1) {
          sockets.splice(idx, 1);
        }
      });

      // Connect outbound
      socket.connect({
        host: peerObservedAddress.address,
        port: peerObservedAddress.port
      });
    }

    // Run first attempt immediately
    attemptConnect();
  });
}
