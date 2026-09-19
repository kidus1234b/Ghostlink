# @ghostlink/gmp-core

Ghost Mesh Protocol (GMP) is GhostLink's secure, decentralized, peer-to-peer encrypted mesh networking stack. It enables zero-metadata virtual multi-hop routing, cryptographic identity-asserted handshakes, and NAT hole punching. The package is optimized to run byte-for-byte identically across web, Electron desktop, and React Native mobile environments.

## Installation

```bash
npm install @ghostlink/gmp-core
```

## Quick Start

```javascript
import { GMPNodeManager } from '@ghostlink/gmp-core';

const manager = new GMPNodeManager({ seedPhrase: 'your twelve word seed phrase here ...' });
const status = await manager.start();
console.log(`GMP Node running at NodeID: ${status.nodeId}`);
```

## Command Line Interface (CLI)

Install globally or use `npx` to manage and monitor local nodes:

- `gmp start` - Prompts securely for seed phrase and starts a local node & websocket bridge.
- `gmp status` - Queries the metrics endpoint and outputs a beautiful human-readable state summary.
- `gmp peers` - Lists currently active peer connections with partial metadata protections.
- `gmp rotate-key` - Generates a new identity seed, rotates active keys, and floods certificates to the mesh.
- `gmp ping <nodeId>` - Measures mesh RTT and hop counts to a target destination.

## Ghost Addresses

Every node has a permanent, human-typeable address derived from its NodeID:

```js
import { GMPNodeManager } from './gmp-node-manager.js';

const node = new GMPNodeManager({ seedPhrase });
await node.start();

node.getGhostAddress();   // 'GHOST-7K2-M4Q-8ZB'
node.getNodeId();         // the full 128-hex NodeID it came from
```

The address is the first 45 bits of the NodeID in Crockford base32 (see
`ghost-address.js`), so it is a pure function of the identity — deterministic,
offline, and identical on every platform. It carries no network location.

Resolving one goes the other way, scanning the node IDs this node has learned
from topology flooding, LAN discovery beacons, and its peer cache:

```js
node.resolveGhostAddress('GHOST-7K2-M4Q-8ZB');
// { reason: 'ok', nodeId: '…', address: 'GHOST-7K2-M4Q-8ZB', candidates: [ … ] }

await node.connectByGhostAddress('GHOST-7K2-M4Q-8ZB');
// { connected: true, transport: 'lan' | 'direct' | 'virtual', … }
```

45 bits is short enough to read aloud and long enough that a collision needs
millions of simultaneously-online nodes. Resolution detects collisions and
returns `reason: 'ambiguous'` with every candidate rather than guessing.

`connectByNodeId` tries a live session first, then a LAN-discovered address,
then a remembered one, and finally a routed virtual circuit through the mesh —
so the same call works on a LAN, behind NAT, and across the internet.

### LAN discovery

`lan-discovery.js` multicasts a `{ nodeId, port }` beacon on
`239.255.42.99:49599` so machines on one subnet can resolve each other's
addresses with no public peer and no internet at all.

It builds a **directory only** — it never opens a connection. Sharing a network
with someone does not put them in your contact list. Disable with
`GMP_LAN_DISCOVERY=false`.

## Configuration

Custom settings can be specified in `gmp-core/data/config.json`, via environment variables, or directly passed to constructor options. See [config.example.json](data/config.example.json) for all available options and defaults.

## Security & Privacy Logging Rules

- **At-Rest Encryption**: Peer cache records and nonce tracking databases are fully encrypted with AES-256-GCM.
- **In-Memory State**: Handshake secrets and temporary connection records reside only in memory and are discarded on process exit.
- **Privacy Logging**: Logs are formatted in structured JSON. Message payloads, private keys, and session keys are never logged. IP addresses and NodeIDs are automatically masked/truncated at `INFO` and higher levels to protect metadata exposure.

For detailed specification of the underlying protocol architecture, refer to [PROTOCOL_SPEC.md](PROTOCOL_SPEC.md).
