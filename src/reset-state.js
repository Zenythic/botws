import 'dotenv/config';
import { access, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_DB_PATH = './data/esmeralda.sqlite';
const DEFAULT_CALLBACK_LOG_PATH = './data/callback-events.jsonl';
const DEFAULT_MEDIA_DIR = './data/whatsapp-media';
const DEFAULT_RECEIPTS_DIR = './data/payment-receipts';
const DEFAULT_AUTH_DIR = './.auth';
const DEFAULT_WHATSAPP_RUNTIME_PATH = './data/whatsapp-runtime.json';
const DEFAULT_WHATSAPP_COMMAND_PATH = './data/whatsapp-command.json';

function getTargets({ includeAuth = false } = {}) {
  const targets = [
    {
      label: 'Base SQLite',
      path: resolve(process.env.ESMERALDA_DB_PATH || DEFAULT_DB_PATH),
    },
    {
      label: 'Log de callbacks',
      path: resolve(process.env.CALLBACK_LOG_PATH || DEFAULT_CALLBACK_LOG_PATH),
    },
    {
      label: 'Adjuntos de WhatsApp',
      path: resolve(process.env.WHATSAPP_MEDIA_DIR || DEFAULT_MEDIA_DIR),
    },
    {
      label: 'Comprobantes de pagos',
      path: resolve(process.env.PAYMENTS_RECEIPTS_DIR || DEFAULT_RECEIPTS_DIR),
    },
    {
      label: 'Estado runtime de WhatsApp',
      path: resolve(
        process.env.WHATSAPP_RUNTIME_STATE_PATH || DEFAULT_WHATSAPP_RUNTIME_PATH,
      ),
    },
    {
      label: 'Buzón de comandos de WhatsApp',
      path: resolve(
        process.env.WHATSAPP_RUNTIME_COMMAND_PATH || DEFAULT_WHATSAPP_COMMAND_PATH,
      ),
    },
  ];

  if (includeAuth) {
    targets.push({
      label: 'Sesion de WhatsApp (.auth)',
      path: resolve(DEFAULT_AUTH_DIR),
    });
  }

  return targets;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function removeTarget({ label, path }) {
  const exists = await pathExists(path);

  if (!exists) {
    return `${label}: no existia`;
  }

  await rm(path, { recursive: true, force: true });
  return `${label}: eliminado -> ${path}`;
}

export async function runLocalStateReset(options = {}) {
  const includeAuth = Boolean(options.includeAuth);
  const targets = getTargets({ includeAuth });
  const results = [];

  for (const target of targets) {
    results.push(await removeTarget(target));
  }

  return {
    ok: true,
    includeAuth,
    results,
    preservedWhatsAppSession: !includeAuth,
  };
}
