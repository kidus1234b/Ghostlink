const rn_bridge = require('rn-bridge');
const path = require('path');

// Listen for start event from React Native
rn_bridge.channel.on('start-gmp', (msg) => {
  const { seedPhrase, port } = msg;
  console.log('[GMP Background] Starting node manager with seed phrase...');
  
  try {
    // Dynamically load and run the gmp-bridge using the relative path to gmp-core
    // In React Native structure, the root project directory is parent of mobile/
    const gmpBridgePath = path.resolve(__dirname, '../../../../gmp-core/gmp-bridge.js');
    
    // Since gmp-bridge is an ES module, we load it dynamically
    import(gmpBridgePath).then(({ startBridge }) => {
      const { GMPNodeManager } = require(path.resolve(__dirname, '../../../../gmp-core/gmp-node-manager.js'));
      const manager = new GMPNodeManager({ seedPhrase, port });
      startBridge(manager, 3002);
      manager.start().then(() => {
        rn_bridge.channel.post('gmp-status', { status: 'started' });
      }).catch(err => {
        rn_bridge.channel.post('gmp-status', { status: 'error', message: err.message });
      });
    }).catch(err => {
      console.error('[GMP Background] Failed to load bridge:', err.message);
    });
  } catch (err) {
    console.error('[GMP Background] Error in start handler:', err.message);
  }
});
