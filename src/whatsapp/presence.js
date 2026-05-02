import { MIN_TYPING_DURATION_MS } from './constants.js';
import { wait } from './helpers.js';

export async function runWithTypingPresence(sock, jid, task) {
  await sock.sendPresenceUpdate('composing', jid).catch(() => undefined);

  const startedAt = Date.now();
  const typingInterval = setInterval(() => {
    sock.sendPresenceUpdate('composing', jid).catch(() => undefined);
  }, 8_000);

  try {
    const result = await task();
    const typingElapsedMs = Date.now() - startedAt;

    if (typingElapsedMs < MIN_TYPING_DURATION_MS) {
      await wait(MIN_TYPING_DURATION_MS - typingElapsedMs);
    }

    return result;
  } finally {
    clearInterval(typingInterval);
    await sock.sendPresenceUpdate('paused', jid).catch(() => undefined);
  }
}
