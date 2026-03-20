/**
 * GhostLink Desktop — Preload Script
 *
 * Bridges the renderer (web app) with native Electron APIs
 * through a secure, sandboxed contextBridge interface.
 *
 * Everything exposed here is available as window.ghostlink.*
 */

const { contextBridge, ipcRenderer } = require('electron');

/* ─── Allowed IPC channels (whitelist) ──────────────────────── */

const SEND_CHANNELS = [
  'minimize',
  'maximize',
  'close',
  'notify',
  'badge-count',
  'clipboard-write',
  'install-update',
  'pop-out-chat',
  'ondragstart',
];

const INVOKE_CHANNELS = [
  'save-file',
  'open-file',
  'secure-get',
  'secure-set',
  'secure-delete',
  'get-setting',
  'set-setting',
];

const RECEIVE_CHANNELS = [
  'deep-link',
  'update-available',
  'update-downloaded',
  'update-error',
  'tray-action',
];

/* ─── Secure send helper (validates channel) ────────────────── */

function secureSend(channel, ...args) {
  if (SEND_CHANNELS.includes(channel)) {
    ipcRenderer.send(channel, ...args);
  }
}

function secureInvoke(channel, ...args) {
  if (INVOKE_CHANNELS.includes(channel)) {
    return ipcRenderer.invoke(channel, ...args);
  }
  return Promise.reject(new Error(`Blocked IPC invoke: ${channel}`));
}

function secureOn(channel, callback) {
  if (RECEIVE_CHANNELS.includes(channel)) {
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    // Return unsubscribe function
    return () => ipcRenderer.removeListener(channel, handler);
  }
}

/* ═══════════════════════════════════════════════════════════════
   EXPOSED API — window.ghostlink
   ═══════════════════════════════════════════════════════════════ */

contextBridge.exposeInMainWorld('ghostlink', {
  /* ── Platform info ──────────────────────────────────────────── */
  platform: process.platform,
  isElectron: true,

  /* ── Window controls ────────────────────────────────────────── */
  minimize: () => secureSend('minimize'),
  maximize: () => secureSend('maximize'),
  close: () => secureSend('close'),

  /* ── Notifications ──────────────────────────────────────────── */
  notify: (title, body) => secureSend('notify', title, body),

  /* ── Tray badge ─────────────────────────────────────────────── */
  setBadgeCount: (count) => secureSend('badge-count', count),

  /* ── Clipboard ──────────────────────────────────────────────── */
  copyToClipboard: (text) => secureSend('clipboard-write', text),

  /* ── File operations ────────────────────────────────────────── */
  saveFile: (data, filename) => secureInvoke('save-file', data, filename),
  openFile: () => secureInvoke('open-file'),

  /* ── Pop-out chat ───────────────────────────────────────────── */
  popOutChat: (chatId, title) => secureSend('pop-out-chat', chatId, title),

  /* ── Deep links ─────────────────────────────────────────────── */
  onDeepLink: (callback) => secureOn('deep-link', callback),

  /* ── Auto-update ────────────────────────────────────────────── */
  onUpdateAvailable: (callback) => secureOn('update-available', callback),
  onUpdateDownloaded: (callback) => secureOn('update-downloaded', callback),
  onUpdateError: (callback) => secureOn('update-error', callback),
  installUpdate: () => secureSend('install-update'),

  /* ── Secure storage (encrypted with OS keychain-level) ──────── */
  secureStore: {
    get: (key) => secureInvoke('secure-get', key),
    set: (key, value) => secureInvoke('secure-set', key, value),
    delete: (key) => secureInvoke('secure-delete', key),
  },

  /* ── Settings ───────────────────────────────────────────────── */
  settings: {
    get: (key) => secureInvoke('get-setting', key),
    set: (key, value) => secureInvoke('set-setting', key, value),
  },

  /* ── Drag-and-drop support ──────────────────────────────────── */
  startDrag: (filePath) => secureSend('ondragstart', filePath),

  /* ── Tray actions listener ──────────────────────────────────── */
  onTrayAction: (callback) => secureOn('tray-action', callback),
});

/* ═══════════════════════════════════════════════════════════════
   DRAG-AND-DROP ENHANCEMENT
   ═══════════════════════════════════════════════════════════════
   Intercept native file drops and forward file data to the
   web app through a custom DOM event. */

// Set signaling URL for the web app (Electron loads via file://, hostname is empty)
window.GHOSTLINK_SIGNAL_URL = 'ws://localhost:3001';

window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = [];
    for (const file of e.dataTransfer.files) {
      files.push({
        name: file.name,
        path: file.path,
        size: file.size,
        type: file.type,
      });
    }
    if (files.length > 0) {
      window.dispatchEvent(
        new CustomEvent('ghostlink-file-drop', { detail: { files } })
      );
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
});
