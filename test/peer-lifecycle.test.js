/**
 * Regression tests for peer connect/disconnect lifecycle in P2PConnector.
 * A peer has three data channels and may also hold a Ghost Mesh session, so
 * listeners must see exactly one peer-connected and one peer-disconnected,
 * and must not be told a peer is gone while any transport still works.
 *
 * Run with: node test/peer-lifecycle.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');

let failures = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ── Minimal browser shim ───────────────────────────────────────────────────
const closedMeshConns = [];
global.window = {
  location: { protocol: 'http:', hostname: 'localhost', port: '3001' },
  ghostlink: {
    ghostMesh: {
      close: (id) => closedMeshConns.push(id),
      onPeerConnected: () => () => {},
      onData: () => () => {},
      onPeerDisconnected: () => () => {},
      startServer: () => Promise.resolve(),
      send: () => Promise.resolve(),
      dial: () => Promise.resolve({ success: false }),
    },
  },
};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
// close() only flips the state: a real socket fires onclose on a later tick,
// which is exactly the window the reconnect guard has to survive. Tests invoke
// onclose() themselves to model that deferred event.
const openedSockets = [];
global.WebSocket = function (url) {
  this.url = url;
  this.readyState = 1;
  this.send = () => {};
  this.close = () => { this.readyState = 3; };
  openedSockets.push(this);
};
global.WebSocket.OPEN = 1;
global.RTCPeerConnection = function () {};

const { P2PConnector } = require(path.join(__dirname, '..', 'src', 'p2p', 'p2p-connector.js'));

function makeChannel(label) {
  return { label, readyState: 'open', close() { this.readyState = 'closed'; }, send() {} };
}

function makeConnector() {
  const c = new P2PConnector({ fingerprint: 'me', publicKeyHex: 'ab'.repeat(33), name: 'Me' });
  const events = [];
  c.on('peer-connected', (id) => events.push(`connected:${id}`));
  c.on('peer-disconnected', (id) => events.push(`disconnected:${id}`));
  return { c, events };
}

/** Attach three open channels the way _setupDc does. */
function attachChannels(c, peerId) {
  const chans = {};
  ['messages', 'files', 'presence'].forEach((label) => {
    chans[label] = makeChannel(label);
    c._setupDc(peerId, label, chans[label]);
  });
  return chans;
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('three channels opening produce one peer-connected', () => {
  const { c, events } = makeConnector();
  const chans = attachChannels(c, 'p1');
  Object.values(chans).forEach((ch) => ch.onopen());
  assert.deepStrictEqual(events, ['connected:p1']);
});

test('closing one channel does not disconnect a peer with others open', () => {
  const { c, events } = makeConnector();
  const chans = attachChannels(c, 'p1');
  Object.values(chans).forEach((ch) => ch.onopen());
  events.length = 0;

  chans.presence.readyState = 'closed';
  chans.presence.onclose();
  assert.deepStrictEqual(events, [], 'peer reported gone while messages channel is open');
  assert.strictEqual(c.isConnected('p1'), true);

  chans.files.readyState = 'closed';
  chans.files.onclose();
  assert.deepStrictEqual(events, [], 'peer reported gone while messages channel is open');
});

test('the last channel closing produces exactly one peer-disconnected', () => {
  const { c, events } = makeConnector();
  const chans = attachChannels(c, 'p1');
  Object.values(chans).forEach((ch) => ch.onopen());
  events.length = 0;

  Object.values(chans).forEach((ch) => { ch.readyState = 'closed'; ch.onclose(); });
  assert.deepStrictEqual(events, ['disconnected:p1']);
});

test('losing the mesh session keeps a peer with open data channels', () => {
  const { c, events } = makeConnector();
  const chans = attachChannels(c, 'p1');
  Object.values(chans).forEach((ch) => ch.onopen());
  c.meshConns['p1'] = { connId: 'conn-1', sharedKey: null };
  events.length = 0;

  c._handleMeshDisconnected('conn-1');
  assert.deepStrictEqual(events, [], 'mesh loss disconnected a peer with live channels');
  assert.strictEqual(c.isConnected('p1'), true);
});

test('losing data channels keeps a mesh-only peer connected', () => {
  const { c, events } = makeConnector();
  const chans = attachChannels(c, 'p1');
  Object.values(chans).forEach((ch) => ch.onopen());
  c.meshConns['p1'] = { connId: 'conn-1', sharedKey: null };
  events.length = 0;

  Object.values(chans).forEach((ch) => { ch.readyState = 'closed'; ch.onclose(); });
  assert.deepStrictEqual(events, [], 'peer reported gone while the mesh session is up');

  c._handleMeshDisconnected('conn-1');
  assert.deepStrictEqual(events, ['disconnected:p1'], 'no disconnect after the last transport closed');
});

test('removePeer forces one disconnect and closes the mesh connection', () => {
  const { c, events } = makeConnector();
  const chans = attachChannels(c, 'p1');
  Object.values(chans).forEach((ch) => ch.onopen());
  c.meshConns['p1'] = { connId: 'conn-9', sharedKey: null };
  closedMeshConns.length = 0;
  events.length = 0;

  c.removePeer('p1');
  assert.deepStrictEqual(events, ['disconnected:p1']);
  assert.deepStrictEqual(closedMeshConns, ['conn-9'], 'mesh connId was not closed');

  // Straggler close handlers must stay silent.
  Object.values(chans).forEach((ch) => { ch.readyState = 'closed'; ch.onclose(); });
  assert.deepStrictEqual(events, ['disconnected:p1'], 'duplicate disconnect after removePeer');
});

test('disconnect() reports every peer once, including mesh-only peers', () => {
  const { c, events } = makeConnector();
  const chans = attachChannels(c, 'webrtcPeer');
  Object.values(chans).forEach((ch) => ch.onopen());
  // A mesh-only peer has no entry in pcs/dcs at all.
  c.meshConns['meshPeer'] = { connId: 'conn-m', sharedKey: null };
  c._announceConnected('meshPeer', { mode: 'Ghost Mesh' });
  events.length = 0;

  c.disconnect();
  assert.strictEqual(events.filter((e) => e === 'disconnected:webrtcPeer').length, 1);
  assert.strictEqual(events.filter((e) => e === 'disconnected:meshPeer').length, 1,
    'mesh-only peer was dropped without a disconnect event');
});

test('a peer can reconnect after disconnecting', () => {
  const { c, events } = makeConnector();
  let chans = attachChannels(c, 'p1');
  Object.values(chans).forEach((ch) => ch.onopen());
  Object.values(chans).forEach((ch) => { ch.readyState = 'closed'; ch.onclose(); });
  events.length = 0;

  chans = attachChannels(c, 'p1');
  Object.values(chans).forEach((ch) => ch.onopen());
  assert.deepStrictEqual(events, ['connected:p1'], 'stale announce state blocked reconnection');
});

test('destroy() closes every transport and drops listeners', () => {
  const { c, events } = makeConnector();
  const chans = attachChannels(c, 'p1');
  Object.values(chans).forEach((ch) => ch.onopen());
  c.meshConns['p1'] = { connId: 'conn-d', sharedKey: null };
  c.pcs['p1'] = { close() { this.closed = true; }, closed: false };
  closedMeshConns.length = 0;
  events.length = 0;

  c.destroy();

  assert.deepStrictEqual(events, ['disconnected:p1'], 'peer was not reported on destroy');
  assert.deepStrictEqual(closedMeshConns, ['conn-d'], 'mesh connId left open');
  assert.deepStrictEqual(c.dcs, {}, 'data channels not released');
  assert.deepStrictEqual(c.pcs, {}, 'peer connections not released');
  Object.values(chans).forEach((ch) => {
    assert.strictEqual(ch.readyState, 'closed', 'data channel left open');
  });

  // Listeners are gone, so a stale event cannot reach the old handlers.
  events.length = 0;
  c.emit('peer-connected', 'p1', {});
  c.emit('peer-disconnected', 'p1');
  assert.deepStrictEqual(events, [], 'destroyed connector still emits into old listeners');
});

test('a live socket closing still schedules a reconnect', () => {
  const { c } = makeConnector();
  openedSockets.length = 0;
  c.wsUrl = 'ws://localhost:3001';
  c._connectWs();
  const ws = openedSockets[0];
  ws.onopen();

  ws.readyState = 3;
  ws.onclose();
  assert.ok(c.reconnectTimer, 'no reconnect scheduled after an unexpected close');
  clearTimeout(c.reconnectTimer);
  c.reconnectTimer = null;
});

test('destroy() stops the signaling reconnect loop', () => {
  const { c } = makeConnector();
  openedSockets.length = 0;
  c.wsUrl = 'ws://localhost:3001';
  c._connectWs();
  const ws = openedSockets[0];
  ws.onopen();
  assert.ok(c.wsPingInterval, 'ping interval was never started');

  c.destroy();
  // The socket's onclose lands after close() returned, i.e. after disconnect()
  // already cleared the timers.
  ws.onclose();

  assert.strictEqual(c.reconnectTimer, null, 'destroyed connector re-armed the reconnect timer');
  assert.strictEqual(c.wsPingInterval, null, 'ping interval left running');
  assert.strictEqual(openedSockets.length, 1, 'destroyed connector opened a new socket');

  // connect() must not resurrect it either.
  return c.connect().then(() => {
    assert.strictEqual(openedSockets.length, 1, 'connect() revived a destroyed connector');
  });
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { failures++; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
  }
  if (failures) { process.stdout.write(`\n${failures} test(s) failed\n`); process.exit(1); }
  process.stdout.write('\nAll peer-lifecycle tests passed\n');
})();
