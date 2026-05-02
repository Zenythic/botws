import { isValidAlphanumericPassword } from '../esmeralda/index.js';
import {
  getResolvedTargetUsername,
} from './identity.js';
import {
  parseRequestedAmountNumber,
  normalizeBankAccountNumber,
} from './helpers.js';

function validateCreateAction(pendingAction) {
  if (!pendingAction.createConfirmed) {
    return {
      ready: false,
      replyText:
        pendingAction.createUsernameMode === 'custom'
          ? 'Dale, confirmame que te creo la cuenta y pasame el nombre que quieres usar.'
          : 'Si quieres, te creo un usuario ahora mismo y te paso usuario y clave listos. ¿Te lo creo?',
    };
  }

  if (
    pendingAction.createUsernameMode === 'custom' &&
    !pendingAction.createUsername
  ) {
    return {
      ready: false,
      replyText: 'Pasame solo el usuario que quieres usar y te lo creo.',
    };
  }

  if (pendingAction.createPassword && !isValidAlphanumericPassword(pendingAction.createPassword)) {
    pendingAction.createPassword = null;
    return {
      ready: false,
      replyText:
        'Se me trabo la generacion de la clave. Decime de nuevo y te lo armo.',
    };
  }

  return { ready: true };
}

function validateAddCreditAction(identity, pendingAction) {
  const targetUsername = getResolvedTargetUsername(identity, pendingAction);

  if (!targetUsername) {
    return {
      ready: false,
      replyText: pendingAction.amount
        ? 'Pasame el usuario al que le quieres cargar y te paso el CVU.'
        : 'Pasame el usuario al que le quieres cargar y el monto, y te paso el CVU.',
    };
  }

  if (!pendingAction.amount) {
    return {
      ready: false,
      replyText: 'Decime cuanto queres cargar y te paso el CVU.',
    };
  }

  if (pendingAction.amount) {
    const numericAmount = parseRequestedAmountNumber(pendingAction.amount);
    if (!numericAmount || numericAmount <= 0) {
      pendingAction.amount = null;
      return {
        ready: false,
        replyText: 'Pasame un monto valido para cargar.',
      };
    }
  }

  return {
    ready: true,
    targetUsername,
    amount: pendingAction.amount || null,
    payerCuit: pendingAction.payerCuit || null,
    payerName: pendingAction.payerName || null,
  };
}

function validateDeductCreditAction(identity, pendingAction) {
  const targetUsername = getResolvedTargetUsername(identity, pendingAction);

  if (!targetUsername && !pendingAction.amount && !pendingAction.destinationAccount) {
    return {
      ready: false,
      replyText: 'Decime el usuario, el monto y el CVU o CBU donde quieres recibir el retiro, y te lo reviso.',
    };
  }

  if (!targetUsername) {
    return {
      ready: false,
      replyText: 'Pasame el usuario y sigo con el retiro.',
    };
  }

  if (!pendingAction.amount) {
    return {
      ready: false,
      replyText: 'Decime cuanto queres retirar y sigo con eso.',
    };
  }

  const numericAmount = parseRequestedAmountNumber(pendingAction.amount);
  if (!numericAmount || numericAmount <= 0) {
    pendingAction.amount = null;
    return {
      ready: false,
      replyText: 'Pasame un monto valido para retirar.',
    };
  }

  const destinationAccount = normalizeBankAccountNumber(
    pendingAction.destinationAccount,
  );
  if (!destinationAccount) {
    return {
      ready: false,
      replyText: pendingAction.destinationAliasHint
        ? 'Eso parece un alias. Para retiro necesito el CVU o CBU de 22 digitos.'
        : 'Pasame el CVU o CBU donde quieres cobrar el retiro. Si viene con espacios o guiones tambien me sirve.',
    };
  }

  return {
    ready: true,
    targetUsername,
    amount: pendingAction.amount,
    destinationAccount,
  };
}

function validateChangePasswordAction(identity, pendingAction) {
  const targetUsername = getResolvedTargetUsername(identity, pendingAction);

  if (!targetUsername) {
    return {
      ready: false,
      replyText: 'Pasame el usuario y la clave nueva, y te lo cambio.',
    };
  }

  if (!pendingAction.newPassword) {
    return {
      ready: false,
      replyText: 'Pasame la clave nueva y te la cambio.',
    };
  }

  if (String(pendingAction.newPassword).trim().length < 8) {
    pendingAction.newPassword = null;
    return {
      ready: false,
      replyText: 'La clave nueva tiene que tener minimo 8 caracteres.',
    };
  }

  return {
    ready: true,
    targetUsername,
    newPassword: pendingAction.newPassword,
    logoutAll: pendingAction.logoutAll,
  };
}

function validateLockUserAction(identity, pendingAction) {
  const targetUsername = getResolvedTargetUsername(identity, pendingAction);

  if (!targetUsername) {
    return {
      ready: false,
      replyText: 'Pasame el usuario que queres bloquear y te lo reviso.',
    };
  }

  return {
    ready: true,
    targetUsername,
    reason: pendingAction.reason || '',
  };
}

export function validatePendingAction(identity, state) {
  switch (state.pendingAction.type) {
    case 'create_user':
      return validateCreateAction(state.pendingAction);
    case 'add_credit':
      return validateAddCreditAction(identity, state.pendingAction);
    case 'deduct_credit':
      return validateDeductCreditAction(identity, state.pendingAction);
    case 'change_password':
      return validateChangePasswordAction(identity, state.pendingAction);
    case 'lock_user':
      return validateLockUserAction(identity, state.pendingAction);
    default:
      return { ready: false, replyText: null };
  }
}
