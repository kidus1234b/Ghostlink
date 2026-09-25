/**
 * GhostLink Mobile — shaping values that came from someone else.
 *
 * A scanned QR code and a peer's chat frame are both parsed JSON written by a
 * stranger, and both end up persisted in AsyncStorage and rendered on the next
 * launch. React Native throws when a <Text> child is an object, and the avatar
 * calls name.charAt(), so a single non-string field — `{"n": {}}` in an invite
 * QR, `{"text": {}}` in a chat frame — used to crash the chat list on render.
 * The chat list is the home screen, and the bad value was already saved, so
 * the app crashed on every launch after that until its data was cleared.
 *
 * Everything from outside goes through here first and comes out as the plain
 * strings and numbers the screens assume, or not at all.
 */

export const MAX_NAME_LENGTH = 64;
export const MAX_MESSAGE_LENGTH = 16 * 1024;
const MAX_ID_LENGTH = 128;
/** Longest public key accepted from an invite: uncompressed P-256 is 130 hex. */
const MAX_KEY_HEX_LENGTH = 260;

const shortString = (value, max) =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

/** A display name, or undefined if the value is not a usable one. */
export function cleanDisplayName(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, MAX_NAME_LENGTH);
  return trimmed || undefined;
}

/** A hex public key, or null. */
export function cleanPublicKeyHex(value) {
  if (typeof value !== 'string') return null;
  if (value.length > MAX_KEY_HEX_LENGTH || !/^(?:[0-9a-fA-F]{2})+$/.test(value)) return null;
  return value;
}

/**
 * The fields of an inbound `chat` frame the UI may use, or null if the frame is
 * not a well-formed chat message.
 *
 * @returns {{id: string|null, text: string, timestamp: number, replyTo: string|null}|null}
 */
export function parseInboundChat(data) {
  if (!data || typeof data !== 'object' || data.__gl !== 'chat') return null;
  const text = shortString(data.text, MAX_MESSAGE_LENGTH);
  if (!text) return null;
  return {
    id: shortString(data.id, MAX_ID_LENGTH),
    text,
    timestamp: Number.isFinite(data.timestamp) ? data.timestamp : Date.now(),
    replyTo: shortString(data.replyTo, MAX_ID_LENGTH),
  };
}

/** The message id an inbound `ack` frame refers to, or null. */
export function parseInboundAck(data) {
  if (!data || typeof data !== 'object' || data.__gl !== 'ack') return null;
  return shortString(data.id, MAX_ID_LENGTH);
}
