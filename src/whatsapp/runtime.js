import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AUTH_FOLDER } from './constants.js';

const DEFAULT_RUNTIME_STATE_PATH = './data/whatsapp-runtime.json';
const DEFAULT_RUNTIME_COMMAND_PATH = './data/whatsapp-command.json';

function resolveRuntimeStatePath() {
  return resolve(
    process.cwd(),
    process.env.WHATSAPP_RUNTIME_STATE_PATH || DEFAULT_RUNTIME_STATE_PATH,
  );
}

function resolveRuntimeCommandPath() {
  return resolve(
    process.cwd(),
    process.env.WHATSAPP_RUNTIME_COMMAND_PATH || DEFAULT_RUNTIME_COMMAND_PATH,
  );
}

function resolveAuthFolderPath() {
  return resolve(process.cwd(), AUTH_FOLDER);
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureParentDirectory(targetPath) {
  await mkdir(dirname(targetPath), { recursive: true });
}

async function hasStoredSession() {
  const authPath = resolveAuthFolderPath();
  const exists = await pathExists(authPath);

  if (!exists) {
    return false;
  }

  try {
    const entries = await readdir(authPath);
    return entries.length > 0;
  } catch {
    return false;
  }
}

function buildDefaultRuntimeState(overrides = {}) {
  return {
    status: 'idle',
    connection: 'idle',
    qrAvailable: false,
    qrDataUrl: null,
    qrUpdatedAt: null,
    phoneNumber: null,
    whatsappId: null,
    sessionPresent: false,
    lastError: null,
    lastUpdateAt: new Date().toISOString(),
    ...overrides,
  };
}

function normalizeRuntimeState(rawState = {}) {
  return buildDefaultRuntimeState({
    status: rawState.status || 'idle',
    connection: rawState.connection || 'idle',
    qrAvailable: Boolean(rawState.qrAvailable),
    qrDataUrl: rawState.qrDataUrl || null,
    qrUpdatedAt: rawState.qrUpdatedAt || null,
    phoneNumber: rawState.phoneNumber || null,
    whatsappId: rawState.whatsappId || null,
    sessionPresent: Boolean(rawState.sessionPresent),
    lastError: rawState.lastError || null,
    lastUpdateAt: rawState.lastUpdateAt || new Date().toISOString(),
  });
}

export async function readWhatsAppRuntimeState() {
  const runtimePath = resolveRuntimeStatePath();
  const sessionPresent = await hasStoredSession();

  try {
    const raw = await readFile(runtimePath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeRuntimeState({
      ...parsed,
      sessionPresent,
    });
  } catch {
    return buildDefaultRuntimeState({
      sessionPresent,
    });
  }
}

export async function writeWhatsAppRuntimeState(patch = {}) {
  const runtimePath = resolveRuntimeStatePath();
  const current = await readWhatsAppRuntimeState();
  const sessionPresent =
    patch.sessionPresent === undefined
      ? await hasStoredSession()
      : Boolean(patch.sessionPresent);

  const next = normalizeRuntimeState({
    ...current,
    ...patch,
    qrAvailable:
      patch.qrDataUrl !== undefined
        ? Boolean(patch.qrDataUrl)
        : patch.qrAvailable !== undefined
        ? Boolean(patch.qrAvailable)
        : current.qrAvailable,
    sessionPresent,
    lastUpdateAt: new Date().toISOString(),
  });

  await ensureParentDirectory(runtimePath);
  await writeFile(runtimePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export async function requestWhatsAppSessionReset(options = {}) {
  const commandPath = resolveRuntimeCommandPath();
  const command = {
    id: crypto.randomUUID(),
    action: 'reset_session',
    reason: String(options.reason || 'panel'),
    requestedAt: new Date().toISOString(),
  };

  await ensureParentDirectory(commandPath);
  await writeFile(commandPath, JSON.stringify(command, null, 2), 'utf8');
  await writeWhatsAppRuntimeState({
    status: 'reset_requested',
    connection: 'reset_requested',
    qrDataUrl: null,
    qrAvailable: false,
    lastError: null,
  });
  return command;
}

export async function readWhatsAppCommand() {
  const commandPath = resolveRuntimeCommandPath();

  try {
    const raw = await readFile(commandPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function clearWhatsAppCommand() {
  const commandPath = resolveRuntimeCommandPath();
  await rm(commandPath, { force: true });
}

export async function deleteStoredWhatsAppSession() {
  await rm(resolveAuthFolderPath(), { recursive: true, force: true });
  await writeWhatsAppRuntimeState({
    sessionPresent: false,
    qrDataUrl: null,
    qrAvailable: false,
    phoneNumber: null,
    whatsappId: null,
  });
}
