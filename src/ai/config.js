export const OPENROUTER_API_URL =
  'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'openai/gpt-5.4';
export const MAX_REPLY_CHARS = 450;

function getApiKey() {
  return process.env.OPENROUTER_API_KEY || '';
}

function getEnvModelValue(key) {
  const value = String(process.env[key] || '').trim();
  return value || null;
}

export function getModelName(purpose = 'default') {
  const byPurpose = {
    turn_plan: getEnvModelValue('OPENROUTER_MODEL_TURN_PLAN'),
    action_reply: getEnvModelValue('OPENROUTER_MODEL_ACTION_REPLY'),
    extraction: getEnvModelValue('OPENROUTER_MODEL_EXTRACTION'),
    vision: getEnvModelValue('OPENROUTER_MODEL_VISION'),
    default: null,
  };

  return (
    byPurpose[purpose] ||
    getEnvModelValue('OPENROUTER_MODEL') ||
    DEFAULT_MODEL
  );
}

export function assertOpenRouterConfig() {
  if (!getApiKey()) {
    throw new Error('Falta OPENROUTER_API_KEY en el entorno o en el archivo .env');
  }
}

export function getRequestHeaders() {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    'Content-Type': 'application/json',
    'X-OpenRouter-Title': 'Bot WhatsApp Casino',
  };
}
