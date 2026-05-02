import {
  getContentType,
  isHostedLidUser,
  isHostedPnUser,
  isLidUser,
  isPnUser,
  normalizeMessageContent,
} from 'baileys';
import {
  MAX_REPLY_DELAY_MS,
  MIN_REPLY_DELAY_MS,
} from './constants.js';

export function shouldUsePairingCode() {
  return process.env.USE_PAIRING_CODE === 'true';
}

export function getPhoneNumber() {
  return (process.env.PHONE_NUMBER || '').replace(/\D/g, '');
}

export function isDirectUserChat(jid) {
  if (!jid) {
    return false;
  }

  return Boolean(
    isPnUser(jid) ||
      isLidUser(jid) ||
      isHostedPnUser(jid) ||
      isHostedLidUser(jid),
  );
}

export function extractText(message) {
  const normalized = normalizeMessageContent(message);
  if (!normalized) {
    return '';
  }

  const contentType = getContentType(normalized);

  switch (contentType) {
    case 'conversation':
      return normalized.conversation || '';
    case 'extendedTextMessage':
      return normalized.extendedTextMessage?.text || '';
    case 'imageMessage':
      return normalized.imageMessage?.caption || '';
    case 'videoMessage':
      return normalized.videoMessage?.caption || '';
    default:
      return '';
  }
}

export function getMessageTimestampIso(message) {
  const rawTimestamp = Number(message?.messageTimestamp);

  if (!Number.isFinite(rawTimestamp) || rawTimestamp <= 0) {
    return new Date().toISOString();
  }

  return new Date(rawTimestamp * 1000).toISOString();
}

export function getRandomReplyDelayMs() {
  return (
    Math.floor(Math.random() * (MAX_REPLY_DELAY_MS - MIN_REPLY_DELAY_MS + 1)) +
    MIN_REPLY_DELAY_MS
  );
}

export async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function getFallbackReply() {
  return 'Se me trabo un toque recien. Decime de nuevo y te ayudo con eso.';
}
