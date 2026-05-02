import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import {
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
} from 'baileys';

const DEFAULT_MEDIA_ROOT = './data/whatsapp-media';

function getResolvedMediaRoot() {
  return resolve(process.env.WHATSAPP_MEDIA_DIR || DEFAULT_MEDIA_ROOT);
}

function normalizeFileName(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_');

  return normalized || null;
}

function extensionFromMimeType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase().trim();

  if (!normalized.includes('/')) {
    return null;
  }

  const subtype = normalized.split('/')[1].split(';')[0].trim();
  if (!subtype) {
    return null;
  }

  if (subtype === 'jpeg') {
    return 'jpg';
  }

  return subtype.replace(/[^a-z0-9]+/g, '') || null;
}

function extractIncomingMediaInfo(message) {
  const normalized = normalizeMessageContent(message.message);
  if (!normalized) {
    return null;
  }

  const contentType = getContentType(normalized);

  if (contentType === 'imageMessage') {
    return {
      contentType,
      mediaKind: 'image',
      mimeType: normalized.imageMessage?.mimetype || 'image/jpeg',
      fileName: null,
    };
  }

  if (contentType === 'documentMessage') {
    return {
      contentType,
      mediaKind: 'document',
      mimeType: normalized.documentMessage?.mimetype || null,
      fileName: normalized.documentMessage?.fileName || null,
    };
  }

  return null;
}

function buildStoredFileName({
  messageId,
  mimeType,
  originalFileName,
  sha256Hex,
}) {
  const safeOriginal = normalizeFileName(originalFileName);
  const originalExt = safeOriginal ? extname(safeOriginal).replace(/^\./, '') : null;
  const derivedExt = originalExt || extensionFromMimeType(mimeType) || 'bin';
  const baseId = normalizeFileName(messageId) || `msg_${Date.now()}`;
  const hashChunk = String(sha256Hex || '').slice(0, 12) || 'file';

  if (safeOriginal) {
    const originalBase = basename(safeOriginal, extname(safeOriginal));
    return `${baseId}-${hashChunk}-${originalBase}.${derivedExt}`;
  }

  return `${baseId}-${hashChunk}.${derivedExt}`;
}

function buildAttachmentId(messageKey, index = 0) {
  const normalizedMessageKey = String(messageKey || '').trim() || 'unknown-message';
  return `${normalizedMessageKey}:${index}`;
}

export function describeMediaAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return '';
  }

  if (attachments.length === 1) {
    const item = attachments[0];
    if (item.mediaKind === 'image') {
      return '[Adjunto una imagen]';
    }

    if (item.mimeType === 'application/pdf') {
      return '[Adjunto un comprobante en PDF]';
    }

    return '[Adjunto un comprobante]';
  }

  return `[Adjunto ${attachments.length} comprobantes]`;
}

export function canUseAttachmentForReferenceExtraction(attachment) {
  const mimeType = String(attachment?.mimeType || '').toLowerCase();
  return mimeType.startsWith('image/');
}

export async function downloadAndStoreIncomingMedia({
  sock,
  message,
  conversationKey,
  identity,
  receivedAt,
  logger,
}) {
  const mediaInfo = extractIncomingMediaInfo(message);

  if (!mediaInfo) {
    return [];
  }

  const buffer = await downloadMediaMessage(
    message,
    'buffer',
    {},
    {
      logger,
      reuploadRequest: sock.updateMediaMessage.bind(sock),
    },
  );

  const sha256Hex = crypto.createHash('sha256').update(buffer).digest('hex');
  const createdAt = receivedAt || new Date().toISOString();
  const datedDir = createdAt.slice(0, 10) || 'undated';
  const safeConversationKey =
    String(conversationKey || identity?.phoneKey || message.key.remoteJid || 'chat')
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 80) || 'chat';
  const storedFileName = buildStoredFileName({
    messageId: message.key.id || null,
    mimeType: mediaInfo.mimeType,
    originalFileName: mediaInfo.fileName,
    sha256Hex,
  });
  const mediaRoot = getResolvedMediaRoot();
  const targetDir = join(mediaRoot, datedDir, safeConversationKey);
  const localPath = join(targetDir, storedFileName);

  await mkdir(targetDir, { recursive: true });
  await writeFile(localPath, buffer);

  return [
    {
      attachmentId: buildAttachmentId(message.key.id || sha256Hex, 0),
      messageKey: message.key.id || null,
      conversationKey,
      phoneKey: identity?.phoneKey || null,
      phoneNumber: identity?.phoneNumber || null,
      whatsappJid: identity?.whatsappJid || message.key.remoteJid || null,
      senderRole: 'customer',
      mediaKind: mediaInfo.mediaKind,
      mimeType: mediaInfo.mimeType,
      fileName: mediaInfo.fileName || storedFileName,
      localPath,
      sha256Hex,
      fileSizeBytes: buffer.byteLength,
      createdAt,
    },
  ];
}
