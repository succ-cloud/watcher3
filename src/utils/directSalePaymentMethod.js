const {
  DEFAULT_TRANSACTION_METHODS,
  ensureDefaultTransactionMethods,
  listActiveTransactionMethods,
  normalizeTransactionMethodKey,
} = require('./transactionMethods');

const LEGACY_ALIASES = new Map([
  ['mobile money', 'momo'],
  ['bank_transfer', 'bank transfer'],
  ['bank-transfer', 'bank transfer'],
  ['others', 'other'],
  ['orthers', 'other'],
  ['other payment', 'other'],
  ['other payments', 'other'],
]);

async function normalizeDirectSalePaymentMethod(raw, methods) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '';

  const rows = methods || (await listActiveTransactionMethods());
  const allowed = new Set(rows.map((row) => row.value));

  if (allowed.has(value)) return value;

  const aliasTarget = LEGACY_ALIASES.get(value);
  if (aliasTarget && allowed.has(aliasTarget)) return aliasTarget;

  if (value.startsWith('other')) {
    const other = rows.find((row) => row.value === 'other');
    if (other) return other.value;
  }

  for (const row of rows) {
    if (normalizeTransactionMethodKey(row.name) === value) return row.value;
  }

  return '';
}

async function assertDirectSalePaymentMethod(raw) {
  await ensureDefaultTransactionMethods();
  const method = await normalizeDirectSalePaymentMethod(raw);
  if (!method) {
    const err = new Error('paymentMethod is required and must be a configured transaction method.');
    err.status = 400;
    throw err;
  }
  return method;
}

module.exports = {
  DEFAULT_TRANSACTION_METHODS,
  normalizeDirectSalePaymentMethod,
  assertDirectSalePaymentMethod,
};
