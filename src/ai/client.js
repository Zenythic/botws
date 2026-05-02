import {
  assertOpenRouterConfig,
  getModelName,
  getRequestHeaders,
  OPENROUTER_API_URL,
} from './config.js';

export async function callOpenRouter({
  chatId,
  messages,
  temperature,
  maxTokens,
  model = null,
}) {
  assertOpenRouterConfig();

  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({
      model: model || getModelName(),
      temperature,
      max_tokens: maxTokens,
      user: chatId,
      messages,
    }),
  });

  const rawBody = await response.text();
  let data;

  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(
      `OpenRouter devolvio una respuesta no valida: ${rawBody.slice(0, 300)}`,
    );
  }

  if (!response.ok) {
    const errorMessage =
      data?.error?.message || data?.message || rawBody.slice(0, 300);
    throw new Error(`OpenRouter ${response.status}: ${errorMessage}`);
  }

  return data;
}
