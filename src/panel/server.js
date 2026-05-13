import 'dotenv/config';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildEffectiveCasinoPrompts,
  CASINO_ACTION_SYSTEM_PROMPT,
  CASINO_AGENT_SYSTEM_PROMPT,
} from '../ai/prompts.js';
import {
  deleteWhatsAppConversation,
  getBotRuntimeState,
  getConversationUserActivity,
  getWhatsAppConversationDetail,
  getWhatsAppDashboardMetrics,
  listWhatsAppConversations,
  setConversationBotPaused,
  setGlobalBotPaused,
  updateBotPromptSettings,
  updateBotAiRules,
} from '../esmeralda/index.js';
import {
  readWhatsAppRuntimeState,
  requestWhatsAppSessionReset,
} from '../whatsapp/runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PANEL_PORT = Number.parseInt(process.env.PANEL_PORT || '3001', 10);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(html);
}

function sendMethodNotAllowed(response) {
  sendJson(response, 405, { error: 'Method not allowed' });
}

function sendNotFound(response) {
  sendJson(response, 404, { error: 'Not found' });
}

function buildPromptPayload(runtime) {
  const effectivePrompts = buildEffectiveCasinoPrompts(runtime?.promptSettings);

  return {
    agentSystemPrompt: effectivePrompts.agentSystemPrompt,
    actionSystemPrompt: effectivePrompts.actionSystemPrompt,
    agentUsesOverride: effectivePrompts.agentUsesOverride,
    actionUsesOverride: effectivePrompts.actionUsesOverride,
    agentUpdatedAt: effectivePrompts.agentUpdatedAt,
    actionUpdatedAt: effectivePrompts.actionUpdatedAt,
    defaultAgentSystemPrompt: CASINO_AGENT_SYSTEM_PROMPT,
    defaultActionSystemPrompt: CASINO_ACTION_SYSTEM_PROMPT,
  };
}

async function buildRuntimePayload(runtime) {
  return {
    ...runtime,
    whatsapp: await readWhatsAppRuntimeState(),
  };
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error('JSON invalido en el body');
  }
}

async function handleMetricsRequest(request, response) {
  if (request.method !== 'GET') {
    sendMethodNotAllowed(response);
    return;
  }

  const metrics = await getWhatsAppDashboardMetrics();
  sendJson(response, 200, metrics);
}

async function handleRuntimeRequest(request, response, url) {
  if (url.pathname === '/api/runtime') {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response);
      return;
    }

    const runtime = await getBotRuntimeState();
    sendJson(response, 200, await buildRuntimePayload(runtime));
    return;
  }

  if (url.pathname === '/api/runtime/global-pause') {
    if (request.method !== 'PUT' && request.method !== 'POST') {
      sendMethodNotAllowed(response);
      return;
    }

    const body = await readJsonBody(request);
    const runtime = await setGlobalBotPaused({
      paused: Boolean(body.paused),
      reason: body.reason || '',
    });
    sendJson(response, 200, await buildRuntimePayload(runtime));
    return;
  }

  if (url.pathname === '/api/runtime/ai-rules') {
    if (request.method === 'GET') {
      const runtime = await getBotRuntimeState();
      sendJson(response, 200, runtime.aiRules);
      return;
    }

    if (request.method !== 'PUT' && request.method !== 'POST') {
      sendMethodNotAllowed(response);
      return;
    }

    const body = await readJsonBody(request);
    const runtime = await updateBotAiRules({
      rulesText: body.rulesText || '',
    });
    sendJson(response, 200, await buildRuntimePayload(runtime));
    return;
  }

  if (url.pathname === '/api/runtime/prompts') {
    if (request.method === 'GET') {
      const runtime = await getBotRuntimeState();
      sendJson(response, 200, buildPromptPayload(runtime));
      return;
    }

    if (request.method !== 'PUT' && request.method !== 'POST') {
      sendMethodNotAllowed(response);
      return;
    }

    const body = await readJsonBody(request);
    const runtime = await updateBotPromptSettings({
      agentSystemPrompt: body.agentSystemPrompt || '',
      actionSystemPrompt: body.actionSystemPrompt || '',
    });
    sendJson(response, 200, buildPromptPayload(runtime));
    return;
  }

  if (url.pathname === '/api/runtime/whatsapp/session-reset') {
    if (request.method !== 'PUT' && request.method !== 'POST') {
      sendMethodNotAllowed(response);
      return;
    }

    const body = await readJsonBody(request);
    const command = await requestWhatsAppSessionReset({
      reason: body.reason || 'panel',
    });
    const runtime = await getBotRuntimeState();

    sendJson(response, 202, {
      ok: true,
      command,
      runtime: await buildRuntimePayload(runtime),
    });
    return;
  }

  sendNotFound(response);
}

async function handleConversationsRequest(request, response, url) {
  if (url.pathname === '/api/conversations') {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response);
      return;
    }

    const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
    const search = url.searchParams.get('search') || '';
    const conversations = await listWhatsAppConversations({ limit, search });
    sendJson(response, 200, conversations);
    return;
  }

  const pauseMatch = url.pathname.match(/^\/api\/conversations\/(.+)\/pause$/);
  if (pauseMatch) {
    if (request.method !== 'PUT' && request.method !== 'POST') {
      sendMethodNotAllowed(response);
      return;
    }

    const conversationKey = decodeURIComponent(pauseMatch[1]);
    const detail = await getWhatsAppConversationDetail(conversationKey);

    if (!detail.conversation) {
      sendNotFound(response);
      return;
    }

    const body = await readJsonBody(request);
    const control = await setConversationBotPaused({
      conversationKey,
      paused: Boolean(body.paused),
      reason: body.reason || '',
    });
    const updatedDetail = await getWhatsAppConversationDetail(conversationKey);

    sendJson(response, 200, {
      control: control.control,
      detail: updatedDetail,
    });
    return;
  }

  const userActivityMatch = url.pathname.match(
    /^\/api\/conversations\/(.+)\/user-activity$/,
  );
  if (userActivityMatch) {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response);
      return;
    }

    const conversationKey = decodeURIComponent(userActivityMatch[1]);
    const activity = await getConversationUserActivity(conversationKey);

    if (!activity.conversation) {
      sendNotFound(response);
      return;
    }

    sendJson(response, 200, activity);
    return;
  }

  const detailMatch = url.pathname.match(/^\/api\/conversations\/(.+)$/);
  if (detailMatch) {
    const conversationKey = decodeURIComponent(detailMatch[1]);
    if (request.method === 'DELETE') {
      const detail = await getWhatsAppConversationDetail(conversationKey);

      if (!detail.conversation) {
        sendNotFound(response);
        return;
      }

      const result = await deleteWhatsAppConversation(conversationKey);
      sendJson(response, 200, result);
      return;
    }

    if (request.method !== 'GET') {
      sendMethodNotAllowed(response);
      return;
    }

    const detail = await getWhatsAppConversationDetail(conversationKey);

    if (!detail.conversation) {
      sendNotFound(response);
      return;
    }

    sendJson(response, 200, detail);
    return;
  }

  sendNotFound(response);
}

async function handleApiRequest(request, response, url) {
  if (url.pathname === '/api/metrics') {
    await handleMetricsRequest(request, response);
    return;
  }

  if (url.pathname.startsWith('/api/runtime')) {
    await handleRuntimeRequest(request, response, url);
    return;
  }

  if (url.pathname.startsWith('/api/conversations')) {
    await handleConversationsRequest(request, response, url);
    return;
  }

  sendNotFound(response);
}

async function handleRequest(request, response) {
  const url = new URL(
    request.url || '/',
    `http://${request.headers.host || 'localhost'}`,
  );

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApiRequest(request, response, url);
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(join(__dirname, 'index.html'), 'utf8');
      sendHtml(response, 200, html);
      return;
    }

    sendNotFound(response);
  } catch (error) {
    sendJson(response, 500, {
      error: 'Internal server error',
      message: String(error?.message || error),
    });
  }
}

const server = createServer(handleRequest);

server.listen(PANEL_PORT, () => {
  console.log(`Panel listo en http://localhost:${PANEL_PORT}`);
});
