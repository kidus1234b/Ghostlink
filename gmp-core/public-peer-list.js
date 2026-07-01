import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PEERS_FILE = path.join(__dirname, 'data', 'public-peers.json');

export function loadPublicPeers(filePath = DEFAULT_PEERS_FILE) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[PublicPeerList] Failed to load public peers:', e.message);
  }
  return [];
}

export function savePublicPeers(peers, filePath = DEFAULT_PEERS_FILE) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(peers, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[PublicPeerList] Failed to save public peers:', e.message);
    return false;
  }
}

export async function querySinglePeer(node, peer, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let link = null;
    let finished = false;

    let timeoutTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      if (link) {
        link.destroy(new Error('Query timeout'));
      }
      reject(new Error(`Timeout querying peer ${peer.address}:${peer.port}`));
    }, timeoutMs);

    node.dial(peer.address, peer.port)
      .then(({ connId, link: activeLink }) => {
        if (finished) {
          activeLink.destroy();
          return;
        }
        link = activeLink;
        
        link.once('binding-response', (info) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutTimer);
          link.destroy();
          resolve(info);
        });

        link.once('error', (err) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutTimer);
          link.destroy();
          reject(err);
        });

        link.once('close', () => {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutTimer);
          reject(new Error('Connection closed before binding response'));
        });

        // Send binding request
        try {
          link.sendBindingRequest();
        } catch (e) {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutTimer);
          link.destroy();
          reject(e);
        }
      })
      .catch((err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutTimer);
        reject(err);
      });
  });
}

export async function queryPublicAddress(node, peers, timeoutMs = 5000) {
  if (!peers || peers.length === 0) {
    throw new Error('No public peers specified for query');
  }

  const promises = peers.map(peer => 
    querySinglePeer(node, peer, timeoutMs)
      .then(res => ({ success: true, res }))
      .catch(err => ({ success: false, err }))
  );

  const results = await Promise.all(promises);
  const successful = results.filter(r => r.success).map(r => r.res);

  if (successful.length === 0) {
    throw new Error('All public peer queries failed');
  }

  // Check consensus among successful responses
  const agreementCounts = {};
  for (const res of successful) {
    const key = `${res.address}:${res.port}`;
    agreementCounts[key] = (agreementCounts[key] || 0) + 1;
  }

  // Find the response with the most agreements
  let bestKey = null;
  let maxCount = 0;
  for (const [key, count] of Object.entries(agreementCounts)) {
    if (count > maxCount) {
      maxCount = count;
      bestKey = key;
    }
  }

  if (maxCount >= Math.min(successful.length, 2)) {
    // Determine the IP/port from key
    const lastColonIndex = bestKey.lastIndexOf(':');
    const parsedAddress = bestKey.slice(0, lastColonIndex);
    const parsedPort = parseInt(bestKey.slice(lastColonIndex + 1), 10);
    return { address: parsedAddress, port: parsedPort };
  }

  throw new Error('Public peers disagreed on public address');
}
