export const MAX_HISTORY_MESSAGES = 20;
export const GENERATED_USERNAME_MIN_LENGTH = 10;
export const GENERATED_PASSWORD_MIN_LENGTH = 9;
export const GENERATED_USERNAME_PREFIXES = [
  'ficha',
  'pleno',
  'carta',
  'suert',
  'juega',
  'rayo',
];
export const ACTION_TYPES = new Set([
  'create_user',
  'add_credit',
  'deduct_credit',
  'change_password',
  'lock_user',
]);
