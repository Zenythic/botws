import {
  getBotExecutionState,
  getConversationPaymentSnapshot,
  storeWhatsAppMediaAttachment,
  storeWhatsAppMessage,
} from '../esmeralda/index.js';
import {
  generateCasinoTurnPlan,
} from '../ai/index.js';
import {
  asksPlatformLink,
  buildPlatformLinkReply,
  buildHandledErrorReply,
  executePendingAction,
} from './actions.js';
import {
  buildCustomerProfile,
  ensureCustomerIdentity,
} from './identity.js';
import {
  extractRequestedAmountText,
  isOperationalAction,
  looksLikeTransferProofMessage,
} from './helpers.js';
import {
  appendHistory,
  clearPendingAction,
  getChatState,
  mergePlanIntoPendingAction,
} from './state.js';
import { describeMediaAttachments } from '../whatsapp/media.js';

function buildInboundTurnText(userText, mediaAttachments = []) {
  const normalizedText = String(userText || '').trim();
  const mediaSummary = describeMediaAttachments(mediaAttachments);

  if (normalizedText && mediaSummary) {
    return `${normalizedText}\n${mediaSummary}`;
  }

  return normalizedText || mediaSummary || '';
}

function isQuestionLike(text) {
  const normalized = String(text || '').trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('?') ||
    /(cvu|alias|titular|minimo|mínimo|cuanto|cuánto|como|cómo|puedo|tienen|tenes|se puede|aceptan)/i.test(
      normalized,
    )
  );
}

function normalizeReplyMessages(replyText, replyMessages = []) {
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

function shouldForcePendingExecution(state, userText, mediaAttachments = []) {
  if (
    state.pendingAction.type === 'add_credit' &&
    state.pendingAction.depositStage === 'awaiting_proof_or_cuit'
  ) {
    return (
      Array.isArray(mediaAttachments) && mediaAttachments.length > 0
    ) || looksLikeTransferProofMessage(userText) || (
      !state.pendingAction.amount && Boolean(extractRequestedAmountText(userText))
    );
  }

  return false;
}

function shouldAnswerSideQuestion(state, plan, userText, mediaAttachments = []) {
  if (!state.pendingAction.type) {
    return false;
  }

  if (asksPlatformLink(userText)) {
    return true;
  }

  if (shouldForcePendingExecution(state, userText, mediaAttachments)) {
    return false;
  }

  if (plan.pendingActionDirective === 'answer_side_question') {
    return true;
  }

  return (
    (plan.actionType === 'casino_support' || plan.actionType === 'off_topic') &&
    isQuestionLike(userText)
  );
}

export async function captureIncomingCasinoMessage({
  sock,
  remoteJid,
  pushName,
  userText,
  messageId,
  messageType,
  receivedAt,
  rawMessage,
  mediaAttachments = [],
}) {
  const identity = await ensureCustomerIdentity({ sock, remoteJid, pushName });
  const conversationKey = identity.phoneKey || remoteJid;

  await storeWhatsAppMessage({
    messageKey: messageId || `incoming:${conversationKey}:${Date.now()}`,
    conversationKey,
    phoneKey: identity.phoneKey,
    phoneNumber: identity.phoneNumber,
    whatsappJid: identity.whatsappJid || remoteJid,
    pushName: identity.pushName,
    linkedRemoteUserId: identity.linkedUser?.remoteUserId || null,
    linkedUsername: identity.linkedUser?.username || null,
    direction: 'incoming',
    senderRole: 'customer',
    messageType,
    text: userText,
    createdAt: receivedAt || new Date().toISOString(),
    rawPayload: rawMessage,
  }).catch(() => undefined);

  for (const attachment of mediaAttachments) {
    await storeWhatsAppMediaAttachment({
      ...attachment,
      conversationKey,
      phoneKey: identity.phoneKey,
      phoneNumber: identity.phoneNumber,
      whatsappJid: identity.whatsappJid || remoteJid,
      messageKey: messageId || attachment.messageKey,
      createdAt: receivedAt || attachment.createdAt,
    }).catch(() => undefined);
  }

  return {
    identity,
    conversationKey,
  };
}

export async function generateCasinoBotReply({
  sock,
  remoteJid,
  pushName,
  userText,
  messageId,
  messageType,
  receivedAt,
  rawMessage,
  mediaAttachments = [],
  identity: providedIdentity = null,
  conversationKey: providedConversationKey = null,
  skipInboundStore = false,
}) {
  let identity =
    providedIdentity ||
    (await ensureCustomerIdentity({ sock, remoteJid, pushName }));
  const conversationKey =
    providedConversationKey || identity.phoneKey || remoteJid;
  const state = getChatState(conversationKey);

  if (!skipInboundStore) {
    await storeWhatsAppMessage({
      messageKey: messageId || `incoming:${conversationKey}:${Date.now()}`,
      conversationKey,
      phoneKey: identity.phoneKey,
      phoneNumber: identity.phoneNumber,
      whatsappJid: identity.whatsappJid || remoteJid,
      pushName: identity.pushName,
      linkedRemoteUserId: identity.linkedUser?.remoteUserId || null,
      linkedUsername: identity.linkedUser?.username || null,
      direction: 'incoming',
      senderRole: 'customer',
      messageType,
      text: userText,
      createdAt: receivedAt || new Date().toISOString(),
      rawPayload: rawMessage,
    }).catch(() => undefined);

    for (const attachment of mediaAttachments) {
      await storeWhatsAppMediaAttachment({
        ...attachment,
        conversationKey,
        phoneKey: identity.phoneKey,
        phoneNumber: identity.phoneNumber,
        whatsappJid: identity.whatsappJid || remoteJid,
        messageKey: messageId || attachment.messageKey,
        createdAt: receivedAt || attachment.createdAt,
      }).catch(() => undefined);
    }
  }

  const executionState = await getBotExecutionState(conversationKey);
  const inboundTurnText = buildInboundTurnText(userText, mediaAttachments);
  const paymentContext = await getConversationPaymentSnapshot(
    conversationKey,
  ).catch(() => ({
    activeCashIn: null,
    activePayOut: null,
  }));

  if (executionState.paused) {
    appendHistory(state, 'user', inboundTurnText);

    return {
      replyText: null,
      replyMessages: [],
      identity,
      conversationKey,
      action: null,
      paused: true,
      pausedScope: executionState.globalPause.paused ? 'global' : 'conversation',
    };
  }

  if (!state.pendingAction.type && asksPlatformLink(userText)) {
    const replyText = buildPlatformLinkReply();
    const replyMessages = normalizeReplyMessages(replyText);
    appendHistory(state, 'user', inboundTurnText);
    appendHistory(state, 'assistant', replyMessages.join('\n'));
    state.hasIntroduced = true;

    return {
      replyText,
      replyMessages,
      identity,
      conversationKey,
      action: null,
    };
  }

  const plan = await generateCasinoTurnPlan({
    chatId: conversationKey,
    userText: inboundTurnText,
    recentMessages: state.history,
    customerProfile: buildCustomerProfile(identity, paymentContext),
    pendingAction: state.pendingAction,
    isFirstInteraction: !state.hasIntroduced,
  });

  mergePlanIntoPendingAction(state, plan);

  if (plan.pendingActionDirective === 'cancel_pending' && state.pendingAction.type) {
    clearPendingAction(state);
  }

  try {
    if (
      shouldAnswerSideQuestion(state, plan, userText, mediaAttachments)
    ) {
      const replyText = asksPlatformLink(userText)
        ? buildPlatformLinkReply()
        : plan.replyText;
      const replyMessages = normalizeReplyMessages(replyText);
      appendHistory(state, 'user', inboundTurnText);
      appendHistory(state, 'assistant', replyMessages.join('\n'));
      state.hasIntroduced = true;

      return {
        replyText,
        replyMessages,
        identity,
        conversationKey,
        action: null,
      };
    }

    if (isOperationalAction(state.pendingAction.type)) {
      const actionResult = await executePendingAction({
        chatId: conversationKey,
        identity,
        state,
        userText,
        mediaAttachments,
      });

      if (!actionResult.ready) {
        const replyMessages = normalizeReplyMessages(
          actionResult.replyText,
          actionResult.replyMessages,
        );
        appendHistory(state, 'user', inboundTurnText);
        appendHistory(state, 'assistant', replyMessages.join('\n'));
        state.hasIntroduced = true;

        return {
          replyText: actionResult.replyText,
          replyMessages,
          identity,
          conversationKey,
          action: null,
        };
      }

      const replyMessages = normalizeReplyMessages(
        actionResult.replyText,
        actionResult.replyMessages,
      );
      appendHistory(state, 'user', inboundTurnText);
      appendHistory(state, 'assistant', replyMessages.join('\n'));
      state.hasIntroduced = true;

      return {
        replyText: actionResult.replyText,
        replyMessages,
        identity: actionResult.identity,
        conversationKey,
        action: actionResult.action,
      };
    }

    const replyText = plan.replyText;
    const replyMessages = normalizeReplyMessages(replyText);
    appendHistory(state, 'user', inboundTurnText);
    appendHistory(state, 'assistant', replyMessages.join('\n'));
    state.hasIntroduced = true;

    return {
      replyText,
      replyMessages,
      identity,
      conversationKey,
      action: null,
    };
  } catch (error) {
    const handledReply = buildHandledErrorReply(state, error);

    if (handledReply) {
      const replyMessages = normalizeReplyMessages(handledReply);
      appendHistory(state, 'user', inboundTurnText);
      appendHistory(state, 'assistant', replyMessages.join('\n'));
      state.hasIntroduced = true;

      return {
        replyText: handledReply,
        replyMessages,
        identity,
        conversationKey,
        action: null,
      };
    }

    throw error;
  }
}
