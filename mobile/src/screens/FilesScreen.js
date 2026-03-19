import React, {useMemo, useCallback} from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Vibration,
  Alert,
} from 'react-native';
import Animated, {FadeInDown} from 'react-native-reanimated';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';

const FILE_COLORS = {
  pdf: '#ff4444',
  doc: '#4488ff',
  docx: '#4488ff',
  zip: '#ffaa00',
  rar: '#ffaa00',
  png: '#00cc88',
  jpg: '#00cc88',
  jpeg: '#00cc88',
  gif: '#00cc88',
  mp4: '#b347ff',
  mp3: '#b347ff',
  wav: '#b347ff',
  py: '#3776ab',
  js: '#f7df1e',
  ts: '#3178c6',
  json: '#6a6a7a',
  txt: '#8a8a9a',
  csv: '#22aa44',
};

function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString([], {month: 'short', day: 'numeric'});
}

export default function FilesScreen() {
  const {theme} = useTheme();
  const {state} = useApp();

  const files = useMemo(() => {
    const allFiles = [];
    Object.entries(state.messages).forEach(([roomId, msgs]) => {
      msgs.forEach(msg => {
        if (msg.type === 'file' && msg.file) {
          allFiles.push({
            ...msg.file,
            messageId: msg.id,
            sender: msg.sender,
            timestamp: msg.timestamp,
            roomId,
          });
        }
      });
    });
    return allFiles.sort((a, b) => b.timestamp - a.timestamp);
  }, [state.messages]);

  const totalSize = useMemo(
    () => files.reduce((sum, f) => sum + (f.size || 0), 0),
    [files],
  );

  const renderFile = useCallback(
    ({item, index}) => {
      const ext = (item.name || '').split('.').pop().toLowerCase();
      const color = FILE_COLORS[ext] || theme.textMuted;

      return (
        <Animated.View entering={FadeInDown.delay(index * 50).duration(250)}>
          <TouchableOpacity
            style={[styles.fileItem, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}
            onPress={() => {
              Vibration.vibrate(15);
              Alert.alert('File', `${item.name}\nFrom: ${item.sender}\nSize: ${formatSize(item.size)}`);
            }}
            activeOpacity={0.7}>
            <View style={[styles.fileIcon, {backgroundColor: color + '20'}]}>
              <Text style={[styles.fileExt, {color}]}>
                {ext ? ext.toUpperCase() : 'FILE'}
              </Text>
            </View>
            <View style={styles.fileInfo}>
              <Text style={[styles.fileName, {color: theme.text}]} numberOfLines={1}>
                {item.name}
              </Text>
              <View style={styles.fileMeta}>
                <Text style={[styles.fileSender, {color: theme.textSecondary}]}>
                  {item.sender}
                </Text>
                <Text style={[styles.fileDot, {color: theme.textMuted}]}>{'\u00B7'}</Text>
                <Text style={[styles.fileSize, {color: theme.textMuted}]}>
                  {formatSize(item.size)}
                </Text>
                <Text style={[styles.fileDot, {color: theme.textMuted}]}>{'\u00B7'}</Text>
                <Text style={[styles.fileDate, {color: theme.textMuted}]}>
                  {formatDate(item.timestamp)}
                </Text>
              </View>
            </View>
            <View style={[styles.encBadge, {backgroundColor: theme.accent + '10'}]}>
              <Text style={[styles.encBadgeText, {color: theme.accent + '60'}]}>E2E</Text>
            </View>
          </TouchableOpacity>
        </Animated.View>
      );
    },
    [theme],
  );

  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      <View style={[styles.header, {backgroundColor: theme.bgSecondary, borderBottomColor: theme.border}]}>
        <Text style={[styles.headerTitle, {color: theme.text}]}>Files</Text>
        <View style={[styles.sizeTag, {backgroundColor: theme.accentDim}]}>
          <Text style={[styles.sizeText, {color: theme.accent}]}>
            {files.length} files {'\u00B7'} {formatSize(totalSize)}
          </Text>
        </View>
      </View>

      <FlatList
        data={files}
        keyExtractor={(item, idx) => `file-${idx}-${item.messageId}`}
        renderItem={renderFile}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={[styles.emptyIcon, {color: theme.accent + '30'}]}>{'\u{1F4C1}'}</Text>
            <Text style={[styles.emptyTitle, {color: theme.textSecondary}]}>No Files</Text>
            <Text style={[styles.emptyDesc, {color: theme.textMuted}]}>
              Encrypted file transfers will appear here.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    paddingTop: 48,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '800',
  },
  sizeTag: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  sizeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  list: {
    padding: 12,
    paddingBottom: 30,
  },
  fileItem: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 8,
  },
  fileIcon: {
    width: 46,
    height: 46,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileExt: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  fileInfo: {
    flex: 1,
    marginLeft: 12,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 3,
  },
  fileMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  fileSender: {
    fontSize: 11,
  },
  fileDot: {
    fontSize: 10,
  },
  fileSize: {
    fontSize: 11,
  },
  fileDate: {
    fontSize: 11,
  },
  encBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 8,
  },
  encBadgeText: {
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
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
});
