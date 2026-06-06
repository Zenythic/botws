export const GEMINI_API_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const MAX_REPLY_CHARS = 450;

function getApiKey() {
  return process.env.GEMINI_API_KEY || '';
}

function getEnvModelValue(key) {
  const value = String(process.env[key] || '').trim();
  return value || null;
}

export function getModelName(purpose = 'default') {
  const byPurpose = {
    turn_plan: getEnvModelValue('GEMINI_MODEL_TURN_PLAN'),
    action_reply: getEnvModelValue('GEMINI_MODEL_ACTION_REPLY'),
    extraction: getEnvModelValue('GEMINI_MODEL_EXTRACTION'),
    vision: getEnvModelValue('GEMINI_MODEL_VISION'),
    default: null,
  };

  return (
    byPurpose[purpose] ||
    getEnvModelValue('GEMINI_MODEL') ||
    DEFAULT_MODEL
  );
}

export function assertOpenRouterConfig() {
  if (!getApiKey()) {
    throw new Error('Falta GEMINI_API_KEY en el entorno o en el archivo .env');
  }
}

export function getRequestHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': getApiKey(),
  };
}
