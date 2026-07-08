// GhostLink Mobile — GMP Node Bridge
// Manages the background nodejs-mobile runtime and WebSocket bridge connection.

let nodejs = null;
try {
  nodejs = require('nodejs-mobile-react-native');
} catch (e) {
  console.warn('[GMP Mobile Bridge] nodejs-mobile-react-native module not found');
}

export async function startMobileGMP(seedPhrase) {
  if (!nodejs) {
    throw new Error('nodejs-mobile not available');
  }

  // Start the background Node.js engine
  // This will run the entry point in nodejs-assets/nodejs-project/main.js
  nodejs.start('main.js');

  // Send the seed phrase to start the GMP Node
  nodejs.channel.post('start-gmp', {
    seedPhrase,
    port: 49500
  });

  console.log('[GMP Mobile Bridge] nodejs-mobile started');
}

export function isMobileGMPAvailable() {
  return nodejs !== null;
}
