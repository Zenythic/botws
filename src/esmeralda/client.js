import 'dotenv/config';
import crypto from 'node:crypto';
import {
  findStoredEsmeraldaUserByUsername,
  storeEsmeraldaOperationLog,
  updateStoredEsmeraldaUserBalance,
  upsertEsmeraldaUsers,
} from './db.js';

const DEFAULT_BASE_URL = 'https://admin.esmeralda.world';
const PHPSESSID_LENGTH = 26;
const PHPSESSID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const AUTH_IDLE_RELOGIN_MS = 60_000;

const LOGIN_HEADERS = {
  'Sec-Ch-Ua-Full-Version-List': '',
  'Sec-Ch-Ua-Platform': '"Linux"',
  'Accept-Language': 'es-419,es;q=0.9',
  'Sec-Ch-Ua': '"Chromium";v="145", "Not:A-Brand";v="99"',
  'Sec-Ch-Ua-Bitness': '""',
  'Sec-Ch-Ua-Model': '""',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Arch': '""',
  'X-Requested-With': 'XMLHttpRequest',
  'Sec-Ch-Ua-Full-Version': '""',
  Accept: '*/*',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'Sec-Ch-Ua-Platform-Version': '""',
  Origin: 'https://admin.esmeralda.world',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  Referer: 'https://admin.esmeralda.world/login.php',
  'Accept-Encoding': 'gzip, deflate, br',
  Priority: 'u=1, i',
};

const USERS_HEADERS = {
  'Sec-Ch-Ua': '"Chromium";v="145", "Not:A-Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Full-Version': '""',
  'Sec-Ch-Ua-Arch': '""',
  'Sec-Ch-Ua-Platform': '"Linux"',
  'Sec-Ch-Ua-Platform-Version': '""',
  'Sec-Ch-Ua-Model': '""',
  'Sec-Ch-Ua-Bitness': '""',
  'Sec-Ch-Ua-Full-Version-List': '',
  'Accept-Language': 'es-419,es;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-User': '?1',
  'Sec-Fetch-Dest': 'document',
  'Accept-Encoding': 'gzip, deflate, br',
  Priority: 'u=0, i',
};

const USERS_LIST_HEADERS = {
  ...LOGIN_HEADERS,
  Accept: 'application/json, text/javascript, */*; q=0.01',
  Referer: 'https://admin.esmeralda.world/users.php',
};

const CREATE_USER_HEADERS = {
  ...LOGIN_HEADERS,
  Referer: 'https://admin.esmeralda.world/dashboard.php',
};

const CREDIT_HEADERS = {
  ...LOGIN_HEADERS,
  Accept: '*/*',
  Referer: 'https://admin.esmeralda.world/users.php',
};

const LOCK_USER_HEADERS = {
  ...LOGIN_HEADERS,
  Accept: '*/*',
  Referer: 'https://admin.esmeralda.world/users.php',
};

const CHANGE_PASSWORD_HEADERS = {
  ...LOGIN_HEADERS,
  Accept: '*/*',
  Referer: 'https://admin.esmeralda.world/users.php',
};

const DEFAULT_PROVIDER_IDS = [
  210, 303, 400, 401, 402, 403, 404, 405, 407, 500, 501, 505, 506, 507, 508,
  510, 511, 512, 513, 514, 515, 516, 517, 518, 519, 600, 603, 608, 612, 613,
];

function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }

  return value;
}

function extractBalanceTextFromCreditResponse(responseText) {
  const trimmedText = String(responseText || '').trim();
  if (!trimmedText) {
    return null;
  }

  try {
    const payload = JSON.parse(trimmedText);
    const directValue =
      payload?.balanceText ||
      payload?.balance_text ||
      payload?.data?.balanceText ||
      payload?.data?.balance_text;

    if (typeof directValue === 'string' && directValue.trim()) {
      return directValue.trim();
    }
  } catch {}

  const patterns = [
    /"balanceText"\s*:\s*"([^"]+)"/i,
    /"balance_text"\s*:\s*"([^"]+)"/i,
    /balanceText\s*:\s*([0-9][0-9.,]*)/i,
    /balance_text\s*:\s*([0-9][0-9.,]*)/i,
  ];

  for (const pattern of patterns) {
    const match = trimmedText.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function readSourceIdFromEnv() {
  return String(process.env.ESMERALDA_SOURCE_ID || '309567').trim();
}

function buildResponseExcerpt(value, maxLength = 500) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength).trim()}...`
    : normalized;
}

export function generatePhpSessionId(length = PHPSESSID_LENGTH) {
  const bytes = crypto.randomBytes(length);
  let result = '';

  for (let index = 0; index < length; index += 1) {
    result += PHPSESSID_ALPHABET[bytes[index] % PHPSESSID_ALPHABET.length];
  }

  return result;
}

export function generateLoginToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function extractSessionTokenFromUsersHtml(html) {
  const sessionTokenMatch = html.match(
    /document\.body\.dataset\.session_token='([^']+)'/,
  );

  if (!sessionTokenMatch) {
    throw new Error('No se pudo extraer session_token del HTML de users.php');
  }

  const roomIdMatch = html.match(/document\.body\.dataset\.room_id='([^']+)'/);

  return {
    sessionToken: sessionTokenMatch[1],
    roomId: roomIdMatch?.[1] || null,
  };
}

export function parseEsmeraldaBalance(balanceText) {
  if (!balanceText) {
    return {
      balanceAmount: 0,
      balanceCents: 0,
    };
  }

  const normalizedValue = balanceText.replace(/\./g, '').replace(',', '.');
  const balanceAmount = Number.parseFloat(normalizedValue);

  if (Number.isNaN(balanceAmount)) {
    return {
      balanceAmount: null,
      balanceCents: null,
    };
  }

  return {
    balanceAmount,
    balanceCents: Math.round(balanceAmount * 100),
  };
}

export function mapEsmeraldaUserRow(row, metadata = {}) {
  const { balanceAmount, balanceCents } = parseEsmeraldaBalance(row[1]);

  return {
    username: row[0] || null,
    balanceText: row[1] || null,
    balanceAmount,
    balanceCents,
    creditActions: Array.isArray(row[2]) ? row[2] : [],
    userActions: Array.isArray(row[3]) ? row[3] : [],
    remoteUserId: String(row[4] ?? ''),
    unknownValue: row[5] ?? null,
    userType: row[6] ?? null,
    rawRow: row,
    draw: metadata.draw ?? null,
    recordsTotal: metadata.recordsTotal ?? null,
    recordsFiltered: metadata.recordsFiltered ?? null,
    syncedAt: new Date().toISOString(),
  };
}

export function isValidAlphanumericPassword(password) {
  return (
    typeof password === 'string' &&
    /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{9,}$/.test(password)
  );
}

function normalizeProviderIds(providerIds) {
  return providerIds.map((providerId) => String(providerId).trim()).filter(Boolean);
}

function normalizeAmount(amount) {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('El monto debe ser un numero positivo');
    }

    return String(amount);
  }

  const normalized = String(amount || '').trim().replace(',', '.');
  if (!normalized || Number.isNaN(Number.parseFloat(normalized)) || Number.parseFloat(normalized) <= 0) {
    throw new Error('El monto debe ser un numero positivo');
  }

  return normalized;
}

function normalizeNewPassword(password) {
  const normalized = String(password || '').trim();

  if (normalized.length < 8) {
    throw new Error('La nueva password debe tener minimo 8 caracteres');
  }

  return normalized;
}

function readProviderIdsFromEnv() {
  const rawValue = process.env.ESMERALDA_PROVIDER_IDS;
  if (!rawValue) {
    return DEFAULT_PROVIDER_IDS;
  }

  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildAuditContext(auditContext = {}) {
  return {
    phoneKey: auditContext.phoneKey ? String(auditContext.phoneKey).trim() : null,
    phoneNumber: auditContext.phoneNumber
      ? String(auditContext.phoneNumber).trim()
      : null,
    whatsappJid: auditContext.whatsappJid
      ? String(auditContext.whatsappJid).trim()
      : null,
    conversationKey: auditContext.conversationKey
      ? String(auditContext.conversationKey).trim()
      : null,
    pushName: auditContext.pushName ? String(auditContext.pushName).trim() : null,
  };
}

export class EsmeraldaClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.ESMERALDA_BASE_URL || DEFAULT_BASE_URL;
    this.username = options.username || process.env.ESMERALDA_USER || null;
    this.password = options.password || process.env.ESMERALDA_PASS || null;
    this.fetchImpl = options.fetchImpl || fetch;

    this.phpSessionId = null;
    this.loginToken = null;
    this.sessionToken = null;
    this.roomId = null;
    this.lastUsersHtml = null;
    this.lastUsersListResponse = null;
    this.lastAuthenticatedRequestAt = null;
    this.sourceId = String(options.sourceId || readSourceIdFromEnv());
    this.defaultProviderIds = normalizeProviderIds(
      options.providerIds || readProviderIdsFromEnv(),
    );
  }

  ensureCredentials() {
    if (!this.username) {
      this.username = readRequiredEnv('ESMERALDA_USER');
    }

    if (!this.password) {
      this.password = readRequiredEnv('ESMERALDA_PASS');
    }
  }

  buildCookieHeader() {
    if (!this.phpSessionId) {
      throw new Error('Todavia no existe PHPSESSID para construir la cookie');
    }

    return `cf_clearance=null; PHPSESSID=${this.phpSessionId}`;
  }

  buildLoginBody() {
    if (!this.loginToken) {
      throw new Error('Todavia no existe token de login');
    }

    return new URLSearchParams({
      user: this.username,
      passwd: this.password,
      token: this.loginToken,
    });
  }

  async login() {
    this.ensureCredentials();
    this.phpSessionId = generatePhpSessionId();
    this.loginToken = generateLoginToken();

    const response = await this.fetchImpl(`${this.baseUrl}/services/login.php`, {
      method: 'POST',
      headers: {
        ...LOGIN_HEADERS,
        Cookie: this.buildCookieHeader(),
      },
      body: this.buildLoginBody(),
    });

    const bodyText = await response.text();

    if (response.status !== 200) {
      throw new Error(
        `Login fallo con status ${response.status}. Respuesta: ${bodyText.slice(0, 300)}`,
      );
    }

    return {
      ok: true,
      status: response.status,
      phpSessionId: this.phpSessionId,
      loginToken: this.loginToken,
      body: bodyText,
    };
  }

  async authorizeUsersPage() {
    if (!this.phpSessionId) {
      throw new Error('Primero debes ejecutar login()');
    }

    const response = await this.fetchImpl(`${this.baseUrl}/users.php`, {
      method: 'GET',
      headers: {
        ...USERS_HEADERS,
        Cookie: this.buildCookieHeader(),
      },
    });

    const html = await response.text();

    if (response.status !== 200) {
      throw new Error(
        `users.php fallo con status ${response.status}. Respuesta: ${html.slice(0, 300)}`,
      );
    }

    const { sessionToken, roomId } = extractSessionTokenFromUsersHtml(html);

    this.sessionToken = sessionToken;
    this.roomId = roomId;
    this.lastUsersHtml = html;
    this.markAuthenticatedRequest();

    return {
      ok: true,
      status: response.status,
      phpSessionId: this.phpSessionId,
      sessionToken: this.sessionToken,
      roomId: this.roomId,
      html,
    };
  }

  async authenticate() {
    const loginResult = await this.login();
    const usersResult = await this.authorizeUsersPage();

    return {
      ok: true,
      loginStatus: loginResult.status,
      usersStatus: usersResult.status,
      phpSessionId: this.phpSessionId,
      loginToken: this.loginToken,
      sessionToken: this.sessionToken,
      roomId: this.roomId,
    };
  }

  ensureAuthenticated() {
    if (!this.phpSessionId || !this.sessionToken) {
      throw new Error('El cliente todavia no esta autenticado');
    }
  }

  markAuthenticatedRequest() {
    this.lastAuthenticatedRequestAt = Date.now();
  }

  shouldReauthenticate() {
    if (!this.phpSessionId || !this.sessionToken || !this.lastAuthenticatedRequestAt) {
      return true;
    }

    return Date.now() - this.lastAuthenticatedRequestAt > AUTH_IDLE_RELOGIN_MS;
  }

  async ensureActiveSession() {
    if (this.shouldReauthenticate()) {
      return this.authenticate();
    }

    return {
      reused: true,
      phpSessionId: this.phpSessionId,
      sessionToken: this.sessionToken,
      roomId: this.roomId,
      lastAuthenticatedRequestAt: this.lastAuthenticatedRequestAt,
    };
  }

  buildUsersListBody(options = {}) {
    this.ensureAuthenticated();

    const draw = options.draw ?? 1;
    const start = options.start ?? 0;
    const length = options.length ?? 10;
    const section = options.section ?? 'all';
    const username = options.username ?? '';
    const affiliatesIndex = options.affiliatesIndex ?? -1;
    const searchValue = options.searchValue ?? '';

    const params = new URLSearchParams();
    params.set('draw', String(draw));

    for (let index = 0; index <= 6; index += 1) {
      params.set(`columns[${index}][data]`, String(index));
      params.set(`columns[${index}][name]`, '');
      params.set(`columns[${index}][searchable]`, 'true');
      params.set(`columns[${index}][orderable]`, 'false');
      params.set(`columns[${index}][search][value]`, '');
      params.set(`columns[${index}][search][regex]`, 'false');
    }

    params.set('start', String(start));
    params.set('length', String(length));
    params.set('search[value]', searchValue);
    params.set('search[regex]', 'false');
    params.set('section', section);
    params.set('username', username);
    params.set('affiliates_index', String(affiliatesIndex));
    params.set('token', this.sessionToken);

    return params;
  }

  async fetchUsersPage(options = {}) {
    await this.ensureActiveSession();

    const response = await this.fetchImpl(
      `${this.baseUrl}/services/operation_get_users_list.php`,
      {
        method: 'POST',
        headers: {
          ...USERS_LIST_HEADERS,
          Cookie: this.buildCookieHeader(),
        },
        body: this.buildUsersListBody(options),
      },
    );

    const responseText = await response.text();

    if (response.status !== 200) {
      throw new Error(
        `operation_get_users_list.php fallo con status ${response.status}. Respuesta: ${responseText.slice(0, 300)}`,
      );
    }

    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch (error) {
      throw new Error(
        `La respuesta de operation_get_users_list.php no fue JSON valido: ${responseText.slice(0, 300)}`,
      );
    }

    const rawRows = Array.isArray(payload.data) ? payload.data : [];
    const users = rawRows.map((row) =>
      mapEsmeraldaUserRow(row, {
        draw: payload.draw,
        recordsTotal: payload.recordsTotal,
        recordsFiltered: payload.recordsFiltered,
      }),
    );

    this.lastUsersListResponse = payload;
    this.markAuthenticatedRequest();

    return {
      status: response.status,
      draw: payload.draw,
      recordsTotal: Number(payload.recordsTotal ?? rawRows.length),
      recordsFiltered: Number(payload.recordsFiltered ?? rawRows.length),
      affiliatesIndex: payload.affiliatesIndex ?? null,
      rawRows,
      users,
      payload,
    };
  }

  async fetchAllUsers(options = {}) {
    this.ensureAuthenticated();

    const pageSize = options.pageSize ?? 100;
    const users = [];
    let start = 0;
    let draw = 1;
    let recordsTotal = null;
    let pagesFetched = 0;

    while (recordsTotal === null || start < recordsTotal) {
      const page = await this.fetchUsersPage({
        ...options,
        draw,
        start,
        length: pageSize,
      });

      users.push(...page.users);
      pagesFetched += 1;
      recordsTotal = page.recordsFiltered || page.recordsTotal || users.length;

      if (page.rawRows.length === 0) {
        break;
      }

      start += page.rawRows.length;
      draw += 1;
    }

    return {
      users,
      totalUsers: users.length,
      recordsTotal,
      pagesFetched,
    };
  }

  async syncUsersToDatabase(options = {}) {
    const result = await this.fetchAllUsers(options);
    const storage = await upsertEsmeraldaUsers(result.users, {
      dbPath: options.dbPath,
    });

    return {
      ...result,
      ...storage,
    };
  }

  async createUser() {
    throw new Error('createUser() requiere argumentos. Usa createUser({ username, password })');
  }

  async loadBalance() {
    throw new Error('loadBalance() requiere argumentos. Usa loadBalance({ username, amount })');
  }

  async withdrawBalance() {
    throw new Error('withdrawBalance() requiere argumentos. Usa withdrawBalance({ username, amount })');
  }

  async lockUser() {
    throw new Error('lockUser() requiere argumentos. Usa lockUser({ username, reason })');
  }

  async changePassword() {
    throw new Error(
      'changePassword() requiere argumentos. Usa changePassword({ username, newPassword })',
    );
  }
}

EsmeraldaClient.prototype.recordOperationLog = async function recordOperationLog(
  options = {},
) {
  const auditContext = buildAuditContext(options.auditContext);

  try {
    await storeEsmeraldaOperationLog(
      {
        operationId: crypto.randomUUID(),
        operationType: options.operationType,
        endpoint: options.endpoint,
        httpMethod: options.httpMethod || 'POST',
        targetRemoteUserId: options.targetRemoteUserId || null,
        targetUsername: options.targetUsername || null,
        targetUserType: options.targetUserType || null,
        phoneKey: auditContext.phoneKey,
        phoneNumber: auditContext.phoneNumber,
        whatsappJid: auditContext.whatsappJid,
        conversationKey: auditContext.conversationKey,
        actorPushName: auditContext.pushName,
        amountText: options.amountText || null,
        balanceText: options.balanceText || null,
        success: options.success !== false,
        responseStatus: options.responseStatus ?? null,
        errorMessage: options.errorMessage || null,
        requestPayload: options.requestPayload || null,
        responseExcerpt: buildResponseExcerpt(options.responseExcerpt),
        metadata: options.metadata || null,
        createdAt: new Date().toISOString(),
      },
      { dbPath: options.dbPath },
    );
  } catch {}
};

EsmeraldaClient.prototype.buildCreateUserBody = function buildCreateUserBody(options = {}) {
  this.ensureAuthenticated();

  const username = String(options.username || '').trim();
  const password = String(options.password || '').trim();
  const role = options.role || 'player';
  const name = options.name || '';
  const passport = options.passport || '';
  const email = options.email || '';
  const phone = options.phone || '';
  const providerIds = normalizeProviderIds(
    options.providerIds?.length ? options.providerIds : this.defaultProviderIds,
  );

  const params = new URLSearchParams();
  params.set('role', role);
  params.set('username', username);
  params.set('password', password);
  params.set('name', name);
  params.set('passport', passport);
  params.set('email', email);
  params.set('phone', phone);

  for (const providerId of providerIds) {
    params.append('providers[]', providerId);
  }

  params.set('token', this.sessionToken);
  return params;
};

EsmeraldaClient.prototype.validateCreateUserInput = function validateCreateUserInput(options = {}) {
  const username = String(options.username || '').trim();
  const password = String(options.password || '').trim();

  if (!username) {
    throw new Error('El username es obligatorio');
  }

  if (!/^[A-Za-z0-9_]+$/.test(username)) {
    throw new Error('El username solo puede contener letras, numeros y guion bajo');
  }

  if (!isValidAlphanumericPassword(password)) {
    throw new Error(
      'La password debe ser alfanumerica y tener minimo 9 caracteres',
    );
  }

  return {
    username,
    password,
  };
};

EsmeraldaClient.prototype.createUser = async function createUser(options = {}) {
  const { username } = this.validateCreateUserInput(options);
  await this.ensureActiveSession();

  await this.syncUsersToDatabase({ dbPath: options.dbPath });
  const existingUser = (
    await findStoredEsmeraldaUserByUsername(username, {
      dbPath: options.dbPath,
    })
  ).row;

  if (existingUser) {
    throw new Error(`Ya existe un usuario con username ${username}`);
  }

  const requestPayload = {
    role: options.role || 'player',
    username,
    hasPassword: true,
    providerIds:
      options.providerIds?.length
        ? normalizeProviderIds(options.providerIds)
        : this.defaultProviderIds,
  };

  const response = await this.fetchImpl(
    `${this.baseUrl}/services/operation_create_user.php`,
    {
      method: 'POST',
      headers: {
        ...CREATE_USER_HEADERS,
        Cookie: this.buildCookieHeader(),
      },
      body: this.buildCreateUserBody(options),
    },
  );

  const responseText = await response.text();

  if (response.status !== 200) {
    await this.recordOperationLog({
      dbPath: options.dbPath,
      auditContext: options.auditContext,
      operationType: 'create_user',
      endpoint: '/services/operation_create_user.php',
      targetUsername: username,
      targetUserType: 'player',
      requestPayload,
      responseStatus: response.status,
      responseExcerpt: responseText,
      success: false,
      errorMessage: `operation_create_user.php fallo con status ${response.status}`,
    });
    throw new Error(
      `operation_create_user.php fallo con status ${response.status}. Respuesta: ${responseText.slice(0, 300)}`,
    );
  }

  this.markAuthenticatedRequest();

  const syncResult = await this.syncUsersToDatabase({ dbPath: options.dbPath });
  const createdUser = (
    await findStoredEsmeraldaUserByUsername(username, {
      dbPath: options.dbPath,
    })
  ).row;

  await this.recordOperationLog({
    dbPath: options.dbPath,
    auditContext: options.auditContext,
    operationType: 'create_user',
    endpoint: '/services/operation_create_user.php',
    targetRemoteUserId: createdUser?.remote_user_id || null,
    targetUsername: username,
    targetUserType: createdUser?.user_type || 'player',
    requestPayload,
    responseStatus: response.status,
    responseExcerpt: responseText,
    success: true,
    metadata: {
      syncedUsers: syncResult.totalUsers || 0,
    },
  });

  return {
    status: response.status,
    username,
    phpSessionId: this.phpSessionId,
    sessionToken: this.sessionToken,
    rawResponse: responseText,
    createdUser,
    syncResult,
  };
};

EsmeraldaClient.prototype.findUserForCreditOperation = async function findUserForCreditOperation(
  options = {},
) {
  const username = String(options.username || '').trim();
  if (!username) {
    throw new Error('Debes indicar el username del usuario destino');
  }

  await this.syncUsersToDatabase({ dbPath: options.dbPath });

  const storedUserResult = await findStoredEsmeraldaUserByUsername(username, {
    dbPath: options.dbPath,
  });

  if (!storedUserResult.row) {
    throw new Error(`No se encontro el usuario ${username} en la base local`);
  }

  return storedUserResult.row;
};

EsmeraldaClient.prototype.buildCreditOperationBody = function buildCreditOperationBody(
  options = {},
) {
  this.ensureAuthenticated();

  const amount = normalizeAmount(options.amount);
  const action = options.action;
  const destinationUser = options.destinationUser;

  if (!['add', 'deduct'].includes(action)) {
    throw new Error('La accion debe ser add o deduct');
  }

  const params = new URLSearchParams();
  params.set('source_id', this.sourceId);
  params.set('destination_id', String(destinationUser.remote_user_id));
  params.set('destination_username', String(destinationUser.username));
  params.set('destination_role', String(destinationUser.user_type || 'player'));
  params.set('action', action);
  params.set('amount', amount);
  params.set('register_finance_collect', 'false');
  params.set('register_finance_bonification', 'false');
  params.set('token', this.sessionToken);

  return params;
};

EsmeraldaClient.prototype.changeCredit = async function changeCredit(options = {}) {
  await this.ensureActiveSession();
  const normalizedAmount = normalizeAmount(options.amount);

  const destinationUser = await this.findUserForCreditOperation({
    username: options.username,
    dbPath: options.dbPath,
  });

  const response = await this.fetchImpl(
    `${this.baseUrl}/services/operation_add_deduct_credit.php`,
    {
      method: 'POST',
      headers: {
        ...CREDIT_HEADERS,
        Cookie: this.buildCookieHeader(),
      },
      body: this.buildCreditOperationBody({
        action: options.action,
        amount: normalizedAmount,
        destinationUser,
      }),
    },
  );

  const responseText = await response.text();

  if (response.status !== 200) {
    await this.recordOperationLog({
      dbPath: options.dbPath,
      auditContext: options.auditContext,
      operationType: options.action === 'add' ? 'add_credit' : 'deduct_credit',
      endpoint: '/services/operation_add_deduct_credit.php',
      targetRemoteUserId: destinationUser.remote_user_id,
      targetUsername: destinationUser.username,
      targetUserType: destinationUser.user_type || 'player',
      amountText: normalizedAmount,
      requestPayload: {
        sourceId: this.sourceId,
        destinationId: destinationUser.remote_user_id,
        destinationUsername: destinationUser.username,
        destinationRole: destinationUser.user_type || 'player',
        action: options.action,
        amount: normalizedAmount,
      },
      responseStatus: response.status,
      responseExcerpt: responseText,
      success: false,
      errorMessage: `operation_add_deduct_credit.php fallo con status ${response.status}`,
    });
    throw new Error(
      `operation_add_deduct_credit.php fallo con status ${response.status}. Respuesta: ${responseText.slice(0, 300)}`,
    );
  }

  this.markAuthenticatedRequest();

  const responseBalanceText = extractBalanceTextFromCreditResponse(responseText);
  if (responseBalanceText) {
    await updateStoredEsmeraldaUserBalance({
      dbPath: options.dbPath,
      remoteUserId: destinationUser.remote_user_id,
      username: destinationUser.username,
      balanceText: responseBalanceText,
    });
  }

  await this.recordOperationLog({
    dbPath: options.dbPath,
    auditContext: options.auditContext,
    operationType: options.action === 'add' ? 'add_credit' : 'deduct_credit',
    endpoint: '/services/operation_add_deduct_credit.php',
    targetRemoteUserId: destinationUser.remote_user_id,
    targetUsername: destinationUser.username,
    targetUserType: destinationUser.user_type || 'player',
    amountText: normalizedAmount,
    balanceText: responseBalanceText,
    requestPayload: {
      sourceId: this.sourceId,
      destinationId: destinationUser.remote_user_id,
      destinationUsername: destinationUser.username,
      destinationRole: destinationUser.user_type || 'player',
      action: options.action,
      amount: normalizedAmount,
    },
    responseStatus: response.status,
    responseExcerpt: responseText,
    success: true,
  });

  const syncResult = await this.syncUsersToDatabase({ dbPath: options.dbPath });
  const updatedUser = (
    await findStoredEsmeraldaUserByUsername(destinationUser.username, {
      dbPath: options.dbPath,
    })
  ).row;

  return {
    status: response.status,
    action: options.action,
    amount: normalizedAmount,
    username: destinationUser.username,
    destinationId: destinationUser.remote_user_id,
    responseBalanceText,
    rawResponse: responseText,
    updatedUser,
    syncResult,
  };
};

EsmeraldaClient.prototype.addCredit = async function addCredit(options = {}) {
  return this.changeCredit({
    ...options,
    action: 'add',
  });
};

EsmeraldaClient.prototype.deductCredit = async function deductCredit(options = {}) {
  return this.changeCredit({
    ...options,
    action: 'deduct',
  });
};

EsmeraldaClient.prototype.loadBalance = async function loadBalance(options = {}) {
  return this.addCredit(options);
};

EsmeraldaClient.prototype.withdrawBalance = async function withdrawBalance(options = {}) {
  return this.deductCredit(options);
};

EsmeraldaClient.prototype.buildLockUserBody = function buildLockUserBody(options = {}) {
  this.ensureAuthenticated();

  const destinationUser = options.destinationUser;
  const reason = String(options.reason || '').trim();

  const params = new URLSearchParams();
  params.set('user_id', String(destinationUser.remote_user_id));
  params.set('user_role', String(destinationUser.user_type || 'player'));
  params.set('action', 'lock');
  params.set('reason', reason);
  params.set('token', this.sessionToken);

  return params;
};

EsmeraldaClient.prototype.lockUser = async function lockUser(options = {}) {
  await this.ensureActiveSession();

  const destinationUser = await this.findUserForCreditOperation({
    username: options.username,
    dbPath: options.dbPath,
  });

  const response = await this.fetchImpl(
    `${this.baseUrl}/services/operation_lock_user.php`,
    {
      method: 'POST',
      headers: {
        ...LOCK_USER_HEADERS,
        Cookie: this.buildCookieHeader(),
      },
      body: this.buildLockUserBody({
        destinationUser,
        reason: options.reason,
      }),
    },
  );

  const responseText = await response.text();

  if (response.status !== 200) {
    await this.recordOperationLog({
      dbPath: options.dbPath,
      auditContext: options.auditContext,
      operationType: 'lock_user',
      endpoint: '/services/operation_lock_user.php',
      targetRemoteUserId: destinationUser.remote_user_id,
      targetUsername: destinationUser.username,
      targetUserType: destinationUser.user_type || 'player',
      requestPayload: {
        userId: destinationUser.remote_user_id,
        userRole: destinationUser.user_type || 'player',
        action: 'lock',
        reason: String(options.reason || '').trim(),
      },
      responseStatus: response.status,
      responseExcerpt: responseText,
      success: false,
      errorMessage: `operation_lock_user.php fallo con status ${response.status}`,
    });
    throw new Error(
      `operation_lock_user.php fallo con status ${response.status}. Respuesta: ${responseText.slice(0, 300)}`,
    );
  }

  this.markAuthenticatedRequest();

  await this.recordOperationLog({
    dbPath: options.dbPath,
    auditContext: options.auditContext,
    operationType: 'lock_user',
    endpoint: '/services/operation_lock_user.php',
    targetRemoteUserId: destinationUser.remote_user_id,
    targetUsername: destinationUser.username,
    targetUserType: destinationUser.user_type || 'player',
    requestPayload: {
      userId: destinationUser.remote_user_id,
      userRole: destinationUser.user_type || 'player',
      action: 'lock',
      reason: String(options.reason || '').trim(),
    },
    responseStatus: response.status,
    responseExcerpt: responseText,
    success: true,
    metadata: {
      reason: String(options.reason || '').trim() || null,
    },
  });

  const syncResult = await this.syncUsersToDatabase({ dbPath: options.dbPath });
  const updatedUser = (
    await findStoredEsmeraldaUserByUsername(destinationUser.username, {
      dbPath: options.dbPath,
    })
  ).row;

  return {
    status: response.status,
    username: destinationUser.username,
    destinationId: destinationUser.remote_user_id,
    reason: String(options.reason || '').trim(),
    rawResponse: responseText,
    updatedUser,
    syncResult,
  };
};

EsmeraldaClient.prototype.buildChangePasswordBody = function buildChangePasswordBody(
  options = {},
) {
  this.ensureAuthenticated();

  const destinationUser = options.destinationUser;
  const newPassword = normalizeNewPassword(options.newPassword);
  const logoutAll = options.logoutAll ? '1' : '0';

  const params = new URLSearchParams();
  params.set('user_id', String(destinationUser.remote_user_id));
  params.set('user_role', String(destinationUser.user_type || 'player'));
  params.set('new_password', newPassword);
  params.set('logout_all', logoutAll);
  params.set('token', this.sessionToken);

  return params;
};

EsmeraldaClient.prototype.changePassword = async function changePassword(options = {}) {
  await this.ensureActiveSession();

  const destinationUser = await this.findUserForCreditOperation({
    username: options.username,
    dbPath: options.dbPath,
  });

  const response = await this.fetchImpl(
    `${this.baseUrl}/services/operation_change_password.php`,
    {
      method: 'POST',
      headers: {
        ...CHANGE_PASSWORD_HEADERS,
        Cookie: this.buildCookieHeader(),
      },
      body: this.buildChangePasswordBody({
        destinationUser,
        newPassword: options.newPassword,
        logoutAll: options.logoutAll,
      }),
    },
  );

  const responseText = await response.text();

  if (response.status !== 200) {
    await this.recordOperationLog({
      dbPath: options.dbPath,
      auditContext: options.auditContext,
      operationType: 'change_password',
      endpoint: '/services/operation_change_password.php',
      targetRemoteUserId: destinationUser.remote_user_id,
      targetUsername: destinationUser.username,
      targetUserType: destinationUser.user_type || 'player',
      requestPayload: {
        userId: destinationUser.remote_user_id,
        userRole: destinationUser.user_type || 'player',
        logoutAll: Boolean(options.logoutAll),
        passwordChanged: true,
      },
      responseStatus: response.status,
      responseExcerpt: responseText,
      success: false,
      errorMessage: `operation_change_password.php fallo con status ${response.status}`,
    });
    throw new Error(
      `operation_change_password.php fallo con status ${response.status}. Respuesta: ${responseText.slice(0, 300)}`,
    );
  }

  this.markAuthenticatedRequest();

  await this.recordOperationLog({
    dbPath: options.dbPath,
    auditContext: options.auditContext,
    operationType: 'change_password',
    endpoint: '/services/operation_change_password.php',
    targetRemoteUserId: destinationUser.remote_user_id,
    targetUsername: destinationUser.username,
    targetUserType: destinationUser.user_type || 'player',
    requestPayload: {
      userId: destinationUser.remote_user_id,
      userRole: destinationUser.user_type || 'player',
      logoutAll: Boolean(options.logoutAll),
      passwordChanged: true,
    },
    responseStatus: response.status,
    responseExcerpt: responseText,
    success: true,
    metadata: {
      logoutAll: Boolean(options.logoutAll),
    },
  });

  return {
    status: response.status,
    username: destinationUser.username,
    destinationId: destinationUser.remote_user_id,
    logoutAll: Boolean(options.logoutAll),
    rawResponse: responseText,
  };
};

export function createEsmeraldaClient(options = {}) {
  return new EsmeraldaClient(options);
}
