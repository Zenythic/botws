import initSqlJs from 'sql.js';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdir,
  open as openFile,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULT_DB_PATH = './data/esmeralda.sqlite';
const DB_LOCK_RETRY_MS = 80;
const DB_LOCK_TIMEOUT_MS = 15_000;
const DB_LOCK_STALE_MS = 60_000;
const require = createRequire(import.meta.url);
const sqlJsDistDir = dirname(require.resolve('sql.js/dist/sql-wasm.js'));

let sqlPromise;

function getResolvedDbPath(dbPath) {
  return resolve(dbPath || process.env.ESMERALDA_DB_PATH || DEFAULT_DB_PATH);
}

async function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) => resolve(sqlJsDistDir, file),
    });
  }

  return sqlPromise;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applySchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS esmeralda_users (
      remote_user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      balance_text TEXT NOT NULL,
      balance_amount REAL,
      balance_cents INTEGER,
      credit_actions_json TEXT NOT NULL,
      user_actions_json TEXT NOT NULL,
      unknown_value TEXT,
      user_type TEXT,
      raw_row_json TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_esmeralda_users_username
      ON esmeralda_users(username);

    CREATE TABLE IF NOT EXISTS whatsapp_contacts (
      phone_key TEXT PRIMARY KEY,
      phone_number TEXT,
      whatsapp_jid TEXT NOT NULL,
      push_name TEXT,
      linked_remote_user_id TEXT,
      linked_username TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_contacts_phone_number
      ON whatsapp_contacts(phone_number);

    CREATE INDEX IF NOT EXISTS idx_whatsapp_contacts_linked_username
      ON whatsapp_contacts(linked_username);

    CREATE TABLE IF NOT EXISTS whatsapp_conversations (
      conversation_key TEXT PRIMARY KEY,
      phone_key TEXT,
      phone_number TEXT,
      whatsapp_jid TEXT NOT NULL,
      push_name TEXT,
      linked_remote_user_id TEXT,
      linked_username TEXT,
      last_incoming_text TEXT,
      last_outgoing_text TEXT,
      last_message_at TEXT NOT NULL,
      last_message_direction TEXT,
      total_messages INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_last_message_at
      ON whatsapp_conversations(last_message_at);

    CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_phone_key
      ON whatsapp_conversations(phone_key);

    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      message_key TEXT PRIMARY KEY,
      conversation_key TEXT NOT NULL,
      phone_key TEXT,
      phone_number TEXT,
      whatsapp_jid TEXT NOT NULL,
      push_name TEXT,
      linked_remote_user_id TEXT,
      linked_username TEXT,
      direction TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      message_type TEXT,
      text TEXT,
      created_at TEXT NOT NULL,
      raw_payload_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation_created_at
      ON whatsapp_messages(conversation_key, created_at);

    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_created_at
      ON whatsapp_messages(created_at);

    CREATE TABLE IF NOT EXISTS whatsapp_media_attachments (
      attachment_id TEXT PRIMARY KEY,
      message_key TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      phone_key TEXT,
      phone_number TEXT,
      whatsapp_jid TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      media_kind TEXT NOT NULL,
      mime_type TEXT,
      file_name TEXT,
      local_path TEXT NOT NULL,
      sha256_hex TEXT,
      file_size_bytes INTEGER,
      extracted_reference TEXT,
      extracted_amount_text TEXT,
      extracted_confidence TEXT,
      extracted_notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_media_attachments_message_key
      ON whatsapp_media_attachments(message_key);

    CREATE INDEX IF NOT EXISTS idx_whatsapp_media_attachments_conversation_key
      ON whatsapp_media_attachments(conversation_key);

    CREATE TABLE IF NOT EXISTS esmeralda_operation_logs (
      operation_id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      http_method TEXT NOT NULL,
      target_remote_user_id TEXT,
      target_username TEXT,
      target_user_type TEXT,
      phone_key TEXT,
      phone_number TEXT,
      whatsapp_jid TEXT,
      conversation_key TEXT,
      actor_push_name TEXT,
      amount_text TEXT,
      amount_value REAL,
      amount_cents INTEGER,
      balance_text TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      response_status INTEGER,
      error_message TEXT,
      request_payload_json TEXT,
      response_excerpt TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_esmeralda_operation_logs_target_username
      ON esmeralda_operation_logs(target_username);

    CREATE INDEX IF NOT EXISTS idx_esmeralda_operation_logs_target_remote_user_id
      ON esmeralda_operation_logs(target_remote_user_id);

    CREATE INDEX IF NOT EXISTS idx_esmeralda_operation_logs_conversation_key
      ON esmeralda_operation_logs(conversation_key);

    CREATE INDEX IF NOT EXISTS idx_esmeralda_operation_logs_created_at
      ON esmeralda_operation_logs(created_at);

    CREATE TABLE IF NOT EXISTS payment_accounts (
      account_key TEXT PRIMARY KEY,
      cvu TEXT,
      alias TEXT,
      holder_name TEXT,
      raw_payload_json TEXT,
      fetched_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cashin_requests (
      request_id TEXT PRIMARY KEY,
      conversation_key TEXT,
      phone_key TEXT,
      phone_number TEXT,
      whatsapp_jid TEXT,
      linked_remote_user_id TEXT,
      linked_username TEXT,
      payer_cuit TEXT NOT NULL,
      payer_name TEXT,
      expected_amount_text TEXT,
      expected_amount_value REAL,
      expected_amount_cents INTEGER,
      currency TEXT NOT NULL,
      account_number TEXT NOT NULL,
      cvu TEXT,
      alias TEXT,
      holder_name TEXT,
      callback_url TEXT,
      referencia_string TEXT,
      referencia_int INTEGER,
      status TEXT NOT NULL,
      expires_at TEXT,
      matched_at TEXT,
      cashin_id TEXT,
      psp_transaction_id TEXT,
      received_at TEXT,
      credit_applied INTEGER NOT NULL DEFAULT 0,
      credit_applied_at TEXT,
      success_notified_at TEXT,
      credit_amount_text TEXT,
      credit_amount_value REAL,
      credit_amount_cents INTEGER,
      last_polled_at TEXT,
      expiry_notified_at TEXT,
      last_error TEXT,
      raw_request_json TEXT,
      raw_status_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cashin_requests_conversation_key
      ON cashin_requests(conversation_key);

    CREATE INDEX IF NOT EXISTS idx_cashin_requests_phone_key
      ON cashin_requests(phone_key);

    CREATE INDEX IF NOT EXISTS idx_cashin_requests_linked_username
      ON cashin_requests(linked_username);

    CREATE INDEX IF NOT EXISTS idx_cashin_requests_status
      ON cashin_requests(status);

    CREATE INDEX IF NOT EXISTS idx_cashin_requests_updated_at
      ON cashin_requests(updated_at);

    CREATE TABLE IF NOT EXISTS cashin_callback_events (
      event_id TEXT PRIMARY KEY,
      request_id TEXT,
      cashin_id TEXT,
      event_type TEXT NOT NULL,
      conversation_key TEXT,
      phone_key TEXT,
      linked_remote_user_id TEXT,
      linked_username TEXT,
      http_headers_json TEXT,
      raw_payload_json TEXT,
      amount_text TEXT,
      amount_value REAL,
      amount_cents INTEGER,
      currency TEXT,
      processed_success INTEGER,
      processing_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cashin_callback_events_request_id
      ON cashin_callback_events(request_id);

    CREATE INDEX IF NOT EXISTS idx_cashin_callback_events_created_at
      ON cashin_callback_events(created_at);

    CREATE TABLE IF NOT EXISTS payout_requests (
      payout_id TEXT PRIMARY KEY,
      conversation_key TEXT,
      phone_key TEXT,
      phone_number TEXT,
      whatsapp_jid TEXT,
      linked_remote_user_id TEXT,
      linked_username TEXT,
      destination_account TEXT NOT NULL,
      amount_text TEXT NOT NULL,
      amount_value REAL,
      amount_cents INTEGER,
      receipt_format TEXT,
      callback_url TEXT,
      status TEXT NOT NULL,
      is_successful INTEGER,
      cvu_pago TEXT,
      source TEXT,
      receipt_content_type TEXT,
      receipt_local_path TEXT,
      receipt_preview_text TEXT,
      esmeralda_debit_applied INTEGER NOT NULL DEFAULT 0,
      esmeralda_debit_applied_at TEXT,
      last_polled_at TEXT,
      success_notified_at TEXT,
      failure_notified_at TEXT,
      last_error TEXT,
      raw_request_json TEXT,
      raw_status_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payout_requests_conversation_key
      ON payout_requests(conversation_key);

    CREATE INDEX IF NOT EXISTS idx_payout_requests_phone_key
      ON payout_requests(phone_key);

    CREATE INDEX IF NOT EXISTS idx_payout_requests_linked_username
      ON payout_requests(linked_username);

    CREATE INDEX IF NOT EXISTS idx_payout_requests_status
      ON payout_requests(status);

    CREATE INDEX IF NOT EXISTS idx_payout_requests_updated_at
      ON payout_requests(updated_at);

    CREATE TABLE IF NOT EXISTS payout_callback_events (
      event_id TEXT PRIMARY KEY,
      payout_id TEXT,
      event_type TEXT,
      conversation_key TEXT,
      phone_key TEXT,
      linked_remote_user_id TEXT,
      linked_username TEXT,
      http_headers_json TEXT,
      raw_payload_json TEXT,
      receipt_content_type TEXT,
      receipt_local_path TEXT,
      amount_text TEXT,
      amount_value REAL,
      amount_cents INTEGER,
      processed_success INTEGER,
      processing_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payout_callback_events_payout_id
      ON payout_callback_events(payout_id);

    CREATE INDEX IF NOT EXISTS idx_payout_callback_events_created_at
      ON payout_callback_events(created_at);

    CREATE TABLE IF NOT EXISTS whatsapp_conversation_controls (
      conversation_key TEXT PRIMARY KEY,
      bot_paused INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT,
      paused_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_conversation_controls_bot_paused
      ON whatsapp_conversation_controls(bot_paused);

    CREATE TABLE IF NOT EXISTS bot_runtime_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = queryAll(db, `PRAGMA table_info(${tableName})`);
  if (columns.some((column) => String(column.name) === columnName)) {
    return;
  }

  db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function applySchemaMigrations(db) {
  ensureColumn(db, 'cashin_requests', 'last_polled_at', 'TEXT');
  ensureColumn(db, 'cashin_requests', 'expiry_notified_at', 'TEXT');
  ensureColumn(db, 'cashin_requests', 'success_notified_at', 'TEXT');
  ensureColumn(db, 'payout_requests', 'last_polled_at', 'TEXT');
  ensureColumn(db, 'payout_requests', 'success_notified_at', 'TEXT');
  ensureColumn(db, 'payout_requests', 'failure_notified_at', 'TEXT');
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_cashin_requests_expiry_notified_at
      ON cashin_requests(expiry_notified_at);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_payout_requests_failure_notified_at
      ON payout_requests(failure_notified_at);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_payout_requests_success_notified_at
      ON payout_requests(success_notified_at);
  `);
}

async function openDatabase(dbPath) {
  const SQL = await getSql();
  const resolvedDbPath = getResolvedDbPath(dbPath);
  const releaseLock = await acquireDbLock(resolvedDbPath);

  try {
    await mkdir(dirname(resolvedDbPath), { recursive: true });

    let db;

    try {
      const fileBuffer = await readFile(resolvedDbPath);
      db = new SQL.Database(fileBuffer);
    } catch (error) {
      db = new SQL.Database();
    }

    applySchema(db);
    applySchemaMigrations(db);

    return { db, resolvedDbPath, releaseLock };
  } catch (error) {
    await releaseLock();
    throw error;
  }
}

async function saveDatabase(db, resolvedDbPath) {
  const data = db.export();
  await writeFile(resolvedDbPath, Buffer.from(data));
}

async function closeDatabase(db, releaseLock) {
  try {
    db.close();
  } finally {
    await releaseLock();
  }
}

async function acquireDbLock(resolvedDbPath) {
  const lockPath = `${resolvedDbPath}.lock`;
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await openFile(lockPath, 'wx');
      await handle.writeFile(String(process.pid));

      return async () => {
        try {
          await handle.close();
        } catch {}

        try {
          await unlink(lockPath);
        } catch {}
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      try {
        const lockStats = await stat(lockPath);
        if (Date.now() - lockStats.mtimeMs > DB_LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {}

      if (Date.now() - startedAt > DB_LOCK_TIMEOUT_MS) {
        throw new Error('No se pudo tomar el lock de la base local a tiempo');
      }

      await wait(DB_LOCK_RETRY_MS);
    }
  }
}

function queryAll(db, sql, params = []) {
  const statement = db.prepare(sql);
  const rows = [];

  try {
    statement.bind(params);

    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
  } finally {
    statement.free();
  }

  return rows;
}

function queryOne(db, sql, params = []) {
  const statement = db.prepare(sql);

  try {
    statement.bind(params);

    if (!statement.step()) {
      return null;
    }

    return statement.getAsObject();
  } finally {
    statement.free();
  }
}

function parseBalanceText(balanceText) {
  if (!balanceText) {
    return {
      balanceAmount: null,
      balanceCents: null,
    };
  }

  const normalizedValue = String(balanceText).replace(/\./g, '').replace(',', '.');
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

function parseMoneyText(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return {
      amountValue: null,
      amountCents: null,
    };
  }

  const sanitized = normalized.replace(/\./g, '').replace(',', '.');
  const amountValue = Number.parseFloat(sanitized);

  if (!Number.isFinite(amountValue)) {
    return {
      amountValue: null,
      amountCents: null,
    };
  }

  return {
    amountValue,
    amountCents: Math.round(amountValue * 100),
  };
}

function serializeRawPayload(rawPayload) {
  if (rawPayload === undefined) {
    return null;
  }

  try {
    return JSON.stringify(rawPayload);
  } catch {
    return JSON.stringify({ unsupported: true });
  }
}

function truncateText(value, maxLength = 800) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength).trim()}...`
    : normalized;
}

function buildIdentifierFilter({
  remoteUserId,
  username,
  phoneKey,
  remoteColumn,
  usernameColumn,
  phoneColumn,
}) {
  const clauses = [];
  const params = [];

  if (remoteUserId) {
    clauses.push(`${remoteColumn} = ?`);
    params.push(String(remoteUserId));
  }

  if (username) {
    clauses.push(`lower(${usernameColumn}) = lower(?)`);
    params.push(String(username));
  }

  if (phoneKey && phoneColumn) {
    clauses.push(`${phoneColumn} = ?`);
    params.push(String(phoneKey));
  }

  return {
    clause: clauses.length ? `(${clauses.join(' OR ')})` : '1 = 0',
    params,
  };
}

function isTruthySettingValue(value) {
  return String(value || '').trim() === '1';
}

function buildSettingsMap(rows) {
  const map = new Map();

  for (const row of rows) {
    map.set(String(row.setting_key), {
      value: row.setting_value,
      updatedAt: row.updated_at,
    });
  }

  return map;
}

function getSettingsEntry(settingsMap, key, fallbackValue = null) {
  return settingsMap.get(key) || {
    value: fallbackValue,
    updatedAt: null,
  };
}

function normalizeConversationControl(row, conversationKey = null) {
  return {
    conversationKey: row?.conversation_key || conversationKey || null,
    paused: Boolean(Number(row?.bot_paused || 0)),
    reason: row?.pause_reason || null,
    pausedAt: row?.paused_at || null,
    updatedAt: row?.updated_at || null,
  };
}

function normalizeRuntimeState(settingsMap, pausedConversationCount = 0) {
  const globalPauseValue = getSettingsEntry(settingsMap, 'global_bot_paused', '0');
  const globalPauseReason = getSettingsEntry(settingsMap, 'global_bot_pause_reason', null);
  const globalPauseAt = getSettingsEntry(settingsMap, 'global_bot_paused_at', null);
  const aiRules = getSettingsEntry(settingsMap, 'ai_runtime_rules', '');
  const agentSystemPrompt = getSettingsEntry(
    settingsMap,
    'casino_agent_system_prompt',
    '',
  );
  const actionSystemPrompt = getSettingsEntry(
    settingsMap,
    'casino_action_system_prompt',
    '',
  );

  return {
    globalPause: {
      paused: isTruthySettingValue(globalPauseValue.value),
      reason: globalPauseReason.value || null,
      pausedAt: globalPauseAt.value || null,
      updatedAt: globalPauseValue.updatedAt || null,
    },
    aiRules: {
      text: String(aiRules.value || ''),
      updatedAt: aiRules.updatedAt || null,
    },
    promptSettings: {
      agentSystemPrompt: String(agentSystemPrompt.value || ''),
      actionSystemPrompt: String(actionSystemPrompt.value || ''),
      agentUpdatedAt: agentSystemPrompt.updatedAt || null,
      actionUpdatedAt: actionSystemPrompt.updatedAt || null,
    },
    pausedConversationCount: Number(pausedConversationCount || 0),
  };
}

function upsertSettings(db, entries) {
  const statement = db.prepare(`
    INSERT INTO bot_runtime_settings (
      setting_key,
      setting_value,
      updated_at
    ) VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = excluded.updated_at
  `);

  try {
    for (const entry of entries) {
      statement.run([
        String(entry.key),
        entry.value === null || entry.value === undefined ? null : String(entry.value),
        entry.updatedAt,
      ]);
    }
  } finally {
    statement.free();
  }
}

export async function upsertEsmeraldaUsers(users, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    db.run('BEGIN');

    const statement = db.prepare(`
      INSERT INTO esmeralda_users (
        remote_user_id,
        username,
        balance_text,
        balance_amount,
        balance_cents,
        credit_actions_json,
        user_actions_json,
        unknown_value,
        user_type,
        raw_row_json,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(remote_user_id) DO UPDATE SET
        username = excluded.username,
        balance_text = excluded.balance_text,
        balance_amount = excluded.balance_amount,
        balance_cents = excluded.balance_cents,
        credit_actions_json = excluded.credit_actions_json,
        user_actions_json = excluded.user_actions_json,
        unknown_value = excluded.unknown_value,
        user_type = excluded.user_type,
        raw_row_json = excluded.raw_row_json,
        synced_at = excluded.synced_at
    `);

    try {
      for (const row of users) {
        statement.run([
          row.remoteUserId,
          row.username,
          row.balanceText,
          row.balanceAmount,
          row.balanceCents,
          JSON.stringify(row.creditActions || []),
          JSON.stringify(row.userActions || []),
          row.unknownValue,
          row.userType,
          JSON.stringify(row.rawRow || []),
          row.syncedAt,
        ]);
      }
    } finally {
      statement.free();
    }

    db.run('COMMIT');
    await saveDatabase(db, resolvedDbPath);

    return {
      dbPath: resolvedDbPath,
      storedUsers: users.length,
    };
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch {}

    throw error;
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function listStoredEsmeraldaUsers(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const limit = Number.isInteger(options.limit) ? options.limit : 50;
    const rows = queryAll(
      db,
      `
        SELECT
          remote_user_id,
          username,
          balance_text,
          balance_amount,
          balance_cents,
          unknown_value,
          user_type,
          synced_at
        FROM esmeralda_users
        ORDER BY username ASC
        LIMIT ?
      `,
      [limit],
    );

    return {
      dbPath: resolvedDbPath,
      rows,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function findStoredEsmeraldaUserByUsername(username, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const row = queryOne(
      db,
      `
        SELECT
          remote_user_id,
          username,
          balance_text,
          balance_amount,
          balance_cents,
          unknown_value,
          user_type,
          credit_actions_json,
          user_actions_json,
          raw_row_json,
          synced_at
        FROM esmeralda_users
        WHERE lower(username) = lower(?)
        LIMIT 1
      `,
      [username],
    );

    return {
      dbPath: resolvedDbPath,
      row,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function updateStoredEsmeraldaUserBalance(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const { balanceAmount, balanceCents } = parseBalanceText(options.balanceText);
    const syncedAt = new Date().toISOString();

    const statement = db.prepare(`
      UPDATE esmeralda_users
      SET
        balance_text = ?,
        balance_amount = ?,
        balance_cents = ?,
        synced_at = ?
      WHERE remote_user_id = ? OR lower(username) = lower(?)
    `);

    try {
      statement.run([
        options.balanceText,
        balanceAmount,
        balanceCents,
        syncedAt,
        String(options.remoteUserId || ''),
        String(options.username || ''),
      ]);
    } finally {
      statement.free();
    }

    await saveDatabase(db, resolvedDbPath);

    return {
      dbPath: resolvedDbPath,
      balanceText: options.balanceText,
      balanceAmount,
      balanceCents,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function upsertWhatsAppContact(contact, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const now = new Date().toISOString();
    const statement = db.prepare(`
      INSERT INTO whatsapp_contacts (
        phone_key,
        phone_number,
        whatsapp_jid,
        push_name,
        linked_remote_user_id,
        linked_username,
        created_at,
        updated_at,
        last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone_key) DO UPDATE SET
        phone_number = COALESCE(excluded.phone_number, whatsapp_contacts.phone_number),
        whatsapp_jid = excluded.whatsapp_jid,
        push_name = COALESCE(excluded.push_name, whatsapp_contacts.push_name),
        linked_remote_user_id = COALESCE(
          excluded.linked_remote_user_id,
          whatsapp_contacts.linked_remote_user_id
        ),
        linked_username = COALESCE(
          excluded.linked_username,
          whatsapp_contacts.linked_username
        ),
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at
    `);

    try {
      statement.run([
        String(contact.phoneKey || '').trim(),
        contact.phoneNumber ? String(contact.phoneNumber).trim() : null,
        String(contact.whatsappJid || '').trim(),
        contact.pushName ? String(contact.pushName).trim() : null,
        contact.linkedRemoteUserId
          ? String(contact.linkedRemoteUserId).trim()
          : null,
        contact.linkedUsername ? String(contact.linkedUsername).trim() : null,
        now,
        now,
        contact.lastSeenAt || now,
      ]);
    } finally {
      statement.free();
    }

    await saveDatabase(db, resolvedDbPath);

    return findWhatsAppContactByPhoneKey(contact.phoneKey, {
      dbPath: resolvedDbPath,
    });
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function findWhatsAppContactByPhoneKey(phoneKey, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const row = queryOne(
      db,
      `
        SELECT
          c.phone_key,
          c.phone_number,
          c.whatsapp_jid,
          c.push_name,
          c.linked_remote_user_id,
          c.linked_username,
          c.created_at,
          c.updated_at,
          c.last_seen_at,
          u.remote_user_id AS user_remote_user_id,
          u.username AS user_username,
          u.balance_text AS user_balance_text,
          u.balance_amount AS user_balance_amount,
          u.balance_cents AS user_balance_cents,
          u.unknown_value AS user_unknown_value,
          u.user_type AS user_user_type,
          u.synced_at AS user_synced_at
        FROM whatsapp_contacts c
        LEFT JOIN esmeralda_users u
          ON (
            c.linked_remote_user_id IS NOT NULL
            AND u.remote_user_id = c.linked_remote_user_id
          ) OR (
            c.linked_remote_user_id IS NULL
            AND c.linked_username IS NOT NULL
            AND lower(u.username) = lower(c.linked_username)
          )
        WHERE c.phone_key = ?
        LIMIT 1
      `,
      [String(phoneKey || '').trim()],
    );

    return {
      dbPath: resolvedDbPath,
      row,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function linkWhatsAppContactToEsmeraldaUser(options = {}) {
  return upsertWhatsAppContact(
    {
      phoneKey: options.phoneKey,
      phoneNumber: options.phoneNumber,
      whatsappJid: options.whatsappJid,
      pushName: options.pushName,
      linkedRemoteUserId: options.remoteUserId,
      linkedUsername: options.username,
      lastSeenAt: options.lastSeenAt,
    },
    { dbPath: options.dbPath },
  );
}

export async function storeWhatsAppMessage(message, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const createdAt = message.createdAt || new Date().toISOString();
    const conversationKey = String(
      message.conversationKey || message.phoneKey || message.whatsappJid,
    ).trim();
    const messageKey = String(message.messageKey || '').trim();

    db.run('BEGIN');

    if (!messageKey) {
      throw new Error('storeWhatsAppMessage requiere messageKey');
    }

    const insertMessage = db.prepare(`
      INSERT INTO whatsapp_messages (
        message_key,
        conversation_key,
        phone_key,
        phone_number,
        whatsapp_jid,
        push_name,
        linked_remote_user_id,
        linked_username,
        direction,
        sender_role,
        message_type,
        text,
        created_at,
        raw_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_key) DO UPDATE SET
        conversation_key = excluded.conversation_key,
        phone_key = COALESCE(excluded.phone_key, whatsapp_messages.phone_key),
        phone_number = COALESCE(excluded.phone_number, whatsapp_messages.phone_number),
        whatsapp_jid = excluded.whatsapp_jid,
        push_name = COALESCE(excluded.push_name, whatsapp_messages.push_name),
        linked_remote_user_id = COALESCE(
          excluded.linked_remote_user_id,
          whatsapp_messages.linked_remote_user_id
        ),
        linked_username = COALESCE(
          excluded.linked_username,
          whatsapp_messages.linked_username
        ),
        direction = excluded.direction,
        sender_role = excluded.sender_role,
        message_type = COALESCE(excluded.message_type, whatsapp_messages.message_type),
        text = COALESCE(excluded.text, whatsapp_messages.text),
        created_at = excluded.created_at,
        raw_payload_json = COALESCE(
          excluded.raw_payload_json,
          whatsapp_messages.raw_payload_json
        )
    `);

    try {
      insertMessage.run([
        messageKey,
        conversationKey,
        message.phoneKey ? String(message.phoneKey).trim() : null,
        message.phoneNumber ? String(message.phoneNumber).trim() : null,
        String(message.whatsappJid || '').trim(),
        message.pushName ? String(message.pushName).trim() : null,
        message.linkedRemoteUserId
          ? String(message.linkedRemoteUserId).trim()
          : null,
        message.linkedUsername ? String(message.linkedUsername).trim() : null,
        String(message.direction || 'unknown').trim(),
        String(message.senderRole || 'unknown').trim(),
        message.messageType ? String(message.messageType).trim() : null,
        message.text ? String(message.text) : null,
        createdAt,
        serializeRawPayload(message.rawPayload),
      ]);
    } finally {
      insertMessage.free();
    }

    const existingConversation = queryOne(
      db,
      `
        SELECT
          conversation_key,
          created_at,
          last_incoming_text,
          last_outgoing_text
        FROM whatsapp_conversations
        WHERE conversation_key = ?
        LIMIT 1
      `,
      [conversationKey],
    );

    const totalMessagesRow = queryOne(
      db,
      `
        SELECT COUNT(*) AS total_messages
        FROM whatsapp_messages
        WHERE conversation_key = ?
      `,
      [conversationKey],
    );

    const totalMessages = Number(totalMessagesRow?.total_messages || 0);
    const lastIncomingText =
      message.direction === 'incoming'
        ? message.text || existingConversation?.last_incoming_text || null
        : existingConversation?.last_incoming_text || null;
    const lastOutgoingText =
      message.direction === 'outgoing'
        ? message.text || existingConversation?.last_outgoing_text || null
        : existingConversation?.last_outgoing_text || null;

    const upsertConversation = db.prepare(`
      INSERT INTO whatsapp_conversations (
        conversation_key,
        phone_key,
        phone_number,
        whatsapp_jid,
        push_name,
        linked_remote_user_id,
        linked_username,
        last_incoming_text,
        last_outgoing_text,
        last_message_at,
        last_message_direction,
        total_messages,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET
        phone_key = COALESCE(excluded.phone_key, whatsapp_conversations.phone_key),
        phone_number = COALESCE(excluded.phone_number, whatsapp_conversations.phone_number),
        whatsapp_jid = excluded.whatsapp_jid,
        push_name = COALESCE(excluded.push_name, whatsapp_conversations.push_name),
        linked_remote_user_id = COALESCE(
          excluded.linked_remote_user_id,
          whatsapp_conversations.linked_remote_user_id
        ),
        linked_username = COALESCE(
          excluded.linked_username,
          whatsapp_conversations.linked_username
        ),
        last_incoming_text = COALESCE(
          excluded.last_incoming_text,
          whatsapp_conversations.last_incoming_text
        ),
        last_outgoing_text = COALESCE(
          excluded.last_outgoing_text,
          whatsapp_conversations.last_outgoing_text
        ),
        last_message_at = excluded.last_message_at,
        last_message_direction = excluded.last_message_direction,
        total_messages = excluded.total_messages,
        updated_at = excluded.updated_at
    `);

    try {
      upsertConversation.run([
        conversationKey,
        message.phoneKey ? String(message.phoneKey).trim() : null,
        message.phoneNumber ? String(message.phoneNumber).trim() : null,
        String(message.whatsappJid || '').trim(),
        message.pushName ? String(message.pushName).trim() : null,
        message.linkedRemoteUserId
          ? String(message.linkedRemoteUserId).trim()
          : null,
        message.linkedUsername ? String(message.linkedUsername).trim() : null,
        lastIncomingText,
        lastOutgoingText,
        createdAt,
        String(message.direction || 'unknown').trim(),
        totalMessages,
        existingConversation?.created_at || createdAt,
        createdAt,
      ]);
    } finally {
      upsertConversation.free();
    }

    db.run('COMMIT');
    await saveDatabase(db, resolvedDbPath);

    return {
      dbPath: resolvedDbPath,
      conversationKey,
      messageKey,
      totalMessages,
    };
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch {}

    throw error;
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function storeWhatsAppMediaAttachment(attachment, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const now = new Date().toISOString();
    const attachmentId = String(attachment.attachmentId || '').trim();

    if (!attachmentId) {
      throw new Error('storeWhatsAppMediaAttachment requiere attachmentId');
    }

    const statement = db.prepare(`
      INSERT INTO whatsapp_media_attachments (
        attachment_id,
        message_key,
        conversation_key,
        phone_key,
        phone_number,
        whatsapp_jid,
        sender_role,
        media_kind,
        mime_type,
        file_name,
        local_path,
        sha256_hex,
        file_size_bytes,
        extracted_reference,
        extracted_amount_text,
        extracted_confidence,
        extracted_notes,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attachment_id) DO UPDATE SET
        message_key = excluded.message_key,
        conversation_key = excluded.conversation_key,
        phone_key = COALESCE(excluded.phone_key, whatsapp_media_attachments.phone_key),
        phone_number = COALESCE(excluded.phone_number, whatsapp_media_attachments.phone_number),
        whatsapp_jid = excluded.whatsapp_jid,
        sender_role = excluded.sender_role,
        media_kind = excluded.media_kind,
        mime_type = COALESCE(excluded.mime_type, whatsapp_media_attachments.mime_type),
        file_name = COALESCE(excluded.file_name, whatsapp_media_attachments.file_name),
        local_path = excluded.local_path,
        sha256_hex = COALESCE(excluded.sha256_hex, whatsapp_media_attachments.sha256_hex),
        file_size_bytes = COALESCE(excluded.file_size_bytes, whatsapp_media_attachments.file_size_bytes),
        extracted_reference = COALESCE(
          excluded.extracted_reference,
          whatsapp_media_attachments.extracted_reference
        ),
        extracted_amount_text = COALESCE(
          excluded.extracted_amount_text,
          whatsapp_media_attachments.extracted_amount_text
        ),
        extracted_confidence = COALESCE(
          excluded.extracted_confidence,
          whatsapp_media_attachments.extracted_confidence
        ),
        extracted_notes = COALESCE(
          excluded.extracted_notes,
          whatsapp_media_attachments.extracted_notes
        ),
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);

    try {
      statement.run([
        attachmentId,
        String(attachment.messageKey || '').trim(),
        String(attachment.conversationKey || '').trim(),
        attachment.phoneKey ? String(attachment.phoneKey).trim() : null,
        attachment.phoneNumber ? String(attachment.phoneNumber).trim() : null,
        String(attachment.whatsappJid || '').trim(),
        String(attachment.senderRole || 'customer').trim(),
        String(attachment.mediaKind || 'document').trim(),
        attachment.mimeType ? String(attachment.mimeType).trim() : null,
        attachment.fileName ? String(attachment.fileName).trim() : null,
        String(attachment.localPath || '').trim(),
        attachment.sha256Hex ? String(attachment.sha256Hex).trim() : null,
        Number.isFinite(Number(attachment.fileSizeBytes))
          ? Number(attachment.fileSizeBytes)
          : null,
        attachment.extractedReference
          ? String(attachment.extractedReference).trim()
          : null,
        attachment.extractedAmountText
          ? String(attachment.extractedAmountText).trim()
          : null,
        attachment.extractedConfidence
          ? String(attachment.extractedConfidence).trim()
          : null,
        attachment.extractedNotes
          ? String(attachment.extractedNotes).trim()
          : null,
        attachment.createdAt || now,
        now,
      ]);
    } finally {
      statement.free();
    }

    await saveDatabase(db, resolvedDbPath);

    return {
      dbPath: resolvedDbPath,
      attachmentId,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function annotateWhatsAppMediaAttachment(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const attachmentId = String(options.attachmentId || '').trim();

    if (!attachmentId) {
      throw new Error('annotateWhatsAppMediaAttachment requiere attachmentId');
    }

    const statement = db.prepare(`
      UPDATE whatsapp_media_attachments
      SET
        extracted_reference = ?,
        extracted_amount_text = ?,
        extracted_confidence = ?,
        extracted_notes = ?,
        updated_at = ?
      WHERE attachment_id = ?
    `);

    try {
      statement.run([
        options.extractedReference
          ? String(options.extractedReference).trim()
          : null,
        options.extractedAmountText
          ? String(options.extractedAmountText).trim()
          : null,
        options.extractedConfidence
          ? String(options.extractedConfidence).trim()
          : null,
        options.extractedNotes ? String(options.extractedNotes).trim() : null,
        new Date().toISOString(),
        attachmentId,
      ]);
    } finally {
      statement.free();
    }

    await saveDatabase(db, resolvedDbPath);

    return {
      dbPath: resolvedDbPath,
      attachmentId,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function storeEsmeraldaOperationLog(entry, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const createdAt = entry.createdAt || new Date().toISOString();
    const operationId = String(entry.operationId || crypto.randomUUID());
    const { amountValue, amountCents } = parseMoneyText(entry.amountText);

    const statement = db.prepare(`
      INSERT INTO esmeralda_operation_logs (
        operation_id,
        operation_type,
        endpoint,
        http_method,
        target_remote_user_id,
        target_username,
        target_user_type,
        phone_key,
        phone_number,
        whatsapp_jid,
        conversation_key,
        actor_push_name,
        amount_text,
        amount_value,
        amount_cents,
        balance_text,
        success,
        response_status,
        error_message,
        request_payload_json,
        response_excerpt,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_id) DO UPDATE SET
        operation_type = excluded.operation_type,
        endpoint = excluded.endpoint,
        http_method = excluded.http_method,
        target_remote_user_id = COALESCE(excluded.target_remote_user_id, esmeralda_operation_logs.target_remote_user_id),
        target_username = COALESCE(excluded.target_username, esmeralda_operation_logs.target_username),
        target_user_type = COALESCE(excluded.target_user_type, esmeralda_operation_logs.target_user_type),
        phone_key = COALESCE(excluded.phone_key, esmeralda_operation_logs.phone_key),
        phone_number = COALESCE(excluded.phone_number, esmeralda_operation_logs.phone_number),
        whatsapp_jid = COALESCE(excluded.whatsapp_jid, esmeralda_operation_logs.whatsapp_jid),
        conversation_key = COALESCE(excluded.conversation_key, esmeralda_operation_logs.conversation_key),
        actor_push_name = COALESCE(excluded.actor_push_name, esmeralda_operation_logs.actor_push_name),
        amount_text = COALESCE(excluded.amount_text, esmeralda_operation_logs.amount_text),
        amount_value = COALESCE(excluded.amount_value, esmeralda_operation_logs.amount_value),
        amount_cents = COALESCE(excluded.amount_cents, esmeralda_operation_logs.amount_cents),
        balance_text = COALESCE(excluded.balance_text, esmeralda_operation_logs.balance_text),
        success = excluded.success,
        response_status = COALESCE(excluded.response_status, esmeralda_operation_logs.response_status),
        error_message = COALESCE(excluded.error_message, esmeralda_operation_logs.error_message),
        request_payload_json = COALESCE(excluded.request_payload_json, esmeralda_operation_logs.request_payload_json),
        response_excerpt = COALESCE(excluded.response_excerpt, esmeralda_operation_logs.response_excerpt),
        metadata_json = COALESCE(excluded.metadata_json, esmeralda_operation_logs.metadata_json),
        created_at = excluded.created_at
    `);

    try {
      statement.run([
        operationId,
        String(entry.operationType || 'unknown'),
        String(entry.endpoint || ''),
        String(entry.httpMethod || 'POST'),
        entry.targetRemoteUserId ? String(entry.targetRemoteUserId) : null,
        entry.targetUsername ? String(entry.targetUsername) : null,
        entry.targetUserType ? String(entry.targetUserType) : null,
        entry.phoneKey ? String(entry.phoneKey) : null,
        entry.phoneNumber ? String(entry.phoneNumber) : null,
        entry.whatsappJid ? String(entry.whatsappJid) : null,
        entry.conversationKey ? String(entry.conversationKey) : null,
        entry.actorPushName ? String(entry.actorPushName) : null,
        entry.amountText ? String(entry.amountText) : null,
        amountValue,
        amountCents,
        entry.balanceText ? String(entry.balanceText) : null,
        entry.success === false ? 0 : 1,
        Number.isFinite(Number(entry.responseStatus))
          ? Number(entry.responseStatus)
          : null,
        truncateText(entry.errorMessage, 500),
        serializeRawPayload(entry.requestPayload),
        truncateText(entry.responseExcerpt, 1200),
        serializeRawPayload(entry.metadata),
        createdAt,
      ]);
    } finally {
      statement.free();
    }

    await saveDatabase(db, resolvedDbPath);

    return {
      dbPath: resolvedDbPath,
      operationId,
      createdAt,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function upsertPaymentAccount(account, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);
  const fetchedAt = account.fetchedAt || new Date().toISOString();
  const updatedAt = new Date().toISOString();

  try {
    const statement = db.prepare(`
      INSERT INTO payment_accounts (
        account_key,
        cvu,
        alias,
        holder_name,
        raw_payload_json,
        fetched_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_key) DO UPDATE SET
        cvu = COALESCE(excluded.cvu, payment_accounts.cvu),
        alias = COALESCE(excluded.alias, payment_accounts.alias),
        holder_name = COALESCE(excluded.holder_name, payment_accounts.holder_name),
        raw_payload_json = COALESCE(excluded.raw_payload_json, payment_accounts.raw_payload_json),
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
    `);

    try {
      statement.run([
        String(account.accountKey || 'collector'),
        account.cvu ? String(account.cvu).trim() : null,
        account.alias ? String(account.alias).trim() : null,
        account.holderName ? String(account.holderName).trim() : null,
        serializeRawPayload(account.rawPayload),
        fetchedAt,
        updatedAt,
      ]);
    } finally {
      statement.free();
    }

    await saveDatabase(db, resolvedDbPath);

    return getPaymentAccount(account.accountKey || 'collector', {
      dbPath: resolvedDbPath,
    });
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function getPaymentAccount(accountKey = 'collector', options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const row = queryOne(
      db,
      `
        SELECT
          account_key,
          cvu,
          alias,
          holder_name,
          raw_payload_json,
          fetched_at,
          updated_at
        FROM payment_accounts
        WHERE account_key = ?
        LIMIT 1
      `,
      [String(accountKey || 'collector')],
    );

    return {
      dbPath: resolvedDbPath,
      row,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function upsertCashInRequest(entry, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);
  const createdAt = entry.createdAt || new Date().toISOString();
  const updatedAt = entry.updatedAt || new Date().toISOString();
  const expectedAmount = parseMoneyText(entry.expectedAmountText ?? entry.expectedAmount);
  const creditAmount = parseMoneyText(entry.creditAmountText ?? entry.creditAmount);

  try {
    const statement = db.prepare(`
      INSERT INTO cashin_requests (
        request_id,
        conversation_key,
        phone_key,
        phone_number,
        whatsapp_jid,
        linked_remote_user_id,
        linked_username,
        payer_cuit,
        payer_name,
        expected_amount_text,
        expected_amount_value,
        expected_amount_cents,
        currency,
        account_number,
        cvu,
        alias,
        holder_name,
        callback_url,
        referencia_string,
        referencia_int,
        status,
        expires_at,
        matched_at,
        cashin_id,
        psp_transaction_id,
        received_at,
        credit_applied,
        credit_applied_at,
        success_notified_at,
        credit_amount_text,
        credit_amount_value,
        credit_amount_cents,
        last_polled_at,
        expiry_notified_at,
        last_error,
        raw_request_json,
        raw_status_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        conversation_key = COALESCE(excluded.conversation_key, cashin_requests.conversation_key),
        phone_key = COALESCE(excluded.phone_key, cashin_requests.phone_key),
        phone_number = COALESCE(excluded.phone_number, cashin_requests.phone_number),
        whatsapp_jid = COALESCE(excluded.whatsapp_jid, cashin_requests.whatsapp_jid),
        linked_remote_user_id = COALESCE(excluded.linked_remote_user_id, cashin_requests.linked_remote_user_id),
        linked_username = COALESCE(excluded.linked_username, cashin_requests.linked_username),
        payer_cuit = COALESCE(excluded.payer_cuit, cashin_requests.payer_cuit),
        payer_name = COALESCE(excluded.payer_name, cashin_requests.payer_name),
        expected_amount_text = COALESCE(excluded.expected_amount_text, cashin_requests.expected_amount_text),
        expected_amount_value = COALESCE(excluded.expected_amount_value, cashin_requests.expected_amount_value),
        expected_amount_cents = COALESCE(excluded.expected_amount_cents, cashin_requests.expected_amount_cents),
        currency = COALESCE(excluded.currency, cashin_requests.currency),
        account_number = COALESCE(excluded.account_number, cashin_requests.account_number),
        cvu = COALESCE(excluded.cvu, cashin_requests.cvu),
        alias = COALESCE(excluded.alias, cashin_requests.alias),
        holder_name = COALESCE(excluded.holder_name, cashin_requests.holder_name),
        callback_url = COALESCE(excluded.callback_url, cashin_requests.callback_url),
        referencia_string = COALESCE(excluded.referencia_string, cashin_requests.referencia_string),
        referencia_int = COALESCE(excluded.referencia_int, cashin_requests.referencia_int),
        status = COALESCE(excluded.status, cashin_requests.status),
        expires_at = COALESCE(excluded.expires_at, cashin_requests.expires_at),
        matched_at = COALESCE(excluded.matched_at, cashin_requests.matched_at),
        cashin_id = COALESCE(excluded.cashin_id, cashin_requests.cashin_id),
        psp_transaction_id = COALESCE(excluded.psp_transaction_id, cashin_requests.psp_transaction_id),
        received_at = COALESCE(excluded.received_at, cashin_requests.received_at),
        credit_applied = COALESCE(excluded.credit_applied, cashin_requests.credit_applied),
        credit_applied_at = COALESCE(excluded.credit_applied_at, cashin_requests.credit_applied_at),
        success_notified_at = COALESCE(excluded.success_notified_at, cashin_requests.success_notified_at),
        credit_amount_text = COALESCE(excluded.credit_amount_text, cashin_requests.credit_amount_text),
        credit_amount_value = COALESCE(excluded.credit_amount_value, cashin_requests.credit_amount_value),
        credit_amount_cents = COALESCE(excluded.credit_amount_cents, cashin_requests.credit_amount_cents),
        last_polled_at = COALESCE(excluded.last_polled_at, cashin_requests.last_polled_at),
        expiry_notified_at = COALESCE(excluded.expiry_notified_at, cashin_requests.expiry_notified_at),
        last_error = COALESCE(excluded.last_error, cashin_requests.last_error),
        raw_request_json = COALESCE(excluded.raw_request_json, cashin_requests.raw_request_json),
        raw_status_json = COALESCE(excluded.raw_status_json, cashin_requests.raw_status_json),
        updated_at = excluded.updated_at
    `);

    try {
      statement.run([
        String(entry.requestId || '').trim(),
        entry.conversationKey ? String(entry.conversationKey).trim() : null,
        entry.phoneKey ? String(entry.phoneKey).trim() : null,
        entry.phoneNumber ? String(entry.phoneNumber).trim() : null,
        entry.whatsappJid ? String(entry.whatsappJid).trim() : null,
        entry.linkedRemoteUserId ? String(entry.linkedRemoteUserId).trim() : null,
        entry.linkedUsername ? String(entry.linkedUsername).trim() : null,
        entry.payerCuit ? String(entry.payerCuit).trim() : null,
        entry.payerName ? String(entry.payerName).trim() : null,
        entry.expectedAmountText ? String(entry.expectedAmountText).trim() : null,
        expectedAmount.amountValue,
        expectedAmount.amountCents,
        entry.currency ? String(entry.currency).trim() : null,
        entry.accountNumber ? String(entry.accountNumber).trim() : null,
        entry.cvu ? String(entry.cvu).trim() : null,
        entry.alias ? String(entry.alias).trim() : null,
        entry.holderName ? String(entry.holderName).trim() : null,
        entry.callbackUrl ? String(entry.callbackUrl).trim() : null,
        entry.referenciaString ? String(entry.referenciaString).trim() : null,
        Number.isInteger(entry.referenciaInt) ? entry.referenciaInt : null,
        entry.status ? String(entry.status).trim() : null,
        entry.expiresAt ? String(entry.expiresAt).trim() : null,
        entry.matchedAt ? String(entry.matchedAt).trim() : null,
        entry.cashInId ? String(entry.cashInId).trim() : null,
        entry.pspTransactionId ? String(entry.pspTransactionId).trim() : null,
        entry.receivedAt ? String(entry.receivedAt).trim() : null,
        Number.isInteger(entry.creditApplied)
          ? entry.creditApplied
          : entry.creditApplied === true
          ? 1
          : entry.creditApplied === false
          ? 0
          : 0,
        entry.creditAppliedAt ? String(entry.creditAppliedAt).trim() : null,
        entry.successNotifiedAt ? String(entry.successNotifiedAt).trim() : null,
        entry.creditAmountText ? String(entry.creditAmountText).trim() : null,
        creditAmount.amountValue,
        creditAmount.amountCents,
        entry.lastPolledAt ? String(entry.lastPolledAt).trim() : null,
        entry.expiryNotifiedAt ? String(entry.expiryNotifiedAt).trim() : null,
        truncateText(entry.lastError, 500),
        serializeRawPayload(entry.rawRequest),
        serializeRawPayload(entry.rawStatus),
        createdAt,
        updatedAt,
      ]);
    } finally {
      statement.free();
    }

    await saveDatabase(db, resolvedDbPath);

    return findCashInRequestById(entry.requestId, { dbPath: resolvedDbPath });
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function findCashInRequestById(requestId, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const row = queryOne(
      db,
      `
        SELECT *
        FROM cashin_requests
        WHERE request_id = ?
        LIMIT 1
      `,
      [String(requestId || '').trim()],
    );

    return {
      dbPath: resolvedDbPath,
      row,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function findLatestConversationCashIn(conversationKey, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);
  const normalizedConversationKey = String(conversationKey || '').trim();
  const statuses = Array.isArray(options.statuses)
    ? options.statuses.filter((value) => typeof value === 'string' && value.trim())
    : [];

  try {
    const whereStatusClause = statuses.length
      ? `AND status IN (${statuses.map(() => '?').join(', ')})`
      : '';
    const params = [normalizedConversationKey, ...statuses];
    const row = queryOne(
      db,
      `
        SELECT *
        FROM cashin_requests
        WHERE conversation_key = ?
        ${whereStatusClause}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `,
      params,
    );

    return {
      dbPath: resolvedDbPath,
      row,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function listPendingCashInRequests(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const limit = Number.isInteger(options.limit) ? options.limit : 50;
    const rows = queryAll(
      db,
      `
        SELECT *
        FROM cashin_requests
        WHERE status = 'Pending'
        ORDER BY updated_at ASC, created_at ASC
        LIMIT ?
      `,
      [limit],
    );

    return {
      dbPath: resolvedDbPath,
      rows,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function listCashInRequestsNeedingExpiryNotification(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const limit = Number.isInteger(options.limit) ? options.limit : 50;
    const rows = queryAll(
      db,
      `
        SELECT *
        FROM cashin_requests
        WHERE status = 'Cancelled'
          AND expiry_notified_at IS NULL
          AND conversation_key IS NOT NULL
        ORDER BY updated_at ASC, created_at ASC
        LIMIT ?
      `,
      [limit],
    );

    return {
      dbPath: resolvedDbPath,
      rows,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function listMatchedCashInRequestsPendingCredit(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const limit = Number.isInteger(options.limit) ? options.limit : 25;
    const rows = queryAll(
      db,
      `
        SELECT *
        FROM cashin_requests
        WHERE status = 'Matched'
          AND COALESCE(credit_applied, 0) = 0
          AND credit_amount_text IS NOT NULL
          AND linked_username IS NOT NULL
        ORDER BY updated_at ASC, created_at ASC
        LIMIT ?
      `,
      [limit],
    );

    return {
      dbPath: resolvedDbPath,
      rows,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function listCashInRequestsNeedingSuccessNotification(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const limit = Number.isInteger(options.limit) ? options.limit : 25;
    const rows = queryAll(
      db,
      `
        SELECT *
        FROM cashin_requests
        WHERE status = 'Matched'
          AND COALESCE(credit_applied, 0) = 1
          AND success_notified_at IS NULL
          AND conversation_key IS NOT NULL
        ORDER BY credit_applied_at ASC, updated_at ASC, created_at ASC
        LIMIT ?
      `,
      [limit],
    );

    return {
      dbPath: resolvedDbPath,
      rows,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function markCashInExpiryNotified(
  requestId,
  notifiedAt = new Date().toISOString(),
  options = {},
) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    db.run(
      `
        UPDATE cashin_requests
        SET expiry_notified_at = ?,
            updated_at = ?
        WHERE request_id = ?
      `,
      [notifiedAt, notifiedAt, String(requestId || '').trim()],
    );

    await saveDatabase(db, resolvedDbPath);

    return {
      dbPath: resolvedDbPath,
      requestId: String(requestId || '').trim(),
      notifiedAt,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function markCashInSuccessNotified(
  requestId,
  notifiedAt = new Date().toISOString(),
  options = {},
) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    db.run(
      `
        UPDATE cashin_requests
        SET success_notified_at = ?,
            updated_at = ?
        WHERE request_id = ?
      `,
      [notifiedAt, notifiedAt, String(requestId || '').trim()],
    );

    await saveDatabase(db, resolvedDbPath);

    return {
      dbPath: resolvedDbPath,
      requestId: String(requestId || '').trim(),
      notifiedAt,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function storeCashInCallbackEvent(entry, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);
  const createdAt = entry.createdAt || new Date().toISOString();
  const updatedAt = entry.updatedAt || createdAt;
  const amount = parseMoneyText(entry.amountText ?? entry.amount);

  try {
    const statement = db.prepare(`
      INSERT INTO cashin_callback_events (
        event_id,
        request_id,
        cashin_id,
        event_type,
        conversation_key,
        phone_key,
        linked_remote_user_id,
        linked_username,
        http_headers_json,
        raw_payload_json,
        amount_text,
        amount_value,
        amount_cents,
        currency,
        processed_success,
        processing_note,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        request_id = COALESCE(excluded.request_id, cashin_callback_events.request_id),
        cashin_id = COALESCE(excluded.cashin_id, cashin_callback_events.cashin_id),
        event_type = COALESCE(excluded.event_type, cashin_callback_events.event_type),
        conversation_key = COALESCE(excluded.conversation_key, cashin_callback_events.conversation_key),
        phone_key = COALESCE(excluded.phone_key, cashin_callback_events.phone_key),
        linked_remote_user_id = COALESCE(excluded.linked_remote_user_id, cashin_callback_events.linked_remote_user_id),
        linked_username = COALESCE(excluded.linked_username, cashin_callback_events.linked_username),
        http_headers_json = COALESCE(excluded.http_headers_json, cashin_callback_events.http_headers_json),
        raw_payload_json = COALESCE(excluded.raw_payload_json, cashin_callback_events.raw_payload_json),
        amount_text = COALESCE(excluded.amount_text, cashin_callback_events.amount_text),
        amount_value = COALESCE(excluded.amount_value, cashin_callback_events.amount_value),
        amount_cents = COALESCE(excluded.amount_cents, cashin_callback_events.amount_cents),
        currency = COALESCE(excluded.currency, cashin_callback_events.currency),
        processed_success = COALESCE(excluded.processed_success, cashin_callback_events.processed_success),
        processing_note = COALESCE(excluded.processing_note, cashin_callback_events.processing_note),
        updated_at = excluded.updated_at
    `);

    try {
      statement.run([
        String(entry.eventId || crypto.randomUUID()),
        entry.requestId ? String(entry.requestId).trim() : null,
        entry.cashInId ? String(entry.cashInId).trim() : null,
        entry.eventType ? String(entry.eventType).trim() : null,
        entry.conversationKey ? String(entry.conversationKey).trim() : null,
        entry.phoneKey ? String(entry.phoneKey).trim() : null,
        entry.linkedRemoteUserId ? String(entry.linkedRemoteUserId).trim() : null,
        entry.linkedUsername ? String(entry.linkedUsername).trim() : null,
        serializeRawPayload(entry.httpHeaders),
        serializeRawPayload(entry.rawPayload),
        entry.amountText ? String(entry.amountText).trim() : null,
        amount.amountValue,
        amount.amountCents,
        entry.currency ? String(entry.currency).trim() : null,
        entry.processedSuccess === true
          ? 1
          : entry.processedSuccess === false
          ? 0
          : null,
        truncateText(entry.processingNote, 600),
        createdAt,
        updatedAt,
      ]);
    } finally {
      statement.free();
    }

    await saveDatabase(db, resolvedDbPath);

    return {
      dbPath: resolvedDbPath,
      eventId: String(entry.eventId || ''),
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function upsertPayOutRequest(entry, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);
  const createdAt = entry.createdAt || new Date().toISOString();
  const updatedAt = entry.updatedAt || new Date().toISOString();
  const amount = parseMoneyText(entry.amountText ?? entry.amount);

  try {
    const statement = db.prepare(`
      INSERT INTO payout_requests (
        payout_id,
        conversation_key,
        phone_key,
        phone_number,
        whatsapp_jid,
        linked_remote_user_id,
        linked_username,
        destination_account,
        amount_text,
        amount_value,
        amount_cents,
        receipt_format,
        callback_url,
        status,
        is_successful,
        cvu_pago,
        source,
        receipt_content_type,
        receipt_local_path,
        receipt_preview_text,
        esmeralda_debit_applied,
        esmeralda_debit_applied_at,
        last_polled_at,
        success_notified_at,
        failure_notified_at,
        last_error,
        raw_request_json,
        raw_status_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(payout_id) DO UPDATE SET
        conversation_key = COALESCE(excluded.conversation_key, payout_requests.conversation_key),
        phone_key = COALESCE(excluded.phone_key, payout_requests.phone_key),
        phone_number = COALESCE(excluded.phone_number, payout_requests.phone_number),
        whatsapp_jid = COALESCE(excluded.whatsapp_jid, payout_requests.whatsapp_jid),
        linked_remote_user_id = COALESCE(excluded.linked_remote_user_id, payout_requests.linked_remote_user_id),
        linked_username = COALESCE(excluded.linked_username, payout_requests.linked_username),
        destination_account = COALESCE(excluded.destination_account, payout_requests.destination_account),
        amount_text = COALESCE(excluded.amount_text, payout_requests.amount_text),
        amount_value = COALESCE(excluded.amount_value, payout_requests.amount_value),
        amount_cents = COALESCE(excluded.amount_cents, payout_requests.amount_cents),
        receipt_format = COALESCE(excluded.receipt_format, payout_requests.receipt_format),
        callback_url = COALESCE(excluded.callback_url, payout_requests.callback_url),
        status = COALESCE(excluded.status, payout_requests.status),
        is_successful = COALESCE(excluded.is_successful, payout_requests.is_successful),
        cvu_pago = COALESCE(excluded.cvu_pago, payout_requests.cvu_pago),
        source = COALESCE(excluded.source, payout_requests.source),
        receipt_content_type = COALESCE(excluded.receipt_content_type, payout_requests.receipt_content_type),
        receipt_local_path = COALESCE(excluded.receipt_local_path, payout_requests.receipt_local_path),
        receipt_preview_text = COALESCE(excluded.receipt_preview_text, payout_requests.receipt_preview_text),
        esmeralda_debit_applied = COALESCE(excluded.esmeralda_debit_applied, payout_requests.esmeralda_debit_applied),
        esmeralda_debit_applied_at = COALESCE(excluded.esmeralda_debit_applied_at, payout_requests.esmeralda_debit_applied_at),
        last_polled_at = COALESCE(excluded.last_polled_at, payout_requests.last_polled_at),
        success_notified_at = COALESCE(excluded.success_notified_at, payout_requests.success_notified_at),
        failure_notified_at = COALESCE(excluded.failure_notified_at, payout_requests.failure_notified_at),
        last_error = COALESCE(excluded.last_error, payout_requests.last_error),
        raw_request_json = COALESCE(excluded.raw_request_json, payout_requests.raw_request_json),
        raw_status_json = COALESCE(excluded.raw_status_json, payout_requests.raw_status_json),
        updated_at = excluded.updated_at
    `);

    try {
      statement.run([
        String(entry.payoutId || '').trim(),
        entry.conversationKey ? String(entry.conversationKey).trim() : null,
        entry.phoneKey ? String(entry.phoneKey).trim() : null,
        entry.phoneNumber ? String(entry.phoneNumber).trim() : null,
        entry.whatsappJid ? String(entry.whatsappJid).trim() : null,
        entry.linkedRemoteUserId ? String(entry.linkedRemoteUserId).trim() : null,
        entry.linkedUsername ? String(entry.linkedUsername).trim() : null,
        entry.destinationAccount ? String(entry.destinationAccount).trim() : null,
        entry.amountText ? String(entry.amountText).trim() : null,
        amount.amountValue,
        amount.amountCents,
        entry.receiptFormat ? String(entry.receiptFormat).trim() : null,
        entry.callbackUrl ? String(entry.callbackUrl).trim() : null,
        entry.status ? String(entry.status).trim() : null,
        entry.isSuccessful === true
          ? 1
          : entry.isSuccessful === false
          ? 0
          : null,
        entry.cvuPago ? String(entry.cvuPago).trim() : null,
        entry.source ? String(entry.source).trim() : null,
        entry.receiptContentType ? String(entry.receiptContentType).trim() : null,
        entry.receiptLocalPath ? String(entry.receiptLocalPath).trim() : null,
        truncateText(entry.receiptPreviewText, 1000),
        Number.isInteger(entry.esmeraldaDebitApplied)
          ? entry.esmeraldaDebitApplied
          : entry.esmeraldaDebitApplied === true
          ? 1
          : entry.esmeraldaDebitApplied === false
          ? 0
          : 0,
        entry.esmeraldaDebitAppliedAt ? String(entry.esmeraldaDebitAppliedAt).trim() : null,
        entry.lastPolledAt ? String(entry.lastPolledAt).trim() : null,
        entry.successNotifiedAt ? String(entry.successNotifiedAt).trim() : null,
        entry.failureNotifiedAt ? String(entry.failureNotifiedAt).trim() : null,
        truncateText(entry.lastError, 500),
        serializeRawPayload(entry.rawRequest),
        serializeRawPayload(entry.rawStatus),
        createdAt,
        updatedAt,
      ]);
    } finally {
      statement.free();
    }

    await saveDatabase(db, resolvedDbPath);

    return findPayOutRequestById(entry.payoutId, { dbPath: resolvedDbPath });
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function findPayOutRequestById(payoutId, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const row = queryOne(
      db,
      `
        SELECT *
        FROM payout_requests
        WHERE payout_id = ?
        LIMIT 1
      `,
      [String(payoutId || '').trim()],
    );

    return {
      dbPath: resolvedDbPath,
      row,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function findLatestConversationPayOut(conversationKey, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);
  const normalizedConversationKey = String(conversationKey || '').trim();
  const statuses = Array.isArray(options.statuses)
    ? options.statuses.filter((value) => typeof value === 'string' && value.trim())
    : [];

  try {
    const whereStatusClause = statuses.length
      ? `AND status IN (${statuses.map(() => '?').join(', ')})`
      : '';
    const params = [normalizedConversationKey, ...statuses];
    const row = queryOne(
      db,
      `
        SELECT *
        FROM payout_requests
        WHERE conversation_key = ?
        ${whereStatusClause}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `,
      params,
    );

    return {
      dbPath: resolvedDbPath,
      row,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function listPendingPayOutRequests(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const limit = Number.isInteger(options.limit) ? options.limit : 50;
    const rows = queryAll(
      db,
      `
        SELECT *
        FROM payout_requests
        WHERE status = 'PENDING'
        ORDER BY updated_at ASC, created_at ASC
        LIMIT ?
      `,
      [limit],
    );

    return {
      dbPath: resolvedDbPath,
      rows,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function listPayOutRequestsNeedingSuccessNotification(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const limit = Number.isInteger(options.limit) ? options.limit : 25;
    const rows = queryAll(
      db,
      `
        SELECT *
        FROM payout_requests
        WHERE status = 'COMPLETED'
          AND COALESCE(is_successful, 1) = 1
          AND COALESCE(esmeralda_debit_applied, 0) = 1
          AND success_notified_at IS NULL
          AND conversation_key IS NOT NULL
        ORDER BY esmeralda_debit_applied_at ASC, updated_at ASC, created_at ASC
        LIMIT ?
      `,
      [limit],
    );

    return {
      dbPath: resolvedDbPath,
      rows,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function listPayOutRequestsNeedingFailureNotification(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const limit = Number.isInteger(options.limit) ? options.limit : 25;
    const rows = queryAll(
      db,
      `
        SELECT *
        FROM payout_requests
        WHERE (
            status = 'FAILED'
            OR (status = 'COMPLETED' AND COALESCE(is_successful, 1) = 0)
          )
          AND failure_notified_at IS NULL
          AND conversation_key IS NOT NULL
        ORDER BY updated_at ASC, created_at ASC
        LIMIT ?
      `,
      [limit],
    );

    return {
      dbPath: resolvedDbPath,
      rows,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function markPayOutSuccessNotified(
  payoutId,
  notifiedAt = new Date().toISOString(),
  options = {},
) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    db.run(
      `
        UPDATE payout_requests
        SET success_notified_at = ?,
            updated_at = ?
        WHERE payout_id = ?
      `,
      [notifiedAt, notifiedAt, String(payoutId || '').trim()],
    );

    await saveDatabase(db, resolvedDbPath);

    return {
      dbPath: resolvedDbPath,
      payoutId: String(payoutId || '').trim(),
      notifiedAt,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function markPayOutFailureNotified(
  payoutId,
  notifiedAt = new Date().toISOString(),
  options = {},
) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    db.run(
      `
        UPDATE payout_requests
        SET failure_notified_at = ?,
            updated_at = ?
        WHERE payout_id = ?
      `,
      [notifiedAt, notifiedAt, String(payoutId || '').trim()],
    );

    await saveDatabase(db, resolvedDbPath);

    return {
      dbPath: resolvedDbPath,
      payoutId: String(payoutId || '').trim(),
      notifiedAt,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function getPendingPayOutReservedAmount(filters = {}, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);
  const identifierFilter = buildIdentifierFilter({
    remoteUserId: filters.remoteUserId,
    username: filters.username,
    phoneKey: filters.phoneKey,
    remoteColumn: 'linked_remote_user_id',
    usernameColumn: 'linked_username',
    phoneColumn: 'phone_key',
  });

  try {
    const row = queryOne(
      db,
      `
        SELECT COALESCE(SUM(amount_value), 0) AS reserved_total
        FROM payout_requests
        WHERE ${identifierFilter.clause}
          AND status = 'PENDING'
          AND COALESCE(esmeralda_debit_applied, 0) = 0
      `,
      identifierFilter.params,
    );

    return {
      dbPath: resolvedDbPath,
      reservedTotal: Number(row?.reserved_total || 0),
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function storePayOutCallbackEvent(entry, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);
  const createdAt = entry.createdAt || new Date().toISOString();
  const updatedAt = entry.updatedAt || createdAt;
  const amount = parseMoneyText(entry.amountText ?? entry.amount);

  try {
    const statement = db.prepare(`
      INSERT INTO payout_callback_events (
        event_id,
        payout_id,
        event_type,
        conversation_key,
        phone_key,
        linked_remote_user_id,
        linked_username,
        http_headers_json,
        raw_payload_json,
        receipt_content_type,
        receipt_local_path,
        amount_text,
        amount_value,
        amount_cents,
        processed_success,
        processing_note,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        payout_id = COALESCE(excluded.payout_id, payout_callback_events.payout_id),
        event_type = COALESCE(excluded.event_type, payout_callback_events.event_type),
        conversation_key = COALESCE(excluded.conversation_key, payout_callback_events.conversation_key),
        phone_key = COALESCE(excluded.phone_key, payout_callback_events.phone_key),
        linked_remote_user_id = COALESCE(excluded.linked_remote_user_id, payout_callback_events.linked_remote_user_id),
        linked_username = COALESCE(excluded.linked_username, payout_callback_events.linked_username),
        http_headers_json = COALESCE(excluded.http_headers_json, payout_callback_events.http_headers_json),
        raw_payload_json = COALESCE(excluded.raw_payload_json, payout_callback_events.raw_payload_json),
        receipt_content_type = COALESCE(excluded.receipt_content_type, payout_callback_events.receipt_content_type),
        receipt_local_path = COALESCE(excluded.receipt_local_path, payout_callback_events.receipt_local_path),
        amount_text = COALESCE(excluded.amount_text, payout_callback_events.amount_text),
        amount_value = COALESCE(excluded.amount_value, payout_callback_events.amount_value),
        amount_cents = COALESCE(excluded.amount_cents, payout_callback_events.amount_cents),
        processed_success = COALESCE(excluded.processed_success, payout_callback_events.processed_success),
        processing_note = COALESCE(excluded.processing_note, payout_callback_events.processing_note),
        updated_at = excluded.updated_at
    `);

    try {
      statement.run([
        String(entry.eventId || crypto.randomUUID()),
        entry.payoutId ? String(entry.payoutId).trim() : null,
        entry.eventType ? String(entry.eventType).trim() : null,
        entry.conversationKey ? String(entry.conversationKey).trim() : null,
        entry.phoneKey ? String(entry.phoneKey).trim() : null,
        entry.linkedRemoteUserId ? String(entry.linkedRemoteUserId).trim() : null,
        entry.linkedUsername ? String(entry.linkedUsername).trim() : null,
        serializeRawPayload(entry.httpHeaders),
        serializeRawPayload(entry.rawPayload),
        entry.receiptContentType ? String(entry.receiptContentType).trim() : null,
        entry.receiptLocalPath ? String(entry.receiptLocalPath).trim() : null,
        entry.amountText ? String(entry.amountText).trim() : null,
        amount.amountValue,
        amount.amountCents,
        entry.processedSuccess === true
          ? 1
          : entry.processedSuccess === false
          ? 0
          : null,
        truncateText(entry.processingNote, 600),
        createdAt,
        updatedAt,
      ]);
    } finally {
      statement.free();
    }

    await saveDatabase(db, resolvedDbPath);

    return {
      dbPath: resolvedDbPath,
      eventId: String(entry.eventId || ''),
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function getConversationPaymentSnapshot(conversationKey, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);
  const normalizedConversationKey = String(conversationKey || '').trim();

  try {
    const activeCashIn = queryOne(
      db,
      `
        SELECT
          request_id,
          payer_cuit,
          payer_name,
          expected_amount_text,
          expected_amount_value,
          currency,
          cvu,
          alias,
          holder_name,
          status,
          expires_at,
          matched_at,
          cashin_id,
          credit_applied,
          credit_applied_at,
          updated_at
        FROM cashin_requests
        WHERE conversation_key = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `,
      [normalizedConversationKey],
    );

    const activePayOut = queryOne(
      db,
      `
        SELECT
          payout_id,
          destination_account,
          amount_text,
          amount_value,
          receipt_format,
          status,
          is_successful,
          cvu_pago,
          esmeralda_debit_applied,
          esmeralda_debit_applied_at,
          updated_at
        FROM payout_requests
        WHERE conversation_key = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `,
      [normalizedConversationKey],
    );

    return {
      dbPath: resolvedDbPath,
      activeCashIn: activeCashIn
        ? {
            requestId: activeCashIn.request_id,
            payerCuit: activeCashIn.payer_cuit,
            payerName: activeCashIn.payer_name || null,
            expectedAmountText: activeCashIn.expected_amount_text || null,
            expectedAmountValue: activeCashIn.expected_amount_value ?? null,
            currency: activeCashIn.currency || null,
            cvu: activeCashIn.cvu || null,
            alias: activeCashIn.alias || null,
            holderName: activeCashIn.holder_name || null,
            status: activeCashIn.status || null,
            expiresAt: activeCashIn.expires_at || null,
            matchedAt: activeCashIn.matched_at || null,
            cashInId: activeCashIn.cashin_id || null,
            creditApplied: Boolean(Number(activeCashIn.credit_applied || 0)),
            creditAppliedAt: activeCashIn.credit_applied_at || null,
            updatedAt: activeCashIn.updated_at || null,
          }
        : null,
      activePayOut: activePayOut
        ? {
            payoutId: activePayOut.payout_id,
            destinationAccount: activePayOut.destination_account || null,
            amountText: activePayOut.amount_text || null,
            amountValue: activePayOut.amount_value ?? null,
            receiptFormat: activePayOut.receipt_format || null,
            status: activePayOut.status || null,
            isSuccessful:
              activePayOut.is_successful === null ||
              activePayOut.is_successful === undefined
                ? null
                : Boolean(Number(activePayOut.is_successful)),
            cvuPago: activePayOut.cvu_pago || null,
            esmeraldaDebitApplied: Boolean(
              Number(activePayOut.esmeralda_debit_applied || 0),
            ),
            esmeraldaDebitAppliedAt:
              activePayOut.esmeralda_debit_applied_at || null,
            updatedAt: activePayOut.updated_at || null,
          }
        : null,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function getWhatsAppDashboardMetrics(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const now = Date.now();
    const activeSince = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    const totals = queryOne(
      db,
      `
        SELECT
          (SELECT COUNT(*) FROM whatsapp_conversations) AS total_conversations,
          (SELECT COUNT(*) FROM whatsapp_messages) AS total_messages,
          (SELECT COUNT(*) FROM whatsapp_messages WHERE direction = 'incoming') AS incoming_messages,
          (SELECT COUNT(*) FROM whatsapp_messages WHERE direction = 'outgoing') AS outgoing_messages,
          (SELECT COUNT(*) FROM whatsapp_contacts WHERE linked_username IS NOT NULL OR linked_remote_user_id IS NOT NULL) AS linked_contacts,
          (SELECT COUNT(*) FROM whatsapp_conversations WHERE last_message_at >= ?) AS active_conversations_24h,
          (SELECT COUNT(*) FROM whatsapp_conversation_controls WHERE bot_paused = 1) AS paused_conversations
      `,
      [activeSince],
    );

    const settingsRows = queryAll(
      db,
      `
        SELECT setting_key, setting_value, updated_at
        FROM bot_runtime_settings
        WHERE setting_key IN ('global_bot_paused', 'global_bot_pause_reason', 'global_bot_paused_at')
      `,
    );
    const runtimeState = normalizeRuntimeState(
      buildSettingsMap(settingsRows),
      Number(totals?.paused_conversations || 0),
    );

    return {
      dbPath: resolvedDbPath,
      totalConversations: Number(totals?.total_conversations || 0),
      totalMessages: Number(totals?.total_messages || 0),
      incomingMessages: Number(totals?.incoming_messages || 0),
      outgoingMessages: Number(totals?.outgoing_messages || 0),
      linkedContacts: Number(totals?.linked_contacts || 0),
      activeConversations24h: Number(totals?.active_conversations_24h || 0),
      pausedConversations: Number(totals?.paused_conversations || 0),
      globalPause: runtimeState.globalPause,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function listWhatsAppConversations(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const limit = Number.isInteger(options.limit) ? options.limit : 50;
    const search = String(options.search || '').trim();
    const searchClause = search
      ? `
        WHERE
          lower(COALESCE(wc.linked_username, '')) LIKE lower(?)
          OR lower(COALESCE(wc.phone_number, '')) LIKE lower(?)
          OR lower(COALESCE(wc.push_name, '')) LIKE lower(?)
          OR lower(COALESCE(wc.whatsapp_jid, '')) LIKE lower(?)
      `
      : '';
    const params = search
      ? Array(4).fill(`%${search}%`).concat([limit])
      : [limit];

    const rows = queryAll(
      db,
      `
        SELECT
          wc.conversation_key,
          wc.phone_key,
          wc.phone_number,
          wc.whatsapp_jid,
          wc.push_name,
          wc.linked_remote_user_id,
          wc.linked_username,
          wc.last_incoming_text,
          wc.last_outgoing_text,
          wc.last_message_at,
          wc.last_message_direction,
          wc.total_messages,
          wc.created_at,
          wc.updated_at,
          COALESCE(ctrl.bot_paused, 0) AS bot_paused,
          ctrl.pause_reason,
          ctrl.paused_at
        FROM whatsapp_conversations wc
        LEFT JOIN whatsapp_conversation_controls ctrl
          ON ctrl.conversation_key = wc.conversation_key
        ${searchClause}
        ORDER BY wc.last_message_at DESC
        LIMIT ?
      `,
      params,
    );

    return {
      dbPath: resolvedDbPath,
      rows,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function getWhatsAppConversationDetail(conversationKey, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const conversation = queryOne(
      db,
      `
        SELECT
          wc.conversation_key,
          wc.phone_key,
          wc.phone_number,
          wc.whatsapp_jid,
          wc.push_name,
          wc.linked_remote_user_id,
          wc.linked_username,
          wc.last_incoming_text,
          wc.last_outgoing_text,
          wc.last_message_at,
          wc.last_message_direction,
          wc.total_messages,
          wc.created_at,
          wc.updated_at,
          COALESCE(ctrl.bot_paused, 0) AS bot_paused,
          ctrl.pause_reason,
          ctrl.paused_at
        FROM whatsapp_conversations wc
        LEFT JOIN whatsapp_conversation_controls ctrl
          ON ctrl.conversation_key = wc.conversation_key
        WHERE wc.conversation_key = ?
        LIMIT 1
      `,
      [conversationKey],
    );

    const limit = Number.isInteger(options.limit) ? options.limit : 250;
    const messages = queryAll(
      db,
      `
        SELECT
          message_key,
          conversation_key,
          phone_key,
          phone_number,
          whatsapp_jid,
          push_name,
          linked_remote_user_id,
          linked_username,
          direction,
          sender_role,
          message_type,
          text,
          created_at
        FROM whatsapp_messages
        WHERE conversation_key = ?
        ORDER BY created_at ASC
        LIMIT ?
      `,
      [conversationKey, limit],
    );

    return {
      dbPath: resolvedDbPath,
      conversation,
      messages,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function getConversationUserActivity(conversationKey, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const conversation = queryOne(
      db,
      `
        SELECT
          conversation_key,
          phone_key,
          phone_number,
          whatsapp_jid,
          push_name,
          linked_remote_user_id,
          linked_username,
          total_messages,
          last_message_at
        FROM whatsapp_conversations
        WHERE conversation_key = ?
        LIMIT 1
      `,
      [String(conversationKey || '').trim()],
    );

    if (!conversation) {
      return {
        dbPath: resolvedDbPath,
        conversation: null,
        user: null,
        summary: null,
        operations: [],
        timeline: [],
      };
    }

    const remoteUserId = conversation.linked_remote_user_id || null;
    const username = conversation.linked_username || null;
    const phoneKey = conversation.phone_key || null;

    const currentUser = remoteUserId
      ? queryOne(
          db,
          `
            SELECT
              remote_user_id,
              username,
              balance_text,
              balance_amount,
              balance_cents,
              user_type,
              synced_at
            FROM esmeralda_users
            WHERE remote_user_id = ?
            LIMIT 1
          `,
          [String(remoteUserId)],
        )
      : username
      ? queryOne(
          db,
          `
            SELECT
              remote_user_id,
              username,
              balance_text,
              balance_amount,
              balance_cents,
              user_type,
              synced_at
            FROM esmeralda_users
            WHERE lower(username) = lower(?)
            LIMIT 1
          `,
          [String(username)],
        )
      : null;

    const operationsFilter = buildIdentifierFilter({
      remoteUserId,
      username,
      phoneKey,
      remoteColumn: 'target_remote_user_id',
      usernameColumn: 'target_username',
      phoneColumn: 'phone_key',
    });
    const messagesFilter = buildIdentifierFilter({
      remoteUserId,
      username,
      phoneKey,
      remoteColumn: 'linked_remote_user_id',
      usernameColumn: 'linked_username',
      phoneColumn: 'phone_key',
    });

    const summaryRow = queryOne(
      db,
      `
        SELECT
          COUNT(*) AS total_operations,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful_operations,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed_operations,
          SUM(CASE WHEN operation_type = 'create_user' AND success = 1 THEN 1 ELSE 0 END) AS created_count,
          SUM(CASE WHEN operation_type = 'add_credit' AND success = 1 THEN 1 ELSE 0 END) AS add_credit_count,
          COALESCE(SUM(CASE WHEN operation_type = 'add_credit' AND success = 1 THEN amount_value ELSE 0 END), 0) AS add_credit_total,
          SUM(CASE WHEN operation_type = 'deduct_credit' AND success = 1 THEN 1 ELSE 0 END) AS deduct_credit_count,
          COALESCE(SUM(CASE WHEN operation_type = 'deduct_credit' AND success = 1 THEN amount_value ELSE 0 END), 0) AS deduct_credit_total,
          SUM(CASE WHEN operation_type = 'change_password' AND success = 1 THEN 1 ELSE 0 END) AS change_password_count,
          SUM(CASE WHEN operation_type = 'lock_user' AND success = 1 THEN 1 ELSE 0 END) AS lock_user_count,
          MAX(created_at) AS last_operation_at
        FROM esmeralda_operation_logs
        WHERE ${operationsFilter.clause}
      `,
      operationsFilter.params,
    );

    const messagesSummaryRow = queryOne(
      db,
      `
        SELECT
          COUNT(*) AS total_messages,
          SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) AS incoming_messages,
          SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) AS outgoing_messages,
          MAX(created_at) AS last_message_at
        FROM whatsapp_messages
        WHERE ${messagesFilter.clause}
      `,
      messagesFilter.params,
    );

    const operations = queryAll(
      db,
      `
        SELECT
          operation_id,
          operation_type,
          endpoint,
          http_method,
          target_remote_user_id,
          target_username,
          target_user_type,
          phone_key,
          phone_number,
          whatsapp_jid,
          conversation_key,
          actor_push_name,
          amount_text,
          amount_value,
          amount_cents,
          balance_text,
          success,
          response_status,
          error_message,
          response_excerpt,
          metadata_json,
          created_at
        FROM esmeralda_operation_logs
        WHERE ${operationsFilter.clause}
        ORDER BY created_at DESC
        LIMIT ?
      `,
      operationsFilter.params.concat([
        Number.isInteger(options.operationsLimit) ? options.operationsLimit : 80,
      ]),
    );

    const relatedMessages = queryAll(
      db,
      `
        SELECT
          message_key,
          conversation_key,
          phone_key,
          phone_number,
          whatsapp_jid,
          push_name,
          linked_remote_user_id,
          linked_username,
          direction,
          sender_role,
          message_type,
          text,
          created_at
        FROM whatsapp_messages
        WHERE ${messagesFilter.clause}
        ORDER BY created_at DESC
        LIMIT ?
      `,
      messagesFilter.params.concat([
        Number.isInteger(options.messagesLimit) ? options.messagesLimit : 80,
      ]),
    );

    const timeline = [
      ...operations.map((operation) => ({
        item_type: 'operation',
        sort_at: operation.created_at,
        data: operation,
      })),
      ...relatedMessages.map((message) => ({
        item_type: 'message',
        sort_at: message.created_at,
        data: message,
      })),
    ]
      .sort((left, right) => String(right.sort_at).localeCompare(String(left.sort_at)))
      .slice(0, Number.isInteger(options.timelineLimit) ? options.timelineLimit : 120);

    return {
      dbPath: resolvedDbPath,
      conversation,
      user: {
        remoteUserId: currentUser?.remote_user_id || remoteUserId,
        username: currentUser?.username || username,
        balanceText: currentUser?.balance_text || null,
        balanceAmount: currentUser?.balance_amount ?? null,
        balanceCents: currentUser?.balance_cents ?? null,
        userType: currentUser?.user_type || null,
        syncedAt: currentUser?.synced_at || null,
        phoneKey,
        phoneNumber: conversation.phone_number || null,
      },
      summary: {
        totalOperations: Number(summaryRow?.total_operations || 0),
        successfulOperations: Number(summaryRow?.successful_operations || 0),
        failedOperations: Number(summaryRow?.failed_operations || 0),
        createdCount: Number(summaryRow?.created_count || 0),
        addCreditCount: Number(summaryRow?.add_credit_count || 0),
        addCreditTotal: Number(summaryRow?.add_credit_total || 0),
        deductCreditCount: Number(summaryRow?.deduct_credit_count || 0),
        deductCreditTotal: Number(summaryRow?.deduct_credit_total || 0),
        netCreditTotal:
          Number(summaryRow?.add_credit_total || 0) -
          Number(summaryRow?.deduct_credit_total || 0),
        changePasswordCount: Number(summaryRow?.change_password_count || 0),
        lockUserCount: Number(summaryRow?.lock_user_count || 0),
        lastOperationAt: summaryRow?.last_operation_at || null,
        totalMessages: Number(messagesSummaryRow?.total_messages || 0),
        incomingMessages: Number(messagesSummaryRow?.incoming_messages || 0),
        outgoingMessages: Number(messagesSummaryRow?.outgoing_messages || 0),
        lastMessageAt: messagesSummaryRow?.last_message_at || null,
      },
      operations,
      timeline,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function deleteWhatsAppConversation(conversationKey, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);
  const normalizedConversationKey = String(conversationKey || '').trim();

  try {
    if (!normalizedConversationKey) {
      throw new Error('Falta conversationKey para eliminar la conversacion');
    }

    const existingConversation = queryOne(
      db,
      `
        SELECT
          conversation_key,
          linked_username,
          phone_number,
          whatsapp_jid
        FROM whatsapp_conversations
        WHERE conversation_key = ?
        LIMIT 1
      `,
      [normalizedConversationKey],
    );

    if (!existingConversation) {
      return {
        dbPath: resolvedDbPath,
        deleted: false,
        conversationKey: normalizedConversationKey,
        deletedMessages: 0,
        deletedControls: 0,
        deletedOperations: 0,
        deletedConversation: 0,
      };
    }

    const messageCountRow = queryOne(
      db,
      `
        SELECT COUNT(*) AS total
        FROM whatsapp_messages
        WHERE conversation_key = ?
      `,
      [normalizedConversationKey],
    );
    const controlCountRow = queryOne(
      db,
      `
        SELECT COUNT(*) AS total
        FROM whatsapp_conversation_controls
        WHERE conversation_key = ?
      `,
      [normalizedConversationKey],
    );
    const operationCountRow = queryOne(
      db,
      `
        SELECT COUNT(*) AS total
        FROM esmeralda_operation_logs
        WHERE conversation_key = ?
      `,
      [normalizedConversationKey],
    );
    const cashInCountRow = queryOne(
      db,
      `
        SELECT COUNT(*) AS total
        FROM cashin_requests
        WHERE conversation_key = ?
      `,
      [normalizedConversationKey],
    );
    const cashInCallbackCountRow = queryOne(
      db,
      `
        SELECT COUNT(*) AS total
        FROM cashin_callback_events
        WHERE conversation_key = ?
      `,
      [normalizedConversationKey],
    );
    const payoutCountRow = queryOne(
      db,
      `
        SELECT COUNT(*) AS total
        FROM payout_requests
        WHERE conversation_key = ?
      `,
      [normalizedConversationKey],
    );
    const payoutCallbackCountRow = queryOne(
      db,
      `
        SELECT COUNT(*) AS total
        FROM payout_callback_events
        WHERE conversation_key = ?
      `,
      [normalizedConversationKey],
    );

    db.run('BEGIN');

    db.run('DELETE FROM whatsapp_messages WHERE conversation_key = ?', [
      normalizedConversationKey,
    ]);
    db.run('DELETE FROM whatsapp_conversation_controls WHERE conversation_key = ?', [
      normalizedConversationKey,
    ]);
    db.run('DELETE FROM esmeralda_operation_logs WHERE conversation_key = ?', [
      normalizedConversationKey,
    ]);
    db.run('DELETE FROM cashin_callback_events WHERE conversation_key = ?', [
      normalizedConversationKey,
    ]);
    db.run('DELETE FROM cashin_requests WHERE conversation_key = ?', [
      normalizedConversationKey,
    ]);
    db.run('DELETE FROM payout_callback_events WHERE conversation_key = ?', [
      normalizedConversationKey,
    ]);
    db.run('DELETE FROM payout_requests WHERE conversation_key = ?', [
      normalizedConversationKey,
    ]);
    db.run('DELETE FROM whatsapp_conversations WHERE conversation_key = ?', [
      normalizedConversationKey,
    ]);

    db.run('COMMIT');
    await saveDatabase(db, resolvedDbPath);

    return {
      dbPath: resolvedDbPath,
      deleted: true,
      conversationKey: normalizedConversationKey,
      deletedMessages: Number(messageCountRow?.total || 0),
      deletedControls: Number(controlCountRow?.total || 0),
      deletedOperations: Number(operationCountRow?.total || 0),
      deletedCashInRequests: Number(cashInCountRow?.total || 0),
      deletedCashInCallbacks: Number(cashInCallbackCountRow?.total || 0),
      deletedPayOutRequests: Number(payoutCountRow?.total || 0),
      deletedPayOutCallbacks: Number(payoutCallbackCountRow?.total || 0),
      deletedConversation: 1,
      conversation: existingConversation,
    };
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch {}

    throw error;
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export function getEsmeraldaDbPath(options = {}) {
  return getResolvedDbPath(options.dbPath);
}

export async function getBotRuntimeState(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const settingsRows = queryAll(
      db,
      `
        SELECT setting_key, setting_value, updated_at
        FROM bot_runtime_settings
      `,
    );
    const pausedConversationRow = queryOne(
      db,
      `
        SELECT COUNT(*) AS paused_conversations
        FROM whatsapp_conversation_controls
        WHERE bot_paused = 1
      `,
    );

    return {
      dbPath: resolvedDbPath,
      ...normalizeRuntimeState(
        buildSettingsMap(settingsRows),
        Number(pausedConversationRow?.paused_conversations || 0),
      ),
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function updateBotAiRules(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    db.run('BEGIN');

    upsertSettings(db, [
      {
        key: 'ai_runtime_rules',
        value: String(options.rulesText || ''),
        updatedAt: new Date().toISOString(),
      },
    ]);

    db.run('COMMIT');
    await saveDatabase(db, resolvedDbPath);

    return getBotRuntimeState({ dbPath: resolvedDbPath });
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch {}

    throw error;
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function updateBotPromptSettings(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);
  const updatedAt = new Date().toISOString();

  try {
    db.run('BEGIN');

    upsertSettings(db, [
      {
        key: 'casino_agent_system_prompt',
        value: String(options.agentSystemPrompt || ''),
        updatedAt,
      },
      {
        key: 'casino_action_system_prompt',
        value: String(options.actionSystemPrompt || ''),
        updatedAt,
      },
    ]);

    db.run('COMMIT');
    await saveDatabase(db, resolvedDbPath);

    return getBotRuntimeState({ dbPath: resolvedDbPath });
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch {}

    throw error;
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function setGlobalBotPaused(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);
  const paused = Boolean(options.paused);
  const updatedAt = new Date().toISOString();

  try {
    db.run('BEGIN');

    upsertSettings(db, [
      {
        key: 'global_bot_paused',
        value: paused ? '1' : '0',
        updatedAt,
      },
      {
        key: 'global_bot_pause_reason',
        value: paused ? String(options.reason || '') : '',
        updatedAt,
      },
      {
        key: 'global_bot_paused_at',
        value: paused ? updatedAt : '',
        updatedAt,
      },
    ]);

    db.run('COMMIT');
    await saveDatabase(db, resolvedDbPath);

    return getBotRuntimeState({ dbPath: resolvedDbPath });
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch {}

    throw error;
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function getConversationBotControl(conversationKey, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const row = queryOne(
      db,
      `
        SELECT
          conversation_key,
          bot_paused,
          pause_reason,
          paused_at,
          updated_at
        FROM whatsapp_conversation_controls
        WHERE conversation_key = ?
        LIMIT 1
      `,
      [String(conversationKey || '').trim()],
    );

    return {
      dbPath: resolvedDbPath,
      control: normalizeConversationControl(row, conversationKey),
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function setConversationBotPaused(options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);
  const updatedAt = new Date().toISOString();
  const paused = Boolean(options.paused);
  const conversationKey = String(options.conversationKey || '').trim();

  try {
    if (!conversationKey) {
      throw new Error('Falta conversationKey para actualizar la pausa del chat');
    }

    db.run('BEGIN');

    const statement = db.prepare(`
      INSERT INTO whatsapp_conversation_controls (
        conversation_key,
        bot_paused,
        pause_reason,
        paused_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET
        bot_paused = excluded.bot_paused,
        pause_reason = excluded.pause_reason,
        paused_at = excluded.paused_at,
        updated_at = excluded.updated_at
    `);

    try {
      statement.run([
        conversationKey,
        paused ? 1 : 0,
        paused ? String(options.reason || '') : null,
        paused ? updatedAt : null,
        updatedAt,
      ]);
    } finally {
      statement.free();
    }

    db.run('COMMIT');
    await saveDatabase(db, resolvedDbPath);

    return getConversationBotControl(conversationKey, { dbPath: resolvedDbPath });
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch {}

    throw error;
  } finally {
    await closeDatabase(db, releaseLock);
  }
}

export async function getBotExecutionState(conversationKey, options = {}) {
  const { db, resolvedDbPath, releaseLock } = await openDatabase(options.dbPath);

  try {
    const settingsRows = queryAll(
      db,
      `
        SELECT setting_key, setting_value, updated_at
        FROM bot_runtime_settings
        WHERE setting_key IN (
          'global_bot_paused',
          'global_bot_pause_reason',
          'global_bot_paused_at'
        )
      `,
    );
    const controlRow = conversationKey
      ? queryOne(
          db,
          `
            SELECT
              conversation_key,
              bot_paused,
              pause_reason,
              paused_at,
              updated_at
            FROM whatsapp_conversation_controls
            WHERE conversation_key = ?
            LIMIT 1
          `,
          [String(conversationKey).trim()],
        )
      : null;

    const runtimeState = normalizeRuntimeState(buildSettingsMap(settingsRows), 0);
    const conversationPause = normalizeConversationControl(controlRow, conversationKey);

    return {
      dbPath: resolvedDbPath,
      paused: runtimeState.globalPause.paused || conversationPause.paused,
      globalPause: runtimeState.globalPause,
      conversationPause,
    };
  } finally {
    await closeDatabase(db, releaseLock);
  }
}
