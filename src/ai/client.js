import {
  assertOpenRouterConfig,
  GEMINI_API_BASE_URL,
  getModelName,
  getRequestHeaders,
} from './config.js';

function normalizeGeminiRole(role) {
  return role === 'assistant' ? 'model' : 'user';
}

function parseDataUrl(value) {
  const match = String(value || '').match(/^data:([^;]+);base64,(.+)$/);

  if (!match) {
    return null;
  }

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function openAiContentToGeminiParts(content) {
  if (typeof content === 'string') {
    return [{ text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ text: String(content || '') }];
  }

  const parts = [];

  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      parts.push({ text: part.text });
      continue;
    }

    if (part?.type === 'image_url') {
      const parsed = parseDataUrl(part.image_url?.url);
      if (parsed) {
        parts.push({
          inline_data: {
            mime_type: parsed.mimeType,
            data: parsed.data,
          },
        });
      }
    }
  }

  return parts.length ? parts : [{ text: '' }];
}

function openAiMessagesToGeminiPayload(messages = []) {
  const systemTexts = [];
  const contents = [];

  for (const message of messages) {
    if (message?.role === 'system') {
      systemTexts.push(
        typeof message.content === 'string'
          ? message.content
          : openAiContentToGeminiParts(message.content)
              .map((part) => part.text)
              .filter(Boolean)
              .join('\n'),
      );
      continue;
    }

    contents.push({
      role: normalizeGeminiRole(message?.role),
      parts: openAiContentToGeminiParts(message?.content),
    });
  }

  return {
    systemInstruction: systemTexts.length
      ? {
          parts: [{ text: systemTexts.join('\n\n') }],
        }
      : undefined,
    contents,
  };
}

function extractGeminiText(data) {
  return (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text)
    .filter((text) => typeof text === 'string' && text)
    .join('\n')
    .trim();
}

function toOpenAiCompatibleResponse(data) {
  return {
    choices: [
      {
        message: {
          content: extractGeminiText(data),
        },
      },
    ],
    gemini: data,
  };
}

export async function callOpenRouter({
  chatId,
  messages,
  temperature,
  maxTokens,
  model = null,
}) {
  assertOpenRouterConfig();
  const selectedModel = model || getModelName();
  const geminiPayload = openAiMessagesToGeminiPayload(messages);

  const response = await fetch(`${GEMINI_API_BASE_URL}/${selectedModel}:generateContent`, {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({
      ...geminiPayload,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    }),
  });

  const rawBody = await response.text();
  let data;

  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(
      `Gemini devolvio una respuesta no valida: ${rawBody.slice(0, 300)}`,
    );
  }

  if (!response.ok) {
    const errorMessage =
      data?.error?.message || data?.message || rawBody.slice(0, 300);
    throw new Error(`Gemini ${response.status}: ${errorMessage}`);
  }

  return toOpenAiCompatibleResponse(data);
}
