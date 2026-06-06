import { readFile } from 'node:fs/promises';
import {
  buildEffectiveCasinoPrompts,
  CASINO_ACTION_SYSTEM_PROMPT,
  CASINO_AGENT_SYSTEM_PROMPT,
} from './prompts.js';
import { getModelName } from './config.js';
import { getBotRuntimeState } from '../esmeralda/index.js';
import { callOpenRouter } from './client.js';
import {
  extractContentText,
  extractJsonObject,
  normalizeRecentMessages,
  sanitizeReply,
} from './utils.js';

function sanitizePlan(plan) {
  const actionType =
    typeof plan?.action_type === 'string' ? plan.action_type : 'casino_support';
  const pendingActionDirective =
    plan?.pending_action_directive === 'answer_side_question' ||
    plan?.pending_action_directive === 'cancel_pending' ||
    plan?.pending_action_directive === 'proceed'
      ? plan.pending_action_directive
      : 'proceed';
  const targetUser = plan?.target_user || {};
  const createUser = plan?.create_user || {};
  const targetScope =
    targetUser.scope === 'linked' ||
    targetUser.scope === 'explicit' ||
    targetUser.scope === 'unknown'
      ? targetUser.scope
      : 'unknown';
  const usernameMode =
    createUser.username_mode === 'custom' ||
    createUser.username_mode === 'generate' ||
    createUser.username_mode === 'unknown'
      ? createUser.username_mode
      : 'unknown';

  return {
    actionType,
    pendingActionDirective,
    replyText:
      typeof plan?.reply_text === 'string' && plan.reply_text.trim()
        ? sanitizeReply(plan.reply_text)
        : 'Decime bien que necesitas y te doy una mano con eso.',
    targetUser: {
      scope: targetScope,
      username:
        typeof targetUser.username === 'string' && targetUser.username.trim()
          ? targetUser.username.trim()
          : null,
    },
    createUser: {
      usernameMode,
      username:
        typeof createUser.username === 'string' && createUser.username.trim()
          ? createUser.username.trim()
          : null,
      password:
        typeof createUser.password === 'string' && createUser.password.trim()
          ? createUser.password.trim()
          : null,
      missingFields: Array.isArray(createUser.missing_fields)
        ? createUser.missing_fields
            .filter((value) => typeof value === 'string' && value.trim())
            .map((value) => value.trim())
        : [],
    },
    amount:
      typeof plan?.amount === 'string' && plan.amount.trim()
        ? plan.amount.trim()
        : null,
    payer: {
      cuit: sanitizeCuitValue(plan?.payer?.cuit),
      name:
        typeof plan?.payer?.name === 'string' && plan.payer.name.trim()
          ? sanitizeReply(plan.payer.name)
          : null,
    },
    destinationAccount: sanitizeBankAccountValue(plan?.destination_account),
    newPassword:
      typeof plan?.new_password === 'string' && plan.new_password.trim()
        ? plan.new_password.trim()
        : null,
    reason:
      typeof plan?.reason === 'string' && plan.reason.trim()
        ? plan.reason.trim()
        : null,
    logoutAll: Boolean(plan?.logout_all),
  };
}

function sanitizeDepositReference(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9_-]/g, '');

  if (normalized.length < 6) {
    return null;
  }

  return normalized.slice(0, 64);
}

function sanitizeCuitValue(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 11 ? digits : null;
}

function sanitizeBankAccountValue(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 22 ? digits : null;
}

function sanitizeDepositProofPlan(plan) {
  const confidence =
    plan?.confidence === 'high' ||
    plan?.confidence === 'medium' ||
    plan?.confidence === 'low'
      ? plan.confidence
      : 'low';

  return {
    foundReference: Boolean(plan?.found_reference),
    reference: sanitizeDepositReference(plan?.reference),
    amountText:
      typeof plan?.amount_text === 'string' && plan.amount_text.trim()
        ? plan.amount_text.trim()
        : null,
    confidence,
    notes:
      typeof plan?.notes === 'string' && plan.notes.trim()
        ? sanitizeReply(plan.notes)
        : null,
    shouldAskForMore: Boolean(plan?.should_ask_for_more),
  };
}

function sanitizeTransferDetailsPlan(plan) {
  const confidence =
    plan?.confidence === 'high' ||
    plan?.confidence === 'medium' ||
    plan?.confidence === 'low'
      ? plan.confidence
      : 'low';

  return {
    amountText:
      typeof plan?.amount_text === 'string' && plan.amount_text.trim()
        ? plan.amount_text.trim()
        : null,
    cuit: sanitizeCuitValue(plan?.cuit),
    payerName:
      typeof plan?.payer_name === 'string' && plan.payer_name.trim()
        ? sanitizeReply(plan.payer_name)
        : null,
    destinationAccount: sanitizeBankAccountValue(plan?.destination_account),
    confidence,
    notes:
      typeof plan?.notes === 'string' && plan.notes.trim()
        ? sanitizeReply(plan.notes)
        : null,
  };
}

async function getSystemPrompt(promptType, basePrompt) {
  const runtimeState = await getBotRuntimeState().catch(() => null);
  const promptSettings = buildEffectiveCasinoPrompts(runtimeState?.promptSettings);
  const runtimeRules = String(runtimeState?.aiRules?.text || '').trim();
  const selectedPrompt =
    promptType === 'action'
      ? promptSettings.actionSystemPrompt || basePrompt
      : promptSettings.agentSystemPrompt || basePrompt;

  if (!runtimeRules) {
    return selectedPrompt;
  }

  return [
    selectedPrompt,
    'Reglas operativas adicionales activas en este momento.',
    'Debes cumplirlas tambien de forma estricta.',
    runtimeRules,
  ].join('\n\n');
}

export async function generateCasinoTurnPlan({
  chatId,
  userText,
  recentMessages,
  customerProfile,
  pendingAction,
  isFirstInteraction,
}) {
  const promptPayload = {
    customer_profile: customerProfile,
    pending_action: pendingAction,
    is_first_interaction: Boolean(isFirstInteraction),
    recent_messages: normalizeRecentMessages(recentMessages),
    current_user_message: String(userText || '').trim(),
    response_contract: {
      pending_action_directive:
        'proceed | answer_side_question | cancel_pending',
      action_type:
        'create_user | add_credit | deduct_credit | change_password | lock_user | casino_support | off_topic',
      reply_text: 'mensaje natural para enviar al cliente',
      target_user: {
        scope: 'linked | explicit | unknown',
        username: 'string|null',
      },
      create_user: {
        username_mode: 'custom | generate | unknown',
        username: 'string|null',
        password: 'string|null',
        missing_fields: ['confirmation'],
      },
      amount: 'string|null',
      payer: {
        cuit: 'string|null',
        name: 'string|null',
      },
      destination_account: 'string|null',
      new_password: 'string|null',
      reason: 'string|null',
      logout_all: 'boolean',
    },
  };

  const data = await callOpenRouter({
    chatId,
    model: getModelName('turn_plan'),
    temperature: 0.2,
    maxTokens: 450,
    messages: [
      {
        role: 'system',
        content: await getSystemPrompt('agent', CASINO_AGENT_SYSTEM_PROMPT),
      },
      {
        role: 'user',
        content: `Analiza este turno del cliente y responde solo JSON.\n${JSON.stringify(
          promptPayload,
          null,
          2,
        )}`,
      },
    ],
  });

  const rawText = extractContentText(data?.choices?.[0]?.message?.content);
  return sanitizePlan(extractJsonObject(rawText));
}

export async function generateCasinoOutcomeReply({
  chatId,
  recentMessages,
  customerProfile,
  outcome,
}) {
  const promptPayload = {
    customer_profile: customerProfile,
    recent_messages: normalizeRecentMessages(recentMessages),
    outcome,
  };

  const data = await callOpenRouter({
    chatId,
    model: getModelName('action_reply'),
    temperature: 0.35,
    maxTokens: 180,
    messages: [
      {
        role: 'system',
        content: await getSystemPrompt('action', CASINO_ACTION_SYSTEM_PROMPT),
      },
      {
        role: 'user',
        content: `Redacta el mensaje final para el cliente con este contexto:\n${JSON.stringify(
          promptPayload,
          null,
          2,
        )}`,
      },
    ],
  });

  const rawText = extractContentText(data?.choices?.[0]?.message?.content);
  const replyText = sanitizeReply(rawText);

  if (!replyText) {
    throw new Error('Gemini devolvio una respuesta vacia');
  }

  return replyText;
}

export async function extractDepositProof({
  chatId,
  userText,
  attachments = [],
}) {
  const content = [
    {
      type: 'text',
      text:
        'Extrae solo datos de un posible comprobante de transferencia. ' +
        'Responde solo JSON con este contrato: ' +
        '{"found_reference":boolean,"reference":"string|null","amount_text":"string|null","confidence":"high|medium|low","notes":"string|null","should_ask_for_more":boolean}. ' +
        'Solo marca found_reference=true si ves o infieres una referencia de transferencia concreta. ' +
        'No confundas monto, fecha, hora, CVU o numero de cuenta con la referencia. ' +
        `Texto del cliente: ${JSON.stringify(String(userText || '').trim() || null)}.`,
    },
  ];

  for (const attachment of attachments) {
    if (!attachment?.localPath) {
      continue;
    }

    const mimeType = String(attachment.mimeType || '').trim().toLowerCase();
    if (!mimeType.startsWith('image/')) {
      continue;
    }

    const fileBuffer = await readFile(attachment.localPath);
    const dataUrl = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;

    content.push({
      type: 'image_url',
      image_url: {
        url: dataUrl,
      },
    });
  }

  const data = await callOpenRouter({
    chatId,
    model: getModelName('vision'),
    maxTokens: 220,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content:
          'Eres un extractor estricto de referencias de pago. Devuelves solo JSON valido.',
      },
      {
        role: 'user',
        content,
      },
    ],
  });

  const rawText = extractContentText(data?.choices?.[0]?.message?.content);
  return sanitizeDepositProofPlan(extractJsonObject(rawText));
}

export async function extractTransferDetails({
  chatId,
  userText,
  attachments = [],
}) {
  const content = [
    {
      type: 'text',
      text:
        'Extrae datos utiles de transferencia y responde solo JSON valido con este contrato: ' +
        '{"amount_text":"string|null","cuit":"string|null","payer_name":"string|null","destination_account":"string|null","confidence":"high|medium|low","notes":"string|null"}. ' +
        'Si no ves un dato, dejalo en null. ' +
        'El CUIT o CUIL debe ser del pagador y tener 11 digitos. Guardalo en el campo cuit sin guiones ni espacios. ' +
        'Si el comprobante muestra cuenta origen y cuenta destino, el pagador es la cuenta origen. No confundas el CUIT o CUIL de la cuenta destino con el del pagador. ' +
        'Si aparece CUIL en vez de CUIT, tratalo igual y guardalo en cuit. ' +
        'destination_account debe ser un CVU o CBU de 22 digitos si aparece. Si hay cuenta origen y cuenta destino, toma el CVU o CBU de la cuenta destino. ' +
        'amount_text debe ser el monto transferido en pesos, aunque venga con puntos, comas, decimales, separadores o formato visual como 107.000,00 o 107.000 00. ' +
        'payer_name debe ser el nombre del titular de la cuenta origen si aparece. ' +
        'En comprobantes con datos extra, prioriza monto enviado, titular origen, CUIT o CUIL origen y cuenta destino. ' +
        `Texto del cliente: ${JSON.stringify(String(userText || '').trim() || null)}.`,
    },
  ];

  for (const attachment of attachments) {
    if (!attachment?.localPath) {
      continue;
    }

    const mimeType = String(attachment.mimeType || '').trim().toLowerCase();
    if (!mimeType.startsWith('image/')) {
      continue;
    }

    const fileBuffer = await readFile(attachment.localPath);
    const dataUrl = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;

    content.push({
      type: 'image_url',
      image_url: {
        url: dataUrl,
      },
    });
  }

  const data = await callOpenRouter({
    chatId,
    model: getModelName('vision'),
    maxTokens: 260,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content:
          'Eres un extractor estricto de datos de transferencias bancarias argentinas. Entiendes comprobantes con cuenta origen, cuenta destino, CVU, CBU, CUIT y CUIL. Devuelves solo JSON valido.',
      },
      {
        role: 'user',
        content,
      },
    ],
  });

  const rawText = extractContentText(data?.choices?.[0]?.message?.content);
  return sanitizeTransferDetailsPlan(extractJsonObject(rawText));
}
