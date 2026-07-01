/**
 * GhostLink Mobile — Global Application Context
 *
 * Centralized state for identity, peers, messages, settings,
 * and connection status. Persistent state backed by AsyncStorage.
 * Peers and messages use Map for O(1) lookups.
 */

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

// ─── Default Settings ────────────────────────────────────────
const DEFAULT_SETTINGS = {
  theme: 'phantom',
  fontSize: 16,
  notifications: true,
  sounds: true,
  readReceipts: false,
  encLevel: 'signal', // 'signal' | 'aes-gcm' | 'triple'
  p2pRelay: false,
};

// ─── Initial State ───────────────────────────────────────────
const INITIAL_STATE = {
  identity: null, // { name, publicKeyHex, fingerprint, keyPair }
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
  REMOVE_PEER: 'REMOVE_PEER',
  ADD_MESSAGE: 'ADD_MESSAGE',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  SET_CONNECTION_STATUS: 'SET_CONNECTION_STATUS',
  SET_GHOST_MESH: 'SET_GHOST_MESH',
  CLEAR_GHOST_MESH: 'CLEAR_GHOST_MESH',
  RESTORE_STATE: 'RESTORE_STATE',
  WIPE_ALL: 'WIPE_ALL',
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

// ─── Reducer ─────────────────────────────────────────────────

function appReducer(state, action) {
  switch (action.type) {
    case Actions.SET_IDENTITY:
      return {...state, identity: action.payload};

    case Actions.ADD_PEER: {
      const nextPeers = new Map(state.peers);
      nextPeers.set(action.payload.id, action.payload);
      return {...state, peers: nextPeers};
    }

    case Actions.REMOVE_PEER: {
      const nextPeers = new Map(state.peers);
      nextPeers.delete(action.payload);
      return {...state, peers: nextPeers};
    }

    case Actions.ADD_MESSAGE: {
      const {roomId, message} = action.payload;
      const nextMessages = new Map(state.messages);
      const existing = nextMessages.get(roomId) || [];
      nextMessages.set(roomId, [...existing, message]);
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

    case Actions.RESTORE_STATE:
      return {...state, ...action.payload};

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
  useEffect(() => {
    (async () => {
      try {
        const [rawIdentity, rawMessages, rawSettings, rawPeers, rawGhostMesh] =
          await Promise.all([
            AsyncStorage.getItem(STORAGE_KEYS.IDENTITY),
            AsyncStorage.getItem(STORAGE_KEYS.MESSAGES),
            AsyncStorage.getItem(STORAGE_KEYS.SETTINGS),
            AsyncStorage.getItem(STORAGE_KEYS.PEERS),
            AsyncStorage.getItem(STORAGE_KEYS.GHOST_MESH),
          ]);

        const restored = {};

        if (rawIdentity) {
          restored.identity = JSON.parse(rawIdentity);
        }
        if (rawMessages) {
          restored.messages = objectToMap(JSON.parse(rawMessages));
        }
        if (rawSettings) {
          restored.settings = {...DEFAULT_SETTINGS, ...JSON.parse(rawSettings)};
        }
        if (rawPeers) {
          restored.peers = objectToMap(JSON.parse(rawPeers));
        }
        if (rawGhostMesh) {
          restored.ghostMesh = JSON.parse(rawGhostMesh);
        }

        if (Object.keys(restored).length > 0) {
          dispatch({type: Actions.RESTORE_STATE, payload: restored});
        }
      } catch (err) {
        console.warn('[AppContext] hydration failed:', err);
      } finally {
        hydrated.current = true;
      }
    })();
  }, []);

  // ── Persist identity ──
  useEffect(() => {
    if (!hydrated.current) {
      return;
    }
    if (state.identity) {
      // Strip non-serialisable keyPair before writing
      const {keyPair, ...serialisable} = state.identity;
      AsyncStorage.setItem(
        STORAGE_KEYS.IDENTITY,
        JSON.stringify(serialisable),
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

  const updateSettings = useCallback(partial => {
    dispatch({type: Actions.UPDATE_SETTINGS, payload: partial});
  }, []);

  const setConnectionStatus = useCallback(status => {
    dispatch({type: Actions.SET_CONNECTION_STATUS, payload: status});
  }, []);

  const wipeAll = useCallback(async () => {
    try {
      await AsyncStorage.multiRemove([
        STORAGE_KEYS.IDENTITY,
        STORAGE_KEYS.MESSAGES,
        STORAGE_KEYS.SETTINGS,
        STORAGE_KEYS.PEERS,
        STORAGE_KEYS.GHOST_MESH,
      ]);
    } catch (err) {
      console.warn('[AppContext] wipe error:', err);
    }
    dispatch({type: Actions.WIPE_ALL});
  }, []);

  const setGhostMesh = useCallback(meshData => {
    dispatch({type: Actions.SET_GHOST_MESH, payload: meshData});
  }, []);

  const clearGhostMesh = useCallback(() => {
    dispatch({type: Actions.CLEAR_GHOST_MESH});
  }, []);

  const value = {
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
    updateSettings,
    setConnectionStatus,
    setGhostMesh,
    clearGhostMesh,
    wipeAll,
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

export {AppProvider, useApp, DEFAULT_SETTINGS, STORAGE_KEYS};
export default AppContext;
