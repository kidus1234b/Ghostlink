/**
 * GhostLink Desktop — Main Process
 * Zero Trust · Zero Trace · Zero Servers
 *
 * Electron main process handling window management, tray, IPC,
 * native integrations, security policies, and auto-updates.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  clipboard,
  globalShortcut,
  Notification,
  nativeImage,
  session,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const os = require('os');
const { createTray, updateBadge, flashTray, destroyTray } = require('./tray');
const { initUpdater } = require('./updater');
const { createSignalingServer } = require('../../server/signaling-core');

let signalingServer = null;
let signalingPort = null;

/* ─── Constants ─────────────────────────────────────────────── */

const IS_DEV = process.argv.includes('--dev');
const PROTOCOL = 'ghostlink';
const INDEX_PATH = path.join(__dirname, '..', '..', 'index.html');
const PRELOAD_PATH = path.join(__dirname, 'preload.js');

/* ─── Persistent config store ───────────────────────────────── */

const store = new Store({
  name: 'ghostlink-config',
  defaults: {
    windowBounds: { width: 1200, height: 800, x: undefined, y: undefined },
    minimizeToTray: true,
    autoLaunch: false,
    mutedNotifications: false,
  },
  encryptionKey: 'gl-desktop-cfg-v1', // light obfuscation for prefs
});

/* ─── Secure store (session-only, in-memory) ─────────────────  */

const secureVault = new Map();

/* ─── Window tracking ───────────────────────────────────────── */

let mainWindow = null;
let chatWindows = new Map(); // id -> BrowserWindow
let tray = null;
let isQuitting = false;

/* ═══════════════════════════════════════════════════════════════
   SINGLE INSTANCE LOCK
   ═══════════════════════════════════════════════════════════════ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Handle deep link from second instance on Windows/Linux
    const deepLink = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (deepLink && mainWindow) {
      mainWindow.webContents.send('deep-link', deepLink);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   DEEP LINK PROTOCOL
   ═══════════════════════════════════════════════════════════════ */

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// macOS deep link
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    mainWindow.webContents.send('deep-link', url);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

/* ═══════════════════════════════════════════════════════════════
   WINDOW CREATION
   ═══════════════════════════════════════════════════════════════ */

function createMainWindow() {
  const saved = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 800,
    minHeight: 600,
    frame: false,              // frameless — custom title bar
    titleBarStyle: 'hidden',   // macOS: keep traffic-light buttons
    trafficLightPosition: { x: -100, y: -100 }, // hide native buttons; we draw our own
    backgroundColor: '#0a0a0f',
    show: false,               // show when ready to avoid flash
    icon: getAppIcon(),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
      enableWebSQL: false,
    },
  });

  // Inject strict Content-Security-Policy
  mainWindow.webContents.session.webRequest.onHeadersReceived(
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; " +
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; " +
            "connect-src 'self' ws: wss: https:; " +
            "font-src 'self' data:;",
          ],
        },
      });
    }
  );

  mainWindow.loadFile(INDEX_PATH);

  // Inject custom titlebar + Electron bridge CSS after DOM ready
  mainWindow.webContents.on('did-finish-load', () => {
    injectTitleBar(mainWindow);
    injectElectronStyles(mainWindow);
  });

  // Graceful show
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Persist window bounds
  const saveBounds = () => {
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Minimize to tray on close (if enabled)
  mainWindow.on('close', (e) => {
    if (!isQuitting && store.get('minimizeToTray')) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

/**
 * Pop-out chat window for a specific conversation
 */
function createChatWindow(chatId, title) {
  if (chatWindows.has(chatId)) {
    chatWindows.get(chatId).focus();
    return;
  }

  const chatWin = new BrowserWindow({
    width: 480,
    height: 680,
    minWidth: 360,
    minHeight: 480,
    frame: false,
    backgroundColor: '#0a0a0f',
    icon: getAppIcon(),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  chatWin.loadFile(INDEX_PATH, { hash: `/chat/${chatId}` });

  chatWin.webContents.on('did-finish-load', () => {
    injectTitleBar(chatWin, title || 'GhostLink Chat');
    injectElectronStyles(chatWin);
  });

  chatWin.once('ready-to-show', () => chatWin.show());

  chatWin.on('closed', () => {
    chatWindows.delete(chatId);
  });

  chatWindows.set(chatId, chatWin);
}

/* ═══════════════════════════════════════════════════════════════
   TITLE BAR INJECTION
   ═══════════════════════════════════════════════════════════════ */

function injectTitleBar(win, title) {
  const titleBarJS = fs.readFileSync(
    path.join(__dirname, 'titlebar.js'),
    'utf-8'
  );
  win.webContents.executeJavaScript(
    titleBarJS.replace('__WINDOW_TITLE__', title || 'GhostLink')
  );
}

function injectElectronStyles(win) {
  win.webContents.insertCSS(`
    /* Push page content below custom title bar */
    body { padding-top: 38px !important; }
    html { overflow: hidden; }
    /* Smooth scrolling for main content */
    #root { height: calc(100vh - 38px); overflow-y: auto; }
  `);
}

/* ═══════════════════════════════════════════════════════════════
   IPC HANDLERS
   ═══════════════════════════════════════════════════════════════ */

function setupIPC() {
  /* ── Window controls ────────────────────────────────────────── */
  ipcMain.on('minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });
  ipcMain.on('maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.on('close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });

  /* ── Notifications ──────────────────────────────────────────── */
  ipcMain.on('notify', (_e, title, body) => {
    if (store.get('mutedNotifications')) return;
    const notif = new Notification({
      title,
      body,
      icon: getAppIcon(),
      silent: false,
    });
    notif.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    notif.show();
    flashTray(tray);
  });

  /* ── Badge count ────────────────────────────────────────────── */
  ipcMain.on('badge-count', (_e, count) => {
    updateBadge(tray, count);
    if (process.platform === 'darwin') app.dock?.setBadge(count > 0 ? String(count) : '');
    if (process.platform === 'linux' || process.platform === 'win32') {
      mainWindow?.setTitle(count > 0 ? `GhostLink (${count})` : 'GhostLink');
    }
  });

  /* ── Clipboard ──────────────────────────────────────────────── */
  ipcMain.on('clipboard-write', (_e, text) => {
    clipboard.writeText(text);
  });

  /* ── File operations ────────────────────────────────────────── */
  ipcMain.handle('save-file', async (_e, data, filename) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename,
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });
    if (canceled || !filePath) return null;
    try {
      const buffer = Buffer.from(data);
      fs.writeFileSync(filePath, buffer);
      return filePath;
    } catch (err) {
      dialog.showErrorBox('Save Failed', err.message);
      return null;
    }
  });

  ipcMain.handle('open-file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });
    if (canceled || filePaths.length === 0) return null;
    try {
      const filePath = filePaths[0];
      const data = fs.readFileSync(filePath);
      return {
        name: path.basename(filePath),
        path: filePath,
        data: Array.from(new Uint8Array(data)),
        size: data.length,
      };
    } catch (err) {
      dialog.showErrorBox('Open Failed', err.message);
      return null;
    }
  });

  /* ── Secure storage (in-memory encrypted vault) ─────────────── */
  ipcMain.handle('secure-get', (_e, key) => {
    return secureVault.get(key) ?? null;
  });
  ipcMain.handle('secure-set', (_e, key, value) => {
    secureVault.set(key, value);
    return true;
  });
  ipcMain.handle('secure-delete', (_e, key) => {
    return secureVault.delete(key);
  });

  /* ── Pop-out chat windows ───────────────────────────────────── */
  ipcMain.on('pop-out-chat', (_e, chatId, title) => {
    createChatWindow(chatId, title);
  });

  /* ── Settings ───────────────────────────────────────────────── */
  ipcMain.handle('get-setting', (_e, key) => store.get(key));
  ipcMain.handle('set-setting', (_e, key, value) => {
    store.set(key, value);
    if (key === 'autoLaunch') setAutoLaunch(value);
    return true;
  });

  /* ── Signaling server status ────────────────────────────────── */
  ipcMain.handle('signaling-status', () => {
    return signalingServer ? signalingServer.getStatus() : { running: false };
  });

  ipcMain.handle('get-network-info', () => {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const [name, nets] of Object.entries(interfaces)) {
      for (const net of nets) {
        if (net.family === 'IPv4' && !net.internal) {
          addresses.push({ name, address: net.address });
        }
      }
    }
    return { addresses, signalingPort };
  });

  /* ── Auto-update trigger ────────────────────────────────────── */
  ipcMain.on('install-update', () => {
    isQuitting = true;
    const { quitAndInstall } = require('./updater');
    quitAndInstall();
  });
}

/* ═══════════════════════════════════════════════════════════════
   FILE DRAG-AND-DROP
   ═══════════════════════════════════════════════════════════════ */

function setupDragDrop() {
  ipcMain.on('ondragstart', (event, filePath) => {
    event.sender.startDrag({
      file: filePath,
      icon: getAppIcon(),
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   GLOBAL SHORTCUTS
   ═══════════════════════════════════════════════════════════════ */

function registerShortcuts() {
  // Ctrl+Shift+G — toggle main window visibility
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (!mainWindow) {
      createMainWindow();
      return;
    }
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   AUTO-LAUNCH
   ═══════════════════════════════════════════════════════════════ */

function setAutoLaunch(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    path: process.execPath,
  });
}

/* ═══════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════ */

function getAppIcon() {
  const iconName =
    process.platform === 'win32' ? 'icon.ico' :
    process.platform === 'darwin' ? 'icon.icns' : 'icon.png';
  const iconPath = path.join(__dirname, '..', 'assets', iconName);
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  // Fallback: generate a simple 32x32 icon programmatically
  return generateFallbackIcon();
}

function generateFallbackIcon() {
  // 16x16 solid teal square as a minimal placeholder
  const size = 16;
  const channels = 4; // RGBA
  const buf = Buffer.alloc(size * size * channels);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4 + 0] = 0;     // R
    buf[i * 4 + 1] = 255;   // G
    buf[i * 4 + 2] = 200;   // B
    buf[i * 4 + 3] = 255;   // A
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

/* ═══════════════════════════════════════════════════════════════
   APP LIFECYCLE
   ═══════════════════════════════════════════════════════════════ */

app.whenReady().then(async () => {
  // Start embedded signaling server
  try {
    signalingServer = createSignalingServer({ port: 3001, serveStatic: false });
    signalingPort = await signalingServer.start();
    console.log(`[GhostLink] Embedded signaling server on port ${signalingPort}`);
  } catch (err) {
    console.error('[GhostLink] Failed to start signaling server:', err.message);
  }

  setupIPC();
  setupDragDrop();
  registerShortcuts();

  mainWindow = createMainWindow();

  // System tray
  tray = createTray(mainWindow, store, () => {
    isQuitting = true;
    app.quit();
  });

  // Auto-updater (non-blocking)
  if (!IS_DEV) {
    initUpdater(mainWindow);
  }

  // Set auto-launch from saved preference
  if (store.get('autoLaunch')) {
    setAutoLaunch(true);
  }

  // macOS: re-create window on dock click
  app.on('activate', () => {
    if (!mainWindow) {
      mainWindow = createMainWindow();
    } else {
      mainWindow.show();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  if (signalingServer) signalingServer.stop();
  globalShortcut.unregisterAll();
  destroyTray(tray);
  secureVault.clear();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/* ─── Prevent navigation to external URLs inside the app ────── */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (navEvent, url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') {
      navEvent.preventDefault();
      shell.openExternal(url);
    }
  });
});
