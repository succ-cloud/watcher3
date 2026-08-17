const ExpenseCategory = require('../models/ExpenseCategory');

function normalizeExpenseCategoryKey(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function formatExpenseCategoryName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ');
}

async function listActiveExpenseCategories() {
  const rows = await ExpenseCategory.find({ isActive: true }).sort({ name: 1 }).lean();
  return rows
    .map((row) => ({
      _id: String(row._id),
      name: formatExpenseCategoryName(row?.name),
      value: normalizeExpenseCategoryKey(row?.normalizedName || row?.name),
    }))
    .filter((row) => row.name && row._id);
}

module.exports = {
  normalizeExpenseCategoryKey,
  formatExpenseCategoryName,
  listActiveExpenseCategories,
};
