/**
 * GhostLink Mobile — Storage Service
 *
 * AsyncStorage wrapper that provides typed getters/setters for all
 * GhostLink data domains: identity, messages, settings, peers,
 * fragment metadata, and the local chain.
 *
 * Install peer dependency:
 *   npm install @react-native-async-storage/async-storage
 *
 * @module StorageService
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Storage Keys ───────────────────────────────────────────────────────────

const KEYS = Object.freeze({
  IDENTITY: 'gl_identity',
  MESSAGES: 'gl_messages',
  SETTINGS: 'gl_settings',
  PEERS: 'gl_peers',
  FRAGMENT_META: 'gl_fragment_meta',
  CHAIN: 'gl_chain',
});

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Read a key from AsyncStorage and parse the JSON value.
 * Returns `fallback` if the key does not exist or parsing fails.
 *
 * @param {string} key
 * @param {*} fallback
 * @returns {Promise<*>}
 */
async function getJSON(key, fallback = null) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[GhostLink:Storage] Failed to read "${key}":`, err);
    return fallback;
  }
}

/**
 * Serialize a value to JSON and persist it in AsyncStorage.
 *
 * @param {string} key
 * @param {*} value
 * @returns {Promise<void>}
 */
async function setJSON(key, value) {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error(`[GhostLink:Storage] Failed to write "${key}":`, err);
    throw err;
  }
}

// ─── StorageService ─────────────────────────────────────────────────────────

const StorageService = {
  /** Expose key names for advanced usage. */
  KEYS,

  // ── Identity ──────────────────────────────────────────────────────────

  /**
   * Get the stored GhostLink identity (key pair, peer ID, display name, etc.).
   *
   * @returns {Promise<object|null>} Identity object or null if not yet created.
   */
  async getIdentity() {
    return getJSON(KEYS.IDENTITY);
  },

  /**
   * Persist the GhostLink identity.
   *
   * @param {object} identity
   *   Expected shape: { peerId, publicKey, privateKey (wrapped), displayName, ... }
   * @returns {Promise<void>}
   */
  async setIdentity(identity) {
    await setJSON(KEYS.IDENTITY, identity);
  },

  // ── Messages ──────────────────────────────────────────────────────────

  /**
   * Get all messages for a specific room.
   *
   * Messages are stored as a top-level map: { [roomId]: Message[] }.
   *
   * @param {string} roomId
   * @returns {Promise<Array<object>>} Array of message objects, or [].
   */
  async getMessages(roomId) {
    const allMessages = await getJSON(KEYS.MESSAGES, {});
    return allMessages[roomId] || [];
  },

  /**
   * Append a message to a room's message list.
   *
   * @param {string} roomId
   * @param {object} msg Message object (id, text, sender, timestamp, etc.).
   * @returns {Promise<void>}
   */
  async addMessage(roomId, msg) {
    const allMessages = await getJSON(KEYS.MESSAGES, {});
    if (!allMessages[roomId]) {
      allMessages[roomId] = [];
    }
    allMessages[roomId].push(msg);
    await setJSON(KEYS.MESSAGES, allMessages);
  },

  /**
   * Get the entire messages map (all rooms).
   *
   * @returns {Promise<object>} { [roomId]: Message[] }
   */
  async getAllMessages() {
    return getJSON(KEYS.MESSAGES, {});
  },

  /**
   * Replace all messages for a specific room.
   *
   * @param {string} roomId
   * @param {Array<object>} messages
   * @returns {Promise<void>}
   */
  async setMessages(roomId, messages) {
    const allMessages = await getJSON(KEYS.MESSAGES, {});
    allMessages[roomId] = messages;
    await setJSON(KEYS.MESSAGES, allMessages);
  },

  /**
   * Delete all messages for a specific room.
   *
   * @param {string} roomId
   * @returns {Promise<void>}
   */
  async clearMessages(roomId) {
    const allMessages = await getJSON(KEYS.MESSAGES, {});
    delete allMessages[roomId];
    await setJSON(KEYS.MESSAGES, allMessages);
  },

  // ── Settings ──────────────────────────────────────────────────────────

  /**
   * Get app settings.
   *
   * @returns {Promise<object>} Settings object, or {} if unset.
   */
  async getSettings() {
    return getJSON(KEYS.SETTINGS, {});
  },

  /**
   * Persist app settings. Merges with existing settings.
   *
   * @param {object} settings Partial settings to merge.
   * @returns {Promise<void>}
   */
  async setSettings(settings) {
    const existing = await getJSON(KEYS.SETTINGS, {});
    await setJSON(KEYS.SETTINGS, { ...existing, ...settings });
  },

  // ── Peers ─────────────────────────────────────────────────────────────

  /**
   * Get the list of known peers.
   *
   * @returns {Promise<Array<object>>} Array of peer objects, or [].
   */
  async getPeers() {
    return getJSON(KEYS.PEERS, []);
  },

  /**
   * Persist the list of known peers.
   *
   * @param {Array<object>} peers
   * @returns {Promise<void>}
   */
  async setPeers(peers) {
    await setJSON(KEYS.PEERS, peers);
  },

  // ── Fragment Metadata (Shamir Recovery) ───────────────────────────────

  /**
   * Get Shamir secret sharing fragment metadata.
   *
   * @returns {Promise<object|null>} Fragment metadata or null.
   */
  async getFragmentMeta() {
    return getJSON(KEYS.FRAGMENT_META);
  },

  /**
   * Persist Shamir fragment metadata.
   *
   * @param {object} meta
   *   Expected shape: { threshold, totalShards, shardIndex, createdAt, ... }
   * @returns {Promise<void>}
   */
  async setFragmentMeta(meta) {
    await setJSON(KEYS.FRAGMENT_META, meta);
  },

  // ── Chain (Local Blockchain / Audit Log) ──────────────────────────────

  /**
   * Get the local chain data.
   *
   * @returns {Promise<Array<object>>} Chain blocks, or [].
   */
  async getChain() {
    return getJSON(KEYS.CHAIN, []);
  },

  /**
   * Persist the local chain data.
   *
   * @param {Array<object>} chain
   * @returns {Promise<void>}
   */
  async setChain(chain) {
    await setJSON(KEYS.CHAIN, chain);
  },

  // ── Wipe ──────────────────────────────────────────────────────────────

  /**
   * Erase all GhostLink data from local storage.
   * This is irreversible — call only during account deletion or factory reset.
   *
   * @returns {Promise<void>}
   */
  async wipeAll() {
    const keys = Object.values(KEYS);
    try {
      await AsyncStorage.multiRemove(keys);
    } catch (err) {
      console.error('[GhostLink:Storage] Failed to wipe all keys:', err);
      throw err;
    }
  },
};

export default StorageService;
