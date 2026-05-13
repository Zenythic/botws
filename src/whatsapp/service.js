import 'dotenv/config';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { assertOpenRouterConfig, getModelName } from '../ai/index.js';
import {
  captureIncomingCasinoMessage,
  generateCasinoBotReply,
} from '../casino/index.js';
import { consumeExpiredPendingDeposits } from '../casino/state.js';
import {
  processMatchedCashInCredits,
  syncPendingCashInRequests,
  syncPendingPayOutRequests,
} from '../payments/index.js';
import {
  getBotExecutionState,
  getWhatsAppConversationDetail,
  listCashInRequestsNeedingSuccessNotification,
  listCashInRequestsNeedingExpiryNotification,
  listPayOutRequestsNeedingFailureNotification,
  listPayOutRequestsNeedingSuccessNotification,
  markCashInSuccessNotified,
  markCashInExpiryNotified,
  markPayOutFailureNotified,
  markPayOutSuccessNotified,
  storeWhatsAppMessage,
} from '../esmeralda/index.js';
import {
  AUTH_FOLDER,
  INCOMING_BURST_QUIET_MS,
} from './constants.js';
import {
  extractText,
  getFallbackReply,
  getMessageTimestampIso,
  getPhoneNumber,
  getRandomReplyDelayMs,
  isDirectUserChat,
  shouldUsePairingCode,
  wait,
} from './helpers.js';
import {
  describeMediaAttachments,
  downloadAndStoreIncomingMedia,
} from './media.js';
import { runWithTypingPresence } from './presence.js';
import { enqueueChatTask } from './queue.js';
import {
  clearWhatsAppCommand,
  deleteStoredWhatsAppSession,
  readWhatsAppCommand,
  writeWhatsAppRuntimeState,
} from './runtime.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const pendingChatBatches = new Map();
const CASHIN_MONITOR_INTERVAL_MS = 30_000;
let cashInMonitorInterval = null;
let cashInMonitorRunning = false;
let currentSock = null;
let botStartPromise = null;
let reconnectTimer = null;
let commandMonitorInterval = null;
let manualSessionResetInProgress = false;
let lastProcessedCommandId = null;

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(delayMs = 1_500) {
  if (manualSessionResetInProgress) {
    return;
  }

  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startBot();
  }, delayMs);
}

function extractOwnPhoneNumber(sock) {
  const rawId = String(sock?.user?.id || '').trim();

  if (!rawId) {
    return null;
  }

  const digits = rawId.replace(/\D/g, '');
  return digits || null;
}

function getOrCreateChatBatch(chatId) {
  let batch = pendingChatBatches.get(chatId);

  if (!batch) {
    batch = {
      chatId,
      pendingItems: [],
      replyDueAt: null,
      lastReceivedAt: 0,
      processing: false,
    };
    pendingChatBatches.set(chatId, batch);
  }

  return batch;
}

function buildBatchedUserText(items) {
  return items
    .map((item) => {
      const text = String(item.text || '').trim();
      const mediaSummary = describeMediaAttachments(item.mediaAttachments || []);

      if (text && mediaSummary) {
        return `${text}\n${mediaSummary}`;
      }

      return text || mediaSummary;
    })
    .filter(Boolean)
    .join('\n');
}

function buildBatchPreview(items) {
  return buildBatchedUserText(items).slice(0, 140);
}

async function storeOutgoingMessage({
  remoteJid,
  replyText,
  sentMessage,
  identity,
  conversationKey,
  pushName,
}) {
  await storeWhatsAppMessage({
    messageKey:
      sentMessage?.key?.id ||
      `outgoing:${conversationKey || remoteJid}:${Date.now()}`,
    conversationKey: conversationKey || remoteJid,
    phoneKey: identity?.phoneKey || null,
    phoneNumber: identity?.phoneNumber || null,
    whatsappJid: identity?.whatsappJid || remoteJid,
    pushName: identity?.pushName || pushName || null,
    linkedRemoteUserId: identity?.linkedUser?.remoteUserId || null,
    linkedUsername: identity?.linkedUser?.username || null,
    direction: 'outgoing',
    senderRole: 'agent',
    messageType: 'text',
    text: replyText,
    createdAt: new Date().toISOString(),
    rawPayload: sentMessage,
  }).catch((storageError) => {
    logger.warn(
      { err: storageError, from: remoteJid },
      'No se pudo guardar el mensaje saliente en la base local',
    );
  });
}

function normalizeOutgoingMessages(replyText, replyMessages = []) {
  const normalized = Array.isArray(replyMessages)
    ? replyMessages
        .map((message) => String(message || '').trim())
        .filter(Boolean)
    : [];

  if (normalized.length > 0) {
    return normalized;
  }

  const singleReply = String(replyText || '').trim();
  return singleReply ? [singleReply] : [];
}

async function sendReplyMessages({
  sock,
  remoteJid,
  quotedMessage = null,
  replyText = null,
  replyMessages = [],
  identity = null,
  conversationKey = null,
  pushName = null,
}) {
  const messages = normalizeOutgoingMessages(replyText, replyMessages);
  const sent = [];

  for (let index = 0; index < messages.length; index += 1) {
    const text = messages[index];
    const sentMessage = await sock.sendMessage(
      remoteJid,
      { text },
      quotedMessage ? { quoted: quotedMessage } : undefined,
    );

    await storeOutgoingMessage({
      remoteJid,
      replyText: text,
      sentMessage,
      identity,
      conversationKey,
      pushName,
    });

    sent.push(sentMessage);

    if (index < messages.length - 1) {
      await wait(250);
    }
  }

  return sent;
}

function buildExpiredDepositReply() {
  return 'Se vencio la carga anterior porque el pago no entro dentro de los 5 minutos. Si quieres, te genero un CVU nuevo.';
}

function buildCashInSuccessReply({ amountText, username }) {
  return `Listo, ya te acredité ${amountText || 'la recarga'}${username ? ` en ${username}` : ''}.`;
}

function maskDestinationAccount(destinationAccount) {
  const normalized = String(destinationAccount || '').replace(/\D/g, '');

  if (normalized.length < 8) {
    return 'la cuenta que me pasaste';
  }

  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function buildPayOutSuccessReply({ amountText, destinationAccount }) {
  return `Listo, ya salió tu retiro${amountText ? ` de ${amountText}` : ''} al CVU/CBU ${maskDestinationAccount(destinationAccount)}.`;
}

function buildPayOutFailureReply({ amountText }) {
  return `No pude completar el retiro${amountText ? ` de ${amountText}` : ''}. Si quieres, lo revisamos y te lo vuelvo a pedir.`;
}

async function sendSystemConversationMessage(
  sock,
  conversationKey,
  replyTextOrMessages,
) {
  const detail = await getWhatsAppConversationDetail(conversationKey).catch(
    () => ({ conversation: null }),
  );
  const conversation = detail?.conversation;
  const remoteJid = conversation?.whatsapp_jid || null;

  const replyMessages = normalizeOutgoingMessages(
    Array.isArray(replyTextOrMessages) ? null : replyTextOrMessages,
    Array.isArray(replyTextOrMessages) ? replyTextOrMessages : [],
  );

  if (!remoteJid || replyMessages.length === 0) {
    return false;
  }

  await sendReplyMessages({
    sock,
    remoteJid,
    replyMessages,
    identity: {
      phoneKey: conversation?.phone_key || null,
      phoneNumber: conversation?.phone_number || null,
      whatsappJid: conversation?.whatsapp_jid || remoteJid,
      pushName: conversation?.push_name || null,
      linkedUser: conversation?.linked_username
        ? {
            remoteUserId: conversation?.linked_remote_user_id || null,
            username: conversation.linked_username,
          }
        : null,
    },
    conversationKey,
    pushName: conversation?.push_name || null,
  });

  return true;
}

async function runCashInMonitor(sock) {
  if (cashInMonitorRunning) {
    return;
  }

  cashInMonitorRunning = true;

  try {
    const expiredPendingDeposits = consumeExpiredPendingDeposits();

    for (const expiredDeposit of expiredPendingDeposits) {
      await sendSystemConversationMessage(
        sock,
        expiredDeposit.chatId,
        buildExpiredDepositReply(),
      ).catch((error) => {
        logger.warn(
          { err: error, conversationKey: expiredDeposit.chatId },
          'No se pudo avisar el vencimiento del CVU pendiente',
        );
      });
    }

    const syncResult = await syncPendingCashInRequests({ limit: 25 }).catch(
      (error) => {
        logger.warn({ err: error }, 'No se pudieron sincronizar los cashin pendientes');
        return null;
      },
    );

    if (syncResult?.checked) {
      logger.debug(
        { checked: syncResult.checked },
        'Sincronizacion de cashin pendientes ejecutada',
      );
    }

    const payOutSyncResult = await syncPendingPayOutRequests({ limit: 25 }).catch(
      (error) => {
        logger.warn({ err: error }, 'No se pudieron sincronizar los payout pendientes');
        return null;
      },
    );

    if (payOutSyncResult?.checked) {
      logger.debug(
        { checked: payOutSyncResult.checked },
        'Sincronizacion de payout pendientes ejecutada',
      );
    }

    const creditResult = await processMatchedCashInCredits({ limit: 25 }).catch(
      (error) => {
        logger.warn({ err: error }, 'No se pudieron acreditar los cashin matcheados');
        return null;
      },
    );

    if (creditResult?.checked) {
      logger.debug(
        { checked: creditResult.checked },
        'Proceso de acreditacion de cashin ejecutado',
      );
    }

    const notificationResult = await listCashInRequestsNeedingExpiryNotification({
      limit: 25,
    }).catch((error) => {
      logger.warn(
        { err: error },
        'No se pudieron cargar los cashin expirados pendientes de aviso',
      );
      return { rows: [] };
    });

    for (const row of notificationResult.rows || []) {
      const sent = await sendSystemConversationMessage(
        sock,
        row.conversation_key,
        buildExpiredDepositReply(),
      ).catch((error) => {
        logger.warn(
          { err: error, requestId: row.request_id },
          'No se pudo avisar el vencimiento del cashin al usuario',
        );
        return false;
      });

      if (sent) {
        await markCashInExpiryNotified(row.request_id).catch((error) => {
          logger.warn(
            { err: error, requestId: row.request_id },
            'No se pudo marcar el cashin expirado como notificado',
          );
        });
      }
    }

    const successNotifications = await listCashInRequestsNeedingSuccessNotification({
      limit: 25,
    }).catch((error) => {
      logger.warn(
        { err: error },
        'No se pudieron cargar los cashin acreditados pendientes de aviso',
      );
      return { rows: [] };
    });

    for (const row of successNotifications.rows || []) {
      const sent = await sendSystemConversationMessage(
        sock,
        row.conversation_key,
        buildCashInSuccessReply({
          amountText: row.credit_amount_text || row.expected_amount_text,
          username: row.linked_username,
        }),
      ).catch((error) => {
        logger.warn(
          { err: error, requestId: row.request_id },
          'No se pudo avisar la acreditacion del cashin al usuario',
        );
        return false;
      });

      if (sent) {
        await markCashInSuccessNotified(row.request_id).catch((error) => {
          logger.warn(
            { err: error, requestId: row.request_id },
            'No se pudo marcar el cashin acreditado como notificado',
          );
        });
      }
    }

    const payOutSuccessNotifications =
      await listPayOutRequestsNeedingSuccessNotification({
        limit: 25,
      }).catch((error) => {
        logger.warn(
          { err: error },
          'No se pudieron cargar los payout exitosos pendientes de aviso',
        );
        return { rows: [] };
      });

    for (const row of payOutSuccessNotifications.rows || []) {
      const sent = await sendSystemConversationMessage(
        sock,
        row.conversation_key,
        buildPayOutSuccessReply({
          amountText: row.amount_text,
          destinationAccount: row.destination_account,
        }),
      ).catch((error) => {
        logger.warn(
          { err: error, payoutId: row.payout_id },
          'No se pudo avisar la salida del payout al usuario',
        );
        return false;
      });

      if (sent) {
        await markPayOutSuccessNotified(row.payout_id).catch((error) => {
          logger.warn(
            { err: error, payoutId: row.payout_id },
            'No se pudo marcar el payout exitoso como notificado',
          );
        });
      }
    }

    const payOutFailureNotifications =
      await listPayOutRequestsNeedingFailureNotification({
        limit: 25,
      }).catch((error) => {
        logger.warn(
          { err: error },
          'No se pudieron cargar los payout fallidos pendientes de aviso',
        );
        return { rows: [] };
      });

    for (const row of payOutFailureNotifications.rows || []) {
      const sent = await sendSystemConversationMessage(
        sock,
        row.conversation_key,
        buildPayOutFailureReply({
          amountText: row.amount_text,
        }),
      ).catch((error) => {
        logger.warn(
          { err: error, payoutId: row.payout_id },
          'No se pudo avisar el fallo del payout al usuario',
        );
        return false;
      });

      if (sent) {
        await markPayOutFailureNotified(row.payout_id).catch((error) => {
          logger.warn(
            { err: error, payoutId: row.payout_id },
            'No se pudo marcar el payout fallido como notificado',
          );
        });
      }
    }
  } finally {
    cashInMonitorRunning = false;
  }
}

function startCashInMonitor(sock) {
  if (cashInMonitorInterval) {
    clearInterval(cashInMonitorInterval);
  }

  cashInMonitorInterval = setInterval(() => {
    runCashInMonitor(sock).catch((error) => {
      logger.warn({ err: error }, 'Fallo el monitor de cashin');
    });
  }, CASHIN_MONITOR_INTERVAL_MS);

  runCashInMonitor(sock).catch((error) => {
    logger.warn({ err: error }, 'Fallo el primer ciclo del monitor de cashin');
  });
}

async function performWhatsAppSessionReset(reason = 'panel') {
  manualSessionResetInProgress = true;
  clearReconnectTimer();

  await writeWhatsAppRuntimeState({
    status: 'resetting',
    connection: 'resetting',
    qrDataUrl: null,
    qrAvailable: false,
    qrUpdatedAt: null,
    lastError: null,
  }).catch(() => null);

  const sock = currentSock;
  currentSock = null;

  if (sock) {
    try {
      await sock.logout(`reset:${reason}`);
    } catch (error) {
      logger.warn({ err: error }, 'No se pudo cerrar la sesion actual antes del reseteo');
    }

    try {
      sock.end(undefined);
    } catch (error) {
      logger.warn({ err: error }, 'No se pudo cerrar el socket actual durante el reseteo');
    }
  }

  pendingChatBatches.clear();
  await deleteStoredWhatsAppSession().catch((error) => {
    logger.warn({ err: error }, 'No se pudo borrar la carpeta .auth durante el reseteo');
  });

  manualSessionResetInProgress = false;
  await startBot();
}

async function processWhatsAppCommand(command) {
  if (!command?.id || command.id === lastProcessedCommandId) {
    return;
  }

  lastProcessedCommandId = command.id;
  await clearWhatsAppCommand().catch(() => null);

  if (command.action === 'reset_session') {
    logger.info(
      { commandId: command.id, reason: command.reason || 'panel' },
      'Llego una orden para resetear la sesion de WhatsApp',
    );
    await performWhatsAppSessionReset(command.reason || 'panel');
  }
}

function startWhatsAppCommandMonitor() {
  if (commandMonitorInterval) {
    return;
  }

  commandMonitorInterval = setInterval(() => {
    readWhatsAppCommand()
      .then((command) => {
        if (command) {
          return processWhatsAppCommand(command);
        }

        return null;
      })
      .catch((error) => {
        logger.warn({ err: error }, 'No se pudo revisar el buzón de comandos de WhatsApp');
      });
  }, 1_500);
}

async function generateAndSendBatchReply(sock, batch, items) {
  const latestItem = items[items.length - 1];
  const remoteJid = latestItem.remoteJid;
  const combinedText = buildBatchedUserText(items);
  const mediaAttachments = items.flatMap((item) =>
    Array.isArray(item.mediaAttachments) ? item.mediaAttachments : [],
  );

  if (!combinedText && mediaAttachments.length === 0) {
    return;
  }

  const executionState = await getBotExecutionState(
    latestItem.capturedContext.conversationKey,
  );

  if (executionState.paused) {
    logger.info(
      {
        from: remoteJid,
        scope: executionState.globalPause.paused ? 'global' : 'conversation',
      },
      'El bot quedo en pausa antes de generar la respuesta del lote. No se enviara mensaje.',
    );
    return;
  }

  logger.info(
    {
      from: remoteJid,
      groupedMessages: items.length,
      preview: buildBatchPreview(items),
    },
    'Arrancando presencia de escritura y preparando respuesta agrupada',
  );

  try {
    const aiResult = await runWithTypingPresence(sock, remoteJid, async () => {
      const result = await generateCasinoBotReply({
        sock,
        remoteJid,
        pushName: latestItem.message.pushName || null,
        userText: combinedText,
        messageId: latestItem.message.key.id || null,
        messageType: latestItem.contentType,
        receivedAt: latestItem.receivedAt,
        rawMessage: latestItem.message,
        mediaAttachments,
        identity: latestItem.capturedContext.identity,
        conversationKey: latestItem.capturedContext.conversationKey,
        skipInboundStore: true,
      });

      logger.info(
        {
          from: remoteJid,
          groupedMessages: items.length,
          linkedUsername: result.identity?.linkedUser?.username || null,
          actionType: result.action?.type || null,
          paused: Boolean(result.paused),
          preview: normalizeOutgoingMessages(
            result.replyText,
            result.replyMessages,
          )
            .join(' | ')
            .slice(0, 120) || null,
        },
        'Respuesta agrupada del agente lista',
      );

      return result;
    });

    const outgoingMessages = normalizeOutgoingMessages(
      aiResult.replyText,
      aiResult.replyMessages,
    );

    if (aiResult.paused || outgoingMessages.length === 0) {
      logger.info(
        {
          from: remoteJid,
          scope: aiResult.pausedScope || 'conversation',
        },
        'La conversacion quedo en pausa o sin respuesta antes del envio del lote.',
      );
      return;
    }

    const latestExecutionState = await getBotExecutionState(
      aiResult.conversationKey || latestItem.capturedContext.conversationKey,
    );
    if (latestExecutionState.paused) {
      logger.info(
        {
          from: remoteJid,
          scope: latestExecutionState.globalPause.paused ? 'global' : 'conversation',
        },
        'El bot fue pausado antes del envio. Se omite la respuesta agrupada.',
      );
      return;
    }

    await sendReplyMessages({
      sock,
      remoteJid,
      quotedMessage: latestItem.message,
      replyMessages: outgoingMessages,
      identity: aiResult.identity,
      conversationKey: aiResult.conversationKey,
      pushName: latestItem.message.pushName || null,
    });

    logger.info(
      { from: remoteJid, groupedMessages: items.length },
      'Respuesta agrupada enviada correctamente',
    );
  } catch (error) {
    logger.error(
      { err: error, from: remoteJid, groupedMessages: items.length, text: combinedText },
      'Fallo la generacion o el envio de la respuesta agrupada',
    );

    const latestExecutionState = await getBotExecutionState(
      latestItem.capturedContext.conversationKey,
    ).catch(() => null);

    if (latestExecutionState?.paused) {
      logger.info(
        { from: remoteJid },
        'No se enviara mensaje de respaldo porque el bot esta en pausa',
      );
      return;
    }

    await sock
      .sendMessage(
        remoteJid,
        { text: getFallbackReply() },
        { quoted: latestItem.message },
      )
      .then(async (sentMessage) => {
        await storeOutgoingMessage({
          remoteJid,
          replyText: getFallbackReply(),
          sentMessage,
          identity: null,
          conversationKey: latestItem.capturedContext.conversationKey || remoteJid,
          pushName: latestItem.message.pushName || null,
        });
      })
      .catch((sendError) => {
        logger.error(
          { err: sendError, from: remoteJid },
          'Tambien fallo el envio del mensaje de respaldo',
        );
      });
  }
}

async function drainChatBatch(sock, chatId) {
  const batch = pendingChatBatches.get(chatId);

  if (!batch) {
    return;
  }

  try {
    while (batch.pendingItems.length > 0) {
      const now = Date.now();
      const waitMs = Math.max(
        (batch.replyDueAt || now) - now,
        batch.lastReceivedAt + INCOMING_BURST_QUIET_MS - now,
        0,
      );

      if (waitMs > 0) {
        await wait(waitMs);
        continue;
      }

      const items = batch.pendingItems.splice(0);
      batch.replyDueAt = null;

      await generateAndSendBatchReply(sock, batch, items);
    }
  } finally {
    batch.processing = false;

    if (batch.pendingItems.length > 0) {
      batch.processing = true;
      void drainChatBatch(sock, chatId);
      return;
    }

    pendingChatBatches.delete(chatId);
  }
}

async function processIncomingMessage(sock, message) {
  const remoteJid = message.key.remoteJid;
  const contentType = getContentType(normalizeMessageContent(message.message));

  if (!remoteJid || !message.message || message.key.fromMe) {
    return;
  }

  if (
    !isDirectUserChat(remoteJid) ||
    isJidGroup(remoteJid) ||
    isJidNewsletter(remoteJid) ||
    isJidStatusBroadcast(remoteJid) ||
    isJidBroadcast(remoteJid)
  ) {
    logger.info(
      { from: remoteJid, contentType },
      'Mensaje recibido pero ignorado por tipo de chat',
    );
    return;
  }

  const text = extractText(message.message).trim();
  let mediaAttachments = [];

  try {
    mediaAttachments = await downloadAndStoreIncomingMedia({
      sock,
      message,
      conversationKey: remoteJid,
      identity: null,
      receivedAt: getMessageTimestampIso(message),
      logger,
    });
  } catch (error) {
    logger.warn(
      { err: error, from: remoteJid, contentType },
      'No se pudo descargar el adjunto entrante',
    );
  }

  if (!text && mediaAttachments.length === 0) {
    logger.info(
      { from: remoteJid, contentType },
      'Mensaje recibido sin texto ni adjuntos utiles para responder',
    );
    return;
  }

  logger.info(
    { from: remoteJid, text },
    'Mensaje recibido. Se agregara al lote del chat',
  );

  const capturedContext = await captureIncomingCasinoMessage({
    sock,
    remoteJid,
    pushName: message.pushName || null,
    userText: text,
    messageId: message.key.id || null,
    messageType: contentType,
    receivedAt: getMessageTimestampIso(message),
    rawMessage: message,
    mediaAttachments,
  });
  const executionState = await getBotExecutionState(
    capturedContext.conversationKey,
  );

  if (executionState.paused) {
    logger.info(
      {
        from: remoteJid,
        scope: executionState.globalPause.paused ? 'global' : 'conversation',
      },
      'Mensaje guardado, pero el bot esta en pausa y no va a responder',
    );
    return;
  }

  const chatId = capturedContext.conversationKey || remoteJid;
  const batch = getOrCreateChatBatch(chatId);

  if (batch.pendingItems.length === 0) {
    const replyDelayMs = getRandomReplyDelayMs();
    batch.replyDueAt = Date.now() + replyDelayMs;

    logger.info(
      {
        from: remoteJid,
        chatId,
        replyDelayMs,
        replyDelaySeconds: Math.round(replyDelayMs / 1000),
      },
      'Arranco una nueva ventana de respuesta para el chat',
    );
  }

  batch.lastReceivedAt = Date.now();
  batch.pendingItems.push({
    remoteJid,
    text,
    contentType,
    receivedAt: getMessageTimestampIso(message),
    message,
    mediaAttachments,
    capturedContext,
  });

  logger.info(
    {
      from: remoteJid,
      chatId,
      pendingMessages: batch.pendingItems.length,
    },
    'Mensaje agregado al lote pendiente del chat',
  );

  if (!batch.processing) {
    batch.processing = true;
    void drainChatBatch(sock, chatId);
  }
}

function setupMessageHandler(sock) {
  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    if (type !== 'notify') {
      return;
    }

    for (const message of messages) {
      const remoteJid = message.key.remoteJid;

      enqueueChatTask(remoteJid || 'unknown-chat', async () => {
        await processIncomingMessage(sock, message);
      }).catch((error) => {
        logger.error({ err: error, from: remoteJid }, 'Fallo la cola del chat');
      });
    }
  });
}

function setupConnectionHandler(sock) {
  let pairingCodeRequested = false;

  sock.ev.on('connection.update', async (update) => {
    if (sock !== currentSock) {
      return;
    }

    const { connection, lastDisconnect, qr } = update;

    if (qr && !shouldUsePairingCode()) {
      const [qrCode, qrDataUrl] = await Promise.all([
        QRCode.toString(qr, {
          type: 'terminal',
          small: true,
        }),
        QRCode.toDataURL(qr, {
          margin: 1,
          width: 320,
        }),
      ]);
      console.log(qrCode);
      await writeWhatsAppRuntimeState({
        status: 'qr',
        connection: connection || 'connecting',
        qrDataUrl,
        qrAvailable: true,
        qrUpdatedAt: new Date().toISOString(),
        lastError: null,
      }).catch(() => null);
      logger.info(
        'Escanea el QR desde WhatsApp > Dispositivos vinculados para conectar el bot.',
      );
    } else if (connection === 'connecting') {
      await writeWhatsAppRuntimeState({
        status: 'connecting',
        connection: 'connecting',
        lastError: null,
      }).catch(() => null);
    }

    if (
      shouldUsePairingCode() &&
      !pairingCodeRequested &&
      !sock.authState.creds.registered &&
      (connection === 'connecting' || qr)
    ) {
      const phoneNumber = getPhoneNumber();

      if (!phoneNumber) {
        logger.warn(
          'USE_PAIRING_CODE=true pero falta PHONE_NUMBER en formato E.164 sin +. Se dejara el login por QR.',
        );
      } else {
        pairingCodeRequested = true;
        const code = await sock.requestPairingCode(phoneNumber);
        logger.info({ code }, 'Codigo de vinculacion generado');
      }
    }

    if (connection === 'open') {
      await writeWhatsAppRuntimeState({
        status: 'open',
        connection: 'open',
        qrDataUrl: null,
        qrAvailable: false,
        qrUpdatedAt: null,
        phoneNumber: extractOwnPhoneNumber(sock),
        whatsappId: sock.user?.id || null,
        lastError: null,
      }).catch(() => null);
      logger.info('Conexion abierta. El bot ya puede responder mensajes.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = String(
        lastDisconnect?.error?.message ||
          lastDisconnect?.error?.stack ||
          lastDisconnect?.error ||
          '',
      ).slice(0, 400);

      await writeWhatsAppRuntimeState({
        status: manualSessionResetInProgress ? 'resetting' : 'closed',
        connection: 'close',
        qrDataUrl: null,
        qrAvailable: false,
        qrUpdatedAt: null,
        lastError: errorMessage || null,
      }).catch(() => null);

      if (manualSessionResetInProgress) {
        logger.info('La conexion se cerro como parte de un reseteo manual de sesion.');
        return;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        currentSock = null;
        await writeWhatsAppRuntimeState({
          status: 'logged_out',
          connection: 'close',
        }).catch(() => null);
        logger.error(
          'La sesion se cerro y WhatsApp marco el dispositivo como desconectado. Borra .auth y vuelve a vincular.',
        );
        return;
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        currentSock = null;
        await writeWhatsAppRuntimeState({
          status: 'replaced',
          connection: 'close',
        }).catch(() => null);
        logger.warn(
          'La conexion fue reemplazada por otra sesion. Asegurate de tener un solo proceso del bot corriendo.',
        );
        return;
      }

      logger.warn({ statusCode }, 'Conexion cerrada. Reintentando...');
      currentSock = null;
      scheduleReconnect();
    }
  });
}

export async function startBot() {
  if (botStartPromise) {
    return botStartPromise;
  }

  if (currentSock) {
    return currentSock;
  }

  assertOpenRouterConfig();
  startWhatsAppCommandMonitor();
  clearReconnectTimer();

  botStartPromise = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    logger.info(
      { version: version.join('.'), isLatest, model: getModelName() },
      'Iniciando conexion con WhatsApp',
    );

    await writeWhatsAppRuntimeState({
      status: 'connecting',
      connection: 'connecting',
      qrDataUrl: null,
      qrAvailable: false,
      qrUpdatedAt: null,
      lastError: null,
    }).catch(() => null);

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      markOnlineOnConnect: false,
    });

    currentSock = sock;
    sock.ev.on('creds.update', saveCreds);
    setupConnectionHandler(sock);
    setupMessageHandler(sock);
    startCashInMonitor(sock);
  })().finally(() => {
    botStartPromise = null;
  });

  return botStartPromise;
}
