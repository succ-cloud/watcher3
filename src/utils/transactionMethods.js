const TransactionMethod = require('../models/TransactionMethod');

const DEFAULT_TRANSACTION_METHODS = [
  { name: 'Cash', value: 'cash' },
  { name: 'MoMo', value: 'momo' },
  { name: 'Bank transfer', value: 'bank transfer' },
  { name: 'Other', value: 'other' },
];

function normalizeTransactionMethodKey(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function formatTransactionMethodName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ');
}

async function listActiveTransactionMethods() {
  try {
    const rows = await TransactionMethod.find({ isActive: true }).sort({ name: 1 }).lean();
    const methods = rows
      .map((row) => ({
        name: formatTransactionMethodName(row?.name),
        value: normalizeTransactionMethodKey(row?.normalizedName || row?.name),
      }))
      .filter((row) => row.name && row.value);
    if (methods.length) return methods;
  } catch {
    // Fall back to defaults when collection is unavailable.
  }
  return DEFAULT_TRANSACTION_METHODS.map((row) => ({ ...row }));
}

async function ensureDefaultTransactionMethods() {
  for (const method of DEFAULT_TRANSACTION_METHODS) {
    const name = formatTransactionMethodName(method.name);
    const normalizedName = normalizeTransactionMethodKey(method.value || name);
    // eslint-disable-next-line no-await-in-loop
    await TransactionMethod.updateOne(
      { normalizedName },
      {
        $setOnInsert: {
          name,
          normalizedName,
          isActive: true,
        },
      },
      { upsert: true },
    );
  }
}

module.exports = {
  DEFAULT_TRANSACTION_METHODS,
  normalizeTransactionMethodKey,
  formatTransactionMethodName,
  listActiveTransactionMethods,
  ensureDefaultTransactionMethods,
};
