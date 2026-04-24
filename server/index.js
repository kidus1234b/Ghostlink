'use strict';

const path = require('path');
const { createSignalingServer } = require('./signaling-core');

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3001', 10);

// ─── Create & Start ──────────────────────────────────────────────────────────

const server = createSignalingServer({
  port: PORT,
  serveStatic: true,
  webRoot: path.join(__dirname, '..'),
});

server.start().then((actualPort) => {
  console.log(`\n  GhostLink Server Ready:`);
  console.log(`  Web App:    http://localhost:${actualPort}`);
  console.log(`  Signaling:  ws://localhost:${actualPort}`);
  console.log(`  Health:     http://localhost:${actualPort}/health\n`);
}).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  server.stop().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
