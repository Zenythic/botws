import { MAX_REPLY_CHARS } from './config.js';

export function normalizeReplyText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function trimReplyText(text) {
  if (text.length <= MAX_REPLY_CHARS) {
    return text;
  }

  const sliced = text.slice(0, MAX_REPLY_CHARS);
  const lastBreak = Math.max(
    sliced.lastIndexOf('. '),
    sliced.lastIndexOf('? '),
    sliced.lastIndexOf('! '),
    sliced.lastIndexOf('\n'),
  );

  if (lastBreak > MAX_REPLY_CHARS * 0.6) {
    return sliced.slice(0, lastBreak + 1).trim();
  }

  return `${sliced.trim()}...`;
}

export function sanitizeReply(text) {
  return trimReplyText(normalizeReplyText(text));
}

export function extractContentText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

export function extractJsonObject(rawText) {
  const trimmed = String(rawText || '').trim();

  if (!trimmed) {
    throw new Error('Gemini devolvio JSON vacio');
  }

  const withoutFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const firstBrace = withoutFence.indexOf('{');
  const lastBrace = withoutFence.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(
      `No se encontro un objeto JSON valido: ${withoutFence.slice(0, 300)}`,
    );
  }

  return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1));
}

export function normalizeRecentMessages(recentMessages) {
  return Array.isArray(recentMessages)
    ? recentMessages
        .filter(
          (item) =>
            item &&
            (item.role === 'user' || item.role === 'assistant') &&
            typeof item.text === 'string' &&
            item.text.trim(),
        )
        .slice(-8)
        .map((item) => ({
          role: item.role,
          text: item.text.trim(),
        }))
    : [];
}
