import {
  findWhatsAppContactByPhoneKey,
  linkWhatsAppContactToEsmeraldaUser,
  upsertWhatsAppContact,
} from '../esmeralda/index.js';
import { extractDigits } from './helpers.js';

export function mapIdentityRow(row, fallback = {}) {
  if (!row) {
    return {
      phoneKey: fallback.phoneKey || null,
      phoneNumber: fallback.phoneNumber || null,
      whatsappJid: fallback.whatsappJid || null,
      pushName: fallback.pushName || null,
      linkedUser: null,
    };
  }

  const linkedUser = row.user_remote_user_id
    ? {
        remoteUserId: row.user_remote_user_id,
        username: row.user_username,
        balanceText: row.user_balance_text,
        balanceAmount: row.user_balance_amount,
        balanceCents: row.user_balance_cents,
        unknownValue: row.user_unknown_value,
        userType: row.user_user_type,
        syncedAt: row.user_synced_at,
      }
    : null;

  return {
    phoneKey: row.phone_key,
    phoneNumber: row.phone_number,
    whatsappJid: row.whatsapp_jid,
    pushName: row.push_name || fallback.pushName || null,
    linkedRemoteUserId: row.linked_remote_user_id,
    linkedUsername: row.linked_username,
    linkedUser,
  };
}

export function buildCustomerProfile(identity, paymentContext = {}) {
  return {
    knownCustomer: Boolean(identity.linkedUser),
    linkedUsername: identity.linkedUser?.username || null,
    linkedBalanceText: identity.linkedUser?.balanceText || null,
    phoneNumber: identity.phoneNumber,
    pushName: identity.pushName || null,
    activeCashIn: paymentContext.activeCashIn || null,
    activePayOut: paymentContext.activePayOut || null,
  };
}

export async function resolvePhoneIdentity(sock, remoteJid) {
  const phoneNumberFromJid = extractDigits(String(remoteJid || '').split('@')[0]);
  if (phoneNumberFromJid) {
    return {
      phoneKey: `pn:${phoneNumberFromJid}`,
      phoneNumber: phoneNumberFromJid,
    };
  }

  if (remoteJid?.endsWith('@lid')) {
    const mappedPnJid = await sock.signalRepository.lidMapping
      .getPNForLID(remoteJid)
      .catch(() => null);

    const mappedPhoneNumber = extractDigits(mappedPnJid);
    if (mappedPhoneNumber) {
      return {
        phoneKey: `pn:${mappedPhoneNumber}`,
        phoneNumber: mappedPhoneNumber,
      };
    }

    return {
      phoneKey: `lid:${String(remoteJid).split('@')[0]}`,
      phoneNumber: null,
    };
  }

  return {
    phoneKey: `jid:${remoteJid || 'unknown'}`,
    phoneNumber: null,
  };
}

export async function ensureCustomerIdentity({ sock, remoteJid, pushName }) {
  const phoneIdentity = await resolvePhoneIdentity(sock, remoteJid);
  const storedContact = await upsertWhatsAppContact({
    phoneKey: phoneIdentity.phoneKey,
    phoneNumber: phoneIdentity.phoneNumber,
    whatsappJid: remoteJid,
    pushName,
  });

  return mapIdentityRow(storedContact.row, {
    ...phoneIdentity,
    whatsappJid: remoteJid,
    pushName,
  });
}

export async function refreshIdentity(phoneKey) {
  const result = await findWhatsAppContactByPhoneKey(phoneKey);
  return mapIdentityRow(result.row, { phoneKey });
}

export function getResolvedTargetUsername(identity, pendingAction) {
  if (pendingAction.targetScope === 'explicit' && pendingAction.targetUsername) {
    return pendingAction.targetUsername;
  }

  if (identity.linkedUser?.username) {
    return identity.linkedUser.username;
  }

  return null;
}

export async function maybeLinkIdentityToUser(identity, userInfo) {
  if (!identity.phoneKey || identity.linkedUser) {
    return identity;
  }

  if (!userInfo?.username) {
    return identity;
  }

  await linkWhatsAppContactToEsmeraldaUser({
    phoneKey: identity.phoneKey,
    phoneNumber: identity.phoneNumber,
    whatsappJid: identity.whatsappJid,
    pushName: identity.pushName,
    remoteUserId: userInfo.remoteUserId || null,
    username: userInfo.username,
  });

  return refreshIdentity(identity.phoneKey);
}
