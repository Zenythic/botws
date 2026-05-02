import {
  createEsmeraldaClient,
  findStoredEsmeraldaUserByUsername,
  getPendingPayOutReservedAmount,
  linkWhatsAppContactToEsmeraldaUser,
} from '../esmeralda/index.js';
import {
  extractTransferDetails,
  generateCasinoOutcomeReply,
} from '../ai/index.js';
import {
  createConversationCashIn,
  createConversationPayOut,
  getCollectorAccount,
} from '../payments/index.js';
import {
  buildCustomerProfile,
  maybeLinkIdentityToUser,
  refreshIdentity,
} from './identity.js';
import {
  extractBankAliasFromText,
  extractBankAccountFromText,
  extractCuitFromText,
  extractDesiredUsernameFromText,
  extractRequestedAmountText,
  generatePasswordCandidate,
  generateUsernameCandidate,
  isAffirmativeReply,
  normalizeBankAccountNumber,
  normalizeCuit,
  normalizeCustomUsername,
  isDuplicateUsernameError,
  isMissingStoredUserError,
  isNegativeReply,
  looksLikeTransferProofMessage,
  parseRequestedAmountNumber,
  wantsCustomUsername,
} from './helpers.js';
import { clearPendingAction } from './state.js';
import { validatePendingAction } from './validators.js';

const esmeraldaClient = createEsmeraldaClient();
const DEPOSIT_CVU =
  process.env.CASINO_DEPOSIT_CVU || '0000003100000000000000';
const DEPOSIT_ALIAS = process.env.CASINO_DEPOSIT_ALIAS || 'prueba.casino.bot';
const DEPOSIT_HOLDER =
  process.env.CASINO_DEPOSIT_HOLDER || 'Cuenta de prueba';
const PLATFORM_URL =
  process.env.CASINO_PLATFORM_URL || 'https://esmeralda.world/';

function buildAuditContext(identity) {
  return {
    phoneKey: identity.phoneKey || null,
    phoneNumber: identity.phoneNumber || null,
    whatsappJid: identity.whatsappJid || null,
    conversationKey: identity.phoneKey || identity.whatsappJid || null,
    pushName: identity.pushName || null,
  };
}

function asksDepositTransferDetails(userText) {
  const normalized = String(userText || '').toLowerCase();
  if (!normalized) {
    return null;
  }

  const asksOnlyTransferMethod =
    /\busdt\b|\busd t\b|\bcripto\b|\bcrypto\b|\bbinance\b/.test(normalized);
  const asksCvu = /\bcvu\b|\bcbu\b/.test(normalized);
  const asksAlias = /\balias\b/.test(normalized);
  const asksHolder = /\btitular\b|a nombre de quien|a nombre de quién/.test(
    normalized,
  );
  const asksMinimum = /\bminimo\b|\bmínimo\b/.test(normalized);

  return {
    asksOnlyTransferMethod,
    asksCvu,
    asksAlias,
    asksHolder,
    asksMinimum,
    askedSomething:
      asksOnlyTransferMethod || asksCvu || asksAlias || asksHolder || asksMinimum,
  };
}

async function buildDepositFaqMessages(userText, options = {}) {
  const intent = asksDepositTransferDetails(userText);
  if (!intent?.askedSomething) {
    return [];
  }

  const chunks = [];
  const collectorAccount =
    options.collectorAccount || (await getCollectorAccount().catch(() => null));
  const cvu = collectorAccount?.cvu || DEPOSIT_CVU;
  const alias = collectorAccount?.alias || DEPOSIT_ALIAS;
  const holderName = collectorAccount?.holderName || DEPOSIT_HOLDER;

  if (intent.asksOnlyTransferMethod) {
    chunks.push('Por ahora solo estamos tomando transferencias al CVU, nada en cripto.');
  }

  if (intent.asksCvu) {
    chunks.push(`CVU: ${cvu}`);
  }

  if (intent.asksAlias && alias) {
    chunks.push(`Alias: ${alias}`);
  }

  if (intent.asksHolder && holderName) {
    chunks.push(`Titular: ${holderName}`);
  }

  if (intent.asksMinimum) {
    chunks.push('Por ahora no hay minimo de recarga.');
  }

  if (options.missingAmount || options.missingCuit) {
    const missingBits = [];

    if (options.missingAmount) {
      missingBits.push('el monto');
    }

    if (options.missingCuit) {
      missingBits.push('el CUIT o CUIL del titular');
    }

    chunks.push(`Si quieres, pasame ${missingBits.join(' y ')} y sigo con eso.`);
  }

  return chunks.filter(Boolean);
}

function buildCashInCreatedReply({
  targetUsername,
  amountText,
}) {
  return `Perfecto, ya deje tomada la carga${amountText ? ` de ${amountText}` : ''} para ${targetUsername}. Si el sistema detecta la transferencia dentro de los proximos 5 minutos, se acredita sola.`;
}

function buildDepositInstructionMessages({
  targetUsername,
  amountText,
  collectorAccount,
}) {
  return [
    `Dale, para cargarle saldo a ${targetUsername} te paso los datos.`,
    `CVU: ${collectorAccount?.cvu || DEPOSIT_CVU}`,
    collectorAccount?.alias || DEPOSIT_ALIAS
      ? `Alias: ${collectorAccount?.alias || DEPOSIT_ALIAS}`
      : null,
    `Titular: ${collectorAccount?.holderName || DEPOSIT_HOLDER}`,
    amountText ? `Monto de referencia: ${amountText}` : null,
    'Tienes 5 minutos para transferir. Cuando lo hagas mandame el comprobante y sigo con eso.',
  ]
    .filter(Boolean)
    ;
}

function buildDepositNeedAmountReply() {
  return 'No me quedó claro el monto. Decimelo cortito y sigo.';
}

function buildDepositNeedCuitReply() {
  return 'No le pude sacar el CUIT o CUIL al comprobante. Pasamelo y te la dejo tomada.';
}

function buildDepositAwaitingProofReply() {
  return 'Dale, cuando transfieras mandame el comprobante y sigo con eso.';
}

function buildPayOutCreatedReply({ amountText, destinationAccount }) {
  const maskedDestination = destinationAccount
    ? `${destinationAccount.slice(0, 4)}...${destinationAccount.slice(-4)}`
    : 'la cuenta que me pasaste';

  return `Dale, ya te deje el retiro pedido por ${amountText} al CVU/CBU ${maskedDestination}. Cuando salga el comprobante queda cerrado.`;
}

async function getFreshStoredUser(username) {
  await esmeraldaClient.ensureActiveSession();
  await esmeraldaClient.syncUsersToDatabase();
  return (
    await findStoredEsmeraldaUserByUsername(username)
  ).row;
}

function buildInsufficientBalanceReply({ username, balanceText, requestedAmount }) {
  const balanceChunk = balanceText ? ` Ahora mismo tiene ${balanceText}.` : '';
  return `No me da el saldo para retirarle ${requestedAmount} a ${username}.${balanceChunk}`;
}

function buildPendingPayoutReservedReply({
  username,
  balanceText,
  requestedAmount,
  reservedAmount,
}) {
  return `No me da para pedir otro retiro de ${requestedAmount} para ${username}. Ya hay ${reservedAmount} reservado en retiros pendientes.${balanceText ? ` El saldo actual es ${balanceText}.` : ''}`;
}

function buildCreateCancelledReply() {
  return 'Dale, no te creo nada por ahora. Si luego quieres jugar, me avisas y te lo armo al toque.';
}

function buildCreateUserSuccessMessages({ username, password }) {
  return [username, password, PLATFORM_URL].filter(Boolean);
}

export function asksPlatformLink(text) {
  const normalized = String(text || '').trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  if (normalized.includes('https://esmeralda.world')) {
    return true;
  }

  const asksLinkLike =
    /\blink\b|\benlace\b|\burl\b|\bpagina\b|\bpágina\b|\bweb\b|\bsitio\b|\bapp\b/.test(
      normalized,
    );
  const asksPlatformLike =
    /\bplataforma\b|\bcasino\b|\bjugar\b|\bingresar\b|\bentrar\b|\bacceder\b/.test(
      normalized,
    );

  return (
    asksLinkLike ||
    normalized === 'plataforma' ||
    normalized === 'pagina' ||
    normalized === 'página' ||
    normalized === 'web' ||
    (asksPlatformLike && /\bpasame\b|\bpasa\b|\bcual\b|\bcuál\b|\bdame\b/.test(normalized))
  );
}

export function buildPlatformLinkReply() {
  return `Dale, entra por aca: ${PLATFORM_URL}`;
}

export function appendPlatformLink(replyText) {
  const baseReply = String(replyText || '').trim();

  if (!baseReply) {
    return buildPlatformLinkReply();
  }

  if (baseReply.includes(PLATFORM_URL)) {
    return baseReply;
  }

  return `${baseReply}\nEntra por aca: ${PLATFORM_URL}`;
}

function applyCreateUserHints(pendingAction, userText) {
  if (wantsCustomUsername(userText)) {
    pendingAction.createUsernameMode = 'custom';
  }

  const desiredUsername = extractDesiredUsernameFromText(userText, {
    allowBareToken:
      pendingAction.createUsernameMode === 'custom' ||
      pendingAction.createConfirmed,
  });

  if (desiredUsername) {
    pendingAction.createUsernameMode = 'custom';
    pendingAction.createUsername = desiredUsername;
  }
}

async function maybePopulateActionDetailsFromEvidence({
  chatId,
  state,
  userText,
  mediaAttachments,
}) {
  const amountFromText = extractRequestedAmountText(userText);
  if (
    amountFromText &&
    !state.pendingAction.amount &&
    (state.pendingAction.type === 'add_credit' ||
      state.pendingAction.type === 'deduct_credit')
  ) {
    state.pendingAction.amount = amountFromText;
  }

  const cuitFromText = normalizeCuit(extractCuitFromText(userText));
  if (cuitFromText && !state.pendingAction.payerCuit) {
    state.pendingAction.payerCuit = cuitFromText;
  }

  const destinationFromText = normalizeBankAccountNumber(
    extractBankAccountFromText(userText),
  );
  if (destinationFromText && !state.pendingAction.destinationAccount) {
    state.pendingAction.destinationAccount = destinationFromText;
    state.pendingAction.destinationAliasHint = null;
  }

  const destinationAlias = extractBankAliasFromText(userText);
  if (
    destinationAlias &&
    state.pendingAction.type === 'deduct_credit' &&
    !state.pendingAction.destinationAccount
  ) {
    state.pendingAction.destinationAliasHint = destinationAlias;
  }

  if (!Array.isArray(mediaAttachments) || mediaAttachments.length === 0) {
    return;
  }

  const needsTransferDetails =
    state.pendingAction.type === 'add_credit' &&
    (!state.pendingAction.amount ||
      !state.pendingAction.payerCuit ||
      !state.pendingAction.payerName);

  if (!needsTransferDetails) {
    return;
  }

  const extracted = await extractTransferDetails({
    chatId,
    userText,
    attachments: mediaAttachments,
  }).catch(() => null);

  if (!extracted) {
    return;
  }

  if (
    extracted.amountText &&
    (!state.pendingAction.amount || state.pendingAction.type === 'add_credit')
  ) {
    state.pendingAction.amount = extracted.amountText;
  }

  if (extracted.cuit && !state.pendingAction.payerCuit) {
    state.pendingAction.payerCuit = extracted.cuit;
  }

  if (extracted.payerName && !state.pendingAction.payerName) {
    state.pendingAction.payerName = extracted.payerName;
  }
}

async function handlePendingCashInPreparation({
  chatId,
  state,
  identity,
  userText,
  mediaAttachments,
}) {
  const normalizedText = String(userText || '').trim();
  const depositFaqMessages = await buildDepositFaqMessages(normalizedText, {
    collectorAccount: {
      cvu: state.pendingAction.depositAccountNumber || null,
      alias: state.pendingAction.depositAlias || null,
      holderName: state.pendingAction.depositHolderName || null,
    },
    missingAmount: !state.pendingAction.amount,
    missingCuit: false,
  });

  if (depositFaqMessages.length > 0) {
    return {
      ready: true,
      replyText: depositFaqMessages.join('\n'),
      replyMessages: depositFaqMessages,
      identity,
      action: null,
    };
  }

  await maybePopulateActionDetailsFromEvidence({
    chatId,
    state,
    userText: normalizedText,
    mediaAttachments,
  });

  if (!state.pendingAction.amount) {
      return {
        ready: true,
        replyText: buildDepositNeedAmountReply(),
        replyMessages: [buildDepositNeedAmountReply()],
        identity,
        action: null,
      };
  }

  if (!state.pendingAction.payerCuit) {
    const proofAttempted =
      (Array.isArray(mediaAttachments) && mediaAttachments.length > 0) ||
      looksLikeTransferProofMessage(normalizedText);

    if (!proofAttempted) {
      return {
        ready: true,
        replyText: buildDepositAwaitingProofReply(),
        replyMessages: [buildDepositAwaitingProofReply()],
        identity,
        action: null,
      };
    }

    return {
      ready: true,
      replyText: buildDepositNeedCuitReply(),
      replyMessages: [buildDepositNeedCuitReply()],
      identity,
      action: null,
    };
  }

  const targetUsername = identity.linkedUser?.username || state.pendingAction.targetUsername;
  const amountText = state.pendingAction.amount;
  const accountNumber = state.pendingAction.depositAccountNumber || DEPOSIT_CVU;
  const alias = state.pendingAction.depositAlias || DEPOSIT_ALIAS;
  const holderName = state.pendingAction.depositHolderName || DEPOSIT_HOLDER;
  const cashInResult = await createConversationCashIn({
    conversationKey: chatId || identity.phoneKey || identity.whatsappJid,
    phoneKey: identity.phoneKey,
    phoneNumber: identity.phoneNumber,
    whatsappJid: identity.whatsappJid,
    linkedRemoteUserId: identity.linkedUser?.remoteUserId || null,
    linkedUsername: targetUsername,
    amountText,
    payerCuit: state.pendingAction.payerCuit,
    payerName: state.pendingAction.payerName || identity.pushName || null,
    accountNumber,
    alias,
    holderName,
  });

  clearPendingAction(state);

  return {
    ready: true,
    replyText: buildCashInCreatedReply({
      targetUsername,
      amountText: cashInResult.expectedAmountText || amountText,
    }),
    replyMessages: [
      buildCashInCreatedReply({
        targetUsername,
        amountText: cashInResult.expectedAmountText || amountText,
      }),
    ],
    identity,
    action: {
      type: 'cashin_request_created',
      requestId: cashInResult.requestId,
      username: targetUsername,
      amount: cashInResult.expectedAmountText || amountText,
    },
  };
}

async function createEsmeraldaUserFromAction(identity, pendingAction) {
  const password = pendingAction.createPassword || generatePasswordCandidate();
  const auditContext = buildAuditContext(identity);
  const desiredCustomUsername = normalizeCustomUsername(pendingAction.createUsername);

  if (
    pendingAction.createUsernameMode === 'custom' &&
    desiredCustomUsername
  ) {
    return {
      ...(await esmeraldaClient.createUser({
        username: desiredCustomUsername,
        password,
        auditContext,
      })),
      generatedUsername: false,
      finalUsername: desiredCustomUsername,
      finalPassword: password,
    };
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateUsernameCandidate(identity.phoneNumber);

    try {
      return {
        ...(await esmeraldaClient.createUser({
          username: candidate,
          password,
          auditContext,
        })),
        generatedUsername: true,
        finalUsername: candidate,
        finalPassword: password,
      };
    } catch (error) {
      if (isDuplicateUsernameError(error)) {
        continue;
      }

      throw error;
    }
  }

  throw new Error('No pude generar un usuario libre recien ahora, probemos de nuevo.');
}

export async function executePendingAction({
  chatId,
  identity,
  state,
  userText,
  mediaAttachments,
}) {
  const actionType = state.pendingAction.type;
  const normalizedUserText = String(userText || '').trim();

  if (actionType === 'create_user') {
    applyCreateUserHints(state.pendingAction, normalizedUserText);
  }

  if (actionType === 'create_user' && !state.pendingAction.createConfirmed) {
    if (isNegativeReply(userText)) {
      clearPendingAction(state);

      return {
        ready: true,
        replyText: buildCreateCancelledReply(),
        replyMessages: [buildCreateCancelledReply()],
        identity,
        action: null,
      };
    }

    if (isAffirmativeReply(userText)) {
      state.pendingAction.createConfirmed = true;
      if (state.pendingAction.createUsernameMode === 'unknown') {
        state.pendingAction.createUsernameMode = 'generate';
      }
      state.pendingAction.createPassword = generatePasswordCandidate();
    }
  }

  await maybePopulateActionDetailsFromEvidence({
    chatId: chatId || identity.phoneKey || identity.whatsappJid,
    state,
    userText: normalizedUserText,
    mediaAttachments,
  });

  const validation = validatePendingAction(identity, state);

  if (!validation.ready) {
    return {
      ready: false,
      replyText: validation.replyText,
      replyMessages: validation.replyText ? [validation.replyText] : [],
      identity,
      action: null,
    };
  }

  switch (actionType) {
    case 'create_user': {
      const createResult = await createEsmeraldaUserFromAction(
        identity,
        state.pendingAction,
      );

      await linkWhatsAppContactToEsmeraldaUser({
        phoneKey: identity.phoneKey,
        phoneNumber: identity.phoneNumber,
        whatsappJid: identity.whatsappJid,
        pushName: identity.pushName,
        remoteUserId:
          createResult.createdUser?.remote_user_id ||
          createResult.destinationId ||
          null,
        username: createResult.finalUsername,
      });

      const refreshedIdentity = await refreshIdentity(identity.phoneKey);
      const replyMessages = buildCreateUserSuccessMessages({
        username: createResult.finalUsername,
        password: createResult.finalPassword,
      });

      clearPendingAction(state);

      return {
        ready: true,
        replyText: replyMessages.join('\n'),
        replyMessages,
        identity: refreshedIdentity,
        action: {
          type: 'create_user',
          username: createResult.finalUsername,
        },
      };
    }
    case 'add_credit': {
      if (state.pendingAction.depositStage === 'awaiting_proof_or_cuit') {
        return handlePendingCashInPreparation({
          chatId: chatId || identity.phoneKey || identity.whatsappJid,
          state,
          identity,
          userText: normalizedUserText,
          mediaAttachments,
        });
      }

      const collectorAccount = await getCollectorAccount({
        forceRefresh: true,
        requireLive: true,
      });
      state.pendingAction.depositAccountNumber =
        collectorAccount?.cvu || DEPOSIT_CVU;
      state.pendingAction.depositAlias =
        collectorAccount?.alias || DEPOSIT_ALIAS;
      state.pendingAction.depositHolderName =
        collectorAccount?.holderName || DEPOSIT_HOLDER;
      state.pendingAction.depositStage = 'awaiting_proof_or_cuit';
      state.pendingAction.depositCvuSentAt = new Date().toISOString();

      return {
        ready: true,
        replyText: buildDepositInstructionMessages({
          targetUsername: validation.targetUsername,
          amountText: validation.amount,
          collectorAccount,
        }).join('\n'),
        replyMessages: buildDepositInstructionMessages({
          targetUsername: validation.targetUsername,
          amountText: validation.amount,
          collectorAccount,
        }),
        identity,
        action: null,
      };
    }
    case 'deduct_credit': {
      const storedUser = await getFreshStoredUser(validation.targetUsername);
      const requestedAmountNumber = parseRequestedAmountNumber(validation.amount);
      const pendingReserved = storedUser
        ? await getPendingPayOutReservedAmount({
            remoteUserId: storedUser.remote_user_id,
            username: storedUser.username,
            phoneKey: identity.phoneKey,
          })
        : { reservedTotal: 0 };
      const availableBalance =
        Number(storedUser?.balance_amount || 0) - Number(pendingReserved.reservedTotal || 0);

      if (
        storedUser &&
        Number.isFinite(requestedAmountNumber) &&
        availableBalance < requestedAmountNumber
      ) {
        const refreshedIdentity = identity.phoneKey
          ? await refreshIdentity(identity.phoneKey)
          : identity;

        clearPendingAction(state);

        return {
          ready: true,
          replyText:
            Number(pendingReserved.reservedTotal || 0) > 0
              ? buildPendingPayoutReservedReply({
                  username: validation.targetUsername,
                  balanceText: storedUser.balance_text,
                  requestedAmount: validation.amount,
                  reservedAmount: amountToText(pendingReserved.reservedTotal) || String(pendingReserved.reservedTotal),
                })
              : buildInsufficientBalanceReply({
                  username: validation.targetUsername,
                  balanceText: storedUser.balance_text,
                  requestedAmount: validation.amount,
                }),
          replyMessages: [
            Number(pendingReserved.reservedTotal || 0) > 0
              ? buildPendingPayoutReservedReply({
                  username: validation.targetUsername,
                  balanceText: storedUser.balance_text,
                  requestedAmount: validation.amount,
                  reservedAmount:
                    amountToText(pendingReserved.reservedTotal) ||
                    String(pendingReserved.reservedTotal),
                })
              : buildInsufficientBalanceReply({
                  username: validation.targetUsername,
                  balanceText: storedUser.balance_text,
                  requestedAmount: validation.amount,
                }),
          ],
          identity: refreshedIdentity,
          action: null,
        };
      }

      clearPendingAction(state);

      const payoutResult = await createConversationPayOut({
        conversationKey: chatId || identity.phoneKey || identity.whatsappJid,
        phoneKey: identity.phoneKey,
        phoneNumber: identity.phoneNumber,
        whatsappJid: identity.whatsappJid,
        linkedRemoteUserId: storedUser?.remote_user_id || identity.linkedUser?.remoteUserId || null,
        linkedUsername: validation.targetUsername,
        amountText: validation.amount,
        destinationAccount: validation.destinationAccount,
      });

      return {
        ready: true,
        replyText: buildPayOutCreatedReply({
          amountText: validation.amount,
          destinationAccount: validation.destinationAccount,
        }),
        replyMessages: [
          buildPayOutCreatedReply({
            amountText: validation.amount,
            destinationAccount: validation.destinationAccount,
          }),
        ],
        identity,
        action: {
          type: 'payout_request_created',
          payoutId: payoutResult.payoutId,
          username: validation.targetUsername,
          amount: validation.amount,
        },
      };
    }
    case 'change_password': {
      const result = await esmeraldaClient.changePassword({
        username: validation.targetUsername,
        newPassword: validation.newPassword,
        logoutAll: validation.logoutAll,
        auditContext: buildAuditContext(identity),
      });

      const refreshedIdentity = await maybeLinkIdentityToUser(identity, {
        username: result.username,
        remoteUserId: result.destinationId,
      });

      const replyText = await generateCasinoOutcomeReply({
        chatId: refreshedIdentity.phoneKey || refreshedIdentity.whatsappJid,
        recentMessages: state.history,
        customerProfile: buildCustomerProfile(refreshedIdentity),
        outcome: {
          type: 'change_password_success',
          username: result.username,
          newPassword: validation.newPassword,
          logoutAll: validation.logoutAll,
        },
      });

      clearPendingAction(state);

      return {
        ready: true,
        replyText,
        replyMessages: [replyText],
        identity: refreshedIdentity,
        action: {
          type: 'change_password',
          username: result.username,
        },
      };
    }
    case 'lock_user': {
      const result = await esmeraldaClient.lockUser({
        username: validation.targetUsername,
        reason: validation.reason,
        auditContext: buildAuditContext(identity),
      });

      const refreshedIdentity = await maybeLinkIdentityToUser(identity, {
        username: result.username,
        remoteUserId: result.destinationId,
      });
      const identityAfterAction = refreshedIdentity.phoneKey
        ? await refreshIdentity(refreshedIdentity.phoneKey)
        : refreshedIdentity;

      const replyText = await generateCasinoOutcomeReply({
        chatId: identityAfterAction.phoneKey || identityAfterAction.whatsappJid,
        recentMessages: state.history,
        customerProfile: buildCustomerProfile(identityAfterAction),
        outcome: {
          type: 'lock_user_success',
          username: result.username,
          reason: validation.reason || null,
        },
      });

      clearPendingAction(state);

      return {
        ready: true,
        replyText,
        replyMessages: [replyText],
        identity: identityAfterAction,
        action: {
          type: 'lock_user',
          username: result.username,
        },
      };
    }
    default:
      return {
        ready: false,
        replyText: null,
        replyMessages: [],
        identity,
        action: null,
      };
  }
}

export function buildHandledErrorReply(state, error) {
  if (
    state.pendingAction.type === 'create_user' &&
    isDuplicateUsernameError(error)
  ) {
    if (state.pendingAction.createUsernameMode === 'custom') {
      state.pendingAction.createUsername = null;
      state.pendingAction.createConfirmed = true;
      return 'Ese usuario ya existe. Pasame otro nombre y te lo creo.';
    }

    clearPendingAction(state);

    return 'Justo se cruzó con un usuario ya tomado. Si quieres, te lo intento crear de nuevo.';
  }

  if (isMissingStoredUserError(error)) {
    state.pendingAction.targetUsername = null;
    state.pendingAction.targetScope = 'unknown';
    return 'No me aparece ese usuario aca. Pasamelo bien y lo reviso.';
  }

  if (/PAYMENTS_API_KEY/i.test(String(error?.message || ''))) {
    return 'Se me cayo la configuracion de pagos de este lado. Probemos en un rato.';
  }

  if (/NO_CVU_RECA/i.test(String(error?.message || ''))) {
    return 'Ahora mismo la cuenta recaudadora no quedo disponible para operar. Probemos en un rato.';
  }

  if (/LIMIT_EXCEEDED/i.test(String(error?.message || ''))) {
    return 'La plataforma no me dejo pedir ese retiro con ese monto. Si quieres, probemos con otro.';
  }

  if (/NO_PAYMENT_ACCOUNT/i.test(String(error?.message || ''))) {
    return 'Ahora mismo no tengo cuentas de pago disponibles para sacar ese retiro. Probemos mas tarde.';
  }

  if (/CVU o CBU destino valido/i.test(String(error?.message || ''))) {
    return 'No me tomo bien el CVU o CBU del retiro. Mandamelo de nuevo y si quieres puede venir con espacios o guiones.';
  }

  return null;
}
