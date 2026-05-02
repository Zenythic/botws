import { MAX_HISTORY_MESSAGES } from './constants.js';
import {
  isOperationalAction,
  normalizeCustomUsername,
  normalizeRequestedAmount,
} from './helpers.js';

const chatStateById = new Map();
const MAX_PENDING_DEPOSIT_MINUTES = 5;
const configuredPendingDepositMinutes =
  Number.parseInt(
    process.env.PAYMENTS_CASHIN_TTL_MINUTES || `${MAX_PENDING_DEPOSIT_MINUTES}`,
    10,
  ) || MAX_PENDING_DEPOSIT_MINUTES;
const PENDING_DEPOSIT_EXPIRY_MS =
  Math.min(configuredPendingDepositMinutes, MAX_PENDING_DEPOSIT_MINUTES) *
  60 *
  1000;

export function createEmptyPendingAction() {
  return {
    type: null,
    targetScope: 'unknown',
    targetUsername: null,
    createUsernameMode: 'unknown',
    createConfirmed: false,
    createUsername: null,
    createPassword: null,
    amount: null,
    payerCuit: null,
    payerName: null,
    destinationAccount: null,
    destinationAliasHint: null,
    newPassword: null,
    reason: null,
    logoutAll: false,
    depositStage: null,
    depositCvuSentAt: null,
    depositAccountNumber: null,
    depositAlias: null,
    depositHolderName: null,
    depositReference: null,
  };
}

export function getChatState(chatId) {
  let state = chatStateById.get(chatId);

  if (!state) {
    state = {
      hasIntroduced: false,
      history: [],
      pendingAction: createEmptyPendingAction(),
    };
    chatStateById.set(chatId, state);
  }

  return state;
}

export function clearPendingAction(state) {
  state.pendingAction = createEmptyPendingAction();
}

export function appendHistory(state, role, text) {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) {
    return;
  }

  state.history.push({ role, text: normalizedText });

  if (state.history.length > MAX_HISTORY_MESSAGES) {
    state.history = state.history.slice(-MAX_HISTORY_MESSAGES);
  }
}

export function mergePlanIntoPendingAction(state, plan) {
  if (isOperationalAction(plan.actionType)) {
    if (state.pendingAction.type !== plan.actionType) {
      clearPendingAction(state);
    }

    state.pendingAction.type = plan.actionType;
  } else if (!state.pendingAction.type) {
    return;
  }

  if (
    plan.targetUser?.scope === 'linked' ||
    plan.targetUser?.scope === 'explicit'
  ) {
    state.pendingAction.targetScope = plan.targetUser.scope;
  }

  if (state.pendingAction.type !== 'create_user') {
    const normalizedTargetUsername = normalizeCustomUsername(
      plan.targetUser?.username,
    );
    if (normalizedTargetUsername) {
      state.pendingAction.targetUsername = normalizedTargetUsername;
      state.pendingAction.targetScope = 'explicit';
    }
  }

  if (state.pendingAction.type === 'create_user') {
    if (plan.createUser?.usernameMode === 'generate') {
      state.pendingAction.createUsernameMode = 'generate';
      state.pendingAction.createUsername = null;
    } else if (plan.createUser?.usernameMode === 'custom') {
      state.pendingAction.createUsernameMode = 'custom';
    }

    const normalizedCreateUsername = normalizeCustomUsername(
      plan.createUser?.username,
    );
    if (normalizedCreateUsername) {
      state.pendingAction.createUsername = normalizedCreateUsername;
      state.pendingAction.createUsernameMode = 'custom';
    }

    if (plan.createUser?.password) {
      state.pendingAction.createPassword = String(plan.createUser.password).trim();
    }
  } else {
    if (plan.createUser?.usernameMode === 'generate') {
      state.pendingAction.createUsernameMode = 'generate';
      state.pendingAction.createUsername = null;
    } else if (plan.createUser?.usernameMode === 'custom') {
      state.pendingAction.createUsernameMode = 'custom';
    }

    const normalizedCreateUsername = normalizeCustomUsername(
      plan.createUser?.username,
    );
    if (normalizedCreateUsername) {
      state.pendingAction.createUsername = normalizedCreateUsername;
      state.pendingAction.createUsernameMode = 'custom';
    }

    if (plan.createUser?.password) {
      state.pendingAction.createPassword = String(plan.createUser.password).trim();
    }
  }

  const normalizedAmount = normalizeRequestedAmount(plan.amount);
  if (normalizedAmount) {
    state.pendingAction.amount = normalizedAmount;
  }

  if (plan.payer?.cuit) {
    state.pendingAction.payerCuit = String(plan.payer.cuit).trim();
  }

  if (plan.payer?.name) {
    state.pendingAction.payerName = String(plan.payer.name).trim();
  }

  if (plan.destinationAccount) {
    state.pendingAction.destinationAccount = String(plan.destinationAccount).trim();
    state.pendingAction.destinationAliasHint = null;
  }

  if (plan.newPassword) {
    state.pendingAction.newPassword = String(plan.newPassword).trim();
  }

  if (plan.reason) {
    state.pendingAction.reason = String(plan.reason).trim();
  }

  if (
    isOperationalAction(plan.actionType) ||
    state.pendingAction.type === 'change_password'
  ) {
    state.pendingAction.logoutAll = Boolean(plan.logoutAll);
  }
}

export function consumeExpiredPendingDeposits(referenceTime = Date.now()) {
  const expired = [];
  const now =
    referenceTime instanceof Date
      ? referenceTime.getTime()
      : Number(referenceTime) || Date.now();

  for (const [chatId, state] of chatStateById.entries()) {
    const sentAt = state?.pendingAction?.depositCvuSentAt
      ? new Date(state.pendingAction.depositCvuSentAt).getTime()
      : null;

    if (
      state?.pendingAction?.type === 'add_credit' &&
      state?.pendingAction?.depositStage === 'awaiting_proof_or_cuit' &&
      Number.isFinite(sentAt) &&
      now - sentAt >= PENDING_DEPOSIT_EXPIRY_MS
    ) {
      expired.push({
        chatId,
        targetUsername: state.pendingAction.targetUsername || null,
      });
      clearPendingAction(state);
    }
  }

  return expired;
}
