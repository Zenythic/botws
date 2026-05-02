import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildDefaultCashInReference,
  createPaymentsClient,
  normalizeBankAccountNumber,
  normalizeCuit,
} from './client.js';
import {
  createEsmeraldaClient,
  findCashInRequestById,
  findPayOutRequestById,
  getPaymentAccount,
  listMatchedCashInRequestsPendingCredit,
  listPendingCashInRequests,
  listPendingPayOutRequests,
  storeCashInCallbackEvent,
  storePayOutCallbackEvent,
  upsertCashInRequest,
  upsertPayOutRequest,
  upsertPaymentAccount,
} from '../esmeralda/index.js';

const paymentsClient = createPaymentsClient();
const esmeraldaClient = createEsmeraldaClient();
const RECEIPTS_DIR = resolve(
  process.cwd(),
  process.env.PAYMENTS_RECEIPTS_DIR || './data/payment-receipts',
);
const COLLECTOR_ACCOUNT_CACHE_MS = 2 * 60 * 1000;

let collectorAccountCache = null;

function parseMoneyNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number(value.toFixed(2));
  }

  const normalized = String(value || '')
    .trim()
    .replace(/[^0-9.,-]/g, '');
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseFloat(
    normalized.replace(/\./g, '').replace(',', '.'),
  );

  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function amountToText(value) {
  const amount = parseMoneyNumber(value);
  return amount === null ? null : String(amount);
}

function buildAuditContextFromStoredRow(row) {
  return {
    phoneKey: row?.phone_key || null,
    phoneNumber: row?.phone_number || null,
    whatsappJid: row?.whatsapp_jid || null,
    conversationKey: row?.conversation_key || null,
    pushName: null,
  };
}

function buildCashInEventId(payload = {}) {
  const requestId = String(payload.requestId || 'unknown').trim();
  const eventType =
    String(payload.event || (payload.cashInId ? 'MATCHED' : 'UNKNOWN')).trim() || 'UNKNOWN';
  const cashInId = String(payload.cashInId || 'none').trim();
  return `cashin:${requestId}:${eventType}:${cashInId}`;
}

function buildPayOutEventId(payload = {}, fallbackSuffix = 'unknown') {
  const payoutId =
    payload?.id !== undefined && payload?.id !== null
      ? String(payload.id).trim()
      : 'unknown';
  const status = String(payload?.status || fallbackSuffix || 'unknown').trim();
  return `payout:${payoutId}:${status}`;
}

function mapStoredCollectorAccount(row) {
  if (!row) {
    return null;
  }

  return {
    accountKey: row.account_key,
    cvu: row.cvu || null,
    alias: row.alias || null,
    holderName: row.holder_name || null,
    fetchedAt: row.fetched_at || null,
    updatedAt: row.updated_at || null,
  };
}

function normalizeCashInStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();

  if (normalized === 'matched') {
    return 'Matched';
  }

  if (normalized === 'cancelled') {
    return 'Cancelled';
  }

  if (normalized === 'pending') {
    return 'Pending';
  }

  return null;
}

function normalizePayOutStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();

  if (normalized === 'PENDING') {
    return 'PENDING';
  }

  if (normalized === 'COMPLETED') {
    return 'COMPLETED';
  }

  if (normalized === 'FAILED') {
    return 'FAILED';
  }

  return null;
}

function isPayOutFailedStatus(status, isSuccessful) {
  const normalizedStatus = normalizePayOutStatus(status);

  return (
    normalizedStatus === 'FAILED' ||
    (normalizedStatus === 'COMPLETED' && isSuccessful === false)
  );
}

function isPayOutSuccessfulCompletion(status, isSuccessful) {
  const normalizedStatus = normalizePayOutStatus(status);

  return normalizedStatus === 'COMPLETED' && isSuccessful !== false;
}

function buildMoneyNumber(value) {
  const amount = parseMoneyNumber(value);
  return amount === null ? null : Number(amount.toFixed(2));
}

export async function getCollectorAccount({
  forceRefresh = false,
  requireLive = false,
} = {}) {
  const now = Date.now();

  if (
    !forceRefresh &&
    collectorAccountCache?.cvu &&
    now - new Date(collectorAccountCache.fetchedAt || 0).getTime() <
      COLLECTOR_ACCOUNT_CACHE_MS
  ) {
    return collectorAccountCache;
  }

  try {
    const liveAccount = await paymentsClient.getCollectorCvu();
    const account = {
      accountKey: 'collector',
      cvu: liveAccount.cvu,
      alias: liveAccount.alias,
      holderName: liveAccount.nombre,
      rawPayload: liveAccount.raw,
      fetchedAt: new Date().toISOString(),
    };
    await upsertPaymentAccount(account);
    collectorAccountCache = {
      ...account,
      updatedAt: account.fetchedAt,
    };
    return collectorAccountCache;
  } catch (error) {
    if (requireLive) {
      throw new Error('NO_CVU_RECA');
    }

    const stored = await getPaymentAccount('collector').catch(() => ({ row: null }));
    const mapped = mapStoredCollectorAccount(stored.row);

    if (mapped?.cvu) {
      collectorAccountCache = mapped;
      return mapped;
    }

    throw error;
  }
}

export async function createConversationCashIn(options = {}) {
  const payerCuit = normalizeCuit(options.payerCuit);
  if (!payerCuit) {
    throw new Error('Falta un CUIT o CUIL valido para crear la carga');
  }

  const collectorAccount =
    options.accountNumber || options.alias || options.holderName
      ? {
          cvu: normalizeBankAccountNumber(options.accountNumber),
          alias: options.alias ? String(options.alias).trim() : null,
          holderName: options.holderName ? String(options.holderName).trim() : null,
        }
      : await getCollectorAccount({ forceRefresh: true });
  const accountNumber = normalizeBankAccountNumber(
    options.accountNumber || collectorAccount?.cvu,
  );

  if (!accountNumber) {
    throw new Error('No pude resolver el CVU de la cuenta recaudadora');
  }

  const expectedAmountText = amountToText(options.amountText || options.amount);
  const referenciaString =
    options.referenciaString ||
    buildDefaultCashInReference(options.conversationKey || options.phoneKey);

  const createResult = await paymentsClient.createCashInRequest({
    cuit: payerCuit,
    accountNumber,
    expectedAmount: expectedAmountText,
    nombre: options.payerName || null,
    referenciaString,
    referenciaInt: Number.isInteger(options.referenciaInt)
      ? options.referenciaInt
      : null,
    clientCallbackUrl: options.callbackUrl || null,
    expiresAt: options.expiresAt || null,
  });

  if (!createResult.requestId) {
    throw new Error('La API de CashIn no devolvio requestId');
  }

  const stored = await upsertCashInRequest({
    requestId: createResult.requestId,
    conversationKey: options.conversationKey,
    phoneKey: options.phoneKey,
    phoneNumber: options.phoneNumber,
    whatsappJid: options.whatsappJid,
    linkedRemoteUserId: options.linkedRemoteUserId,
    linkedUsername: options.linkedUsername,
    payerCuit,
    payerName: options.payerName || null,
    expectedAmountText,
    currency: '032',
    accountNumber,
    cvu: collectorAccount?.cvu || null,
    alias: collectorAccount?.alias || null,
    holderName: collectorAccount?.holderName || null,
    callbackUrl:
      options.callbackUrl || paymentsClient.defaultCashInCallbackUrl || null,
    referenciaString,
    referenciaInt: Number.isInteger(options.referenciaInt)
      ? options.referenciaInt
      : null,
    status: 'Pending',
    expiresAt:
      createResult.payload?.expiresAt ||
      new Date(
        Date.now() + paymentsClient.defaultCashInTtlMinutes * 60 * 1000,
      ).toISOString(),
    rawRequest: createResult.payload,
    rawStatus: createResult.raw,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return {
    requestId: createResult.requestId,
    cvu: collectorAccount?.cvu || null,
    alias: collectorAccount?.alias || null,
    holderName: collectorAccount?.holderName || null,
    expectedAmountText,
    storedRow: stored.row,
  };
}

export async function syncPendingCashInRequests(options = {}) {
  const pendingRequestsResult = await listPendingCashInRequests({
    limit: options.limit,
  }).catch(() => ({ rows: [] }));
  const rows = Array.isArray(pendingRequestsResult.rows)
    ? pendingRequestsResult.rows
    : [];
  const results = [];

  for (const row of rows) {
    try {
      const response = await paymentsClient.getCashInRequest(row.request_id);
      const data = response.data || {};
      const status = normalizeCashInStatus(data.status);
      const requestId = String(data.id || row.request_id || '').trim();

      if (!requestId) {
        results.push({
          requestId: row.request_id,
          ok: false,
          reason: 'missing_request_id',
        });
        continue;
      }

      if (status === 'Matched') {
        const outcome = await upsertCashInRequest({
          requestId,
          payerCuit: data.cuit || row.payer_cuit,
          payerName: row.payer_name || null,
          expectedAmountText:
            amountToText(data.expectedAmount) || row.expected_amount_text || null,
          currency: data.currency || row.currency || '032',
          accountNumber: data.accountNumber || row.account_number,
          status: 'Matched',
          expiresAt: data.expiresAt || row.expires_at || null,
          matchedAt: data.matchedAt || row.matched_at || null,
          lastPolledAt: new Date().toISOString(),
          rawStatus: data,
          updatedAt: new Date().toISOString(),
        });

        results.push({
          requestId,
          ok: true,
          status,
          outcome,
        });
        continue;
      }

      if (status === 'Cancelled') {
        const outcome = await processCashInCallback(
          {
            requestId,
            status,
            event: 'EXPIRED',
            expiresAt: data.expiresAt || row.expires_at || null,
            cuit: data.cuit || row.payer_cuit || null,
            accountNumber: data.accountNumber || row.account_number || null,
            currency: data.currency || row.currency || null,
            message: 'La solicitud expiro sin ser procesada',
          },
          {
            syntheticEventType: 'EXPIRED',
            headers: null,
            contentType: 'application/json',
            rawText: JSON.stringify(data),
          },
        );

        results.push({
          requestId,
          ok: true,
          status,
          outcome,
        });
        continue;
      }

      await upsertCashInRequest({
        requestId,
        payerCuit: data.cuit || row.payer_cuit,
        payerName: row.payer_name || null,
        expectedAmountText:
          amountToText(data.expectedAmount) || row.expected_amount_text || null,
        currency: data.currency || row.currency || '032',
        accountNumber: data.accountNumber || row.account_number,
        status: status || row.status || 'Pending',
        expiresAt: data.expiresAt || row.expires_at || null,
        matchedAt: data.matchedAt || row.matched_at || null,
        lastPolledAt: new Date().toISOString(),
        rawStatus: data,
        updatedAt: new Date().toISOString(),
      });

      results.push({
        requestId,
        ok: true,
        status: status || 'Pending',
      });
    } catch (error) {
      results.push({
        requestId: row.request_id,
        ok: false,
        reason: String(error?.message || error),
      });
    }
  }

  return {
    checked: rows.length,
    results,
  };
}

export async function syncPendingPayOutRequests(options = {}) {
  const pendingRequestsResult = await listPendingPayOutRequests({
    limit: options.limit,
  }).catch(() => ({ rows: [] }));
  const rows = Array.isArray(pendingRequestsResult.rows)
    ? pendingRequestsResult.rows
    : [];
  const results = [];

  for (const row of rows) {
    try {
      const response = await paymentsClient.getPayOutRequest(row.payout_id);
      const data = response.data || {};
      const payoutId =
        data?.id !== undefined && data?.id !== null
          ? String(data.id).trim()
          : String(row.payout_id || '').trim();
      const status = normalizePayOutStatus(data.status) || 'PENDING';
      const isSuccessful =
        data?.isSuccessful === true
          ? true
          : data?.isSuccessful === false
          ? false
          : null;
      const now = new Date().toISOString();

      if (!payoutId) {
        results.push({
          payoutId: row.payout_id,
          ok: false,
          reason: 'missing_payout_id',
        });
        continue;
      }

      const payloadData = {
        destination: data.destination || row.destination_account || null,
        amount: data.amount ?? row.amount_text ?? null,
        cvuPago: data.cvuPago || row.cvu_pago || null,
        source: data.source || row.source || null,
        createdDate: data.createdDate || row.created_at || null,
        modifiedDate: data.modifiedDate || now,
        jsonCashOut: data.jsonCashOut || null,
      };

      await upsertPayOutRequest({
        payoutId,
        conversationKey: row.conversation_key,
        phoneKey: row.phone_key,
        phoneNumber: row.phone_number,
        whatsappJid: row.whatsapp_jid,
        linkedRemoteUserId: row.linked_remote_user_id,
        linkedUsername: row.linked_username,
        destinationAccount:
          data.destination || row.destination_account || null,
        amountText: amountToText(data.amount) || row.amount_text || null,
        receiptFormat: row.receipt_format || null,
        callbackUrl: row.callback_url || null,
        status,
        isSuccessful,
        cvuPago: data.cvuPago || row.cvu_pago || null,
        source: data.source || row.source || null,
        lastPolledAt: now,
        lastError: isPayOutFailedStatus(status, isSuccessful)
          ? row.last_error || 'El payout fallo'
          : null,
        rawStatus: data,
        updatedAt: now,
      });

      if (
        isPayOutSuccessfulCompletion(status, isSuccessful) ||
        isPayOutFailedStatus(status, isSuccessful)
      ) {
        const outcome = await processPayOutCallback(
          {
            id: payoutId,
            status,
            isSuccessful,
            data: payloadData,
          },
          {
            headers: null,
            contentType: 'application/json',
            rawText: JSON.stringify(data),
          },
        );

        results.push({
          payoutId,
          ok: true,
          status,
          outcome,
        });
        continue;
      }

      results.push({
        payoutId,
        ok: true,
        status,
      });
    } catch (error) {
      results.push({
        payoutId: row.payout_id,
        ok: false,
        reason: String(error?.message || error),
      });
    }
  }

  return {
    checked: rows.length,
    results,
  };
}

export async function processMatchedCashInCredits(options = {}) {
  const pendingCreditResult = await listMatchedCashInRequestsPendingCredit({
    limit: options.limit,
  }).catch(() => ({ rows: [] }));
  const rows = Array.isArray(pendingCreditResult.rows)
    ? pendingCreditResult.rows
    : [];
  const results = [];

  for (const row of rows) {
    const requestId = String(row.request_id || '').trim();
    const amountText =
      row.credit_amount_text || row.expected_amount_text || null;

    if (!requestId) {
      continue;
    }

    if (!row.linked_username) {
      await upsertCashInRequest({
        requestId,
        payerCuit: row.payer_cuit,
        currency: row.currency,
        accountNumber: row.account_number,
        lastError: 'No hay linked_username para acreditar este cashin',
        updatedAt: new Date().toISOString(),
      });
      results.push({
        requestId,
        ok: false,
        reason: 'missing_linked_user',
      });
      continue;
    }

    if (!amountText) {
      await upsertCashInRequest({
        requestId,
        payerCuit: row.payer_cuit,
        currency: row.currency,
        accountNumber: row.account_number,
        lastError: 'No pude determinar el monto para acreditar',
        updatedAt: new Date().toISOString(),
      });
      results.push({
        requestId,
        ok: false,
        reason: 'missing_amount',
      });
      continue;
    }

    try {
      await esmeraldaClient.addCredit({
        username: row.linked_username,
        amount: amountText,
        auditContext: buildAuditContextFromStoredRow(row),
      });

      await upsertCashInRequest({
        requestId,
        payerCuit: row.payer_cuit,
        currency: row.currency,
        accountNumber: row.account_number,
        status: 'Matched',
        creditApplied: 1,
        creditAppliedAt: new Date().toISOString(),
        creditAmountText: amountText,
        lastError: null,
        updatedAt: new Date().toISOString(),
      });

      results.push({
        requestId,
        ok: true,
        username: row.linked_username,
        amountText,
      });
    } catch (error) {
      await upsertCashInRequest({
        requestId,
        payerCuit: row.payer_cuit,
        currency: row.currency,
        accountNumber: row.account_number,
        creditApplied: 0,
        lastError: String(error?.message || error),
        updatedAt: new Date().toISOString(),
      });

      results.push({
        requestId,
        ok: false,
        username: row.linked_username,
        reason: String(error?.message || error),
      });
    }
  }

  return {
    checked: rows.length,
    results,
  };
}

export async function createConversationPayOut(options = {}) {
  const destinationAccount = normalizeBankAccountNumber(options.destinationAccount);
  if (!destinationAccount) {
    throw new Error('Falta un CVU o CBU destino valido para el retiro');
  }

  const amountText = amountToText(options.amountText || options.amount);
  if (!amountText) {
    throw new Error('Falta un monto valido para crear el retiro');
  }

  const createResult = await paymentsClient.createPayOutRequest({
    destination: destinationAccount,
    amount: amountText,
    receiptFormat: options.receiptFormat || null,
    callbackUrl: options.callbackUrl || null,
  });

  if (!createResult.payoutId) {
    throw new Error('La API de PayOut no devolvio payoutId');
  }

  const stored = await upsertPayOutRequest({
    payoutId: createResult.payoutId,
    conversationKey: options.conversationKey,
    phoneKey: options.phoneKey,
    phoneNumber: options.phoneNumber,
    whatsappJid: options.whatsappJid,
    linkedRemoteUserId: options.linkedRemoteUserId,
    linkedUsername: options.linkedUsername,
    destinationAccount,
    amountText,
    receiptFormat:
      createResult.requestPayload?.receiptFormat ||
      paymentsClient.defaultPayOutReceiptFormat,
    callbackUrl:
      createResult.requestPayload?.callbackUrl ||
      paymentsClient.defaultPayOutCallbackUrl ||
      null,
    status: String(createResult.data?.status || 'PENDING'),
    rawRequest: createResult.requestPayload,
    rawStatus: createResult.data,
    createdAt: String(createResult.data?.createdAt || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  });

  return {
    payoutId: createResult.payoutId,
    storedRow: stored.row,
  };
}

async function persistReceiptFile({ payoutId, format, content, contentType }) {
  await mkdir(RECEIPTS_DIR, { recursive: true });

  if (format === 'html') {
    const filePath = resolve(RECEIPTS_DIR, `${String(payoutId)}.html`);
    await writeFile(filePath, String(content || ''), 'utf8');
    return {
      filePath,
      previewText: String(content || '').slice(0, 800),
      receiptContentType: 'text/html; charset=utf-8',
    };
  }

  if (format === 'stringbase64') {
    const filePath = resolve(RECEIPTS_DIR, `${String(payoutId)}.jpg`);
    await writeFile(filePath, Buffer.from(String(content || ''), 'base64'));
    return {
      filePath,
      previewText: 'receipt:stringbase64',
      receiptContentType: 'image/jpeg',
    };
  }

  if (contentType === 'image/jpeg' && Buffer.isBuffer(content)) {
    const filePath = resolve(
      RECEIPTS_DIR,
      `${String(payoutId || `receipt-${Date.now()}`)}.jpg`,
    );
    await writeFile(filePath, content);
    return {
      filePath,
      previewText: 'receipt:binary-jpeg',
      receiptContentType: 'image/jpeg',
    };
  }

  return {
    filePath: null,
    previewText: null,
    receiptContentType: contentType || null,
  };
}

export async function processCashInCallback(payload = {}, context = {}) {
  const requestId = String(payload.requestId || '').trim();
  const eventType =
    String(
      context.syntheticEventType ||
        payload.event ||
        (String(payload.status || '').trim().toLowerCase() === 'matched'
          ? 'MATCHED'
          : payload.cashInId
          ? 'MATCHED'
          : 'UNKNOWN'),
    ).trim() ||
    'UNKNOWN';
  const eventId = buildCashInEventId(payload);
  const now = new Date().toISOString();

  const storedRequest = requestId
    ? (await findCashInRequestById(requestId)).row
    : null;

  await storeCashInCallbackEvent({
    eventId,
    requestId: requestId || null,
    cashInId: payload.cashInId || null,
    eventType,
    conversationKey: storedRequest?.conversation_key || null,
    phoneKey: storedRequest?.phone_key || null,
    linkedRemoteUserId: storedRequest?.linked_remote_user_id || null,
    linkedUsername: storedRequest?.linked_username || null,
    httpHeaders: context.headers || null,
    rawPayload: payload,
    amount: payload.amount ?? null,
    amountText: amountToText(payload.amount),
    currency: payload.currency || null,
    processedSuccess: null,
    processingNote: 'recibido',
    createdAt: now,
    updatedAt: now,
  });

  if (!requestId) {
    await storeCashInCallbackEvent({
      eventId,
      processingNote: 'callback sin requestId',
      processedSuccess: false,
      updatedAt: new Date().toISOString(),
    });
    return { ok: false, reason: 'missing_request_id' };
  }

  if (eventType === 'EXPIRED') {
    if (!storedRequest) {
      await storeCashInCallbackEvent({
        eventId,
        processedSuccess: false,
        processingNote: 'cashin expirado sin correlacion local',
        updatedAt: new Date().toISOString(),
      });
      return { ok: false, reason: 'unknown_request' };
    }

    await upsertCashInRequest({
      requestId,
      conversationKey: storedRequest.conversation_key || null,
      phoneKey: storedRequest.phone_key || null,
      linkedRemoteUserId: storedRequest.linked_remote_user_id || null,
      linkedUsername: storedRequest.linked_username || null,
      payerCuit: payload.cuit || storedRequest.payer_cuit,
      payerName: storedRequest.payer_name || null,
      expectedAmountText: storedRequest.expected_amount_text || null,
      currency: storedRequest.currency || '032',
      accountNumber: storedRequest.account_number,
      status: 'Cancelled',
      expiresAt: payload.expiresAt || storedRequest.expires_at || null,
      lastError: payload.message || 'La solicitud expiro sin ser procesada',
      rawStatus: payload,
      updatedAt: new Date().toISOString(),
    });

    await storeCashInCallbackEvent({
      eventId,
      processedSuccess: true,
      processingNote: 'cashin marcado como expirado',
      updatedAt: new Date().toISOString(),
    });

    return { ok: true, eventType };
  }

  if (!storedRequest) {
    await storeCashInCallbackEvent({
      eventId,
      processingNote: 'no encontre el cashin request local',
      processedSuccess: false,
      updatedAt: new Date().toISOString(),
    });
    return { ok: false, reason: 'unknown_request' };
  }

  await upsertCashInRequest({
    requestId,
    conversationKey: storedRequest.conversation_key,
    phoneKey: storedRequest.phone_key,
    phoneNumber: storedRequest.phone_number,
    whatsappJid: storedRequest.whatsapp_jid,
    linkedRemoteUserId: storedRequest.linked_remote_user_id,
    linkedUsername: storedRequest.linked_username,
    payerCuit: payload.cuit || storedRequest.payer_cuit,
    payerName: payload.nombre || storedRequest.payer_name || null,
    expectedAmountText: storedRequest.expected_amount_text || amountToText(payload.amount),
    currency: payload.currency || storedRequest.currency || '032',
    accountNumber: storedRequest.account_number,
    cvu: storedRequest.cvu || null,
    alias: storedRequest.alias || null,
    holderName: storedRequest.holder_name || null,
    callbackUrl: storedRequest.callback_url || null,
    referenciaString: storedRequest.referencia_string || null,
    referenciaInt:
      storedRequest.referencia_int !== null &&
      storedRequest.referencia_int !== undefined
        ? Number(storedRequest.referencia_int)
        : null,
    status: 'Matched',
    expiresAt: storedRequest.expires_at || null,
    matchedAt: payload.matchedAt || now,
    cashInId: payload.cashInId || null,
    pspTransactionId: payload.pspTransactionId || null,
    receivedAt: payload.receivedAt || null,
    creditAmountText: amountToText(payload.amount),
    lastError: null,
    rawStatus: payload,
    updatedAt: new Date().toISOString(),
  });

  if (Number(storedRequest.credit_applied || 0) > 0) {
    const callbackAmount = buildMoneyNumber(payload.amount);
    const creditedAmount = buildMoneyNumber(storedRequest.credit_amount_text);

    if (
      callbackAmount !== null &&
      creditedAmount !== null &&
      callbackAmount !== creditedAmount &&
      storedRequest.linked_username
    ) {
      const difference = Number((callbackAmount - creditedAmount).toFixed(2));
      const differenceText = amountToText(Math.abs(difference));

      if (differenceText) {
        if (difference > 0) {
          await esmeraldaClient.addCredit({
            username: storedRequest.linked_username,
            amount: differenceText,
            auditContext: buildAuditContextFromStoredRow(storedRequest),
          });
        } else if (difference < 0) {
          await esmeraldaClient.deductCredit({
            username: storedRequest.linked_username,
            amount: differenceText,
            auditContext: buildAuditContextFromStoredRow(storedRequest),
          });
        }

        await upsertCashInRequest({
          requestId,
          payerCuit: payload.cuit || storedRequest.payer_cuit,
          currency: payload.currency || storedRequest.currency || '032',
          accountNumber: storedRequest.account_number,
          status: 'Matched',
          creditApplied: 1,
          creditAppliedAt: new Date().toISOString(),
          creditAmountText: amountToText(callbackAmount),
          lastError: null,
          rawStatus: payload,
          updatedAt: new Date().toISOString(),
        });

        await storeCashInCallbackEvent({
          eventId,
          eventType,
          processedSuccess: true,
          processingNote: `cashin ajustado en esmeralda por diferencia de monto (${creditedAmount} -> ${callbackAmount})`,
          updatedAt: new Date().toISOString(),
        });

        return {
          ok: true,
          eventType,
          alreadyProcessed: true,
          adjusted: true,
          adjustedAmountText: amountToText(callbackAmount),
        };
      }
    }

    await storeCashInCallbackEvent({
      eventId,
      eventType,
      processedSuccess: true,
      processingNote: 'cashin ya procesado antes',
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, eventType, alreadyProcessed: true };
  }

  if (!storedRequest.linked_username) {
    await upsertCashInRequest({
      requestId,
      payerCuit: storedRequest.payer_cuit,
      currency: storedRequest.currency,
      accountNumber: storedRequest.account_number,
      status: 'Matched',
      lastError: 'No hay linked_username para acreditar este cashin',
      updatedAt: new Date().toISOString(),
    });
    await storeCashInCallbackEvent({
      eventId,
      processedSuccess: false,
      processingNote: 'cashin matcheado pero sin usuario vinculado',
      updatedAt: new Date().toISOString(),
    });
    return { ok: false, reason: 'missing_linked_user' };
  }

  await storeCashInCallbackEvent({
    eventId,
    eventType,
    processedSuccess: true,
    processingNote: 'cashin matcheado y listo para acreditar',
    updatedAt: new Date().toISOString(),
  });

  return { ok: true, eventType, queuedForCredit: true };
}

export async function processPayOutCallback(payload = {}, context = {}) {
  const payoutId =
    payload?.id !== undefined && payload?.id !== null
      ? String(payload.id).trim()
      : null;
  const status = normalizePayOutStatus(payload?.status) || 'UNKNOWN';
  const payoutData =
    payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const isSuccessful =
    payload?.isSuccessful === true
      ? true
      : payload?.isSuccessful === false
      ? false
      : payoutData?.isSuccessful === true
      ? true
      : payoutData?.isSuccessful === false
      ? false
      : null;
  const eventId = buildPayOutEventId(payload, status || 'unknown');
  const now = new Date().toISOString();
  const storedRequest = payoutId
    ? (await findPayOutRequestById(payoutId)).row
    : null;

  let receiptArtifact = {
    filePath: null,
    previewText: null,
    receiptContentType: context.contentType || null,
  };

  if (payload?.receipt?.format && payload?.receipt?.content) {
    receiptArtifact = await persistReceiptFile({
      payoutId,
      format: payload.receipt.format,
      content: payload.receipt.content,
      contentType: context.contentType,
    });
  } else if (context.contentType === 'image/jpeg' && Buffer.isBuffer(context.rawBody)) {
    receiptArtifact = await persistReceiptFile({
      payoutId: payoutId || `unmatched-${Date.now()}`,
      format: 'base64',
      content: context.rawBody,
      contentType: 'image/jpeg',
    });
  }

  await storePayOutCallbackEvent({
    eventId,
    payoutId,
    eventType: status,
    conversationKey: storedRequest?.conversation_key || null,
    phoneKey: storedRequest?.phone_key || null,
    linkedRemoteUserId: storedRequest?.linked_remote_user_id || null,
    linkedUsername: storedRequest?.linked_username || null,
    httpHeaders: context.headers || null,
    rawPayload: payload,
    receiptContentType: receiptArtifact.receiptContentType,
    receiptLocalPath: receiptArtifact.filePath,
    amountText: amountToText(
      payoutData?.amount ?? payload?.amount ?? storedRequest?.amount_text,
    ),
    processedSuccess: null,
    processingNote: 'recibido',
    createdAt: now,
    updatedAt: now,
  });

  if (!payoutId || !storedRequest) {
    await storePayOutCallbackEvent({
      eventId,
      processedSuccess: false,
      processingNote: 'callback payout sin correlacion local',
      updatedAt: new Date().toISOString(),
    });
    return { ok: false, reason: 'unknown_payout' };
  }

  if (isPayOutFailedStatus(status, isSuccessful)) {
    await upsertPayOutRequest({
      payoutId,
      conversationKey: storedRequest.conversation_key,
      phoneKey: storedRequest.phone_key,
      phoneNumber: storedRequest.phone_number,
      whatsappJid: storedRequest.whatsapp_jid,
      linkedRemoteUserId: storedRequest.linked_remote_user_id,
      linkedUsername: storedRequest.linked_username,
      destinationAccount: storedRequest.destination_account,
      amountText: storedRequest.amount_text,
      receiptFormat: storedRequest.receipt_format,
      callbackUrl: storedRequest.callback_url,
      status,
      isSuccessful: false,
      cvuPago: payoutData?.cvuPago || storedRequest.cvu_pago || null,
      source: payoutData?.source || storedRequest.source || null,
      receiptContentType: receiptArtifact.receiptContentType,
      receiptLocalPath: receiptArtifact.filePath,
      receiptPreviewText: receiptArtifact.previewText,
      lastError:
        payload.error ||
        payoutData?.error ||
        (status === 'COMPLETED'
          ? 'El payout fue procesado con error'
          : 'El payout fallo'),
      rawStatus: payload,
      updatedAt: new Date().toISOString(),
    });
    await storePayOutCallbackEvent({
      eventId,
      processedSuccess: true,
      processingNote:
        status === 'COMPLETED'
          ? 'payout completado con error, sin descuento en esmeralda'
          : 'payout marcado como failed',
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, status };
  }

  await upsertPayOutRequest({
    payoutId,
    conversationKey: storedRequest.conversation_key,
    phoneKey: storedRequest.phone_key,
    phoneNumber: storedRequest.phone_number,
    whatsappJid: storedRequest.whatsapp_jid,
    linkedRemoteUserId: storedRequest.linked_remote_user_id,
    linkedUsername: storedRequest.linked_username,
    destinationAccount: storedRequest.destination_account,
    amountText: storedRequest.amount_text,
    receiptFormat:
      payload?.receipt?.format || storedRequest.receipt_format || null,
    callbackUrl: storedRequest.callback_url,
    status: status || 'COMPLETED',
    isSuccessful: isSuccessful === false ? false : status === 'COMPLETED',
    cvuPago: payoutData?.cvuPago || storedRequest.cvu_pago || null,
    source: payoutData?.source || storedRequest.source || null,
    receiptContentType: receiptArtifact.receiptContentType,
    receiptLocalPath: receiptArtifact.filePath,
    receiptPreviewText: receiptArtifact.previewText,
    rawStatus: payload,
    updatedAt: new Date().toISOString(),
  });

  if (Number(storedRequest.esmeralda_debit_applied || 0) > 0) {
    await storePayOutCallbackEvent({
      eventId,
      processedSuccess: true,
      processingNote: 'payout ya descontado antes',
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, status, alreadyProcessed: true };
  }

  if (!storedRequest.linked_username) {
    await upsertPayOutRequest({
      payoutId,
      destinationAccount: storedRequest.destination_account,
      amountText: storedRequest.amount_text,
      status: status || 'COMPLETED',
      lastError: 'No hay linked_username para descontar el payout',
      updatedAt: new Date().toISOString(),
    });
    await storePayOutCallbackEvent({
      eventId,
      processedSuccess: false,
      processingNote: 'payout completado pero sin usuario vinculado',
      updatedAt: new Date().toISOString(),
    });
    return { ok: false, reason: 'missing_linked_user' };
  }

  await upsertPayOutRequest({
    payoutId,
    destinationAccount: storedRequest.destination_account,
    amountText: storedRequest.amount_text,
    esmeraldaDebitApplied: 2,
    updatedAt: new Date().toISOString(),
  });

  try {
    await esmeraldaClient.deductCredit({
      username: storedRequest.linked_username,
      amount: storedRequest.amount_text,
      auditContext: buildAuditContextFromStoredRow(storedRequest),
    });

    await upsertPayOutRequest({
      payoutId,
      destinationAccount: storedRequest.destination_account,
      amountText: storedRequest.amount_text,
      status: status || 'COMPLETED',
      isSuccessful: true,
      esmeraldaDebitApplied: 1,
      esmeraldaDebitAppliedAt: new Date().toISOString(),
      lastError: null,
      rawStatus: payload,
      updatedAt: new Date().toISOString(),
    });

    await storePayOutCallbackEvent({
      eventId,
      processedSuccess: true,
      processingNote: 'payout completado y descontado en esmeralda',
      updatedAt: new Date().toISOString(),
    });

    return { ok: true, status, debited: true };
  } catch (error) {
    await upsertPayOutRequest({
      payoutId,
      destinationAccount: storedRequest.destination_account,
      amountText: storedRequest.amount_text,
      esmeraldaDebitApplied: 0,
      lastError: String(error?.message || error),
      rawStatus: payload,
      updatedAt: new Date().toISOString(),
    });
    await storePayOutCallbackEvent({
      eventId,
      processedSuccess: false,
      processingNote: `fallo el descuento en esmeralda: ${String(error?.message || error)}`,
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }
}
