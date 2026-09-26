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
  safeStorage,
  session,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const Store = require('electron-store');
const net = require('net');
const { createTray, updateBadge, flashTray, destroyTray } = require('./tray');
const { initUpdater, updateReady, quitAndInstall } = require('./updater');
let gmpManager = null;
let gmpBridge = null;
let gmpStarting = null;

/**
 * Start the node and its loopback bridge once. startBridge is async and
 * resolves to { wss } only after the listener is bound; it used to be stored
 * unawaited, so gmpBridge was a Promise, `gmpBridge.wss` was always undefined
 * and stopGMPNode never closed the bridge, and a bind failure surfaced as an
 * unhandled rejection. gmpManager was also set before start() succeeded, so a
 * failed start left a dead manager that made every later gmp-start a silent
 * no-op. Concurrent callers now share one attempt, and a failure is cleaned
 * up so the next call can retry.
 */
function startGMPNode(seedPhrase) {
  if (!gmpStarting) {
    gmpStarting = (async () => {
      // gmp-core keeps peer cache / nonce state under its package data dir,
      // which is read-only inside an installed app. Redirect mutable state to
      // the per-user data dir unless the environment already picked a spot.
      if (app.isPackaged && !process.env.GMP_DATA_DIR) {
        process.env.GMP_DATA_DIR = path.join(app.getPath('userData'), 'gmp-data');
        fs.mkdirSync(process.env.GMP_DATA_DIR, { recursive: true });
      }
      // A raw absolute path breaks dynamic import() on Windows
      // (ERR_UNSUPPORTED_ESM_URL_SCHEME) — ESM needs a file:// URL.
      const { GMPNodeManager } = await import(pathToFileURL(path.join(GMP_CORE_DIR, 'dist', 'gmp-node-manager.js')).href);
      const { startBridge } = await import(pathToFileURL(path.join(GMP_CORE_DIR, 'dist', 'gmp-bridge.js')).href);

      gmpManager = new GMPNodeManager({ seedPhrase });
      gmpBridge = await startBridge(gmpManager, 3002);
      const { port } = await gmpManager.start();
      console.log(`[Electron GMP] Node Manager started on port ${port}, Bridge on 3002`);
    })().catch((err) => {
      stopGMPNode();
      throw err;
    });
  }
  return gmpStarting;
}

function stopGMPNode() {
  if (gmpBridge && gmpBridge.wss) {
    try { gmpBridge.wss.close(); } catch(e){}
  }
  if (gmpManager) {
    // stop() is async: a try/catch alone never sees its rejection.
    gmpManager.stop().catch(() => {});
  }
  gmpManager = null;
  gmpBridge = null;
  gmpStarting = null;
}

/* ─── Constants ─────────────────────────────────────────────── */

const IS_DEV = process.argv.includes('--dev');
const PROTOCOL = 'ghostlink';

/**
 * Locate a repo-root resource that the packaged app needs.
 *
 * Development and `electron-builder --dir` runs load straight from the
 * checkout (electron/src -> repo root). Installed builds instead ship these
 * files via electron-builder's extraResources, which lands them under
 * process.resourcesPath (resources/ inside the install directory): the web
 * payload under resources/webapp/ and the mesh core under resources/gmp-core/.
 * The checkout path is tried first so the repo layout keeps working unchanged.
 */
function resolveResource(checkoutRelative, packagedRelative) {
  const checkoutPath = path.join(__dirname, '..', '..', checkoutRelative);
  if (fs.existsSync(checkoutPath)) return checkoutPath;
  return path.join(process.resourcesPath, packagedRelative);
}

const INDEX_PATH = resolveResource('index.html', path.join('webapp', 'index.html'));
const GMP_CORE_DIR = resolveResource('gmp-core', 'gmp-core');
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
  // electron-store's encryptionKey is obfuscation, not encryption: the key is
  // a constant compiled into the app, so anyone with the binary can read the
  // file. That is acceptable for window bounds and a tray preference, which is
  // all this store now holds — the recovery seed moved to safeStorage below.
  encryptionKey: 'gl-desktop-cfg-v1', // light obfuscation for prefs
});

/* ─── Recovery seed at rest ─────────────────────────────────── */

/**
 * The GMP seed phrase is the master identity: every key the node uses derives
 * from it, and it is the whole of account recovery. It used to sit in the
 * config store above under that constant key, which meant it was recoverable
 * from the config file by anyone who could read it — no user secret involved.
 *
 * safeStorage backs onto the OS keychain (Keychain on macOS, DPAPI on Windows,
 * libsecret/kwallet on Linux), so the ciphertext is bound to the logged-in
 * user. If the platform cannot provide that, storing the phrase in the clear
 * is not an acceptable substitute — refuse, and let the caller surface it.
 */
const SEED_STORE_KEY = 'gmp_seed_phrase_enc';
const LEGACY_SEED_STORE_KEY = 'gmp_seed_phrase';

function seedStorageAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_e) {
    return false;
  }
}

function setStoredSeed(seed) {
  if (typeof seed !== 'string' || !seed.trim()) {
    throw new Error('Refusing to store an empty seed phrase.');
  }
  if (!seedStorageAvailable()) {
    throw new Error(
      'OS secure storage is unavailable, so the recovery phrase cannot be ' +
      'stored safely. On Linux this usually means no keyring (gnome-keyring ' +
      'or kwallet) is running.'
    );
  }
  store.set(SEED_STORE_KEY, safeStorage.encryptString(seed).toString('base64'));
  // Clear any copy left by an older build that wrote it in the clear.
  store.delete(LEGACY_SEED_STORE_KEY);
  return true;
}

function getStoredSeed() {
  const sealed = store.get(SEED_STORE_KEY);
  if (sealed) {
    if (!seedStorageAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'));
    } catch (err) {
      console.error('[Electron GMP] Stored seed could not be decrypted:', err.message);
      return null;
    }
  }

  // One-time migration off the plaintext key written by older builds.
  const legacy = store.get(LEGACY_SEED_STORE_KEY);
  if (!legacy) return null;
  try {
    setStoredSeed(legacy);
    console.log('[Electron GMP] Migrated recovery phrase into OS secure storage.');
  } catch (err) {
    console.warn('[Electron GMP] Could not migrate seed to secure storage:', err.message);
  }
  return legacy;
}

/* ─── Ghost Mesh TCP bridge state ───────────────────────────── */
// These were referenced by every ghostmesh-* IPC handler but never declared,
// so the first `if (ghostMeshServer)` threw a ReferenceError and the whole
// Ghost Mesh transport was dead on arrival.
// Must differ from the GMP node's port (config.GMP_PORT, default 49500): both
// run in this process and bind [::], so sharing a port made whichever started
// second fail with EADDRINUSE. The renderer dials without a port and gets this.
const GHOSTMESH_PORT = 49600;
let ghostMeshServer = null;
const activeMeshSockets = new Map(); // connId -> net.Socket

/* ─── Window tracking ───────────────────────────────────────── */

let mainWindow = null;
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
          // The app is a local file:// bundle with no remote code. The policy
          // said otherwise: script-src allowed https://unpkg.com, so anything
          // that host served (or anyone who could answer for it) ran with full
          // access to the preload bridge, and 'unsafe-eval' let injected
          // markup reach a JS compiler. Neither is used — index.html vendors
          // its dependencies locally and pins an import map for that reason.
          'Content-Security-Policy': [
            "default-src 'self' blob: data:; " +
            "script-src 'self' 'unsafe-inline'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; " +
            "media-src 'self' blob: data:; " +
            // Loopback only: the GMP bridge (ws 3002), the signaling socket
            // (ws 3001) and the relay-queue fetch that offline-queue.js derives
            // from that same origin. WebRTC/STUN is negotiated by the ICE
            // agent and is not governed by connect-src.
            "connect-src 'self' " +
            "http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:* " +
            "ws://127.0.0.1:* ws://localhost:* wss://127.0.0.1:* wss://localhost:*; " +
            "font-src 'self' data:; " +
            "object-src 'none'; " +
            "base-uri 'none'; " +
            "frame-src 'none'; " +
            "form-action 'none';",
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
    openExternalIfSafe(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

/* ═══════════════════════════════════════════════════════════════
   TITLE BAR INJECTION
   ═══════════════════════════════════════════════════════════════ */

function injectTitleBar(win) {
  const titleBarJS = fs.readFileSync(
    path.join(__dirname, 'titlebar.js'),
    'utf-8'
  );
  win.webContents
    .executeJavaScript(titleBarJS.replace("'__WINDOW_TITLE__'", JSON.stringify('GhostLink')))
    .catch((err) => console.error('[GhostLink] Title bar injection failed:', err.message));
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
   EXTERNAL LINK SAFETY
   ═══════════════════════════════════════════════════════════════ */

/**
 * Hand a URL to the OS only if it is plain web traffic.
 *
 * shell.openExternal asks the desktop to launch whatever handler is registered
 * for the scheme. The navigation hook used to pass it every non-file: URL and
 * the window-open hook used a `startsWith('http')` test that also matched
 * `httpsomething:` — so a link in a message could reach the handler for
 * smb:, ms-msdt:, vscode:, or any other locally registered protocol. Parse the
 * URL and allow only http/https, plus mailto: — the license request flow and
 * the "Contact for pricing" link navigate to mailto:, and blocking it left
 * both dead in the desktop app. A mail client only opens a compose window.
 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function openExternalIfSafe(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_e) {
    return false;
  }
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    console.warn('[GhostLink] Blocked external open for scheme:', parsed.protocol);
    return false;
  }
  shell.openExternal(parsed.toString());
  return true;
}

/* ═══════════════════════════════════════════════════════════════
   GHOST MESH SOCKETS
   ═══════════════════════════════════════════════════════════════ */

// One newline-delimited frame. The reader used to append every chunk to a
// string until it saw '\n', with no limit, so anyone who could reach the
// mesh port (it listens on [::], every interface) could stream bytes without
// a newline and grow the main process's heap until it died.
const MAX_MESH_LINE_CHARS = 1024 * 1024;

function wireMeshSocket(socket, connId, label) {
  // setEncoding keeps a multi-byte character that straddles two TCP chunks
  // intact; decoding each chunk on its own turned it into U+FFFD.
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (data) => {
    buffer += data;
    let boundary = buffer.indexOf('\n');
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (line) {
        mainWindow?.webContents.send('ghostmesh-data', { connId, data: line });
      }
      boundary = buffer.indexOf('\n');
    }
    if (buffer.length > MAX_MESH_LINE_CHARS) {
      console.warn(`[GhostMesh ${label}] Dropping ${connId}: frame exceeds ${MAX_MESH_LINE_CHARS} chars`);
      socket.destroy();
    }
  });

  socket.on('close', () => {
    activeMeshSockets.delete(connId);
    mainWindow?.webContents.send('ghostmesh-peer-disconnected', { connId });
  });

  socket.on('error', (err) => {
    console.warn(`[GhostMesh ${label} Socket Error]`, err.message);
  });
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

  /* ── GMP Node/Bridge IPC Handlers ───────────────────────────── */
  ipcMain.handle('gmp-start', async (_e, seed) => {
    try {
      setStoredSeed(seed);
    } catch (err) {
      return { error: err.message };
    }
    await startGMPNode(seed);
    return true;
  });

  /* ── Auto-update trigger ────────────────────────────────────── */
  ipcMain.on('install-update', () => {
    // Only flag the quit when an update is actually installed; otherwise a
    // stray call left isQuitting set and the window stopped hiding to tray.
    if (updateReady()) {
      isQuitting = true;
      quitAndInstall();
    }
  });

  /* ── Ghost Mesh (Yggdrasil TCP Socket Bridge) ───────────────── */
  ipcMain.handle('ghostmesh-start-server', async () => {
    if (ghostMeshServer) {
      return { success: true, message: 'Server already running' };
    }
    
    return new Promise((resolve) => {
      try {
        ghostMeshServer = net.createServer((socket) => {
          const connId = `mesh-${Math.random().toString(36).slice(2, 10)}`;
          activeMeshSockets.set(connId, socket);
          
          mainWindow?.webContents.send('ghostmesh-peer-connected', {
            connId,
            remoteAddress: socket.remoteAddress,
            type: 'incoming'
          });
          
          wireMeshSocket(socket, connId, 'Server');
        });
        
        ghostMeshServer.on('error', (err) => {
          console.error('[GhostMesh Server Error]', err.message);
          resolve({ success: false, error: err.message });
        });
        
        ghostMeshServer.listen({ host: '::', port: GHOSTMESH_PORT }, () => {
          console.log(`[GhostMesh] Server listening on [::]:${GHOSTMESH_PORT}`);
          resolve({ success: true });
        });
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  });

  ipcMain.handle('ghostmesh-stop-server', async () => {
    if (!ghostMeshServer) {
      return { success: true };
    }
    return new Promise((resolve) => {
      // destroy, not end: server.close() only calls back once every
      // connection is fully closed, and end() is a half-close that a peer
      // which never sends its own FIN keeps open forever — the promise then
      // never settled and ghostMeshServer stayed set, so the server could not
      // be restarted.
      for (const [connId, socket] of activeMeshSockets.entries()) {
        try { socket.destroy(); } catch (e) {}
        activeMeshSockets.delete(connId);
      }
      ghostMeshServer.close(() => {
        ghostMeshServer = null;
        console.log('[GhostMesh] Server stopped');
        resolve({ success: true });
      });
    });
  });

  ipcMain.handle('ghostmesh-dial', async (_e, { host, port = GHOSTMESH_PORT }) => {
    return new Promise((resolve) => {
      try {
        console.log(`[GhostMesh] Dialing ${host}:${port}...`);
        const socket = net.connect({ host, port }, () => {
          const connId = `mesh-${Math.random().toString(36).slice(2, 10)}`;
          activeMeshSockets.set(connId, socket);
          
          wireMeshSocket(socket, connId, 'Dial');
          resolve({ success: true, connId });
        });
        
        socket.on('error', (err) => {
          console.error('[GhostMesh Dial Error]', err.message);
          resolve({ success: false, error: err.message });
        });
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  });

  ipcMain.handle('ghostmesh-send', async (_e, { connId, data }) => {
    const socket = activeMeshSockets.get(connId);
    if (socket) {
      try {
        socket.write(data + '\n');
        return true;
      } catch (err) {
        console.error('[GhostMesh Send Error]', err.message);
        return false;
      }
    }
    return false;
  });

  ipcMain.handle('ghostmesh-close', async (_e, { connId }) => {
    const socket = activeMeshSockets.get(connId);
    if (socket) {
      try {
        socket.end();
        activeMeshSockets.delete(connId);
        return true;
      } catch (err) {
        return false;
      }
    }
    return false;
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
  // Auto-start GMP node on app launch if seed exists
  const savedSeed = getStoredSeed();
  if (savedSeed) {
    try {
      await startGMPNode(savedSeed);
    } catch (err) {
      console.error('[Electron GMP] Failed to auto-start GMP Node:', err.message);
    }
  }

  // Calls need the microphone and camera; nothing here needs geolocation, USB,
  // MIDI, or the rest. Electron grants every permission by default, so a page
  // flaw would otherwise be enough to turn on the mic. Deny by default.
  const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  );

  setupIPC();
  registerShortcuts();

  mainWindow = createMainWindow();

  // System tray
  tray = createTray(() => mainWindow, store, () => {
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
  stopGMPNode();
  globalShortcut.unregisterAll();
  destroyTray(tray);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/* ─── Prevent navigation to external URLs inside the app ────── */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (navEvent, url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_e) {
      navEvent.preventDefault();
      return;
    }
    if (parsed.protocol !== 'file:') {
      navEvent.preventDefault();
      openExternalIfSafe(url);
    }
  });

  // Nothing in this app embeds a webview, and an attached one would not
  // inherit the window's webPreferences hardening.
  contents.on('will-attach-webview', (attachEvent) => {
    attachEvent.preventDefault();
  });
});
