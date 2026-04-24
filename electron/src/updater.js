/**
 * GhostLink Desktop — Auto-Update Module
 *
 * Uses electron-updater to check GitHub Releases for new versions,
 * download updates in the background, and prompt the user to restart.
 *
 * Update flow:
 *   1. On app launch, check for updates (silent)
 *   2. If update found, notify renderer via IPC
 *   3. Download in background with progress
 *   4. When ready, notify user — they choose when to restart
 *   5. On install-update IPC, quit and install
 */

const { autoUpdater } = require('electron-updater');
const { ipcMain } = require('electron');

let mainWindowRef = null;
let updateDownloaded = false;

/* ═══════════════════════════════════════════════════════════════
   CONFIGURATION
   ═══════════════════════════════════════════════════════════════ */

function configureUpdater() {
  // Don't auto-download — let us control the flow
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // Allow pre-release updates if the user is on a pre-release
  autoUpdater.allowPrerelease = false;

  // Use GitHub as update provider (reads from package.json repository field)
  // For custom servers, set: autoUpdater.setFeedURL({ provider: 'generic', url: '...' });

  // Logging
  autoUpdater.logger = {
    info: (msg) => console.log('[Updater]', msg),
    warn: (msg) => console.warn('[Updater]', msg),
    error: (msg) => console.error('[Updater]', msg),
  };
}

/* ═══════════════════════════════════════════════════════════════
   EVENT HANDLERS
   ═══════════════════════════════════════════════════════════════ */

function bindEvents() {
  /* ── Update available ───────────────────────────────────────── */
  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] Update available:', info.version);
    sendToRenderer('update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    });

    // Start downloading automatically
    autoUpdater.downloadUpdate().catch((err) => {
      console.error('[Updater] Download failed:', err.message);
      sendToRenderer('update-error', { message: err.message });
    });
  });

  /* ── No update ──────────────────────────────────────────────── */
  autoUpdater.on('update-not-available', (info) => {
    console.log('[Updater] Already on latest version:', info.version);
  });

  /* ── Download progress ──────────────────────────────────────── */
  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent);
    console.log(`[Updater] Downloading: ${pct}%`);
    sendToRenderer('update-progress', {
      percent: pct,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  /* ── Update downloaded (ready to install) ───────────────────── */
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Update downloaded:', info.version);
    updateDownloaded = true;
    sendToRenderer('update-downloaded', {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  /* ── Error handling ─────────────────────────────────────────── */
  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message);
    // Don't spam the user — only log errors silently
    // The renderer can listen for 'update-error' if it wants to show UI
    sendToRenderer('update-error', {
      message: err.message,
      stack: err.stack,
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════ */

function sendToRenderer(channel, data) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, data);
  }
}

/* ═══════════════════════════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════════════════════════ */

/**
 * Initialize the auto-updater. Call once after app.whenReady().
 *
 * @param {BrowserWindow} mainWindow - main app window for IPC
 */
function initUpdater(mainWindow) {
  mainWindowRef = mainWindow;

  configureUpdater();
  bindEvents();

  // Check for updates after a short delay (let the app settle)
  setTimeout(() => {
    checkForUpdates();
  }, 5000);

  // Re-check every 4 hours
  setInterval(() => {
    checkForUpdates();
  }, 4 * 60 * 60 * 1000);
}

/**
 * Manually trigger an update check.
 */
function checkForUpdates() {
  autoUpdater.checkForUpdates().catch((err) => {
    // Silently handle — no network, no release, etc.
    console.log('[Updater] Check failed (non-fatal):', err.message);
  });
}

/**
 * Quit the app and install the downloaded update.
 */
function quitAndInstall() {
  if (updateDownloaded) {
    autoUpdater.quitAndInstall(false, true);
  }
}

/* ─── Exports ───────────────────────────────────────────────── */

module.exports = {
  initUpdater,
  checkForUpdates,
  quitAndInstall,
};
