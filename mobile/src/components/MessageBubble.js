import React, {useState, useEffect, useCallback} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, Vibration} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  FadeIn,
  SlideInRight,
  SlideInLeft,
} from 'react-native-reanimated';
import {useTheme} from '../context/ThemeContext';

const FILE_ICONS = {
  pdf: '#ff4444',
  doc: '#4488ff',
  zip: '#ffaa00',
  png: '#00cc88',
  jpg: '#00cc88',
  mp4: '#b347ff',
  py: '#3776ab',
  js: '#f7df1e',
  json: '#6a6a7a',
  txt: '#8a8a9a',
};

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

export default function MessageBubble({
  message,
  isMine,
  onLongPress,
  onReplyPress,
  replyMessage,
  isPinned,
}) {
  const {theme} = useTheme();
  const [selfDestructRemaining, setSelfDestructRemaining] = useState(null);
  const opacity = useSharedValue(1);
  const scale = useSharedValue(1);

  useEffect(() => {
    if (message.selfDestructAt) {
      const interval = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((message.selfDestructAt - Date.now()) / 1000));
        setSelfDestructRemaining(remaining);
        if (remaining <= 0) {
          opacity.value = withTiming(0, {duration: 500});
          scale.value = withTiming(0.8, {duration: 500});
          clearInterval(interval);
        }
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [message.selfDestructAt, opacity, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{scale: scale.value}],
  }));

  const handleLongPress = useCallback(() => {
    Vibration.vibrate(30);
    if (onLongPress) {
      onLongPress(message);
    }
  }, [message, onLongPress]);

  const ext = message.file ? message.file.name.split('.').pop().toLowerCase() : null;
  const fileColor = ext ? FILE_ICONS[ext] || theme.textMuted : theme.textMuted;

  const entering = isMine ? SlideInRight.duration(250).springify() : SlideInLeft.duration(250).springify();

  return (
    <Animated.View
      entering={entering}
      style={[
        animatedStyle,
        styles.wrapper,
        {alignItems: isMine ? 'flex-end' : 'flex-start'},
      ]}>
      <TouchableOpacity
        activeOpacity={0.8}
        onLongPress={handleLongPress}
        delayLongPress={400}
        style={[
          styles.bubble,
          {
            backgroundColor: isMine ? theme.accentDim : theme.bgTertiary,
            borderColor: isMine ? theme.accent + '30' : theme.border,
            borderWidth: 1,
            maxWidth: '82%',
          },
          isPinned && {borderColor: theme.warning + '60', borderWidth: 1.5},
        ]}>
        {isPinned && (
          <View style={styles.pinnedBadge}>
            <Text style={[styles.pinnedText, {color: theme.warning}]}>Pinned</Text>
          </View>
        )}

        {replyMessage && (
          <TouchableOpacity
            onPress={() => onReplyPress && onReplyPress(replyMessage.id)}
            style={[
              styles.replyPreview,
              {
                backgroundColor: theme.bg + 'aa',
                borderLeftColor: theme.accent,
              },
            ]}>
            <Text style={[styles.replyName, {color: theme.accent}]} numberOfLines={1}>
              {replyMessage.sender}
            </Text>
            <Text style={[styles.replyText, {color: theme.textSecondary}]} numberOfLines={1}>
              {replyMessage.plainText}
            </Text>
          </TouchableOpacity>
        )}

        {!isMine && (
          <Text style={[styles.senderName, {color: theme.accent}]}>
            {message.sender}
          </Text>
        )}

        {message.type === 'file' && message.file && (
          <View style={[styles.fileAttachment, {backgroundColor: theme.bg + '80'}]}>
            <View style={[styles.fileIcon, {backgroundColor: fileColor + '25'}]}>
              <Text style={[styles.fileExt, {color: fileColor}]}>
                {ext ? ext.toUpperCase() : 'FILE'}
              </Text>
            </View>
            <View style={styles.fileInfo}>
              <Text style={[styles.fileName, {color: theme.text}]} numberOfLines={1}>
                {message.file.name}
              </Text>
              <Text style={[styles.fileSize, {color: theme.textSecondary}]}>
                {formatFileSize(message.file.size || 0)}
              </Text>
            </View>
          </View>
        )}

        <Text style={[styles.messageText, {color: isMine ? theme.text : theme.text}]}>
          {message.plainText}
        </Text>

        <View style={styles.metaRow}>
          {selfDestructRemaining !== null && (
            <View style={[styles.destructBadge, {backgroundColor: theme.danger + '20'}]}>
              <Text style={[styles.destructText, {color: theme.danger}]}>
                {selfDestructRemaining}s
              </Text>
            </View>
          )}
          <Text style={[styles.timestamp, {color: theme.textMuted}]}>
            {formatTime(message.timestamp)}
          </Text>
          {isMine && (
            <Text style={[styles.readReceipt, {color: message.read ? theme.accent : theme.textMuted}]}>
              {message.read ? '\u2713\u2713' : message.delivered ? '\u2713' : '\u25CB'}
            </Text>
          )}
        </View>

        <View
          style={[
            styles.encryptedBadge,
            {backgroundColor: theme.accent + '10'},
          ]}>
          <Text style={[styles.encryptedText, {color: theme.accent + '60'}]}>
            E2E
          </Text>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: 12,
    marginVertical: 2,
  },
  bubble: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    paddingBottom: 8,
    position: 'relative',
  },
  pinnedBadge: {
    position: 'absolute',
    top: -8,
    right: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  pinnedText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  replyPreview: {
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 6,
  },
  replyName: {
    fontSize: 11,
    fontWeight: '700',
  },
  replyText: {
    fontSize: 12,
    marginTop: 1,
  },
  senderName: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 3,
    letterSpacing: 0.3,
  },
  fileAttachment: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    padding: 10,
    marginBottom: 6,
  },
  fileIcon: {
    width: 42,
    height: 42,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileExt: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  fileInfo: {
    marginLeft: 10,
    flex: 1,
  },
  fileName: {
    fontSize: 13,
    fontWeight: '600',
  },
  fileSize: {
    fontSize: 11,
    marginTop: 2,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 21,
    letterSpacing: 0.1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 4,
    gap: 6,
  },
  destructBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  destructText: {
    fontSize: 10,
    fontWeight: '700',
  },
  timestamp: {
    fontSize: 10,
  },
  readReceipt: {
    fontSize: 12,
    fontWeight: '700',
  },
  encryptedBadge: {
    position: 'absolute',
    top: 4,
    right: 6,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  encryptedText: {
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
});
