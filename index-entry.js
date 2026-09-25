// index-entry.js — Entry point to bundle legacy GhostLink modules using esbuild.
// File transfer and the recovery-phrase wordlist are loaded lazily by index.html.

// Initialize the global namespace
globalThis.GhostLink = globalThis.GhostLink || {};

import './src/utils/capabilities.js';
import './src/utils/qr-invite.js';

// Core system
import './src/core/event-bus.js';
import './src/core/logger.js';
import './src/debug/debug-console.js';

// Notifications
import './src/notifications/notification-manager.js';
import './src/notifications/in-app-alerts.js';
import './src/notifications/sound-generator.js';

// Markdown
import './src/markdown/sanitize.js';
import './src/markdown/parser.js';

// License / Pro systems
import './src/license/license-core.js';
import './src/license/device-fingerprint.js';
import './src/license/license-validator.js';
import './src/license/license-manager.js';
import './src/license/feature-gate.js';
import './src/license/workspace-manager.js';
import './src/license/index.js';
import './src/license/workspace-components.js';
