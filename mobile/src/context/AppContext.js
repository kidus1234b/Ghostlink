/**
 * GhostLink Mobile — Global Application Context
 *
 * Centralized state for identity, peers, messages, settings,
 * and connection status. Persistent state backed by AsyncStorage.
 * Peers and messages use Map for O(1) lookups.
 */

import WebRTCService from '../services/WebRTCService';
import {DEFAULT_SETTINGS, parseStoredState} from '../utils/settings-migration';
import {BUNDLE_STORAGE_KEY, FRAGMENTS_STORAGE_KEY} from '../utils/recovery';
import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Storage Keys ────────────────────────────────────────────
const STORAGE_KEYS = {
  IDENTITY: '@ghostlink/identity',
  MESSAGES: '@ghostlink/messages',
  SETTINGS: '@ghostlink/settings',
  PEERS: '@ghostlink/peers',
  GHOST_MESH: '@ghostlink/ghost_mesh',
};

/**
 * Everything else this identity writes to AsyncStorage outside the reducer.
 *
 * The recovery bundle carries the wrapped private key with the name, public
 * key and Ghost Address beside it in plaintext; the fragments are all seven
 * Shamir shares of that bundle. Neither was removed by a wipe or a restore, so
 * "Wipe All Data" left the identity on the device, and a restore kept the
 * previous identity's backup.
 */
const IDENTITY_SCOPED_EXTRA_KEYS = [
  BUNDLE_STORAGE_KEY,
  FRAGMENTS_STORAGE_KEY,
  'gl_invite_code', // SetupScreen
];

/** Shares other people asked this device to hold (MobileDistributor). */
const HELD_FRAGMENTS_KEY = '@ghostlink/recovery-fragments';

/** What "Wipe All Data" removes from AsyncStorage. */
const WIPE_KEYS = [
  ...Object.values(STORAGE_KEYS),
  ...IDENTITY_SCOPED_EXTRA_KEYS,
  HELD_FRAGMENTS_KEY,
];

/** What installing a different identity removes; settings stay. */
const IDENTITY_SCOPED_KEYS = [
  STORAGE_KEYS.MESSAGES,
  STORAGE_KEYS.PEERS,
  STORAGE_KEYS.GHOST_MESH,
  ...IDENTITY_SCOPED_EXTRA_KEYS,
];

// ─── Initial State ───────────────────────────────────────────
const INITIAL_STATE = {
  identity: null, // { name, publicKeyHex, fingerprint, ghostAddress, ... } — never a private key
  peers: new Map(), // peerId -> { id, name, publicKeyHex, fingerprint, online, lastSeen }
  messages: new Map(), // roomId -> [{ id, sender, text, timestamp, type, status }]
  settings: {...DEFAULT_SETTINGS},
  connectionStatus: 'disconnected', // 'disconnected' | 'connecting' | 'connected'
  ghostMesh: {
    enabled: false,
    address: '',       // Yggdrasil IPv6 address
    publicKeyHex: '',  // X25519 public key hex
    status: 'not_configured', // 'not_configured' | 'configured' | 'active'
  },
};

// ─── Action Types ────────────────────────────────────────────
const Actions = {
  SET_IDENTITY: 'SET_IDENTITY',
  ADD_PEER: 'ADD_PEER',
  UPDATE_PEER: 'UPDATE_PEER',
  REMOVE_PEER: 'REMOVE_PEER',
  ADD_MESSAGE: 'ADD_MESSAGE',
  UPDATE_MESSAGE: 'UPDATE_MESSAGE',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  SET_CONNECTION_STATUS: 'SET_CONNECTION_STATUS',
  SET_GHOST_MESH: 'SET_GHOST_MESH',
  CLEAR_GHOST_MESH: 'CLEAR_GHOST_MESH',
  RESTORE_STATE: 'RESTORE_STATE',
  WIPE_ALL: 'WIPE_ALL',
  CLEAR_IDENTITY_DATA: 'CLEAR_IDENTITY_DATA',
};

// ─── Map Serialisation Helpers ───────────────────────────────

function mapToObject(map) {
  const obj = {};
  for (const [key, value] of map.entries()) {
    obj[key] = value;
  }
  return obj;
}

function objectToMap(obj) {
  const map = new Map();
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      map.set(key, obj[key]);
    }
  }
  return map;
}

/**
 * The identity as app state may hold it: no private key.
 *
 * The key lives in the keystore. RecoveryScreen's restore paths hand
 * setIdentity the object unlockBundle returns, which carries privateKeyRaw,
 * and the identity is persisted to AsyncStorage — unencrypted — so a restore
 * wrote the raw private key to disk beside the public one. Stripping here also
 * scrubs a copy an earlier build already saved: hydration re-persists the
 * identity through the same path.
 */
function withoutSecrets(identity) {
  if (!identity || typeof identity !== 'object') return identity;
  const {keyPair, privateKeyRaw, privateKey, seedPhrase, ...rest} = identity;
  return rest;
}

// ─── Reducer ─────────────────────────────────────────────────

function appReducer(state, action) {
  switch (action.type) {
    case Actions.SET_IDENTITY:
      return {...state, identity: withoutSecrets(action.payload)};

    case Actions.ADD_PEER: {
      const nextPeers = new Map(state.peers);
      nextPeers.set(action.payload.id, action.payload);
      return {...state, peers: nextPeers};
    }

    case Actions.UPDATE_PEER: {
      // Pin and mute dispatch this. Without a case here the reducer fell
      // through to `default` and returned state unchanged, so both buttons
      // animated and then did nothing.
      const existing = state.peers.get(action.payload.id);
      if (!existing) return state;
      const nextPeers = new Map(state.peers);
      nextPeers.set(action.payload.id, {...existing, ...action.payload});
      return {...state, peers: nextPeers};
    }

    case Actions.REMOVE_PEER: {
      // The conversation goes with the peer. Deleting a chat used to drop only
      // the peer entry, leaving its whole history persisted and unreachable.
      const removed = state.peers.get(action.payload);
      const nextPeers = new Map(state.peers);
      nextPeers.delete(action.payload);
      const nextMessages = new Map(state.messages);
      nextMessages.delete(action.payload);
      if (removed?.roomId) nextMessages.delete(removed.roomId);
      return {...state, peers: nextPeers, messages: nextMessages};
    }

    case Actions.ADD_MESSAGE: {
      const {roomId, message} = action.payload;
      const nextMessages = new Map(state.messages);
      const existing = nextMessages.get(roomId) || [];
      nextMessages.set(roomId, [...existing, message]);
      return {...state, messages: nextMessages};
    }

    /**
     * Amend a message already in the list — its delivery status, mostly.
     *
     * Without this a status could never change after send, which is why the
     * old code faked DELIVERED with a timer: there was no way to record a real
     * one. Statuses now only move because something actually happened.
     */
    case Actions.UPDATE_MESSAGE: {
      const {roomId, messageId, patch} = action.payload;
      const existing = state.messages.get(roomId);
      if (!existing) return state;
      let changed = false;
      const updated = existing.map(m => {
        if (m.id !== messageId) return m;
        changed = true;
        return {...m, ...patch};
      });
      if (!changed) return state;
      const nextMessages = new Map(state.messages);
      nextMessages.set(roomId, updated);
      return {...state, messages: nextMessages};
    }

    case Actions.UPDATE_SETTINGS:
      return {
        ...state,
        settings: {...state.settings, ...action.payload},
      };

    case Actions.SET_CONNECTION_STATUS:
      return {...state, connectionStatus: action.payload};

    case Actions.SET_GHOST_MESH:
      return {
        ...state,
        ghostMesh: {...state.ghostMesh, ...action.payload},
      };

    case Actions.CLEAR_GHOST_MESH:
      return {
        ...state,
        ghostMesh: {
          enabled: false,
          address: '',
          publicKeyHex: '',
          status: 'not_configured',
        },
      };

    case Actions.RESTORE_STATE: {
      const next = {...state, ...action.payload};
      if ('identity' in action.payload) next.identity = withoutSecrets(action.payload.identity);
      return next;
    }

    // Everything the previous identity owned, without touching the
    // preferences that belong to the person holding the phone.
    case Actions.CLEAR_IDENTITY_DATA:
      return {
        ...state,
        peers: new Map(),
        messages: new Map(),
        ghostMesh: {enabled: false, address: '', publicKeyHex: '', status: 'not_configured'},
      };

    case Actions.WIPE_ALL:
      return {
        ...INITIAL_STATE,
        settings: {...DEFAULT_SETTINGS},
        peers: new Map(),
        messages: new Map(),
        ghostMesh: {
          enabled: false,
          address: '',
          publicKeyHex: '',
          status: 'not_configured',
        },
      };

    default:
      return state;
  }
}

// ─── Context ─────────────────────────────────────────────────
const AppContext = createContext(null);

function AppProvider({children}) {
  const [state, dispatch] = useReducer(appReducer, INITIAL_STATE);
  const hydrated = useRef(false);

  // ── Hydrate from AsyncStorage on mount ──
  /**
   * Point the transport at this device's identity and, if one is configured, a
   * Ghost Mesh bridge.
   *
   * The transport needs our own id to derive session keys for the direct path —
   * the derivation sorts the two peer ids so both ends agree — and it cannot
   * know it on its own.
   */
  useEffect(() => {
    const localId = state.identity?.fingerprint || state.identity?.publicKeyHex || null;
    if (localId) WebRTCService.setLocalPeerId(localId);
  }, [state.identity]);

  useEffect(() => {
    const url = (state.settings?.meshBridgeUrl || '').trim();
    // No seed is passed, and none is available to pass: SetupScreen keeps the
    // recovery phrase out of app state on purpose, so that a plaintext copy
    // never lands in AsyncStorage alongside the identity. This call used to
    // read state.identity.seedPhrase, which is always undefined — so the
    // bridge connected and then sat there, never sending the `start` frame it
    // needs to bring a node up, with nothing saying why.
    //
    // Starting the mesh therefore needs an explicit unlock that supplies the
    // phrase for the moment it is used. Until that exists the transport
    // reports 'needs-unlock' rather than pretending to be connecting.
    WebRTCService.setMeshBridge(url || null, null);
  }, [state.settings?.meshBridgeUrl]);

  useEffect(() => {
    (async () => {
      const raw = {};
      try {
        const [rawIdentity, rawMessages, rawSettings, rawPeers, rawGhostMesh] =
          await Promise.all([
            AsyncStorage.getItem(STORAGE_KEYS.IDENTITY),
            AsyncStorage.getItem(STORAGE_KEYS.MESSAGES),
            AsyncStorage.getItem(STORAGE_KEYS.SETTINGS),
            AsyncStorage.getItem(STORAGE_KEYS.PEERS),
            AsyncStorage.getItem(STORAGE_KEYS.GHOST_MESH),
          ]);
        Object.assign(raw, {rawIdentity, rawMessages, rawSettings, rawPeers, rawGhostMesh});
      } catch (err) {
        console.error('[AppContext] could not read local storage:', err);
        hydrated.current = true;
        return;
      }

      const {restored, lost} = parseStoredState(
        {
          identity: raw.rawIdentity,
          messages: raw.rawMessages,
          settings: raw.rawSettings,
          peers: raw.rawPeers,
          ghostMesh: raw.rawGhostMesh,
        },
        objectToMap,
      );

      if (lost.length > 0) {
        console.error(
          `[AppContext] ${lost.join(', ')} could not be read and were skipped. ` +
          'The stored data has been left untouched.',
        );
      }

      if (Object.keys(restored).length > 0) {
        dispatch({type: Actions.RESTORE_STATE, payload: restored});
      }
      hydrated.current = true;
    })();
  }, []);

  // ── Persist identity ──
  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    if (state.identity) {
      AsyncStorage.setItem(
        STORAGE_KEYS.IDENTITY,
        JSON.stringify(withoutSecrets(state.identity)),
      ).catch(() => {});
    } else {
      AsyncStorage.removeItem(STORAGE_KEYS.IDENTITY).catch(() => {});
    }
  }, [state.identity]);

  // ── Persist messages ──
  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    AsyncStorage.setItem(
      STORAGE_KEYS.MESSAGES,
      JSON.stringify(mapToObject(state.messages)),
    ).catch(() => {});
  }, [state.messages]);

  // ── Persist settings ──
  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    AsyncStorage.setItem(
      STORAGE_KEYS.SETTINGS,
      JSON.stringify(state.settings),
    ).catch(() => {});
  }, [state.settings]);

  // ── Persist peers ──
  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    AsyncStorage.setItem(
      STORAGE_KEYS.PEERS,
      JSON.stringify(mapToObject(state.peers)),
    ).catch(() => {});
  }, [state.peers]);

  // ── Persist ghostMesh ──
  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    AsyncStorage.setItem(
      STORAGE_KEYS.GHOST_MESH,
      JSON.stringify(state.ghostMesh),
    ).catch(() => {});
  }, [state.ghostMesh]);

  // ── Bound Actions ──

  const setIdentity = useCallback(identity => {
    dispatch({type: Actions.SET_IDENTITY, payload: identity});
  }, []);

  const addPeer = useCallback(peer => {
    dispatch({type: Actions.ADD_PEER, payload: peer});
  }, []);

  const removePeer = useCallback(peerId => {
    dispatch({type: Actions.REMOVE_PEER, payload: peerId});
  }, []);

  const addMessage = useCallback((roomId, message) => {
    dispatch({
      type: Actions.ADD_MESSAGE,
      payload: {roomId, message},
    });
  }, []);

  const updateMessage = useCallback((roomId, messageId, patch) => {
    dispatch({
      type: Actions.UPDATE_MESSAGE,
      payload: {roomId, messageId, patch},
    });
  }, []);

  const updateSettings = useCallback(partial => {
    dispatch({type: Actions.UPDATE_SETTINGS, payload: partial});
  }, []);

  const setConnectionStatus = useCallback(status => {
    dispatch({type: Actions.SET_CONNECTION_STATUS, payload: status});
  }, []);

  /**
   * Remove this identity and everything derived from it, from this device.
   *
   * The private key does not live in AsyncStorage — it is in the platform
   * keystore, written by CryptoEngine.saveKeys() under the service
   * "com.ghostlink.keys" and guarded by biometry. Clearing only the
   * AsyncStorage keys therefore left the key material behind: a "wipe" that
   * dropped the messages and the settings while the identity itself stayed on
   * the device, recoverable by anything that could authenticate. CryptoEngine
   * has always exported clearKeys(); nothing called it.
   *
   * Reports what it managed to remove so the caller can tell the user the
   * truth rather than claiming a clean wipe after a partial one.
   *
   * @returns {Promise<{ok: boolean, cleared: string[], failed: string[]}>}
   */
  const wipeAll = useCallback(async () => {
    const cleared = [];
    const failed = [];

    try {
      await AsyncStorage.multiRemove(WIPE_KEYS);
      cleared.push('messages', 'settings', 'peer cache', 'mesh state', 'recovery backup');
    } catch (err) {
      console.warn('[AppContext] wipe: local store failed:', err);
      failed.push('local store');
    }

    // The part that actually matters.
    try {
      // clearKeys is a member of CryptoEngine (the default export), not a
      // named export — destructuring it off the module gives undefined.
      const {default: CryptoEngine} = await import('../utils/crypto');
      const gone = await CryptoEngine.clearKeys();
      if (gone) cleared.push('identity key');
      else failed.push('identity key');
    } catch (err) {
      console.warn('[AppContext] wipe: keystore failed:', err);
      failed.push('identity key');
    }

    dispatch({type: Actions.WIPE_ALL});
    return {ok: failed.length === 0, cleared, failed};
  }, []);

  /**
   * Drop everything tied to whoever was on this device before, keeping nothing
   * but the app's own preferences.
   *
   * Restoring a phrase installs a different identity. Messages, the peer cache
   * and mesh state all belong to the previous one: a conversation list left
   * behind would be attributed to the restored identity, showing history it
   * never had and peers it never spoke to. The restore screen already tells
   * people their messages do not come back — this is what makes that true.
   *
   * Settings are deliberately kept: text size and theme are properties of the
   * person holding the phone, not of the identity.
   *
   * @returns {Promise<void>}
   */
  const clearIdentityScopedData = useCallback(async () => {
    try {
      await AsyncStorage.multiRemove(IDENTITY_SCOPED_KEYS);
    } catch (err) {
      // Non-fatal: the restore still has to complete, and leaving stale rows
      // is better than refusing to restore the identity at all. Say so.
      console.warn('[AppContext] could not clear prior identity data:', err);
    }
    dispatch({type: Actions.CLEAR_IDENTITY_DATA});
  }, []);

  const setGhostMesh = useCallback(meshData => {
    dispatch({type: Actions.SET_GHOST_MESH, payload: meshData});
  }, []);

  const clearGhostMesh = useCallback(() => {
    dispatch({type: Actions.CLEAR_GHOST_MESH});
  }, []);

  const value = {
    // Screens were written against two different shapes of this context: some
    // read the flattened fields below, others destructure `{state, dispatch}`.
    // Only the flattened half was ever provided, so ChatListScreen's
    // `state.peers` threw on render and SetupScreen's `dispatch(...)` was
    // "undefined is not a function". Exposing both keeps every existing caller
    // working rather than rewriting screens to match.
    state,
    dispatch,

    // State
    identity: state.identity,
    peers: state.peers,
    messages: state.messages,
    settings: state.settings,
    connectionStatus: state.connectionStatus,
    ghostMesh: state.ghostMesh,

    // Actions
    setIdentity,
    addPeer,
    removePeer,
    addMessage,
    updateMessage,
    updateSettings,
    setConnectionStatus,
    setGhostMesh,
    clearGhostMesh,
    wipeAll,
    clearIdentityScopedData,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used inside <AppProvider>');
  }
  return ctx;
}

export {AppProvider, useApp, DEFAULT_SETTINGS, STORAGE_KEYS, WIPE_KEYS, IDENTITY_SCOPED_KEYS};
export default AppContext;
