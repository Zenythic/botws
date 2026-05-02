import crypto from 'node:crypto';
import {
  ACTION_TYPES,
  GENERATED_PASSWORD_MIN_LENGTH,
  GENERATED_USERNAME_MIN_LENGTH,
  GENERATED_USERNAME_PREFIXES,
} from './constants.js';

export function extractDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits || null;
}

export function normalizeCustomUsername(value) {
  let normalized = String(value || '').trim();

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('@')) {
    normalized = normalized.slice(1);
  }

  normalized = normalized.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '');
  return normalized || null;
}

function normalizeIntentText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function normalizeRequestedAmount(value) {
  const parsed = parseRequestedAmountNumber(value);
  if (parsed === null) {
    const normalized = String(value || '')
      .trim()
      .replace(/[^0-9.,]/g, '');

    return normalized || null;
  }

  return Number.isInteger(parsed) ? String(parsed) : String(parsed.toFixed(2));
}

export function extractRequestedAmountText(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return null;
  }

  const normalizedText = rawValue
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (!/\d/.test(normalizedText)) {
    return null;
  }

  const hasMoneyContext =
    /[$]|\b(peso|pesos|mil|miles|luca|lucas|gamba|gambas|palo|palos)\b/.test(
      normalizedText,
    ) || /\d+\s*k\b/.test(normalizedText);
  const hasBankingContext =
    /\b(cuit|cuil|cvu|cbu|alias|cuenta|dni|cedula|telefono|tel|celu|numero|nro)\b/.test(
      normalizedText,
    );
  const digitRuns = normalizedText.match(/\d+/g) || [];

  if (!hasMoneyContext && hasBankingContext) {
    return null;
  }

  if (!hasMoneyContext && digitRuns.some((run) => run.length === 11 || run.length === 22)) {
    return null;
  }

  const parsed = parseRequestedAmountNumber(rawValue);
  if (parsed === null || parsed <= 0) {
    return null;
  }

  return Number.isInteger(parsed) ? String(parsed) : String(parsed.toFixed(2));
}

export function parseRequestedAmountNumber(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return null;
  }

  const normalizedText = rawValue
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const keywordMultiplier =
    /\b(k|mil|miles|luca|lucas|gamba|gambas|palo|palos)\b/.test(normalizedText)
      ? 1000
      : 1;

  const match = normalizedText.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) {
    return null;
  }

  const numberToken = match[1];
  const numericValue = Number.parseFloat(
    numberToken.replace(/\./g, '').replace(',', '.'),
  );

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  const hasDecimalSeparator = /[.,]/.test(numberToken);
  let finalValue = numericValue * keywordMultiplier;

  // Si luego quieres volver al modo anterior, descomenta este bloque y
  // expresiones como "20" volveran a interpretarse como "20000".
  /*
  if (
    keywordMultiplier === 1 &&
    Number.isInteger(numericValue) &&
    numericValue > 0 &&
    numericValue < 1000 &&
    !hasDecimalSeparator
  ) {
    finalValue = numericValue * 1000;
  }
  */

  return Number.isFinite(finalValue) ? Number(finalValue.toFixed(2)) : null;
}

export function normalizeCuit(value) {
  const digits = extractDigits(value);
  return digits && digits.length === 11 ? digits : null;
}

export function normalizeBankAccountNumber(value) {
  const digits = extractDigits(value);
  return digits && digits.length === 22 ? digits : null;
}

export function wantsCustomUsername(value) {
  const normalized = normalizeIntentText(value);

  if (!normalized) {
    return false;
  }

  return (
    /\b(puedo|puede|quiero|quisiera|me gustaria|me gustaría|prefiero)\b/.test(normalized) &&
    /\b(elegir|usar|poner|decidir)\b/.test(normalized) &&
    /\b(nombre|nick|usuario|user)\b/.test(normalized)
  ) || /\b(nombre propio|usuario propio|nick propio)\b/.test(normalized);
}

function isStandaloneUsernameToken(value) {
  const raw = String(value || '').trim();
  const normalized = normalizeCustomUsername(raw);

  if (!normalized || /\s/.test(raw) || normalized.length < 3) {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    return null;
  }

  const lowered = normalized.toLowerCase();
  if (
    [
      'si',
      'no',
      'ok',
      'hola',
      'dale',
      'gracias',
      'cvu',
      'cbu',
      'alias',
      'usuario',
      'contrasena',
      'contrasenia',
      'clave',
    ].includes(lowered)
  ) {
    return null;
  }

  return normalized;
}

export function extractDesiredUsernameFromText(value, options = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  const patterns = [
    /(?:quiero(?:\s+usar)?|usa|usar|que\s+sea|seria|sería|sea|poneme|ponme|me\s+gustaria\s+que\s+sea|me\s+llamo|mi\s+usuario(?:\s+puede\s+ser)?|mi\s+nick(?:\s+puede\s+ser)?|nombre(?:\s+de\s+usuario)?(?:\s+puede\s+ser)?)(?:\s+es)?\s+([@A-Za-z0-9_.-]{3,32})/i,
    /(?:usuario|nick|nombre)(?:\s*:\s*|\s+)([@A-Za-z0-9_.-]{3,32})/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const normalized = normalizeCustomUsername(match?.[1]);
    if (normalized) {
      return normalized;
    }
  }

  if (options.allowBareToken) {
    return isStandaloneUsernameToken(raw);
  }

  return null;
}

export function extractCuitFromText(value) {
  const digitsOnly = String(value || '').replace(/\D/g, ' ');
  const match = digitsOnly.match(/\b\d{11}\b/);
  return match ? match[0] : null;
}

export function extractBankAccountFromText(value) {
  const rawText = String(value || '').trim();
  if (!rawText) {
    return null;
  }

  const inlineCandidates = rawText.match(/(?:\d[\s-]*){21}\d/g) || [];
  for (const candidate of inlineCandidates) {
    const normalized = normalizeBankAccountNumber(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const digitsOnly = rawText.replace(/\D/g, ' ');
  const match = digitsOnly.match(/\b\d{22}\b/);
  if (match) {
    return match[0];
  }

  const normalizedText = rawText
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const hasBankingContext =
    /\b(cvu|cbu|cuenta|bancaria|banco|destino|retiro|cobrar|recibir|pago)\b/.test(
      normalizedText,
    );

  if (hasBankingContext) {
    return normalizeBankAccountNumber(rawText);
  }

  return null;
}

export function extractBankAliasFromText(value) {
  const rawText = String(value || '').trim();
  if (!rawText) {
    return null;
  }

  const explicitMatch = rawText.match(
    /(?:alias(?:\s+es)?\s*[:\-]?\s*)([A-Za-z][A-Za-z0-9_.-]{5,40})/i,
  );
  if (explicitMatch?.[1]) {
    return explicitMatch[1];
  }

  if (
    /^[A-Za-z][A-Za-z0-9_.-]{5,40}$/.test(rawText) &&
    rawText.includes('.') &&
    !/\d{11,}/.test(rawText)
  ) {
    return rawText;
  }

  return null;
}

export function looksLikeTransferProofMessage(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (!normalized) {
    return false;
  }

  if (
    /\b(comprobante|transferi|transf|transferencia|deposite|deposito|pago|pague|te mande|te envie|ya hice|ya esta|ya quedo|trx|referencia|operacion)\b/.test(
      normalized,
    )
  ) {
    return true;
  }

  return /\b\d{11}\b/.test(normalized);
}

export function isValidCasinoUsername(username) {
  return typeof username === 'string' && /^[A-Za-z0-9_]+$/.test(username);
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function randomAlphaNumeric(length) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

export function generateUsernameCandidate(phoneNumber) {
  const prefix = pickRandom(GENERATED_USERNAME_PREFIXES);
  const digits = phoneNumber ? phoneNumber.slice(-4) : randomAlphaNumeric(4);
  const baseValue = `${prefix}${digits}`;
  const minSuffixLength = Math.max(
    GENERATED_USERNAME_MIN_LENGTH - baseValue.length,
    2,
  );
  const suffix = randomAlphaNumeric(minSuffixLength);
  return `${baseValue}${suffix}`.slice(0, 14);
}

export function generatePasswordCandidate() {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const upperLetters = letters.toUpperCase();
  const digits = '0123456789';
  const alphabet = `${letters}${upperLetters}${digits}`;

  let password = '';
  password += pickRandom(letters);
  password += pickRandom(upperLetters);
  password += pickRandom(digits);

  while (password.length < GENERATED_PASSWORD_MIN_LENGTH) {
    password += pickRandom(alphabet);
  }

  return password
    .split('')
    .sort(() => Math.random() - 0.5)
    .join('');
}

function normalizeDecisionText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function isAffirmativeReply(value) {
  const normalized = normalizeDecisionText(value);

  if (!normalized) {
    return false;
  }

  return /^(si|sii+|sip|sep|dale|de una|obvio|ok|oki|bueno|hagalo|hacelo|mandale|crealo|creamelo|confirmo|confirmado)\b/.test(
    normalized,
  );
}

export function isNegativeReply(value) {
  const normalized = normalizeDecisionText(value);

  if (!normalized) {
    return false;
  }

  return /^(no|nop|dejalo|dejalo ahi|dejalo ahi|mejor no|cancel(a|alo|ar)?|no quiero)\b/.test(
    normalized,
  );
}

export function isDuplicateUsernameError(error) {
  return /Ya existe un usuario con username/i.test(String(error?.message || ''));
}

export function isMissingStoredUserError(error) {
  return /No se encontro el usuario/i.test(String(error?.message || ''));
}

export function isOperationalAction(actionType) {
  return ACTION_TYPES.has(actionType);
}
