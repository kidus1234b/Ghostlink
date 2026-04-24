import React, {useState, useCallback, useMemo, useRef, useEffect} from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Modal,
  Alert,
  Vibration,
  StatusBar,
  RefreshControl,
  Dimensions,
  Platform,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  SlideInDown,
  SlideOutDown,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withRepeat,
  withSequence,
  interpolate,
  runOnJS,
} from 'react-native-reanimated';
import {Gesture, GestureDetector, GestureHandlerRootView} from 'react-native-gesture-handler';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import {CryptoEngine} from '../utils/crypto';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SWIPE_THRESHOLD = 80;
const CHAT_ITEM_HEIGHT = 76;

// ==================== AVATAR GRADIENT COLORS ====================
const AVATAR_GRADIENTS = [
  ['#00ffa3', '#00cc82'],
  ['#ff4466', '#cc3652'],
  ['#44ddff', '#36b1cc'],
  ['#8866ff', '#6d52cc'],
  ['#ffaa00', '#cc8800'],
  ['#ff66aa', '#cc5288'],
  ['#66ffcc', '#52cca3'],
  ['#aa66ff', '#8852cc'],
];

function getAvatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  const diff = now - date;
  const oneDay = 86400000;

  if (diff < oneDay && date.getDate() === now.getDate()) {
    const h = date.getHours();
    const m = date.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${m} ${ampm}`;
  }
  if (diff < 2 * oneDay) return 'Yesterday';
  if (diff < 7 * oneDay) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// ==================== SWIPEABLE CHAT ITEM ====================
function ChatItem({item, theme, onPress, onPin, onMute, onDelete}) {
  const translateX = useSharedValue(0);
  const rowHeight = useSharedValue(CHAT_ITEM_HEIGHT);
  const isSwipeOpen = useRef(false);

  const avatarColors = useMemo(() => getAvatarColor(item.name), [item.name]);
  const firstLetter = item.name ? item.name[0].toUpperCase() : '?';

  const panGesture = Gesture.Pan()
    .activeOffsetX([-15, 15])
    .failOffsetY([-10, 10])
    .onUpdate(e => {
      // Only allow left swipe (negative direction) to reveal actions
      if (e.translationX < 0) {
        translateX.value = Math.max(e.translationX, -220);
      } else if (isSwipeOpen.current) {
        translateX.value = Math.min(-220 + e.translationX, 0);
      }
    })
    .onEnd(e => {
      if (translateX.value < -SWIPE_THRESHOLD) {
        translateX.value = withSpring(-220, {damping: 20, stiffness: 200});
        isSwipeOpen.current = true;
      } else {
        translateX.value = withSpring(0, {damping: 20, stiffness: 200});
        isSwipeOpen.current = false;
      }
    });

  const animatedRowStyle = useAnimatedStyle(() => ({
    transform: [{translateX: translateX.value}],
  }));

  const animatedActionsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateX.value, [0, -100], [0, 1]),
  }));

  const closeSwipe = useCallback(() => {
    translateX.value = withSpring(0, {damping: 20, stiffness: 200});
    isSwipeOpen.current = false;
  }, [translateX]);

  const handlePin = useCallback(() => {
    closeSwipe();
    onPin(item.id);
  }, [item.id, onPin, closeSwipe]);

  const handleMute = useCallback(() => {
    closeSwipe();
    onMute(item.id);
  }, [item.id, onMute, closeSwipe]);

  const handleDelete = useCallback(() => {
    closeSwipe();
    onDelete(item.id, item.name);
  }, [item.id, item.name, onDelete, closeSwipe]);

  return (
    <View style={styles.chatItemContainer}>
      {/* Swipe actions behind the row */}
      <Animated.View style={[styles.swipeActions, animatedActionsStyle]}>
        <TouchableOpacity
          style={[styles.swipeAction, {backgroundColor: '#3366ff'}]}
          onPress={handlePin}
          activeOpacity={0.7}>
          <Text style={styles.swipeActionIcon}>{item.pinned ? 'U' : 'P'}</Text>
          <Text style={styles.swipeActionLabel}>{item.pinned ? 'Unpin' : 'Pin'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.swipeAction, {backgroundColor: '#ff9900'}]}
          onPress={handleMute}
          activeOpacity={0.7}>
          <Text style={styles.swipeActionIcon}>{item.muted ? 'V' : 'M'}</Text>
          <Text style={styles.swipeActionLabel}>{item.muted ? 'Unmute' : 'Mute'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.swipeAction, {backgroundColor: '#ff4466'}]}
          onPress={handleDelete}
          activeOpacity={0.7}>
          <Text style={styles.swipeActionIcon}>X</Text>
          <Text style={styles.swipeActionLabel}>Delete</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Main chat row */}
      <GestureDetector gesture={panGesture}>
        <Animated.View style={[styles.chatItemRow, animatedRowStyle]}>
          <TouchableOpacity
            style={[styles.chatItem, {backgroundColor: theme.bg}]}
            onPress={() => onPress(item)}
            activeOpacity={0.7}>
            {/* Avatar */}
            <View style={[styles.avatar, {backgroundColor: avatarColors[0]}]}>
              <Text style={styles.avatarText}>{firstLetter}</Text>
              {item.online && (
                <View style={[styles.onlineDot, {borderColor: theme.bg}]} />
              )}
            </View>

            {/* Content */}
            <View style={styles.chatContent}>
              <View style={styles.chatTopRow}>
                <View style={styles.chatNameRow}>
                  {item.pinned && (
                    <Text style={[styles.pinIcon, {color: theme.textMuted}]}>*</Text>
                  )}
                  <Text
                    style={[styles.chatName, {color: theme.text}]}
                    numberOfLines={1}>
                    {item.name}
                  </Text>
                  {item.muted && (
                    <Text style={[styles.mutedIcon, {color: theme.textMuted}]}>M</Text>
                  )}
                </View>
                <Text style={[styles.chatTime, {color: theme.textMuted}]}>
                  {formatTimestamp(item.lastMessageTime)}
                </Text>
              </View>
              <View style={styles.chatBottomRow}>
                <Text
                  style={[
                    styles.chatPreview,
                    {color: item.unread > 0 ? theme.textSecondary : theme.textMuted},
                    item.unread > 0 && {fontWeight: '600'},
                  ]}
                  numberOfLines={1}>
                  {item.lastMessage || 'No messages yet'}
                </Text>
                {item.unread > 0 && (
                  <View style={[styles.unreadBadge, {backgroundColor: theme.accent}]}>
                    <Text style={[styles.unreadText, {color: theme.bg}]}>
                      {item.unread > 99 ? '99+' : item.unread}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </TouchableOpacity>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

// ==================== MAIN CHAT LIST SCREEN ====================
export default function ChatListScreen({navigation}) {
  const {theme} = useTheme();
  const {state, dispatch} = useApp();
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [addPeerModalVisible, setAddPeerModalVisible] = useState(false);
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('connected'); // 'connected' | 'connecting' | 'offline'

  // FAB animation
  const fabScale = useSharedValue(1);
  const fabStyle = useAnimatedStyle(() => ({
    transform: [{scale: fabScale.value}],
  }));

  // Build chat list from peers + messages
  const chatList = useMemo(() => {
    const peers = state.peers || [];
    return peers
      .map(peer => {
        const roomId = peer.roomId || peer.id;
        const msgs = state.messages[roomId] || [];
        const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        const unread = msgs.filter(
          m => !m.read && m.sender !== state.displayName,
        ).length;

        return {
          id: peer.id,
          name: peer.name || peer.displayName || 'Unknown',
          lastMessage: lastMsg ? lastMsg.plainText || '[Encrypted]' : '',
          lastMessageTime: lastMsg ? lastMsg.timestamp : peer.addedAt || 0,
          unread,
          online: peer.online || false,
          pinned: peer.pinned || false,
          muted: peer.muted || false,
          roomId,
        };
      })
      .sort((a, b) => {
        // Pinned first, then by last message time
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return (b.lastMessageTime || 0) - (a.lastMessageTime || 0);
      });
  }, [state.peers, state.messages, state.displayName]);

  // Filtered list based on search
  const filteredChats = useMemo(() => {
    if (!searchQuery.trim()) return chatList;
    const q = searchQuery.toLowerCase().trim();
    return chatList.filter(
      c =>
        c.name.toLowerCase().includes(q) ||
        (c.lastMessage && c.lastMessage.toLowerCase().includes(q)),
    );
  }, [chatList, searchQuery]);

  // Pull to refresh
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    Vibration.vibrate(10);
    // Simulate refresh — in production this would re-check peer connections
    setTimeout(() => setRefreshing(false), 1200);
  }, []);

  // Chat item press
  const handleChatPress = useCallback(
    item => {
      dispatch({type: 'SET_ACTIVE_PEER', payload: item.id});
      navigation.navigate('Chat', {peerId: item.id, peerName: item.name, roomId: item.roomId});
    },
    [dispatch, navigation],
  );

  // Swipe actions
  const handlePin = useCallback(
    peerId => {
      Vibration.vibrate(15);
      const peer = (state.peers || []).find(p => p.id === peerId);
      if (peer) {
        dispatch({
          type: 'UPDATE_PEER',
          payload: {id: peerId, pinned: !peer.pinned},
        });
      }
    },
    [state.peers, dispatch],
  );

  const handleMute = useCallback(
    peerId => {
      Vibration.vibrate(15);
      const peer = (state.peers || []).find(p => p.id === peerId);
      if (peer) {
        dispatch({
          type: 'UPDATE_PEER',
          payload: {id: peerId, muted: !peer.muted},
        });
      }
    },
    [state.peers, dispatch],
  );

  const handleDelete = useCallback(
    (peerId, peerName) => {
      Alert.alert(
        'Delete Conversation',
        `Remove ${peerName} and all messages? This cannot be undone.`,
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              Vibration.vibrate(20);
              dispatch({type: 'REMOVE_PEER', payload: peerId});
            },
          },
        ],
      );
    },
    [dispatch],
  );

  // Add peer via invite code
  const handleAddPeer = useCallback(async () => {
    const code = inviteCodeInput.trim().toUpperCase();
    if (!code) {
      Alert.alert('Invalid Code', 'Enter an invite code to add a peer.');
      return;
    }
    if (!code.startsWith('GL-') || code.length < 35) {
      Alert.alert('Invalid Format', 'Invite codes start with GL- followed by 4 groups of 8 characters.');
      return;
    }

    Vibration.vibrate(20);

    const peerId = `peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fingerprint = await CryptoEngine.sha256(code);

    dispatch({
      type: 'ADD_PEER',
      payload: {
        id: peerId,
        name: `Peer ${(state.peers || []).length + 1}`,
        inviteCode: code,
        fingerprint: fingerprint.slice(0, 16),
        online: false,
        pinned: false,
        muted: false,
        roomId: `room-${peerId}`,
        addedAt: Date.now(),
      },
    });

    setInviteCodeInput('');
    setAddPeerModalVisible(false);
  }, [inviteCodeInput, dispatch, state.peers]);

  // Open QR scanner
  const handleScanQR = useCallback(() => {
    setAddPeerModalVisible(false);
    // Navigate to QR scanner screen if available
    if (navigation.navigate) {
      try {
        navigation.navigate('QRScanner');
      } catch (_e) {
        Alert.alert('QR Scanner', 'QR scanning will be available in a future update.');
      }
    }
  }, [navigation]);

  // FAB press
  const handleFABPress = useCallback(() => {
    fabScale.value = withSequence(
      withSpring(0.85, {damping: 8}),
      withSpring(1, {damping: 8}),
    );
    Vibration.vibrate(15);
    setAddPeerModalVisible(true);
  }, [fabScale]);

  // Settings press
  const handleSettingsPress = useCallback(() => {
    Vibration.vibrate(10);
    navigation.navigate('Settings');
  }, [navigation]);

  // Connection status color
  const statusColor = useMemo(() => {
    switch (connectionStatus) {
      case 'connected':
        return theme.success;
      case 'connecting':
        return theme.warning;
      case 'offline':
        return theme.danger;
      default:
        return theme.textMuted;
    }
  }, [connectionStatus, theme]);

  // FlatList key extractor
  const keyExtractor = useCallback(item => item.id, []);

  // FlatList getItemLayout for fixed-height rows
  const getItemLayout = useCallback(
    (_data, index) => ({
      length: CHAT_ITEM_HEIGHT,
      offset: CHAT_ITEM_HEIGHT * index,
      index,
    }),
    [],
  );

  // Render chat item
  const renderItem = useCallback(
    ({item}) => (
      <ChatItem
        item={item}
        theme={theme}
        onPress={handleChatPress}
        onPin={handlePin}
        onMute={handleMute}
        onDelete={handleDelete}
      />
    ),
    [theme, handleChatPress, handlePin, handleMute, handleDelete],
  );

  // ==================== RENDER ====================
  return (
    <GestureHandlerRootView style={{flex: 1}}>
      <View style={[styles.container, {backgroundColor: theme.bg}]}>
        <StatusBar barStyle="light-content" backgroundColor={theme.bg} />

        {/* ===== HEADER ===== */}
        <View style={[styles.header, {borderBottomColor: theme.border}]}>
          <View style={styles.headerLeft}>
            <View style={[styles.headerGhost, {backgroundColor: theme.accent + '18'}]}>
              <Text style={[styles.headerGhostText, {color: theme.accent}]}>G</Text>
            </View>
            <View>
              <Text style={[styles.headerTitle, {color: theme.text}]}>GhostLink</Text>
              <View style={styles.statusRow}>
                <View style={[styles.statusDot, {backgroundColor: statusColor}]} />
                <Text style={[styles.statusText, {color: theme.textMuted}]}>
                  {connectionStatus === 'connected'
                    ? 'Connected'
                    : connectionStatus === 'connecting'
                    ? 'Connecting...'
                    : 'Offline'}
                </Text>
              </View>
            </View>
          </View>
          <TouchableOpacity
            style={[styles.settingsBtn, {backgroundColor: theme.bgSecondary}]}
            onPress={handleSettingsPress}
            activeOpacity={0.6}>
            <Text style={[styles.settingsIcon, {color: theme.textSecondary}]}>S</Text>
          </TouchableOpacity>
        </View>

        {/* ===== SEARCH BAR ===== */}
        <View style={[styles.searchContainer, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
          <Text style={[styles.searchIcon, {color: theme.textMuted}]}>?</Text>
          <TextInput
            style={[styles.searchInput, {color: theme.text}]}
            placeholder="Search conversations..."
            placeholderTextColor={theme.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')} activeOpacity={0.6}>
              <Text style={[styles.clearIcon, {color: theme.textMuted}]}>X</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ===== CHAT LIST ===== */}
        {filteredChats.length > 0 ? (
          <FlatList
            data={filteredChats}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            getItemLayout={getItemLayout}
            style={styles.chatList}
            contentContainerStyle={styles.chatListContent}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={theme.accent}
                colors={[theme.accent]}
                progressBackgroundColor={theme.bgSecondary}
              />
            }
            initialNumToRender={15}
            maxToRenderPerBatch={10}
            windowSize={11}
            removeClippedSubviews={Platform.OS === 'android'}
          />
        ) : (
          /* ===== EMPTY STATE ===== */
          <View style={styles.emptyContainer}>
            <Animated.View entering={FadeInDown.duration(500)} style={styles.emptyContent}>
              {/* Ghost illustration */}
              <View style={[styles.emptyGhost, {borderColor: theme.accent + '20', backgroundColor: theme.accent + '06'}]}>
                <Text style={[styles.emptyGhostText, {color: theme.accent + '40'}]}>G</Text>
              </View>
              <Text style={[styles.emptyTitle, {color: theme.textSecondary}]}>
                No conversations yet
              </Text>
              <Text style={[styles.emptyDesc, {color: theme.textMuted}]}>
                Tap the + button to add a peer using an{'\n'}invite code or QR scan.
              </Text>

              {/* Invite code display if available */}
              {state.inviteCode ? (
                <View style={[styles.myCodeBox, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                  <Text style={[styles.myCodeLabel, {color: theme.textMuted}]}>
                    Your invite code
                  </Text>
                  <Text style={[styles.myCodeValue, {color: theme.accent}]} selectable>
                    {state.inviteCode}
                  </Text>
                  <Text style={[styles.myCodeHint, {color: theme.textMuted}]}>
                    Share this code with peers to connect
                  </Text>
                </View>
              ) : null}
            </Animated.View>
          </View>
        )}

        {/* ===== OFFLINE STATUS BAR ===== */}
        {connectionStatus === 'offline' && (
          <Animated.View
            entering={SlideInDown.duration(300)}
            exiting={SlideOutDown.duration(200)}
            style={[styles.offlineBar, {backgroundColor: theme.danger + '20', borderTopColor: theme.danger + '40'}]}>
            <View style={[styles.offlineDot, {backgroundColor: theme.danger}]} />
            <Text style={[styles.offlineText, {color: theme.danger}]}>
              No connection. Messages will queue and send when back online.
            </Text>
          </Animated.View>
        )}

        {/* ===== FAB (Add Peer) ===== */}
        <Animated.View style={[styles.fabContainer, fabStyle]}>
          <TouchableOpacity
            style={[styles.fab, {backgroundColor: theme.accent}]}
            onPress={handleFABPress}
            activeOpacity={0.8}>
            <Text style={[styles.fabIcon, {color: theme.bg}]}>+</Text>
          </TouchableOpacity>
        </Animated.View>

        {/* ===== ADD PEER MODAL ===== */}
        <Modal
          visible={addPeerModalVisible}
          animationType="none"
          transparent
          onRequestClose={() => setAddPeerModalVisible(false)}>
          <TouchableOpacity
            style={styles.modalOverlay}
            activeOpacity={1}
            onPress={() => setAddPeerModalVisible(false)}>
            <Animated.View entering={SlideInDown.springify().damping(18)} exiting={SlideOutDown.duration(200)}>
              <TouchableOpacity activeOpacity={1} onPress={() => {}}>
                <View style={[styles.modalContent, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
                  <View style={styles.modalHandle}>
                    <View style={[styles.modalHandleBar, {backgroundColor: theme.textMuted + '40'}]} />
                  </View>

                  <Text style={[styles.modalTitle, {color: theme.text}]}>
                    Add Peer
                  </Text>
                  <Text style={[styles.modalDesc, {color: theme.textSecondary}]}>
                    Enter an invite code or scan a QR code to connect with a peer.
                  </Text>

                  {/* Invite code input */}
                  <View
                    style={[
                      styles.modalInputWrap,
                      {backgroundColor: theme.bgTertiary, borderColor: theme.border},
                    ]}>
                    <TextInput
                      style={[styles.modalInput, {color: theme.text}]}
                      placeholder="GL-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX"
                      placeholderTextColor={theme.textMuted}
                      value={inviteCodeInput}
                      onChangeText={setInviteCodeInput}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      autoFocus
                      returnKeyType="done"
                      onSubmitEditing={handleAddPeer}
                    />
                  </View>

                  <TouchableOpacity
                    style={[styles.modalPrimaryBtn, {backgroundColor: theme.accent}]}
                    onPress={handleAddPeer}
                    activeOpacity={0.7}>
                    <Text style={[styles.modalPrimaryBtnText, {color: theme.bg}]}>
                      Connect
                    </Text>
                  </TouchableOpacity>

                  {/* Divider */}
                  <View style={styles.modalDivider}>
                    <View style={[styles.modalDividerLine, {backgroundColor: theme.border}]} />
                    <Text style={[styles.modalDividerText, {color: theme.textMuted}]}>
                      or
                    </Text>
                    <View style={[styles.modalDividerLine, {backgroundColor: theme.border}]} />
                  </View>

                  {/* QR Scan button */}
                  <TouchableOpacity
                    style={[styles.modalQRBtn, {borderColor: theme.accent + '40', backgroundColor: theme.accent + '08'}]}
                    onPress={handleScanQR}
                    activeOpacity={0.7}>
                    <Text style={[styles.modalQRIcon, {color: theme.accent}]}>[QR]</Text>
                    <Text style={[styles.modalQRText, {color: theme.accent}]}>
                      Scan QR Code
                    </Text>
                  </TouchableOpacity>

                  {/* Cancel */}
                  <TouchableOpacity
                    style={styles.modalCancelBtn}
                    onPress={() => {
                      setInviteCodeInput('');
                      setAddPeerModalVisible(false);
                    }}
                    activeOpacity={0.6}>
                    <Text style={[styles.modalCancelText, {color: theme.textSecondary}]}>
                      Cancel
                    </Text>
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            </Animated.View>
          </TouchableOpacity>
        </Modal>
      </View>
    </GestureHandlerRootView>
  );
}

// ==================== STYLES ====================
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 56 : 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerGhost: {
    width: 38,
    height: 38,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  headerGhostText: {
    fontSize: 20,
    fontWeight: '900',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginRight: 5,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '500',
  },
  settingsBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingsIcon: {
    fontSize: 18,
    fontWeight: '700',
  },

  // Search
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginTop: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
  },
  searchIcon: {
    fontSize: 16,
    fontWeight: '600',
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 11,
    fontWeight: '500',
  },
  clearIcon: {
    fontSize: 14,
    fontWeight: '700',
    paddingLeft: 8,
  },

  // Chat list
  chatList: {
    flex: 1,
  },
  chatListContent: {
    paddingBottom: 100,
  },

  // Chat item
  chatItemContainer: {
    height: CHAT_ITEM_HEIGHT,
    overflow: 'hidden',
  },
  swipeActions: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 220,
    flexDirection: 'row',
  },
  swipeAction: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  swipeActionIcon: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 2,
  },
  swipeActionLabel: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  chatItemRow: {
    height: CHAT_ITEM_HEIGHT,
  },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    height: CHAT_ITEM_HEIGHT,
  },

  // Avatar
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  avatarText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '800',
  },
  onlineDot: {
    position: 'absolute',
    bottom: 1,
    right: 1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#00ffa3',
    borderWidth: 2,
  },

  // Chat content
  chatContent: {
    flex: 1,
  },
  chatTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  chatNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  pinIcon: {
    fontSize: 12,
    fontWeight: '700',
    marginRight: 4,
  },
  chatName: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  mutedIcon: {
    fontSize: 10,
    fontWeight: '700',
    marginLeft: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 3,
    paddingHorizontal: 3,
    paddingVertical: 1,
  },
  chatTime: {
    fontSize: 11,
    fontWeight: '500',
  },
  chatBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  chatPreview: {
    fontSize: 13,
    flex: 1,
    marginRight: 8,
  },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  unreadText: {
    fontSize: 11,
    fontWeight: '800',
  },

  // Empty state
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyContent: {
    alignItems: 'center',
  },
  emptyGhost: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  emptyGhostText: {
    fontSize: 48,
    fontWeight: '900',
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptyDesc: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 24,
  },
  myCodeBox: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    width: '100%',
  },
  myCodeLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  myCodeValue: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  myCodeHint: {
    fontSize: 11,
    fontWeight: '500',
  },

  // Offline bar
  offlineBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderTopWidth: 1,
  },
  offlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  offlineText: {
    fontSize: 12,
    fontWeight: '500',
    flex: 1,
  },

  // FAB
  fabContainer: {
    position: 'absolute',
    right: 20,
    bottom: Platform.OS === 'ios' ? 36 : 24,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 3},
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
  fabIcon: {
    fontSize: 28,
    fontWeight: '400',
    marginTop: -1,
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 24,
    paddingBottom: Platform.OS === 'ios' ? 40 : 28,
  },
  modalHandle: {
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 16,
  },
  modalHandleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 6,
  },
  modalDesc: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 20,
  },
  modalInputWrap: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    marginBottom: 14,
  },
  modalInput: {
    fontSize: 14,
    paddingVertical: 13,
    fontWeight: '500',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  modalPrimaryBtn: {
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    marginBottom: 16,
  },
  modalPrimaryBtnText: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  modalDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalDividerLine: {
    flex: 1,
    height: 1,
  },
  modalDividerText: {
    fontSize: 12,
    fontWeight: '500',
    marginHorizontal: 12,
  },
  modalQRBtn: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 12,
  },
  modalQRIcon: {
    fontSize: 16,
    fontWeight: '700',
    marginRight: 8,
  },
  modalQRText: {
    fontSize: 15,
    fontWeight: '600',
  },
  modalCancelBtn: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  modalCancelText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
