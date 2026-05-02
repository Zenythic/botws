import 'dotenv/config';
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processCashInCallback, processPayOutCallback } from '../payments/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CALLBACK_PORT = Number.parseInt(process.env.CALLBACK_PORT || '3010', 10);
const CALLBACK_LOG_PATH = resolve(
  process.cwd(),
  process.env.CALLBACK_LOG_PATH || './data/callback-events.jsonl',
);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(html);
}

async function ensureLogDirectory() {
  await mkdir(dirname(CALLBACK_LOG_PATH), { recursive: true });
}

async function readRawBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(', ') : String(value ?? ''),
    ]),
  );
}

function tryParseBody(contentType, rawBuffer) {
  const lowerType = String(contentType || '').toLowerCase();
  const isBinaryBody =
    lowerType.startsWith('image/') || lowerType.includes('application/octet-stream');
  const rawText = isBinaryBody
    ? `<binary:${rawBuffer.length}:bytes>`
    : rawBuffer.toString('utf8');

  if (!rawText.trim()) {
    return { bodyType: 'empty', parsedBody: null, rawText: '' };
  }

  if (lowerType.includes('application/json')) {
    try {
      return {
        bodyType: 'json',
        parsedBody: JSON.parse(rawText),
        rawText,
      };
    } catch {
      return { bodyType: 'invalid-json', parsedBody: null, rawText };
    }
  }

  if (lowerType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(rawText);
    return {
      bodyType: 'form',
      parsedBody: Object.fromEntries(params.entries()),
      rawText,
    };
  }

  return {
    bodyType: lowerType || 'text',
    parsedBody: rawText,
    rawText,
  };
}

async function persistEvent(event) {
  await ensureLogDirectory();
  await appendFile(CALLBACK_LOG_PATH, `${JSON.stringify(event)}\n`, 'utf8');
}

async function listRecentEvents(limit = 50) {
  try {
    const fileContent = await readFile(CALLBACK_LOG_PATH, 'utf8');
    const lines = fileContent
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    return lines
      .slice(-limit)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return {
            id: `invalid-${Math.random().toString(36).slice(2, 10)}`,
            type: 'unknown',
            receivedAt: new Date().toISOString(),
            note: 'No se pudo parsear una linea del log',
          };
        }
      });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function buildHomeHtml(baseUrl, events) {
  const safeBaseUrl = String(baseUrl).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  const prettyEvents = events.length
    ? JSON.stringify(events, null, 2)
    : 'Todavia no llegaron callbacks.';

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Callback Test</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f7fb;
        --card: #ffffff;
        --line: #d9e2ec;
        --ink: #122033;
        --muted: #5f7085;
        --accent: #0b6bcb;
        --accent-soft: #e9f3ff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #eef4fb 0%, var(--bg) 100%);
        color: var(--ink);
      }
      .wrap {
        max-width: 1100px;
        margin: 0 auto;
        padding: 24px;
      }
      .hero, .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 18px;
        box-shadow: 0 10px 30px rgba(15, 39, 65, 0.06);
      }
      .hero {
        padding: 24px;
        margin-bottom: 18px;
      }
      .hero h1 {
        margin: 0 0 8px;
        font-size: 28px;
      }
      .hero p {
        margin: 0;
        color: var(--muted);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 18px;
        margin-bottom: 18px;
      }
      .card {
        padding: 18px;
      }
      .card h2 {
        margin: 0 0 12px;
        font-size: 18px;
      }
      .endpoint {
        display: block;
        width: 100%;
        overflow-wrap: anywhere;
        padding: 10px 12px;
        border-radius: 12px;
        background: var(--accent-soft);
        color: var(--accent);
        font-weight: 600;
      }
      .meta {
        margin-top: 10px;
        color: var(--muted);
        font-size: 14px;
      }
      pre {
        margin: 0;
        padding: 16px;
        border-radius: 14px;
        background: #0f1720;
        color: #dce8f5;
        overflow: auto;
        max-height: 420px;
        font-size: 13px;
      }
      .actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 12px;
      }
      a.button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 10px 14px;
        border-radius: 10px;
        background: var(--accent);
        color: #fff;
        text-decoration: none;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="hero">
        <h1>Callback de prueba</h1>
        <p>Testing</p>
      </section>

      <section class="grid">
        <article class="card">
          <h2>CashIn</h2>
          <span class="endpoint">${safeBaseUrl}/callbacks/cashin</span>
          <div class="meta">Usa esta URL como callback para pruebas de CashIn.</div>
        </article>

        <article class="card">
          <h2>CashOut</h2>
          <span class="endpoint">${safeBaseUrl}/callbacks/cashout</span>
          <div class="meta">Usa esta URL como callback para pruebas de CashOut.</div>
        </article>

        <article class="card">
          <h2>Salud y eventos</h2>
          <span class="endpoint">${safeBaseUrl}/health</span>
          <div class="actions">
            <a class="button" href="/events" target="_blank" rel="noreferrer">Ver eventos JSON</a>
          </div>
        </article>
      </section>

      <section class="card">
        <h2>Ultimos callbacks recibidos</h2>
        <pre>${prettyEvents}</pre>
      </section>
    </main>
  </body>
</html>`;
}

async function handleCallbackRequest(request, response, type) {
  const receivedAt = new Date().toISOString();
  const rawBody = await readRawBody(request);
  const headers = normalizeHeaders(request.headers);
  const { bodyType, parsedBody, rawText } = tryParseBody(
    headers['content-type'],
    rawBody,
  );

  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    type,
    receivedAt,
    method: request.method || 'POST',
    headers,
    bodyType,
    parsedBody,
    rawText,
  };

  await persistEvent(event);

  sendJson(response, 202, {
    ok: true,
    type,
    receivedAt,
    stored: true,
  });

  setTimeout(() => {
    const processor =
      type === 'cashout' ? processPayOutCallback : processCashInCallback;
    const payload =
      bodyType === 'json' && parsedBody && typeof parsedBody === 'object'
        ? parsedBody
        : {};

    processor(payload, {
      headers,
      contentType: headers['content-type'] || '',
      rawBody,
      rawText,
    }).catch((error) => {
      console.error(
        `[callback:${type}] fallo el procesamiento interno:`,
        String(error?.stack || error),
      );
    });
  }, 0);
}

async function handleRequest(request, response) {
  const baseUrl = `http://${request.headers.host || `localhost:${CALLBACK_PORT}`}`;
  const url = new URL(request.url || '/', baseUrl);

  if (url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      service: 'callback-test-server',
      now: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === '/callbacks/cashin' || url.pathname === '/callbacks/cashout') {
    if (request.method !== 'POST') {
      sendJson(response, 405, {
        error: 'Method not allowed',
        message: 'Este endpoint de callback espera POST',
      });
      return;
    }

    const type = url.pathname.endsWith('/cashout') ? 'cashout' : 'cashin';
    await handleCallbackRequest(request, response, type);
    return;
  }

  if (url.pathname === '/events') {
    const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
    const events = await listRecentEvents(limit);
    sendJson(response, 200, {
      items: events,
      count: events.length,
      limit,
      logPath: CALLBACK_LOG_PATH,
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const events = await listRecentEvents(20);
    sendHtml(response, 200, buildHomeHtml(baseUrl, events));
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    sendJson(response, 500, {
      ok: false,
      error: 'Internal server error',
      message: String(error?.message || error),
    });
  });
});

server.listen(CALLBACK_PORT, () => {
  console.log(`Callback test server listo en http://localhost:${CALLBACK_PORT}`);
  console.log(`CashIn callback:  http://localhost:${CALLBACK_PORT}/callbacks/cashin`);
  console.log(`CashOut callback: http://localhost:${CALLBACK_PORT}/callbacks/cashout`);
  console.log(`Eventos:          http://localhost:${CALLBACK_PORT}/events`);
});
