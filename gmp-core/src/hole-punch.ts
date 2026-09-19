import net from 'net';
import logger from './logger.js';
import type {
  GMPNodeLike,
  GMPLinkLike,
  DialResult,
} from './types.js';

interface HolePunchParams {
  node: GMPNodeLike;
  peerNodeId: string;
  previouslyKnownAddress?: { address: string; port: number };
  peerObservedAddress: { address: string; port: number };
  attemptTimestamp: number;
  retryIntervalMs?: number;
  timeoutMs?: number;
}

export async function holePunchConnect({
  node,
  peerNodeId,
  previouslyKnownAddress,
  peerObservedAddress,
  attemptTimestamp,
  retryIntervalMs = 200,
  timeoutMs = 5000,
}: HolePunchParams): Promise<DialResult> {
  if (!peerObservedAddress || !peerObservedAddress.address || !peerObservedAddress.port) {
    throw new Error("Cannot initiate hole punching: peer's observed address is missing or invalid.");
  }

  if (previouslyKnownAddress) {
    try {
      logger.info('hole-punch', 'direct-connect-attempt', `Fast path: Attempting direct connection to ${previouslyKnownAddress.address}:${previouslyKnownAddress.port}`, {
        peerNodeId,
        address: previouslyKnownAddress.address,
        port: previouslyKnownAddress.port
      });
      const result = await node.dial(previouslyKnownAddress.address, previouslyKnownAddress.port);
      return result;
    } catch (e: unknown) {
      const err = e as Error;
      logger.info('hole-punch', 'direct-connect-failed', `Fast path direct connection failed: ${err.message}. Proceeding to simultaneous-open hole punching.`, {
        peerNodeId,
        err: err.message
      });
    }
  }

  const now = Date.now();
  const waitMs = attemptTimestamp - now;
  if (waitMs > 0) {
    logger.info('hole-punch', 'waiting-timestamp', `Waiting ${waitMs}ms until coordinated timestamp ${attemptTimestamp} to start hole punching...`, {
      peerNodeId,
      waitMs,
      attemptTimestamp
    });
    await new Promise<void>(resolve => setTimeout(resolve, waitMs));
  }

  logger.info('hole-punch', 'simultaneous-open-start', `Starting simultaneous-open TCP connections to ${peerObservedAddress.address}:${peerObservedAddress.port}...`, {
    peerNodeId,
    address: peerObservedAddress.address,
    port: peerObservedAddress.port
  });

  return new Promise((resolve, reject) => {
    const sockets: net.Socket[] = [];
    let isFinished = false;

    const overallTimeout = setTimeout(() => {
      cleanup(new Error("Direct connection failed — this can happen with strict (symmetric) NAT on one or both sides. Falling back to QR/paste signaling or the optional relay."));
    }, timeoutMs);

    const intervalTimer = setInterval(() => {
      attemptConnect();
    }, retryIntervalMs);

    function cleanup(err: Error | null): void {
      if (isFinished) return;
      isFinished = true;
      clearInterval(intervalTimer);
      clearTimeout(overallTimeout);

      for (const socket of sockets) {
        socket.destroy();
      }

      if (err) {
        reject(err);
      }
    }

    function attemptConnect(): void {
      if (isFinished) return;

      const socket = new net.Socket();
      sockets.push(socket);

      socket.once('connect', () => {
        if (isFinished) {
          socket.destroy();
          return;
        }

        const idx = sockets.indexOf(socket);
        if (idx !== -1) {
          sockets.splice(idx, 1);
        }

        logger.info('hole-punch', 'tcp-established', `TCP connection established! Running GMP handshake...`, {
          peerNodeId,
          address: peerObservedAddress.address,
          port: peerObservedAddress.port
        });
        cleanup(null);

        node.dialWithSocket(socket)
          .then((res: DialResult) => {
            resolve(res);
          })
          .catch((err: Error) => {
            socket.destroy();
            reject(err);
          });
      });

      socket.once('error', (err: Error) => {
        socket.destroy();
        const idx = sockets.indexOf(socket);
        if (idx !== -1) {
          sockets.splice(idx, 1);
        }
      });

      socket.connect({
        host: peerObservedAddress.address,
        port: peerObservedAddress.port
      });
    }

    attemptConnect();
  });
}