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
const Store = require('electron-store');
const os = require('os');
const net = require('net');
const { createTray, updateBadge, flashTray, destroyTray } = require('./tray');
const { initUpdater } = require('./updater');
// We no longer start the old signaling server.
let gmpManager = null;
let gmpBridge = null;

async function startGMPNode(seedPhrase) {
  if (gmpManager) return;
  const { GMPNodeManager } = await import('../../gmp-core/dist/gmp-node-manager.js');
  const { startBridge } = await import('../../gmp-core/dist/gmp-bridge.js');

  gmpManager = new GMPNodeManager({ seedPhrase, port: 49500 });
  gmpBridge = startBridge(gmpManager, 3002);
  await gmpManager.start();
  console.log('[Electron GMP] Node Manager started on port 49500, Bridge on 3002');
}

function stopGMPNode() {
  if (gmpBridge && gmpBridge.wss) {
    try { gmpBridge.wss.close(); } catch(e){}
  }
  if (gmpManager) {
    try { gmpManager.stop(); } catch(e){}
  }
  gmpManager = null;
  gmpBridge = null;
}

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

/* ─── Secure store (session-only, in-memory) ─────────────────  */

const secureVault = new Map();

/* ─── Ghost Mesh TCP bridge state ───────────────────────────── */
// These were referenced by every ghostmesh-* IPC handler but never declared,
// so the first `if (ghostMeshServer)` threw a ReferenceError and the whole
// Ghost Mesh transport was dead on arrival.
const GHOSTMESH_PORT = 49500;
let ghostMeshServer = null;
const activeMeshSockets = new Map(); // connId -> net.Socket

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
  // The title reaches here from the renderer (pop-out-chat) and is derived
  // from a conversation name, which a peer controls. Substituting it into the
  // placeholder raw spliced that string into JavaScript source — a name
  // containing a quote and a semicolon ran as code in the page, where the
  // preload bridge lives. JSON.stringify emits a string literal instead, so
  // the value can only ever be data.
  const literal = JSON.stringify(String(title || 'GhostLink'));
  win.webContents.executeJavaScript(
    titleBarJS.replace("'__WINDOW_TITLE__'", literal)
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
 * URL and allow only http/https.
 */
function openExternalIfSafe(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_e) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.warn('[GhostLink] Blocked external open for scheme:', parsed.protocol);
    return false;
  }
  shell.openExternal(parsed.toString());
  return true;
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

  /* ── GMP Node/Bridge IPC Handlers ───────────────────────────── */
  ipcMain.handle('gmp-get-seed', () => getStoredSeed());
  ipcMain.handle('gmp-set-seed', (_e, seed) => {
    try {
      return setStoredSeed(seed);
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle('gmp-start', async (_e, seed) => {
    try {
      setStoredSeed(seed);
    } catch (err) {
      return { error: err.message };
    }
    await startGMPNode(seed);
    return true;
  });
  ipcMain.handle('gmp-status', () => {
    if (!gmpManager) return { started: false };
    return { started: true, nodeId: gmpManager.node?.identity?.nodeIdHex };
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
    // `signalingPort` used to be referenced here but was never declared, so
    // this handler threw. The signaling server is gone; the mesh port is the
    // port callers actually want.
    return { addresses, meshPort: GHOSTMESH_PORT };
  });

  /* ── Auto-update trigger ────────────────────────────────────── */
  ipcMain.on('install-update', () => {
    isQuitting = true;
    const { quitAndInstall } = require('./updater');
    quitAndInstall();
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
          
          let buffer = '';
          socket.on('data', (data) => {
            buffer += data.toString('utf8');
            let boundary = buffer.indexOf('\n');
            while (boundary !== -1) {
              const line = buffer.slice(0, boundary).trim();
              buffer = buffer.slice(boundary + 1);
              if (line) {
                mainWindow?.webContents.send('ghostmesh-data', { connId, data: line });
              }
              boundary = buffer.indexOf('\n');
            }
          });
          
          socket.on('close', () => {
            activeMeshSockets.delete(connId);
            mainWindow?.webContents.send('ghostmesh-peer-disconnected', { connId });
          });
          
          socket.on('error', (err) => {
            console.warn('[GhostMesh Server Socket Error]', err.message);
          });
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
      for (const [connId, socket] of activeMeshSockets.entries()) {
        try { socket.end(); } catch (e) {}
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
          
          let buffer = '';
          socket.on('data', (data) => {
            buffer += data.toString('utf8');
            let boundary = buffer.indexOf('\n');
            while (boundary !== -1) {
              const line = buffer.slice(0, boundary).trim();
              buffer = buffer.slice(boundary + 1);
              if (line) {
                mainWindow?.webContents.send('ghostmesh-data', { connId, data: line });
              }
              boundary = buffer.indexOf('\n');
            }
          });
          
          socket.on('close', () => {
            activeMeshSockets.delete(connId);
            mainWindow?.webContents.send('ghostmesh-peer-disconnected', { connId });
          });
          
          socket.on('error', (err) => {
            console.warn('[GhostMesh Dial Socket Error]', err.message);
          });
          
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
  stopGMPNode();
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
