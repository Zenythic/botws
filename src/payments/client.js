import crypto from 'node:crypto';

const DEFAULT_PAYMENTS_BASE_URL = 'https://ingress.soportecallcenter.com';
const DEFAULT_CURRENCY = '032';
const DEFAULT_CASHIN_TTL_MINUTES = 5;
const DEFAULT_PAYOUT_RECEIPT_FORMAT = 'stringbase64';

function normalizeBaseUrl(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.replace(/\/+$/, '') : DEFAULT_PAYMENTS_BASE_URL;
}

export function normalizeCuit(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 11 ? digits : null;
}

export function normalizeBankAccountNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 22 ? digits : null;
}

function normalizeMoneyAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number(value.toFixed(2));
  }

  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^0-9.,-]/g, '');

  if (!normalized) {
    return null;
  }

  const parsed = Number.parseFloat(
    normalized.replace(/\./g, '').replace(',', '.'),
  );

  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function buildHeaders(apiKey, extraHeaders = {}) {
  const normalizedKey = String(apiKey || '').trim();
  if (!normalizedKey) {
    throw new Error('Falta PAYMENTS_API_KEY para usar la API de CashIn/PayOut');
  }

  return {
    'X-API-Key': normalizedKey,
    ...extraHeaders,
  };
}

async function readResponsePayload(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const rawText = await response.text();

  if (!rawText.trim()) {
    return {
      contentType,
      rawText: '',
      json: null,
    };
  }

  if (contentType.includes('application/json')) {
    try {
      return {
        contentType,
        rawText,
        json: JSON.parse(rawText),
      };
    } catch {
      return {
        contentType,
        rawText,
        json: null,
      };
    }
  }

  return {
    contentType,
    rawText,
    json: null,
  };
}

function assertSuccess(response, payload, expectedStatuses, contextLabel) {
  if (expectedStatuses.includes(response.status)) {
    return;
  }

  const excerpt = String(payload?.rawText || '').slice(0, 500);
  throw new Error(
    `${contextLabel} fallo con status ${response.status}.${excerpt ? ` Respuesta: ${excerpt}` : ''}`,
  );
}

function buildCashInReference(conversationKey) {
  const suffix = crypto.randomBytes(5).toString('hex');
  const base = String(conversationKey || 'wa')
    .replace(/[^A-Za-z0-9:_-]/g, '')
    .slice(-36);
  return `WA-${base}-${suffix}`.slice(0, 64);
}

export class PaymentsClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl || process.env.PAYMENTS_BASE_URL || DEFAULT_PAYMENTS_BASE_URL,
    );
    this.apiKey = String(options.apiKey || process.env.PAYMENTS_API_KEY || '').trim();
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.defaultCashInCallbackUrl = String(
      options.cashInCallbackUrl || process.env.PAYMENTS_CASHIN_CALLBACK_URL || '',
    ).trim();
    this.defaultPayOutCallbackUrl = String(
      options.payOutCallbackUrl || process.env.PAYMENTS_PAYOUT_CALLBACK_URL || '',
    ).trim();
    this.defaultCurrency = String(
      options.currency || process.env.PAYMENTS_CURRENCY || DEFAULT_CURRENCY,
    ).trim() || DEFAULT_CURRENCY;
    const configuredCashInTtlMinutes =
      Number.parseInt(
        options.cashInTtlMinutes || process.env.PAYMENTS_CASHIN_TTL_MINUTES || `${DEFAULT_CASHIN_TTL_MINUTES}`,
        10,
      ) || DEFAULT_CASHIN_TTL_MINUTES;
    this.defaultCashInTtlMinutes = Math.min(
      configuredCashInTtlMinutes > 0
        ? configuredCashInTtlMinutes
        : DEFAULT_CASHIN_TTL_MINUTES,
      DEFAULT_CASHIN_TTL_MINUTES,
    );
    this.defaultPayOutReceiptFormat = String(
      options.payOutReceiptFormat ||
        process.env.PAYMENTS_PAYOUT_RECEIPT_FORMAT ||
        DEFAULT_PAYOUT_RECEIPT_FORMAT,
    ).trim() || DEFAULT_PAYOUT_RECEIPT_FORMAT;

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('No hay una implementacion de fetch disponible para PaymentsClient');
    }
  }

  assertConfigured() {
    if (!this.apiKey) {
      throw new Error('Falta PAYMENTS_API_KEY para usar la API de CashIn/PayOut');
    }
  }

  async request(pathname, options = {}) {
    this.assertConfigured();

    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: options.method || 'GET',
      headers: buildHeaders(this.apiKey, options.headers),
      body: options.body,
    });
    const payload = await readResponsePayload(response);

    return { response, payload };
  }

  async getHealth() {
    const response = await this.fetchImpl(`${this.baseUrl}/health`, {
      method: 'GET',
    });
    const payload = await readResponsePayload(response);
    assertSuccess(response, payload, [200], 'GET /health');

    return {
      status: response.status,
      data: payload.json,
      rawText: payload.rawText,
    };
  }

  async getCollectorCvu() {
    const { response, payload } = await this.request('/api/v1/cvu');
    assertSuccess(response, payload, [200], 'GET /api/v1/cvu');

    const data = payload.json || {};
    return {
      status: response.status,
      cvu: normalizeBankAccountNumber(data.cvu),
      alias: data.alias ? String(data.alias).trim() : null,
      nombre: data.nombre ? String(data.nombre).trim() : null,
      raw: data,
    };
  }

  buildCashInRequestPayload(options = {}) {
    const cuit = normalizeCuit(options.cuit);
    if (!cuit) {
      throw new Error('El CashIn requiere un CUIT o CUIL valido de 11 digitos');
    }

    const accountNumber = normalizeBankAccountNumber(options.accountNumber);
    if (!accountNumber) {
      throw new Error('El CashIn requiere un accountNumber valido de 22 digitos');
    }

    const payload = {
      cuit,
      accountNumber,
      currency: String(options.currency || this.defaultCurrency || DEFAULT_CURRENCY),
    };

    const expectedAmount = normalizeMoneyAmount(options.expectedAmount);
    if (expectedAmount !== null) {
      payload.expectedAmount = expectedAmount;
    }

    if (options.expiresAt) {
      payload.expiresAt = new Date(options.expiresAt).toISOString();
    } else if (!options.disableDefaultExpiry) {
      payload.expiresAt = new Date(
        Date.now() + this.defaultCashInTtlMinutes * 60 * 1000,
      ).toISOString();
    }

    const callbackUrl = String(
      options.clientCallbackUrl || this.defaultCashInCallbackUrl || '',
    ).trim();
    if (callbackUrl) {
      payload.clientCallbackUrl = callbackUrl;
    }

    if (options.nombre) {
      payload.nombre = String(options.nombre).trim();
    }

    if (options.referenciaString) {
      payload.referenciaString = String(options.referenciaString).trim().slice(0, 64);
    }

    if (Number.isInteger(options.referenciaInt)) {
      payload.referenciaInt = options.referenciaInt;
    }

    return payload;
  }

  async createCashInRequest(options = {}) {
    const payload = this.buildCashInRequestPayload(options);
    const { response, payload: responsePayload } = await this.request(
      '/api/v1/cashin-requests',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    assertSuccess(response, responsePayload, [201], 'POST /api/v1/cashin-requests');

    return {
      status: response.status,
      requestId: responsePayload.json?.id ? String(responsePayload.json.id) : null,
      payload,
      raw: responsePayload.json,
    };
  }

  async getCashInRequest(requestId) {
    const normalizedId = String(requestId || '').trim();
    if (!normalizedId) {
      throw new Error('Falta requestId para consultar el CashIn');
    }

    const { response, payload } = await this.request(
      `/api/v1/cashin-requests/${encodeURIComponent(normalizedId)}`,
    );
    assertSuccess(response, payload, [200], 'GET /api/v1/cashin-requests/{id}');

    return {
      status: response.status,
      data: payload.json || null,
      rawText: payload.rawText,
    };
  }

  async listFailedNotifications() {
    const { response, payload } = await this.request('/api/v1/notifications/failed');
    assertSuccess(response, payload, [200], 'GET /api/v1/notifications/failed');

    return {
      status: response.status,
      items: Array.isArray(payload.json) ? payload.json : [],
    };
  }

  async retryFailedNotification(ticketId) {
    const normalizedId = String(ticketId || '').trim();
    if (!normalizedId) {
      throw new Error('Falta ticketId para reintentar la notificacion');
    }

    const { response, payload } = await this.request(
      `/api/v1/notifications/${encodeURIComponent(normalizedId)}/retry`,
      {
        method: 'POST',
      },
    );
    assertSuccess(
      response,
      payload,
      [202],
      'POST /api/v1/notifications/{id}/retry',
    );

    return {
      status: response.status,
      ticketId: normalizedId,
    };
  }

  buildPayOutRequestPayload(options = {}) {
    const destination = normalizeBankAccountNumber(options.destination);
    if (!destination) {
      throw new Error('El PayOut requiere un CVU o CBU destino valido de 22 digitos');
    }

    const amount = normalizeMoneyAmount(options.amount);
    if (amount === null || amount <= 0) {
      throw new Error('El PayOut requiere un monto valido');
    }

    const payload = {
      destination,
      amount,
      receiptFormat:
        String(options.receiptFormat || this.defaultPayOutReceiptFormat || DEFAULT_PAYOUT_RECEIPT_FORMAT).trim() ||
        DEFAULT_PAYOUT_RECEIPT_FORMAT,
    };

    const callbackUrl = String(
      options.callbackUrl || this.defaultPayOutCallbackUrl || '',
    ).trim();
    if (callbackUrl) {
      payload.callbackUrl = callbackUrl;
    }

    return payload;
  }

  async createPayOutRequest(options = {}) {
    const payload = this.buildPayOutRequestPayload(options);
    const { response, payload: responsePayload } = await this.request(
      '/api/v1/payout/requests',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    assertSuccess(response, responsePayload, [202], 'POST /api/v1/payout/requests');

    return {
      status: response.status,
      payoutId:
        responsePayload.json?.id !== undefined && responsePayload.json?.id !== null
          ? String(responsePayload.json.id)
          : null,
      requestPayload: payload,
      data: responsePayload.json || null,
    };
  }

  async getPayOutRequest(payoutId) {
    const normalizedId = String(payoutId || '').trim();
    if (!normalizedId) {
      throw new Error('Falta payoutId para consultar el PayOut');
    }

    const { response, payload } = await this.request(
      `/api/v1/payout/requests/${encodeURIComponent(normalizedId)}`,
    );
    assertSuccess(response, payload, [200], 'GET /api/v1/payout/requests/{id}');

    return {
      status: response.status,
      data: payload.json || null,
      rawText: payload.rawText,
    };
  }

  async listPayOutRequests(options = {}) {
    const query = new URLSearchParams();

    if (options.isCompleted !== undefined && options.isCompleted !== null) {
      query.set('isCompleted', options.isCompleted ? 'true' : 'false');
    }

    if (options.from) {
      query.set('from', String(options.from));
    }

    if (options.to) {
      query.set('to', String(options.to));
    }

    query.set('page', String(options.page || 1));
    query.set('pageSize', String(options.pageSize || 20));

    const suffix = query.toString() ? `?${query.toString()}` : '';
    const { response, payload } = await this.request(
      `/api/v1/payout/requests${suffix}`,
    );
    assertSuccess(response, payload, [200], 'GET /api/v1/payout/requests');

    return {
      status: response.status,
      data: payload.json || null,
      rawText: payload.rawText,
    };
  }
}

let sharedClient;

export function createPaymentsClient(options = {}) {
  return new PaymentsClient(options);
}

export function getPaymentsClient() {
  if (!sharedClient) {
    sharedClient = new PaymentsClient();
  }

  return sharedClient;
}

export function buildDefaultCashInReference(conversationKey) {
  return buildCashInReference(conversationKey);
}
