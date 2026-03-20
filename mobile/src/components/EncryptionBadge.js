/**
 * GhostLink Mobile — EncryptionBadge Component
 *
 * A small pill-shaped indicator that shows end-to-end encryption status.
 * Displays a lock icon and "E2EE" text.  Tap to open a modal with
 * encryption details (cipher suite, key fingerprint, verification status).
 *
 * @example
 * <EncryptionBadge encrypted />
 * <EncryptionBadge encrypted={false} />
 * <EncryptionBadge
 *   encrypted
 *   details={{
 *     cipher: 'AES-256-GCM',
 *     keyFingerprint: 'A3F7 K9B2 M4X1 Q8Z5',
 *     verified: true,
 *   }}
 * />
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  Pressable,
  StyleSheet,
} from 'react-native';

// ─── Constants ──────────────────────────────────────────────────────────────

const ACCENT = '#6366F1';
const GREEN = '#22C55E';
const GRAY = '#6B7280';

// ─── Lock Icon (text-based, no external dependency) ─────────────────────────

/**
 * A simple text-based lock icon. Uses Unicode characters so we don't need
 * an icon library as a hard dependency.
 */
const LockIcon = ({ locked, size, color }) => (
  <Text
    style={{
      fontSize: size,
      color,
      lineHeight: size + 2,
      includeFontPadding: false,
    }}
  >
    {locked ? '\uD83D\uDD12' : '\uD83D\uDD13'}
  </Text>
);

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {boolean} [props.encrypted=true]  Whether the connection is encrypted.
 * @param {object}  [props.details]         Optional encryption detail object:
 *   { cipher?: string, keyFingerprint?: string, verified?: boolean }
 * @param {object}  [props.style]           Additional styles on the pill.
 */
const EncryptionBadge = ({ encrypted = true, details, style }) => {
  const [modalVisible, setModalVisible] = useState(false);

  const badgeColor = encrypted ? GREEN : GRAY;

  const handlePress = useCallback(() => {
    setModalVisible(true);
  }, []);

  const handleClose = useCallback(() => {
    setModalVisible(false);
  }, []);

  return (
    <>
      {/* ── Pill Badge ─────────────────────────────────────────────────── */}
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={handlePress}
        style={[
          styles.pill,
          { backgroundColor: badgeColor + '18', borderColor: badgeColor + '40' },
          style,
        ]}
        accessibilityRole="button"
        accessibilityLabel={
          encrypted
            ? 'End-to-end encrypted. Tap for details.'
            : 'Not encrypted. Tap for details.'
        }
      >
        <LockIcon locked={encrypted} size={10} color={badgeColor} />
        <Text style={[styles.pillText, { color: badgeColor }]}>
          E2EE
        </Text>
      </TouchableOpacity>

      {/* ── Details Modal ──────────────────────────────────────────────── */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={handleClose}
      >
        <Pressable style={styles.backdrop} onPress={handleClose}>
          <Pressable style={styles.modal} onPress={() => {}}>
            {/* Header */}
            <View style={styles.modalHeader}>
              <LockIcon locked={encrypted} size={22} color={badgeColor} />
              <Text style={styles.modalTitle}>
                {encrypted ? 'End-to-End Encrypted' : 'Not Encrypted'}
              </Text>
            </View>

            {/* Description */}
            <Text style={styles.modalDesc}>
              {encrypted
                ? 'Messages in this conversation are secured with end-to-end encryption. Only you and the other participants can read them.'
                : 'This conversation is not currently encrypted. Messages may be visible to the server.'}
            </Text>

            {/* Details (if provided) */}
            {encrypted && details && (
              <View style={styles.detailsSection}>
                {details.cipher && (
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Cipher</Text>
                    <Text style={styles.detailValue}>{details.cipher}</Text>
                  </View>
                )}
                {details.keyFingerprint && (
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Key Fingerprint</Text>
                    <Text style={[styles.detailValue, styles.mono]}>
                      {details.keyFingerprint}
                    </Text>
                  </View>
                )}
                {details.verified !== undefined && (
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Verified</Text>
                    <Text
                      style={[
                        styles.detailValue,
                        { color: details.verified ? GREEN : '#EAB308' },
                      ]}
                    >
                      {details.verified ? 'Yes' : 'Not yet'}
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* Close Button */}
            <TouchableOpacity
              onPress={handleClose}
              style={styles.closeButton}
              activeOpacity={0.7}
            >
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
};

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── Pill
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    gap: 3,
  },
  pillText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },

  // ── Modal backdrop
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // ── Modal card
  modal: {
    width: '85%',
    maxWidth: 340,
    backgroundColor: '#1A1A2E',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#2A2A3E',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#F3F4F6',
  },
  modalDesc: {
    fontSize: 14,
    lineHeight: 20,
    color: '#9CA3AF',
    marginBottom: 16,
  },

  // ── Details
  detailsSection: {
    backgroundColor: '#0F0F1A',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    gap: 10,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  detailLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
  },
  detailValue: {
    fontSize: 12,
    fontWeight: '600',
    color: '#E5E7EB',
  },
  mono: {
    fontFamily: 'monospace',
    letterSpacing: 1,
  },

  // ── Close button
  closeButton: {
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: ACCENT + '20',
  },
  closeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: ACCENT,
  },
});

export default React.memo(EncryptionBadge);
