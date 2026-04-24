/**
 * GhostLink Mobile — MessageBubble Component
 *
 * A chat message bubble that supports:
 * - Own vs. other message alignment and coloring
 * - Reply-to previews
 * - File/image attachment rendering
 * - Emoji-only messages rendered larger without a bubble
 * - Timestamps and read receipt indicators
 * - Long-press and reply callbacks
 * - Self-destruct countdown
 * - Pinned message badge
 *
 * @example
 * <MessageBubble
 *   message={{ id: '1', text: 'Hello!', sender: 'Kidus', timestamp: Date.now() }}
 *   isMine={false}
 *   showAvatar
 *   onLongPress={(msg) => handleMenu(msg)}
 *   onReply={(msg) => setReplyTo(msg)}
 * />
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  Vibration,
} from 'react-native';
import GhostAvatar from './GhostAvatar';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Check if a string consists solely of emoji characters (1-3 emoji, no text).
 */
const EMOJI_ONLY_RE =
  /^(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F){1,3}$/u;

function isEmojiOnly(text) {
  if (!text || text.length > 12) return false;
  return EMOJI_ONLY_RE.test(text.trim());
}

/**
 * Format a timestamp for display below the bubble.
 * @param {number|string} ts Epoch ms or ISO string.
 * @returns {string} e.g. "2:34 PM"
 */
function formatTime(ts) {
  try {
    const date = new Date(ts);
    let hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours}:${minutes} ${ampm}`;
  } catch (_) {
    return '';
  }
}

/**
 * Format bytes into a human-readable size string.
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── File Type Colors ───────────────────────────────────────────────────────

const FILE_COLORS = {
  pdf: '#FF4444',
  doc: '#4488FF',
  docx: '#4488FF',
  zip: '#FFAA00',
  png: '#00CC88',
  jpg: '#00CC88',
  jpeg: '#00CC88',
  mp4: '#B347FF',
  py: '#3776AB',
  js: '#F7DF1E',
  json: '#6A6A7A',
  txt: '#8A8A9A',
};

// ─── Read Receipt ───────────────────────────────────────────────────────────

const ReadReceipt = ({ message }) => {
  let symbol;
  let color;

  if (message.read) {
    symbol = '\u2713\u2713';
    color = ACCENT;
  } else if (message.delivered) {
    symbol = '\u2713\u2713';
    color = '#6B7280';
  } else if (message.status === 'sent') {
    symbol = '\u2713';
    color = '#6B7280';
  } else if (message.status === 'sending') {
    symbol = '\u25CB';
    color = '#6B7280';
  } else {
    // Default: single check for sent
    symbol = '\u2713';
    color = '#6B7280';
  }

  return <Text style={[styles.receipt, { color }]}>{symbol}</Text>;
};

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {object} props.message
 *   { id, text/plainText, sender, timestamp, status?, read?, delivered?,
 *     replyTo?, attachment?, file?, type?, selfDestructAt?, isPinned? }
 * @param {boolean} props.isMine         Whether the current user sent this.
 * @param {boolean} [props.showAvatar]   Show sender avatar (for group chats).
 * @param {Function} [props.onLongPress] Called with the message on long-press.
 * @param {Function} [props.onReply]     Called with the message to initiate a reply.
 * @param {object}  [props.replyMessage] The message being replied to (resolved).
 * @param {boolean} [props.isPinned]     Whether this message is pinned.
 */
const MessageBubble = ({
  message,
  isMine,
  showAvatar,
  onLongPress,
  onReply,
  replyMessage,
  isPinned,
}) => {
  // Support both `text` and `plainText` field names
  const text = message.text || message.plainText || '';
  const sender = message.sender || '';
  const timestamp = message.timestamp;
  const replyTo = message.replyTo || replyMessage;
  const attachment = message.attachment || null;
  const file = message.file || null;
  const pinned = isPinned || message.isPinned;

  const emojiOnly = useMemo(() => isEmojiOnly(text), [text]);
  const timeStr = useMemo(() => formatTime(timestamp), [timestamp]);

  // ── Self-destruct countdown ─────────────────────────────────────────────

  const [selfDestructRemaining, setSelfDestructRemaining] = useState(null);

  useEffect(() => {
    if (!message.selfDestructAt) return;
    const interval = setInterval(() => {
      const remaining = Math.max(
        0,
        Math.ceil((message.selfDestructAt - Date.now()) / 1000),
      );
      setSelfDestructRemaining(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [message.selfDestructAt]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleLongPress = useCallback(() => {
    Vibration.vibrate(30);
    if (onLongPress) onLongPress(message);
  }, [message, onLongPress]);

  // ── Reply Preview ───────────────────────────────────────────────────────

  const renderReplyPreview = () => {
    if (!replyTo) return null;
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => onReply && onReply(replyTo)}
        style={styles.replyContainer}
      >
        <View style={styles.replyBar} />
        <View style={styles.replyContent}>
          <Text style={styles.replySender} numberOfLines={1}>
            {replyTo.sender || 'Unknown'}
          </Text>
          <Text style={styles.replyText} numberOfLines={1}>
            {replyTo.text || replyTo.plainText || (replyTo.attachment ? 'Attachment' : '')}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  // ── Attachment ──────────────────────────────────────────────────────────

  const renderAttachment = () => {
    // Image attachment (via attachment prop)
    if (attachment && attachment.type === 'image') {
      return (
        <Image
          source={{ uri: attachment.uri }}
          style={styles.attachmentImage}
          resizeMode="cover"
        />
      );
    }

    // File attachment (via attachment prop or file prop)
    const fileData = attachment || file;
    if (!fileData) return null;

    // If it's an image attachment without explicit type
    if (fileData.uri && /\.(png|jpg|jpeg|gif|webp)$/i.test(fileData.name || '')) {
      return (
        <Image
          source={{ uri: fileData.uri }}
          style={styles.attachmentImage}
          resizeMode="cover"
        />
      );
    }

    const ext = fileData.name
      ? fileData.name.split('.').pop().toLowerCase()
      : null;
    const fileColor = ext ? FILE_COLORS[ext] || '#8A8A9A' : '#8A8A9A';

    return (
      <View style={styles.fileContainer}>
        <View style={[styles.fileIconBox, { backgroundColor: fileColor + '25' }]}>
          <Text style={[styles.fileExt, { color: fileColor }]}>
            {ext ? ext.toUpperCase() : 'FILE'}
          </Text>
        </View>
        <View style={styles.fileInfo}>
          <Text style={styles.fileName} numberOfLines={1}>
            {fileData.name || 'File'}
          </Text>
          {(fileData.size != null) && (
            <Text style={styles.fileSize}>
              {formatFileSize(fileData.size)}
            </Text>
          )}
        </View>
      </View>
    );
  };

  // ── Emoji-Only Message ─────────────────────────────────────────────────

  if (emojiOnly) {
    return (
      <View
        style={[
          styles.row,
          isMine ? styles.rowMine : styles.rowTheirs,
        ]}
      >
        {!isMine && showAvatar && (
          <GhostAvatar name={sender || '?'} size={28} style={styles.avatar} />
        )}
        {!isMine && !showAvatar && <View style={styles.avatarSpacer} />}
        <TouchableOpacity
          activeOpacity={0.7}
          onLongPress={handleLongPress}
          delayLongPress={400}
          style={styles.emojiContainer}
        >
          <Text style={styles.emojiText}>{text}</Text>
          <Text style={[styles.time, styles.emojiTime]}>{timeStr}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Standard Bubble ────────────────────────────────────────────────────

  return (
    <View
      style={[
        styles.row,
        isMine ? styles.rowMine : styles.rowTheirs,
      ]}
    >
      {!isMine && showAvatar && (
        <GhostAvatar name={sender || '?'} size={28} style={styles.avatar} />
      )}
      {!isMine && !showAvatar && <View style={styles.avatarSpacer} />}

      <TouchableOpacity
        activeOpacity={0.8}
        onLongPress={handleLongPress}
        delayLongPress={400}
        style={[
          styles.bubble,
          isMine ? styles.bubbleMine : styles.bubbleTheirs,
          pinned && styles.bubblePinned,
        ]}
      >
        {/* Pinned badge */}
        {pinned && (
          <View style={styles.pinnedBadge}>
            <Text style={styles.pinnedText}>Pinned</Text>
          </View>
        )}

        {/* Sender name (group chats, incoming only) */}
        {!isMine && sender ? (
          <Text style={styles.senderName}>{sender}</Text>
        ) : null}

        {renderReplyPreview()}
        {renderAttachment()}

        {text ? (
          <Text
            selectable
            style={[
              styles.messageText,
              isMine ? styles.textMine : styles.textTheirs,
            ]}
          >
            {text}
          </Text>
        ) : null}

        {/* Footer: self-destruct, time, receipt */}
        <View style={styles.footer}>
          {selfDestructRemaining !== null && (
            <View style={styles.destructBadge}>
              <Text style={styles.destructText}>
                {selfDestructRemaining}s
              </Text>
            </View>
          )}
          <Text
            style={[
              styles.time,
              isMine ? styles.timeMine : styles.timeTheirs,
            ]}
          >
            {timeStr}
          </Text>
          {isMine && <ReadReceipt message={message} />}
        </View>
      </TouchableOpacity>
    </View>
  );
};

// ─── Styles ─────────────────────────────────────────────────────────────────

const ACCENT = '#6366F1';
const BUBBLE_DARK = '#1E1E2E';

const styles = StyleSheet.create({
  // ── Row layout
  row: {
    flexDirection: 'row',
    marginVertical: 2,
    paddingHorizontal: 12,
    alignItems: 'flex-end',
  },
  rowMine: {
    justifyContent: 'flex-end',
  },
  rowTheirs: {
    justifyContent: 'flex-start',
  },

  // ── Avatar
  avatar: {
    marginRight: 6,
    marginBottom: 2,
  },
  avatarSpacer: {
    width: 34, // 28 avatar + 6 margin
  },

  // ── Bubble
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    position: 'relative',
  },
  bubbleMine: {
    backgroundColor: ACCENT,
    borderBottomRightRadius: 4,
    borderWidth: 1,
    borderColor: ACCENT + '30',
  },
  bubbleTheirs: {
    backgroundColor: BUBBLE_DARK,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: '#2A2A3E',
  },
  bubblePinned: {
    borderColor: '#EAB30860',
    borderWidth: 1.5,
  },

  // ── Pinned badge
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
    color: '#EAB308',
  },

  // ── Sender name
  senderName: {
    fontSize: 12,
    fontWeight: '700',
    color: '#A5B4FC',
    marginBottom: 3,
    letterSpacing: 0.3,
  },

  // ── Text
  messageText: {
    fontSize: 15,
    lineHeight: 21,
    letterSpacing: 0.1,
  },
  textMine: {
    color: '#FFFFFF',
  },
  textTheirs: {
    color: '#E5E7EB',
  },

  // ── Footer (time + receipt)
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: 4,
    gap: 6,
  },
  time: {
    fontSize: 10,
  },
  timeMine: {
    color: 'rgba(255, 255, 255, 0.6)',
  },
  timeTheirs: {
    color: '#6B7280',
  },
  receipt: {
    fontSize: 12,
    fontWeight: '700',
  },

  // ── Self-destruct
  destructBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: '#EF444420',
  },
  destructText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#EF4444',
  },

  // ── Reply preview
  replyContainer: {
    flexDirection: 'row',
    marginBottom: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
    overflow: 'hidden',
  },
  replyBar: {
    width: 3,
    backgroundColor: '#A5B4FC',
  },
  replyContent: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  replySender: {
    fontSize: 11,
    fontWeight: '700',
    color: '#A5B4FC',
  },
  replyText: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.7)',
    marginTop: 1,
  },

  // ── Attachment: image
  attachmentImage: {
    width: 200,
    height: 150,
    borderRadius: 8,
    marginBottom: 4,
  },

  // ── Attachment: file
  fileContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
    borderRadius: 10,
    padding: 10,
    marginBottom: 6,
  },
  fileIconBox: {
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
    color: '#E5E7EB',
  },
  fileSize: {
    fontSize: 11,
    color: '#9CA3AF',
    marginTop: 2,
  },

  // ── Emoji-only
  emojiContainer: {
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  emojiText: {
    fontSize: 40,
    lineHeight: 48,
  },
  emojiTime: {
    color: '#6B7280',
    marginTop: 0,
  },
});

export default React.memo(MessageBubble);
