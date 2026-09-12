// index-entry.js — Entry point to bundle legacy GhostLink modules using esbuild.
// Excludes voice, media-handling, and file-transfer modules for dynamic lazy loading.

// Initialize the global namespace
globalThis.GhostLink = globalThis.GhostLink || {};

// Signal protocol & WebRTC
import './src/crypto/signal-protocol.js';
import './src/p2p/webrtc-manager.js';
import './src/utils/qr-invite.js';
import './src/p2p/p2p-connector.js';

// Core system
import './src/core/event-bus.js';
import './src/core/logger.js';
import './src/core/state-machine.js';
import './src/core/retry-queue.js';
import './src/core/types.js';
import './src/core/signal-bus.js';
import './src/crypto/key-manager.js';
import './src/network/connection-manager.js';
import './src/network/peer-manager.js';
import './src/message/message-router.js';
import './src/presence/presence-manager.js';
import './src/security/security-manager.js';
import './src/debug/debug-console.js';
import './src/debug/self-test.js';

// Notifications
import './src/notifications/notification-manager.js';
import './src/notifications/in-app-alerts.js';
import './src/notifications/sound-generator.js';

// Markdown
import './src/markdown/sanitize.js';
import './src/markdown/parser.js';
import './src/markdown/input-toolbar.js';

// License / Pro systems
import './src/license/license-core.js';
import './src/license/device-fingerprint.js';
import './src/license/license-validator.js';
import './src/license/license-manager.js';
import './src/license/feature-gate.js';
import './src/license/workspace-manager.js';
import './src/license/data-export.js';
import './src/license/pro-themes.js';
import './src/license/security-hardening.js';
import './src/license/dev-console.js';
import './src/license/license-activation-ui.js';
import './src/license/index.js';
import './src/license/workspace-components.js';
