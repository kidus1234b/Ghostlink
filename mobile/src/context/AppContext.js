import React, {createContext, useContext, useReducer, useCallback, useEffect} from 'react';
import EncryptedStorage from 'react-native-encrypted-storage';
import {CryptoEngine} from '../utils/crypto';

const AppContext = createContext();

const BIP39_WORDS = ["abandon","ability","able","above","absent","absorb","abuse","access","account","achieve","acid","across","action","actor","adapt","address","admit","adult","advance","advice","afford","afraid","again","agent","agree","aim","airport","alarm","album","alert","alien","alley","allow","almost","alone","already","alter","amateur","amazing","anchor","ancient","anger","angle","animal","annual","antenna","anxiety","appear","approve","arch","arctic","area","argue","armor","army","arrest","arrive","artist","aspect","assault","assist","athlete","attach","attend","attract","audit","author","autumn","aware","awesome","axis","balance","bamboo","banner","barely","barrel","battle","beauty","become","benefit","betray","bicycle","biology","birth","bitter","blade","blame","blast","bless","blind","blossom","boost","border","bounce","bracket","brave","bridge","brief","bright","brisk","broken","brother","bubble","bullet","bundle","burden","burst","business","butter","cable","cactus","canvas","capable","captain","carbon","cargo","carry","castle","casual","catalog","cause","caution","cement","century","cereal","champion","chapter","charge","chase","cheap","chest","chief","child","choice","circuit","citizen","civil","claim","clever","client","climb","clinic","clog","cloth","cloud","cluster","clutch","coast","coconut","combine","comfort","company","confirm","congress","connect","consider","control","convince","copper","coral","correct","cotton","country","couple","cousin","cover","crack","cradle","craft","crane","crash","cream","cricket","crime","crisp","cross","crucial","crystal","culture","curious","current","custom","cycle","damage","danger","daring","daughter","decade","decline","define","delay","deliver","demand","dental","derive","describe","design","detect","develop","device","diagram","diamond","digital","dilemma","discover","display","domain","donate","double","dragon","drama","draw","dream","dress","drift","drive","dynamic","eagle","economy","effort","eight","electric","element","elite","emerge","emotion","employ","enable","endorse","energy","enforce","engage","engine","enjoy","enough","enrich","enter","equal","equip","escape","estate","ethics","evidence","evolve","exact","excess","excite","exercise","exhaust","exist","expand","explain","expose","extend","fabric","faculty","faith","famous","fantasy","fashion","feature","festival","fiction","figure","filter","fiscal","fitness","flame","flavor","flight","float","flower","fluid","focus","forest","fortune","fossil","frame","frequent","fresh","future","galaxy","gallery","garlic","gather","genius","genuine","ghost","giant","ginger","giraffe","global","gospel","govern","grace","grain","grape","gravity","great","guard","guide","guitar","habit","harvest","hazard","health","heavy","height","hidden","history","hobby","hockey","holiday","honey","hospital","hover","humble","humor","hybrid","icon","ignore","illegal","image","immune","impact","improve","impulse","income","indoor","industry","infant","innocent","inquiry","inspire","install","intact","invest","invite","island","isolate","jacket","jaguar","jealous","journey","jungle","kangaroo","kingdom","kitchen","knowledge","language","laptop","laundry","lawsuit","leader","lecture","legend","liberty","license","liquid","lottery","luggage","luxury","magic","magnet","marble","margin","marine","master","matrix","meadow","melody","memory","mentor","mercy","middle","midnight","miracle","mitten","monitor","monkey","moral","morning","mountain","museum","mystery","nature","network","neutral","noble","nominee","nuclear","object","obtain","ocean","olympic","onion","orbit","orchard","order","organ","orphan","ostrich","output","oxygen","paddle","palace","panic","patrol","payment","peasant","pelican","penalty","perfect","permit","phrase","physical","pioneer","pistol","planet","plastic","pledge","polar","popular","portrait","pottery","poverty","predict","preserve","primary","priority","prison","produce","profit","program","promote","property","protect","provide","pudding","quantum","question","rabbit","raccoon","radar","rainbow","rally","random","rebel","rebuild","recall","recipe","reduce","reform","region","regular","release","remain","remind","rescue","resist","resource","result","retire","reunion","reveal","reward","rhythm","ribbon","ritual","robust","romance","rookie","rotate","satellite","satisfy","scatter","science","scorpion","screen","second","section","security","segment","seminar","separate","shadow","sheriff","shield","signal","silent","similar","simple","siren","social","solar","soldier","solution","someone","source","space","spatial","spawn","special","sphere","spirit","sponsor","stable","stadium","stairs","strategy","street","struggle","student","style","submit","subway","surface","surprise","sustain","symbol","symptom","tackle","talent","target","texture","theory","thunder","timber","tissue","token","tornado","tourist","traffic","tragic","transfer","trigger","trophy","trumpet","tunnel","unique","universe","unlock","unusual","upgrade","uphold","urban","utility","vacant","valley","vendor","venture","verify","vibrant","victory","vintage","virtual","vital","vivid","volcano","voyage","walnut","warfare","warrior","wealth","weapon","wedding","whisper","wildlife","wisdom","witness","wonder","wrist","yellow","zebra","zero"];

function generateSeedPhrase() {
  const words = [];
  for (let i = 0; i < 12; i++) {
    const idx = Math.floor(Math.random() * BIP39_WORDS.length);
    words.push(BIP39_WORDS[idx]);
  }
  return words;
}

const initialState = {
  identity: null,
  seedPhrase: null,
  displayName: '',
  isSetupComplete: false,
  peers: [],
  activePeer: null,
  messages: {},
  pinnedMessages: {},
  rooms: [],
  activeRoom: null,
  callState: null,
  chain: [],
  files: [],
  notifications: true,
  biometricEnabled: false,
  autoWipeMinutes: 0,
  inviteCode: '',
};

function appReducer(state, action) {
  switch (action.type) {
    case 'SET_IDENTITY':
      return {...state, identity: action.payload};
    case 'SET_SEED_PHRASE':
      return {...state, seedPhrase: action.payload};
    case 'SET_DISPLAY_NAME':
      return {...state, displayName: action.payload};
    case 'COMPLETE_SETUP':
      return {...state, isSetupComplete: true};
    case 'ADD_PEER':
      if (state.peers.find(p => p.id === action.payload.id)) return state;
      return {...state, peers: [...state.peers, action.payload]};
    case 'REMOVE_PEER':
      return {...state, peers: state.peers.filter(p => p.id !== action.payload)};
    case 'SET_ACTIVE_PEER':
      return {...state, activePeer: action.payload};
    case 'UPDATE_PEER':
      return {
        ...state,
        peers: state.peers.map(p =>
          p.id === action.payload.id ? {...p, ...action.payload} : p,
        ),
      };
    case 'ADD_MESSAGE': {
      const {roomId, message} = action.payload;
      const roomMessages = state.messages[roomId] || [];
      return {
        ...state,
        messages: {
          ...state.messages,
          [roomId]: [...roomMessages, message],
        },
      };
    }
    case 'DELETE_MESSAGE': {
      const {roomId: rid, messageId} = action.payload;
      const msgs = (state.messages[rid] || []).filter(m => m.id !== messageId);
      return {...state, messages: {...state.messages, [rid]: msgs}};
    }
    case 'PIN_MESSAGE': {
      const {roomId: prid, messageId: pmid} = action.payload;
      const pinned = state.pinnedMessages[prid] || [];
      if (pinned.includes(pmid)) {
        return {
          ...state,
          pinnedMessages: {
            ...state.pinnedMessages,
            [prid]: pinned.filter(id => id !== pmid),
          },
        };
      }
      return {
        ...state,
        pinnedMessages: {
          ...state.pinnedMessages,
          [prid]: [...pinned, pmid],
        },
      };
    }
    case 'ADD_ROOM':
      return {...state, rooms: [...state.rooms, action.payload]};
    case 'SET_ACTIVE_ROOM':
      return {...state, activeRoom: action.payload};
    case 'SET_CALL_STATE':
      return {...state, callState: action.payload};
    case 'ADD_CHAIN_BLOCK':
      return {...state, chain: [...state.chain, action.payload]};
    case 'SET_CHAIN':
      return {...state, chain: action.payload};
    case 'ADD_FILE':
      return {...state, files: [...state.files, action.payload]};
    case 'SET_NOTIFICATIONS':
      return {...state, notifications: action.payload};
    case 'SET_BIOMETRIC':
      return {...state, biometricEnabled: action.payload};
    case 'SET_AUTO_WIPE':
      return {...state, autoWipeMinutes: action.payload};
    case 'SET_INVITE_CODE':
      return {...state, inviteCode: action.payload};
    case 'WIPE_ALL':
      return {...initialState};
    case 'RESTORE_STATE':
      return {...state, ...action.payload};
    default:
      return state;
  }
}

export function AppProvider({children}) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  useEffect(() => {
    loadPersistedState();
  }, []);

  const loadPersistedState = async () => {
    try {
      const stored = await EncryptedStorage.getItem('gl_app_state');
      if (stored) {
        const parsed = JSON.parse(stored);
        dispatch({type: 'RESTORE_STATE', payload: parsed});
      }
    } catch (_e) {
      // First launch or corrupted state
    }
  };

  const persistState = useCallback(async () => {
    try {
      const toStore = {
        displayName: state.displayName,
        isSetupComplete: state.isSetupComplete,
        peers: state.peers,
        messages: state.messages,
        pinnedMessages: state.pinnedMessages,
        rooms: state.rooms,
        chain: state.chain,
        files: state.files,
        notifications: state.notifications,
        biometricEnabled: state.biometricEnabled,
        autoWipeMinutes: state.autoWipeMinutes,
        inviteCode: state.inviteCode,
      };
      await EncryptedStorage.setItem('gl_app_state', JSON.stringify(toStore));
    } catch (_e) {
      // Storage error
    }
  }, [state]);

  useEffect(() => {
    if (state.isSetupComplete) {
      persistState();
    }
  }, [state, persistState]);

  const setupIdentity = useCallback(async (name) => {
    const keyPair = await CryptoEngine.generateKeyPair();
    const seed = generateSeedPhrase();
    const fingerprint = await CryptoEngine.sha256(keyPair.publicKeyHex);
    const invite = CryptoEngine.genInvite();

    const identity = {
      publicKeyHex: keyPair.publicKeyHex,
      fingerprint: fingerprint.slice(0, 16),
      name,
    };

    await CryptoEngine.storeKeyPair(keyPair.publicKeyHex, keyPair.privateKeyRaw);

    dispatch({type: 'SET_IDENTITY', payload: identity});
    dispatch({type: 'SET_SEED_PHRASE', payload: seed});
    dispatch({type: 'SET_DISPLAY_NAME', payload: name});
    dispatch({type: 'SET_INVITE_CODE', payload: invite});

    return {identity, seedPhrase: seed, inviteCode: invite};
  }, []);

  const sendMessage = useCallback(
    async (roomId, text, options = {}) => {
      const {replyTo, selfDestruct, fileAttachment} = options;
      const encrypted = await CryptoEngine.encrypt(text, state.identity?.publicKeyHex || 'default-key');

      const message = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sender: state.displayName,
        senderFingerprint: state.identity?.fingerprint || '',
        content: encrypted,
        plainText: text,
        type: fileAttachment ? 'file' : 'text',
        timestamp: Date.now(),
        replyTo: replyTo || null,
        selfDestruct: selfDestruct || 0,
        selfDestructAt: selfDestruct ? Date.now() + selfDestruct * 1000 : null,
        file: fileAttachment || null,
        read: false,
        delivered: true,
      };

      dispatch({type: 'ADD_MESSAGE', payload: {roomId, message}});

      const hash = await CryptoEngine.sha256(
        JSON.stringify({sender: message.sender, content: text, ts: message.timestamp}),
      );
      dispatch({
        type: 'ADD_CHAIN_BLOCK',
        payload: {
          index: state.chain.length,
          ts: message.timestamp,
          sender: message.sender,
          hash,
          type: message.type,
          prevHash: state.chain.length > 0 ? state.chain[state.chain.length - 1].hash : '0'.repeat(64),
        },
      });

      return message;
    },
    [state.identity, state.displayName, state.chain],
  );

  const wipeAll = useCallback(async () => {
    try {
      await EncryptedStorage.clear();
      await CryptoEngine.clearKeys();
    } catch (_e) {
      // Wipe error
    }
    dispatch({type: 'WIPE_ALL'});
  }, []);

  return (
    <AppContext.Provider
      value={{
        state,
        dispatch,
        setupIdentity,
        sendMessage,
        wipeAll,
        generateSeedPhrase,
        BIP39_WORDS,
      }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be inside AppProvider');
  return ctx;
}

export {BIP39_WORDS};
export default AppContext;
