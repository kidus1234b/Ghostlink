import React, {useMemo, useState, useCallback} from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Modal,
  Vibration,
  Clipboard,
  Alert,
} from 'react-native';
import Animated, {FadeInDown, FadeIn} from 'react-native-reanimated';
import {useTheme} from '../context/ThemeContext';
import {useApp} from '../context/AppContext';

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString([], {month: 'short', day: 'numeric', year: 'numeric'});
}

export default function ChainScreen() {
  const {theme} = useTheme();
  const {state} = useApp();
  const [selectedBlock, setSelectedBlock] = useState(null);

  const chain = state.chain || [];

  const stats = useMemo(() => ({
    totalBlocks: chain.length,
    totalSize: JSON.stringify(chain).length,
    verified: chain.length > 0,
    firstBlock: chain.length > 0 ? chain[0].ts : null,
    lastBlock: chain.length > 0 ? chain[chain.length - 1].ts : null,
  }), [chain]);

  const handleBlockPress = useCallback((block) => {
    Vibration.vibrate(15);
    setSelectedBlock(block);
  }, []);

  const handleExportChain = useCallback(() => {
    Vibration.vibrate(20);
    Clipboard.setString(JSON.stringify(chain, null, 2));
    Alert.alert('Exported', 'Full blockchain data copied to clipboard.');
  }, [chain]);

  const renderBlock = useCallback(
    ({item, index}) => (
      <Animated.View entering={FadeInDown.delay(index * 40).duration(250)}>
        <TouchableOpacity
          style={[styles.block, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}
          onPress={() => handleBlockPress(item)}
          activeOpacity={0.7}>
          <View style={styles.blockHeader}>
            <View style={[styles.blockIndex, {backgroundColor: theme.accentDim}]}>
              <Text style={[styles.blockIndexText, {color: theme.accent}]}>#{item.index}</Text>
            </View>
            <Text style={[styles.blockTime, {color: theme.textMuted}]}>{formatTime(item.ts)}</Text>
          </View>
          <View style={styles.blockBody}>
            <Text style={[styles.blockSender, {color: theme.text}]}>{item.sender}</Text>
            <Text style={[styles.blockType, {color: theme.textSecondary}]}>{item.type}</Text>
          </View>
          <Text style={[styles.blockHash, {color: theme.accent + '80'}]} numberOfLines={1}>
            {item.hash}
          </Text>
          {item.prevHash && item.prevHash !== '0'.repeat(64) && (
            <View style={styles.chainLink}>
              <View style={[styles.chainLine, {backgroundColor: theme.accent + '30'}]} />
            </View>
          )}
        </TouchableOpacity>
      </Animated.View>
    ),
    [theme, handleBlockPress],
  );

  return (
    <View style={[styles.container, {backgroundColor: theme.bg}]}>
      <View style={[styles.header, {backgroundColor: theme.bgSecondary, borderBottomColor: theme.border}]}>
        <Text style={[styles.headerTitle, {color: theme.text}]}>Chain Explorer</Text>
        <TouchableOpacity
          style={[styles.exportBtn, {backgroundColor: theme.accentDim}]}
          onPress={handleExportChain}>
          <Text style={[styles.exportBtnText, {color: theme.accent}]}>Export</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.statsRow}>
        {[
          {label: 'Blocks', value: stats.totalBlocks},
          {label: 'Verified', value: stats.verified ? 'Yes' : 'N/A'},
          {label: 'Size', value: `${(stats.totalSize / 1024).toFixed(1)} KB`},
        ].map((stat, idx) => (
          <Animated.View
            key={stat.label}
            entering={FadeInDown.delay(idx * 80).duration(250)}
            style={[styles.statCard, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
            <Text style={[styles.statValue, {color: theme.accent}]}>{stat.value}</Text>
            <Text style={[styles.statLabel, {color: theme.textMuted}]}>{stat.label}</Text>
          </Animated.View>
        ))}
      </View>

      <FlatList
        data={chain}
        keyExtractor={(item, idx) => `block-${idx}`}
        renderItem={renderBlock}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={[styles.emptyIcon, {color: theme.accent + '30'}]}>{'\u26D3'}</Text>
            <Text style={[styles.emptyTitle, {color: theme.textSecondary}]}>No Blocks Yet</Text>
            <Text style={[styles.emptyDesc, {color: theme.textMuted}]}>
              Send a message to create the first block in your local blockchain.
            </Text>
          </View>
        }
      />

      <Modal
        visible={!!selectedBlock}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedBlock(null)}>
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setSelectedBlock(null)}>
          <Animated.View
            entering={FadeIn.duration(200)}
            style={[styles.modalContent, {backgroundColor: theme.bgSecondary, borderColor: theme.border}]}>
            {selectedBlock && (
              <>
                <Text style={[styles.modalTitle, {color: theme.text}]}>
                  Block #{selectedBlock.index}
                </Text>
                {[
                  {label: 'Timestamp', value: `${formatDate(selectedBlock.ts)} ${formatTime(selectedBlock.ts)}`},
                  {label: 'Sender', value: selectedBlock.sender},
                  {label: 'Type', value: selectedBlock.type},
                  {label: 'Hash', value: selectedBlock.hash, mono: true},
                  {label: 'Prev Hash', value: selectedBlock.prevHash, mono: true},
                  {label: 'Nonce', value: String(selectedBlock.nonce || 0)},
                ].map(field => (
                  <View key={field.label} style={[styles.modalField, {borderBottomColor: theme.border}]}>
                    <Text style={[styles.modalFieldLabel, {color: theme.textMuted}]}>{field.label}</Text>
                    <Text
                      style={[
                        styles.modalFieldValue,
                        {color: field.mono ? theme.accent : theme.text},
                        field.mono && styles.mono,
                      ]}
                      selectable>
                      {field.value}
                    </Text>
                  </View>
                ))}
                <TouchableOpacity
                  style={[styles.modalCopyBtn, {backgroundColor: theme.accentDim}]}
                  onPress={() => {
                    Clipboard.setString(JSON.stringify(selectedBlock, null, 2));
                    Vibration.vibrate(15);
                    setSelectedBlock(null);
                  }}>
                  <Text style={[styles.modalCopyText, {color: theme.accent}]}>Copy Block Data</Text>
                </TouchableOpacity>
              </>
            )}
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
  exportBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
  },
  exportBtnText: {
    fontSize: 13,
    fontWeight: '700',
  },
  statsRow: {
    flexDirection: 'row',
    padding: 12,
    gap: 10,
  },
  statCard: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 18,
    fontWeight: '800',
  },
  statLabel: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    marginTop: 4,
    textTransform: 'uppercase',
  },
  list: {
    padding: 12,
    paddingBottom: 30,
  },
  block: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  blockHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  blockIndex: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 6,
  },
  blockIndexText: {
    fontSize: 12,
    fontWeight: '800',
  },
  blockTime: {
    fontSize: 11,
  },
  blockBody: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  blockSender: {
    fontSize: 14,
    fontWeight: '600',
  },
  blockType: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  blockHash: {
    fontSize: 10,
    letterSpacing: 0.5,
  },
  chainLink: {
    position: 'absolute',
    left: 30,
    bottom: -12,
    height: 12,
    width: 2,
  },
  chainLine: {
    flex: 1,
    width: 2,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
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
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    width: '100%',
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 16,
  },
  modalField: {
    paddingVertical: 10,
    borderBottomWidth: 0.5,
  },
  modalFieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  modalFieldValue: {
    fontSize: 13,
    fontWeight: '500',
  },
  mono: {
    fontFamily: Platform?.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
  },
  modalCopyBtn: {
    marginTop: 16,
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  modalCopyText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
