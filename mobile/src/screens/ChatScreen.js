import React, {useState, useCallback, useRef, useEffect, useMemo} from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Vibration,
  Dimensions,
  Modal,
  RefreshControl,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Clipboard,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  SlideInUp,
  SlideOutDown,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';
import MessageBubble from '../components/MessageBubble';
import PeerAvatar from '../components/PeerAvatar';

const EMOJIS = ['😀','😂','😍','🥰','😎','🤔','😤','😭','🥺','😅','🙏','👍','👎','❤️','🔥','✅','⚡','🎉','👀','💀','🤝','🚀','💡','🔒','⚠️','📎','📁','🛡️','🌐','💬'];
const SELF_DESTRUCT_OPTIONS = [0, 5, 15, 30, 60, 300, 900];

const {width: SCREEN_WIDTH} = Dimensions.get('window');
const IS_TABLET = SCREEN_WIDTH >= 768;

export default function ChatScreen({navigation}) {
  const {theme} = useTheme();
  const {state, dispatch, sendMessage} = useApp();
  const [inputText, setInputText] = useState('');
  const [showPeerList, setShowPeerList] = useState(IS_TABLET);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showSelfDestruct, setShowSelfDestruct] = useState(false);
  const [selfDestructTime, setSelfDestructTime] = useState(0);
  const [replyTo, setReplyTo] = useState(null);
  const [contextMessage, setContextMessage] = useState(null);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const flatListRef = useRef(null);

  const currentRoom = state.activeRoom || 'general';
  const messages = state.messages[currentRoom] || [];
  const pinnedIds = state.pinnedMessages[currentRoom] || [];

  const filteredMessages = useMemo(() => {
    if (!searchQuery.trim()) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter(
      m =>
        m.plainText.toLowerCase().includes(q) ||
        m.sender.toLowerCase().includes(q),
    );
  }, [messages, searchQuery]);

  const demoPeers = useMemo(
    () =>
      state.peers.length > 0
        ? state.peers
        : [
            {id: 'p1', name: 'Phantom Node', online: true, typing: false},
            {id: 'p2', name: 'Cipher', online: true, typing: false},
            {id: 'p3', name: 'Specter', online: false, typing: false},
            {id: 'p4', name: 'Wraith', online: false, typing: false},
          ],
    [state.peers],
  );

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({animated: true});
      }, 100);
    }
  }, [messages.length]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text) return;
    Vibration.vibrate(15);
    await sendMessage(currentRoom, text, {
      replyTo: replyTo?.id || null,
      selfDestruct: selfDestructTime,
    });
    setInputText('');
    setReplyTo(null);
    setSelfDestructTime(0);
    setShowSelfDestruct(false);
    setTimeout(() => flatListRef.current?.scrollToEnd({animated: true}), 100);
  }, [inputText, currentRoom, replyTo, selfDestructTime, sendMessage]);

  const handleLongPress = useCallback((message) => {
    setContextMessage(message);
    setShowContextMenu(true);
    Vibration.vibrate(30);
  }, []);

  const handleContextAction = useCallback(
    (action) => {
      if (!contextMessage) return;
      Vibration.vibrate(15);
      switch (action) {
        case 'reply':
          setReplyTo(contextMessage);
          break;
        case 'pin':
          dispatch({
            type: 'PIN_MESSAGE',
            payload: {roomId: currentRoom, messageId: contextMessage.id},
          });
          break;
        case 'copy':
          Clipboard.setString(contextMessage.plainText);
          break;
        case 'delete':
          Alert.alert('Delete Message', 'Remove this message?', [
            {text: 'Cancel', style: 'cancel'},
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () =>
                dispatch({
                  type: 'DELETE_MESSAGE',
                  payload: {roomId: currentRoom, messageId: contextMessage.id},
                }),
            },
          ]);
          break;
      }
      setShowContextMenu(false);
      setContextMessage(null);
    },
    [contextMessage, currentRoom, dispatch],
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    Vibration.vibrate(10);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  const handleEmojiSelect = useCallback((emoji) => {
    setInputText(prev => prev + emoji);
    setShowEmoji(false);
  }, []);

  const renderPeerItem = useCallback(
    ({item}) => (
      <TouchableOpacity
        style={[
          styles.peerItem,
          {
            backgroundColor:
              state.activePeer === item.id ? theme.accentDim : 'transparent',
            borderColor: theme.border,
          },
        ]}
        onPress={() => {
          dispatch({type: 'SET_ACTIVE_PEER', payload: item.id});
          dispatch({type: 'SET_ACTIVE_ROOM', payload: item.id});
          if (!IS_TABLET) setShowPeerList(false);
          Vibration.vibrate(10);
        }}>
        <PeerAvatar name={item.name} size={40} online={item.online} typing={item.typing} />
        <View style={styles.peerInfo}>
          <Text style={[styles.peerName, {color: theme.text}]} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={[styles.peerStatus, {color: item.online ? theme.accent : theme.textMuted}]}>
            {item.typing ? 'typing...' : item.online ? 'online' : 'offline'}
          </Text>
        </View>
      </TouchableOpacity>
    ),
    [state.activePeer, theme, dispatch],
  );

  const renderMessage = useCallback(
    ({item}) => {
      const isMine = item.sender === state.displayName;
      const replyMsg = item.replyTo
        ? messages.find(m => m.id === item.replyTo)
        : null;
      return (
        <MessageBubble
          message={item}
          isMine={isMine}
          onLongPress={handleLongPress}
          replyMessage={replyMsg}
          isPinned={pinnedIds.includes(item.id)}
        />
      );
    },
    [state.displayName, messages, pinnedIds, handleLongPress],
  );

  const peerListPanel = (
    <Animated.View
      entering={FadeIn.duration(200)}
      style={[
        styles.peerPanel,
        {
          backgroundColor: theme.bgSecondary,
          borderRightColor: theme.border,
          width: IS_TABLET ? 280 : '100%',
        },
      ]}>
      <View style={[styles.peerHeader, {borderBottomColor: theme.border}]}>
        <Text style={[styles.peerHeaderTitle, {color: theme.text}]}>Peers</Text>
        <View style={styles.peerHeaderActions}>
          <TouchableOpacity
            style={[styles.iconBtn, {backgroundColor: theme.accentDim}]}
            onPress={() => navigation.navigate('QRScanner')}>
            <Text style={[styles.iconBtnText, {color: theme.accent}]}>QR</Text>
          </TouchableOpacity>
          {!IS_TABLET && (
            <TouchableOpacity
              style={[styles.iconBtn, {backgroundColor: theme.bgTertiary}]}
              onPress={() => setShowPeerList(false)}>
              <Text style={[styles.iconBtnText, {color: theme.textSecondary}]}>X</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
      <FlatList
        data={demoPeers}
        keyExtractor={item => item.id}
        renderItem={renderPeerItem}
        contentContainerStyle={styles.peerListContent}
      />
      <TouchableOpacity
        style={[styles.inviteBtn, {backgroundColor: theme.accentDim, borderColor: theme.accent + '30'}]}
        onPress={() => {
          if (state.inviteCode) {
            Clipboard.setString(state.inviteCode);
            Alert.alert('Copied', 'Invite code copied to clipboard');
          }
        }}>
        <Text style={[styles.inviteBtnText, {color: theme.accent}]}>
          Share Invite Code
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );

  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      <View style={styles.mainLayout}>
        {(showPeerList || IS_TABLET) && peerListPanel}

        <KeyboardAvoidingView
          style={styles.chatArea}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={90}>
          <View style={[styles.chatHeader, {backgroundColor: theme.bgSecondary, borderBottomColor: theme.border}]}>
            <View style={styles.chatHeaderLeft}>
              {!IS_TABLET && (
                <TouchableOpacity
                  onPress={() => {
                    setShowPeerList(true);
                    Vibration.vibrate(10);
                  }}
                  style={styles.menuBtn}>
                  <Text style={[styles.menuIcon, {color: theme.accent}]}>{'\u2630'}</Text>
                </TouchableOpacity>
              )}
              <View>
                <Text style={[styles.chatTitle, {color: theme.text}]} numberOfLines={1}>
                  {state.activePeer
                    ? demoPeers.find(p => p.id === state.activePeer)?.name || 'Chat'
                    : 'General'}
                </Text>
                <Text style={[styles.chatSubtitle, {color: theme.textMuted}]}>
                  E2E encrypted
                </Text>
              </View>
            </View>
            <View style={styles.chatHeaderRight}>
              <TouchableOpacity
                style={[styles.headerIconBtn, {backgroundColor: theme.bgTertiary}]}
                onPress={() => {
                  setShowSearch(s => !s);
                  Vibration.vibrate(10);
                }}>
                <Text style={{color: theme.textSecondary, fontSize: 16}}>{'\u{1F50D}'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.headerIconBtn, {backgroundColor: theme.bgTertiary}]}
                onPress={() => {
                  navigation.navigate('Calls', {peer: state.activePeer, video: false});
                  Vibration.vibrate(10);
                }}>
                <Text style={{color: theme.accent, fontSize: 16}}>{'\u{1F4DE}'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.headerIconBtn, {backgroundColor: theme.bgTertiary}]}
                onPress={() => {
                  navigation.navigate('Calls', {peer: state.activePeer, video: true});
                  Vibration.vibrate(10);
                }}>
                <Text style={{color: theme.accent, fontSize: 16}}>{'\u{1F4F9}'}</Text>
              </TouchableOpacity>
            </View>
          </View>

          {showSearch && (
            <Animated.View
              entering={SlideInUp.duration(200)}
              exiting={SlideOutDown.duration(200)}
              style={[styles.searchBar, {backgroundColor: theme.bgSecondary, borderBottomColor: theme.border}]}>
              <TextInput
                style={[styles.searchInput, {color: theme.text, backgroundColor: theme.bgTertiary}]}
                placeholder="Search messages..."
                placeholderTextColor={theme.textMuted}
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoFocus
              />
            </Animated.View>
          )}

          <FlatList
            ref={flatListRef}
            data={filteredMessages}
            keyExtractor={item => item.id}
            renderItem={renderMessage}
            contentContainerStyle={styles.messageList}
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
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={[styles.emptyIcon, {color: theme.accent + '40'}]}>G</Text>
                <Text style={[styles.emptyTitle, {color: theme.textSecondary}]}>
                  No messages yet
                </Text>
                <Text style={[styles.emptyDesc, {color: theme.textMuted}]}>
                  Send an encrypted message to start the conversation.
                </Text>
              </View>
            }
          />

          {replyTo && (
            <Animated.View
              entering={SlideInUp.duration(200)}
              style={[
                styles.replyBar,
                {backgroundColor: theme.bgSecondary, borderTopColor: theme.border},
              ]}>
              <View style={[styles.replyLine, {backgroundColor: theme.accent}]} />
              <View style={styles.replyContent}>
                <Text style={[styles.replyLabel, {color: theme.accent}]}>
                  Replying to {replyTo.sender}
                </Text>
                <Text style={[styles.replyPreviewText, {color: theme.textSecondary}]} numberOfLines={1}>
                  {replyTo.plainText}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setReplyTo(null)}>
                <Text style={{color: theme.textMuted, fontSize: 18}}>X</Text>
              </TouchableOpacity>
            </Animated.View>
          )}

          <View
            style={[
              styles.inputBar,
              {backgroundColor: theme.bgSecondary, borderTopColor: theme.border},
            ]}>
            <TouchableOpacity
              style={styles.inputAction}
              onPress={() => {
                Vibration.vibrate(10);
                Alert.alert('Attach File', 'File picker would open here');
              }}>
              <Text style={{color: theme.textSecondary, fontSize: 20}}>{'\u{1F4CE}'}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.inputAction}
              onPress={() => {
                setShowEmoji(e => !e);
                Vibration.vibrate(10);
              }}>
              <Text style={{color: theme.textSecondary, fontSize: 20}}>{'\u{1F600}'}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.destructToggle,
                selfDestructTime > 0 && {backgroundColor: theme.danger + '20'},
              ]}
              onPress={() => {
                setShowSelfDestruct(s => !s);
                Vibration.vibrate(10);
              }}>
              <Text style={{color: selfDestructTime > 0 ? theme.danger : theme.textMuted, fontSize: 16}}>
                {selfDestructTime > 0 ? `${selfDestructTime}s` : '\u{23F2}'}
              </Text>
            </TouchableOpacity>

            <View
              style={[
                styles.inputField,
                {backgroundColor: theme.bgTertiary, borderColor: theme.border},
              ]}>
              <TextInput
                style={[styles.textInput, {color: theme.text}]}
                placeholder="Encrypted message..."
                placeholderTextColor={theme.textMuted}
                value={inputText}
                onChangeText={setInputText}
                multiline
                maxLength={4096}
                returnKeyType="default"
              />
            </View>

            <TouchableOpacity
              style={[
                styles.sendBtn,
                {backgroundColor: inputText.trim() ? theme.accent : theme.bgTertiary},
              ]}
              onPress={handleSend}
              disabled={!inputText.trim()}>
              <Text
                style={{
                  color: inputText.trim() ? theme.bg : theme.textMuted,
                  fontSize: 16,
                  fontWeight: '800',
                }}>
                {'\u2191'}
              </Text>
            </TouchableOpacity>
          </View>

          {showEmoji && (
            <Animated.View
              entering={SlideInUp.duration(200)}
              exiting={SlideOutDown.duration(150)}
              style={[styles.emojiPanel, {backgroundColor: theme.bgSecondary, borderTopColor: theme.border}]}>
              <View style={styles.emojiGrid}>
                {EMOJIS.map((emoji, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={styles.emojiItem}
                    onPress={() => handleEmojiSelect(emoji)}>
                    <Text style={styles.emojiText}>{emoji}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Animated.View>
          )}

          {showSelfDestruct && (
            <Animated.View
              entering={SlideInUp.duration(200)}
              exiting={SlideOutDown.duration(150)}
              style={[styles.destructPanel, {backgroundColor: theme.bgSecondary, borderTopColor: theme.border}]}>
              <Text style={[styles.destructTitle, {color: theme.text}]}>
                Self-Destruct Timer
              </Text>
              <View style={styles.destructOptions}>
                {SELF_DESTRUCT_OPTIONS.map(sec => (
                  <TouchableOpacity
                    key={sec}
                    style={[
                      styles.destructOption,
                      {
                        backgroundColor:
                          selfDestructTime === sec ? theme.danger + '25' : theme.bgTertiary,
                        borderColor:
                          selfDestructTime === sec ? theme.danger : theme.border,
                      },
                    ]}
                    onPress={() => {
                      setSelfDestructTime(sec);
                      setShowSelfDestruct(false);
                      Vibration.vibrate(15);
                    }}>
                    <Text
                      style={{
                        color: selfDestructTime === sec ? theme.danger : theme.textSecondary,
                        fontWeight: '600',
                        fontSize: 13,
                      }}>
                      {sec === 0 ? 'OFF' : sec < 60 ? `${sec}s` : `${sec / 60}m`}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Animated.View>
          )}
        </KeyboardAvoidingView>
      </View>

      <Modal
        visible={showContextMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowContextMenu(false)}>
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowContextMenu(false)}>
          <Animated.View
            entering={FadeIn.duration(150)}
            style={[styles.contextMenu, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
            {contextMessage && (
              <View style={[styles.contextPreview, {borderBottomColor: theme.border}]}>
                <Text style={[styles.contextPreviewText, {color: theme.textSecondary}]} numberOfLines={2}>
                  {contextMessage.plainText}
                </Text>
              </View>
            )}
            {[
              {key: 'reply', label: 'Reply', icon: '\u21A9'},
              {key: 'pin', label: pinnedIds.includes(contextMessage?.id) ? 'Unpin' : 'Pin', icon: '\u2B50'},
              {key: 'copy', label: 'Copy Text', icon: '\u{1F4CB}'},
              {key: 'delete', label: 'Delete', icon: '\u{1F5D1}', danger: true},
            ].map(action => (
              <TouchableOpacity
                key={action.key}
                style={[styles.contextItem, {borderBottomColor: theme.border}]}
                onPress={() => handleContextAction(action.key)}>
                <Text style={styles.contextIcon}>{action.icon}</Text>
                <Text
                  style={[
                    styles.contextLabel,
                    {color: action.danger ? theme.danger : theme.text},
                  ]}>
                  {action.label}
                </Text>
              </TouchableOpacity>
            ))}
          </Animated.View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  mainLayout: {
    flex: 1,
    flexDirection: 'row',
  },
  peerPanel: {
    borderRightWidth: 1,
  },
  peerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  peerHeaderTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  peerHeaderActions: {
    flexDirection: 'row',
    gap: 8,
  },
  iconBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  iconBtnText: {
    fontSize: 13,
    fontWeight: '700',
  },
  peerListContent: {
    padding: 8,
  },
  peerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 12,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  peerInfo: {
    marginLeft: 12,
    flex: 1,
  },
  peerName: {
    fontSize: 14,
    fontWeight: '600',
  },
  peerStatus: {
    fontSize: 11,
    marginTop: 1,
  },
  inviteBtn: {
    margin: 12,
    padding: 12,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  inviteBtnText: {
    fontSize: 13,
    fontWeight: '700',
  },
  chatArea: {
    flex: 1,
  },
  chatHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  chatHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  menuBtn: {
    marginRight: 12,
  },
  menuIcon: {
    fontSize: 22,
    fontWeight: '700',
  },
  chatTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  chatSubtitle: {
    fontSize: 11,
    marginTop: 1,
  },
  chatHeaderRight: {
    flexDirection: 'row',
    gap: 6,
  },
  headerIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchBar: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  searchInput: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
  },
  messageList: {
    paddingVertical: 10,
    flexGrow: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyIcon: {
    fontSize: 60,
    fontWeight: '900',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 6,
  },
  emptyDesc: {
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: 1,
  },
  replyLine: {
    width: 3,
    height: '100%',
    borderRadius: 2,
    marginRight: 10,
  },
  replyContent: {
    flex: 1,
  },
  replyLabel: {
    fontSize: 12,
    fontWeight: '700',
  },
  replyPreviewText: {
    fontSize: 13,
    marginTop: 1,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderTopWidth: 1,
    gap: 4,
  },
  inputAction: {
    width: 36,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  destructToggle: {
    width: 36,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
  },
  inputField: {
    flex: 1,
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 14,
    minHeight: 40,
    maxHeight: 120,
    justifyContent: 'center',
  },
  textInput: {
    fontSize: 15,
    paddingVertical: 8,
    maxHeight: 100,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emojiPanel: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
  },
  emojiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  emojiItem: {
    width: '10%',
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emojiText: {
    fontSize: 24,
  },
  destructPanel: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
  },
  destructTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 10,
  },
  destructOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  destructOption: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  contextMenu: {
    width: 260,
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  contextPreview: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  contextPreviewText: {
    fontSize: 13,
  },
  contextItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  contextIcon: {
    fontSize: 18,
    marginRight: 12,
  },
  contextLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
});
