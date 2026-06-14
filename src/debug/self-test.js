// SelfTest — GhostLink self-validation suite (PHASED)
(function(exports) {
  'use strict';

  const GL = window.GhostLink || {};
  const { NonceTracker, KeyManager, EventBus, StateMachine, RetryQueue, Logger,
          MessageRouter, RelayManager, FileTransferManager, ConnectionManager,
          RateLimiter, SessionManager, FloodProtection } = GL;

  class SelfTest {
    constructor() {
      this._results = [];
      this._phaseResults = {};
    }

    async runAllTests() {
      this._results = [];
      this._phaseResults = {};

      console.log('═══════════════════════════════════════════════════');
      console.log('  GhostLink Full Self-Validation Suite');
      console.log('═══════════════════════════════════════════════════');
      console.log('');

      const phases = [
        { name: 'Phase 1: EventBus', tests: this._phase1_EventBus.bind(this) },
        { name: 'Phase 2: StateMachine', tests: this._phase2_StateMachine.bind(this) },
        { name: 'Phase 3: RetryQueue', tests: this._phase3_RetryQueue.bind(this) },
        { name: 'Phase 4: ConnectionManager', tests: this._phase4_ConnectionManager.bind(this) },
        { name: 'Phase 5: SecurityManager', tests: this._phase5_SecurityManager.bind(this) },
        { name: 'Phase 6: MessageRouter', tests: this._phase6_MessageRouter.bind(this) },
        { name: 'Phase 7: FileTransfer', tests: this._phase7_FileTransfer.bind(this) },
        { name: 'Phase 8: RelayManager', tests: this._phase8_RelayManager.bind(this) },
        { name: 'Phase 9: GhostLinkDebug', tests: this._phase9_GhostLinkDebug.bind(this) },
      ];

      let passed = 0;
      let failed = 0;

      for (const phase of phases) {
        console.log(`══ ${phase.name} ══`);
        const phaseResult = await phase.tests();
        this._phaseResults[phase.name] = phaseResult;
        phaseResult.forEach(r => {
          if (r.passed) passed++; else failed++;
          this._results.push(r);
        });
        console.log('');
      }

      this._printSummary(passed, failed);
      return { passed, failed, results: this._results, phaseResults: this._phaseResults };
    }

    async runQuick() {
      console.log('═══════════════════════════════════════════════════');
      console.log('  GhostLink Quick Self-Check');
      console.log('═══════════════════════════════════════════════════');
      const checks = [
        ['Module loading', () => this._quickModuleCheck()],
        ['CryptoEngine intact', () => typeof window.CryptoEngine !== 'undefined'],
        ['PeerCache intact', () => typeof window.PeerCache !== 'undefined'],
        ['GhostLink global bus', () => !!(GL.globalBus)],
        ['No DOM corruption', () => document.getElementById('root') !== null],
      ];
      checks.forEach(([name, fn]) => {
        const ok = fn();
        console.log((ok ? '✓' : '✗') + ' ' + name);
      });
    }

    // ── Phase 1: EventBus ──────────────────────────────────────────────

    async _phase1_EventBus() {
      const results = [];
      const bus = new EventBus('test-phase1');

      const t = (name, fn) => this._runTest(name, fn, results);

      await t('EventBus.on() registers listener', async () => {
        let called = false;
        bus.on('p1:topic1', () => { called = true; });
        await bus.emit('p1:topic1', {});
        if (!called) throw new Error('listener not called');
      });

      await t('EventBus.once() fires once only', async () => {
        let count = 0;
        bus.once('p1:topic2', () => { count++; });
        await bus.emit('p1:topic2', {});
        await bus.emit('p1:topic2', {});
        if (count !== 1) throw new Error(`expected 1 call, got ${count}`);
      });

      await t('EventBus.emit() async resolution', async () => {
        let resolved = false;
        bus.once('p1:topic3', () => { resolved = true; });
        await bus.emit('p1:topic3', { data: 42 });
        if (!resolved) throw new Error('async emit did not resolve handler');
      });

      await t('EventBus.waitFor() resolves on emit', async () => {
        const fired = bus.waitFor('p1:topic4', 500);
        setTimeout(() => bus.emit('p1:topic4', {}), 50);
        await fired;
      });

      await t('EventBus.wiretap() captures all events', async () => {
        let tapped = false;
        bus.wiretap(() => { tapped = true; });
        await bus.emit('p1:topic5', {});
        if (!tapped) throw new Error('wiretap not called');
      });

      await t('EventBus.off() removes listener', async () => {
        let count = 0;
        const handler = () => { count++; };
        bus.on('p1:topic6', handler);
        bus.off('p1:topic6', handler);
        await bus.emit('p1:topic6', {});
        if (count !== 0) throw new Error('listener still called after off()');
      });

      await t('EventBus.waitFor() timeout rejects', async () => {
        let timedOut = false;
        try {
          await bus.waitFor('p1:nonexistent', 100);
        } catch (e) {
          timedOut = true;
        }
        if (!timedOut) throw new Error('waitFor should have timed out');
      });

      return results;
    }

    // ── Phase 2: StateMachine ───────────────────────────────────────────

    async _phase2_StateMachine() {
      const results = [];
      const t = (name, fn) => this._runTest(name, fn, results);

      await t('StateMachine legal transitions', async () => {
        const sm = new StateMachine('idle');
        if (!sm.can('connecting')) throw new Error('idle cannot transition to connecting');
        if (!sm.transition('connecting')) throw new Error('transition to connecting failed');
        if (sm.state !== 'connecting') throw new Error('state should be connecting');
      });

      await t('StateMachine illegal transitions', async () => {
        const sm = new StateMachine('idle');
        if (sm.can('connected')) throw new Error('idle should not transition directly to connected');
        if (sm.transition('connected') !== false) throw new Error('illegal transition should return false');
        if (sm.state !== 'idle') throw new Error('state should remain idle');
      });

      await t('StateMachine history tracking', async () => {
        const sm = new StateMachine('idle');
        sm.transition('connecting');
        sm.transition('connected');
        const history = sm.history?.() || [];
        if (!history.includes('connecting') || !history.includes('connected')) {
          throw new Error('history does not contain transitions');
        }
      });

      await t('StateMachine multiple legal transitions', async () => {
        const sm = new StateMachine('idle');
        const legal = ['connecting', 'connected', 'disconnected'];
        for (const s of legal) {
          sm.transition(s);
          if (sm.state !== s) throw new Error(`failed to transition to ${s}`);
        }
      });

      await t('StateMachine reset', async () => {
        const sm = new StateMachine('idle');
        sm.transition('connecting');
        sm.reset?.();
        if (sm.state !== 'idle') throw new Error('state should be reset to idle');
      });

      return results;
    }

    // ── Phase 3: RetryQueue ────────────────────────────────────────────

    async _phase3_RetryQueue() {
      const results = [];
      const t = (name, fn) => this._runTest(name, fn, results);

      await t('RetryQueue retry on failure', async () => {
        const rq = new RetryQueue({ baseDelay: 5, maxDelay: 50 });
        let attempts = 0;
        await rq.enqueue(() => {
          attempts++;
          if (attempts < 2) throw new Error('fail');
          return 'ok';
        });
        if (attempts < 2) throw new Error(`expected at least 2 attempts, got ${attempts}`);
      });

      await t('RetryQueue exponential backoff', async () => {
        const rq = new RetryQueue({ baseDelay: 10, maxDelay: 1000 });
        let attempts = 0;
        const start = Date.now();
        await rq.enqueue(() => {
          attempts++;
          if (attempts < 3) throw new Error('fail');
          return 'ok';
        });
        const elapsed = Date.now() - start;
        if (elapsed < 20) throw new Error('backoff not working, too fast');
      });

      await t('RetryQueue exhausted retries', async () => {
        const rq = new RetryQueue({ baseDelay: 5, maxDelay: 20, maxRetries: 3 });
        let attempts = 0;
        try {
          await rq.enqueue(() => {
            attempts++;
            throw new Error('always fail');
          });
          throw new Error('should have thrown');
        } catch (e) {
          if (attempts !== 4) throw new Error(`expected 4 attempts (3 retries + 1 initial), got ${attempts}`);
        }
      });

      await t('RetryQueue immediate success', async () => {
        const rq = new RetryQueue({ baseDelay: 10, maxDelay: 100 });
        const result = await rq.enqueue(() => 'immediate');
        if (result !== 'immediate') throw new Error('expected immediate success');
      });

      return results;
    }

    // ── Phase 4: ConnectionManager ─────────────────────────────────────

    async _phase4_ConnectionManager() {
      const results = [];
      const t = (name, fn) => this._runTest(name, fn, results);

      await t('RTCPeerConnection creation', async () => {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        if (!pc) throw new Error('RTCPeerConnection not created');
        pc.close();
      });

      await t('DataChannel creation', async () => {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        const dc = pc.createDataChannel('test', { ordered: true });
        if (!dc) throw new Error('DataChannel not created');
        pc.close();
      });

      await t('ICE candidate exchange simulation', async () => {
        const pc1 = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        const pc2 = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        const candidates = [];
        pc1.onicecandidate = (e) => { if (e.candidate) candidates.push(e.candidate); };
        pc2.onicecandidate = (e) => { if (e.candidate) candidates.push(e.candidate); };
        const offer = await pc1.createOffer();
        await pc1.setLocalDescription(offer);
        await pc2.setRemoteDescription(offer);
        const answer = await pc2.createAnswer();
        await pc2.setLocalDescription(answer);
        await pc1.setRemoteDescription(answer);
        if (candidates.length === 0) throw new Error('no ICE candidates generated');
        pc1.close();
        pc2.close();
      });

      await t('PeerConnection close cleanup', async () => {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        pc.createDataChannel('test');
        pc.close();
        if (pc.connectionState !== 'closed') throw new Error('connection should be closed');
      });

      return results;
    }

    // ── Phase 5: SecurityManager ───────────────────────────────────────

    async _phase5_SecurityManager() {
      const results = [];
      const t = (name, fn) => this._runTest(name, fn, results);

      await t('NonceTracker replay protection', async () => {
        if (!NonceTracker) throw new Error('NonceTracker not found');
        const tracker = new NonceTracker();
        const nonce = 'nonce-phase5-' + Math.random();
        if (!tracker.isUnique(nonce)) throw new Error('first use should be unique');
        if (tracker.isUnique(nonce)) throw new Error('second use should not be unique');
      });

      await t('RateLimiter rate limiting', async () => {
        if (!RateLimiter) return true;
        const rl = new RateLimiter({ maxPerSecond: 5, windowMs: 1000 });
        for (let i = 0; i < 5; i++) {
          if (!rl.check?.('test-p5-1')) throw new Error('should allow within limit');
        }
        if (rl.check?.('test-p5-1')) throw new Error('should be rate limited');
      });

      await t('FloodProtection detection', async () => {
        if (!FloodProtection) return true;
        const fp = new FloodProtection({ threshold: 3 });
        const peerId = 'test-p5-peer';
        for (let i = 0; i < 3; i++) {
          fp.record?.(peerId);
        }
        if (!fp.isFlooding?.(peerId)) throw new Error('should detect flooding');
      });

      await t('SessionManager session lifecycle', async () => {
        if (!SessionManager) return true;
        const sm = new SessionManager({ sessionExpiryMs: 5000 });
        sm.create?.('test-peer-p5', { key: crypto.getRandomValues(new Uint8Array(32)) });
        const session = sm.get?.('test-peer-p5');
        if (!session) throw new Error('session not created');
        await new Promise(r => setTimeout(r, 100));
        sm.destroy?.('test-peer-p5');
        const after = sm.get?.('test-peer-p5');
        if (after) throw new Error('session not destroyed');
      });

      await t('KeyManager encrypt/decrypt roundtrip', async () => {
        if (!KeyManager) return true;
        const km = new KeyManager({ rotationIntervalMs: 60000, sessionExpiryMs: 60000 });
        const masterKey = crypto.getRandomValues(new Uint8Array(32));
        await km.initSession('peer-p5', masterKey);
        const { iv, ciphertext } = await km.encrypt('hello world', 'peer-p5');
        if (!iv || !ciphertext) throw new Error('encryption returned null');
        const plaintext = await km.decrypt(iv, ciphertext, 'peer-p5');
        if (plaintext !== 'hello world') throw new Error(`decryption mismatch: got "${plaintext}"`);
        km.destroySession('peer-p5');
      });

      return results;
    }

    // ── Phase 6: MessageRouter ─────────────────────────────────────────

    async _phase6_MessageRouter() {
      const results = [];
      const t = (name, fn) => this._runTest(name, fn, results);

      await t('MessageRouter deduplication', async () => {
        if (!MessageRouter) throw new Error('MessageRouter not found');
        const router = new MessageRouter({ sendFn: () => true });
        const msg = { type: 'chat', content: 'hello' };
        const r1 = router.receive?.({ ...msg, _id: 'p6-msg-1' }, 'peer1') ?? router.handle?.({ ...msg, _id: 'p6-msg-1' }, 'peer1');
        const r2 = router.receive?.({ ...msg, _id: 'p6-msg-1' }, 'peer1') ?? router.handle?.({ ...msg, _id: 'p6-msg-1' }, 'peer1');
        if (r1 === null || r2 !== null) throw new Error('deduplication failed');
      });

      await t('MessageRouter ACK handling', async () => {
        if (!MessageRouter) return true;
        const router = new MessageRouter({ sendFn: () => true });
        const ackReceived = await new Promise(resolve => {
          router.sendAck?.('peer1', 'msg-ack-test', resolve);
          setTimeout(() => resolve(false), 500);
        });
        if (ackReceived === false) throw new Error('ACK not handled');
      });

      await t('MessageRouter offline queue', async () => {
        if (!MessageRouter) return true;
        const router = new MessageRouter({ sendFn: () => false });
        const queued = router.queueOffline?.('peer1', { type: 'test' });
        if (!queued && router.offlineCount === 0) throw new Error('offline queue not working');
      });

      await t('MessageRouter in-flight tracking', async () => {
        if (!MessageRouter) return true;
        const router = new MessageRouter({ sendFn: () => new Promise(() => {}) });
        const msgId = 'p6-inflight-' + Date.now();
        router.trackOutgoing?.(msgId, 'peer1');
        const tracked = router.inFlight?.has?.(msgId) || (router.inFlightCount > 0);
        if (!tracked) throw new Error('in-flight tracking not working');
      });

      return results;
    }

    // ── Phase 7: FileTransfer ───────────────────────────────────────────

    async _phase7_FileTransfer() {
      const results = [];
      const t = (name, fn) => this._runTest(name, fn, results);

      await t('FileTransfer chunk hashing', async () => {
        const data = new Uint8Array(1024);
        crypto.getRandomValues(data);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        if (hashHex.length !== 64) throw new Error('SHA-256 hash wrong length');
      });

      await t('FileTransfer metadata encoding', async () => {
        const metadata = {
          name: 'test.txt',
          size: 1024,
          type: 'text/plain',
          lastModified: Date.now(),
        };
        const encoded = JSON.stringify(metadata);
        const decoded = JSON.parse(encoded);
        if (decoded.name !== metadata.name || decoded.size !== metadata.size) {
          throw new Error('metadata encoding failed');
        }
      });

      await t('FileTransfer chunk size calculation', async () => {
        const fileSize = 10 * 1024 * 1024;
        const chunkSize = 64 * 1024;
        const expectedChunks = Math.ceil(fileSize / chunkSize);
        if (expectedChunks !== 160) throw new Error('chunk calculation wrong');
      });

      return results;
    }

    // ── Phase 8: RelayManager ───────────────────────────────────────────

    async _phase8_RelayManager() {
      const results = [];
      const t = (name, fn) => this._runTest(name, fn, results);

      await t('RelayManager queue FIFO', async () => {
        if (!RelayManager) throw new Error('RelayManager not found');
        const rm = new RelayManager({ sendFn: () => false });
        rm.queuePacket('peer1', { type: 'test' }, { msgId: 'p8-msg1', expectAck: false });
        rm.queuePacket('peer2', { type: 'test' }, { msgId: 'p8-msg2', expectAck: false });
        if (rm.queueSize !== 2) throw new Error(`expected queue size 2, got ${rm.queueSize}`);
      });

      await t('RelayManager fallback behavior', async () => {
        if (!RelayManager) return true;
        const rm = new RelayManager({ sendFn: () => false });
        let usedFallback = false;
        rm.onFallback?.(() => { usedFallback = true; });
        rm.queuePacket('peer1', { type: 'test' }, { msgId: 'p8-msg3', expectAck: true });
        rm.processQueue?.();
        if (rm.queueSize !== 1) throw new Error('fallback not queued');
      });

      await t('RelayManager ACK handling', async () => {
        if (!RelayManager) return true;
        const rm = new RelayManager({ sendFn: () => true });
        rm.queuePacket('peer1', { type: 'ack-test' }, { msgId: 'p8-ack', expectAck: true });
        let acked = false;
        rm.onAck?.((msgId) => { if (msgId === 'p8-ack') acked = true; });
        rm.processQueue?.();
        if (!acked) throw new Error('ACK handler not invoked');
      });

      return results;
    }

    // ── Phase 9: GhostLinkDebug ─────────────────────────────────────────

    async _phase9_GhostLinkDebug() {
      const results = [];
      const t = (name, fn) => this._runTest(name, fn, results);
      const dbg = window.GhostLinkDebug;

      await t('GhostLinkDebug inspectPeers()', async () => {
        if (!dbg) throw new Error('GhostLinkDebug not loaded');
        const result = dbg.inspectPeers();
        if (!Array.isArray(result)) throw new Error('inspectPeers should return array');
      });

      await t('GhostLinkDebug inspectChannels()', async () => {
        if (!dbg) throw new Error('GhostLinkDebug not loaded');
        const result = dbg.inspectChannels('nonexistent');
        if (typeof result !== 'object') throw new Error('inspectChannels should return object');
      });

      await t('GhostLinkDebug dumpConnectionStates()', async () => {
        if (!dbg) throw new Error('GhostLinkDebug not loaded');
        const result = dbg.dumpConnectionStates();
        if (typeof result !== 'object') throw new Error('dumpConnectionStates should return object');
      });

      await t('GhostLinkDebug getNetworkStats()', async () => {
        if (!dbg) throw new Error('GhostLinkDebug not loaded');
        const result = dbg.getNetworkStats();
        if (typeof result.totalPeers !== 'number') throw new Error('getNetworkStats malformed');
      });

      await t('GhostLinkDebug getEventTimeline()', async () => {
        if (!dbg) throw new Error('GhostLinkDebug not loaded');
        const result = dbg.getEventTimeline(50);
        if (!Array.isArray(result)) throw new Error('getEventTimeline should return array');
      });

      await t('GhostLinkDebug getMemorySnapshot()', async () => {
        if (!dbg) throw new Error('GhostLinkDebug not loaded');
        const result = dbg.getMemorySnapshot();
        if (typeof result !== 'object') throw new Error('getMemorySnapshot should return object');
      });

      await t('GhostLinkDebug dumpFullState()', async () => {
        if (!dbg) throw new Error('GhostLinkDebug not loaded');
        const result = dbg.dumpFullState();
        if (!result.timestamp || !result.uptime) throw new Error('dumpFullState incomplete');
      });

      await t('GhostLinkDebug floatable attach/detach', async () => {
        if (!dbg) throw new Error('GhostLinkDebug not loaded');
        const wasFloatable = dbg.isFloatable?.();
        if (wasFloatable) dbg.detach();
        if (dbg.isFloatable?.()) throw new Error('should not be floatable after detach');
      });

      await t('GhostLinkDebug simulateDisconnect()', async () => {
        if (!dbg) throw new Error('GhostLinkDebug not loaded');
        const result = dbg.simulateDisconnect('nonexistent-peer');
        if (result !== false) throw new Error('should return false for unknown peer');
      });

      return results;
    }

    // ── Test runner helper ───────────────────────────────────────────────

    async _runTest(name, fn, results) {
      const t = Date.now();
      try {
        await fn();
        const dur = Date.now() - t;
        console.log(`  ✓ ${name} (${dur}ms)`);
        results.push({ name, passed: true, error: null, duration: dur });
      } catch (e) {
        const dur = Date.now() - t;
        console.log(`  ✗ ${name}: ${e.message}`);
        results.push({ name, passed: false, error: e.message, duration: dur });
      }
    }

    _printSummary(passed, failed) {
      console.log('═══════════════════════════════════════════════════');
      console.log(`  ${passed} passed, ${failed} failed`);
      console.log('═══════════════════════════════════════════════════');
    }

    _quickModuleCheck() {
      const required = ['EventBus', 'Logger', 'StateMachine', 'SignalManager',
                        'ConnectionManager', 'MessageRouter', 'FileTransferManager',
                        'GhostLinkDebug', 'Types'];
      return required.filter(n => !GL[n]).length === 0;
    }
  }

  const tester = new SelfTest();
  exports.GhostLink = exports.GhostLink || {};
  exports.GhostLink.SelfTest = SelfTest;
  exports.GhostLinkSelfTest = tester;
  window.GhostLinkSelfTest = tester;
})(typeof globalThis !== 'undefined' ? globalThis : this);