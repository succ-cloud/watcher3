const ExpenseCategory = require('../models/ExpenseCategory');
const ShopExpense = require('../models/ShopExpense');
const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');
const { ROLES } = require('../models/User');
const {
  normalizeExpenseCategoryKey,
  formatExpenseCategoryName,
  listActiveExpenseCategories,
} = require('../utils/expenseCategories');
const { assertSalesmanShopAccess } = require('../utils/salesmanShopAccess');

function resolveCategoryParam(rawParam) {
  try {
    const decoded = decodeURIComponent(String(rawParam || '').trim());
    const normalizedName = normalizeExpenseCategoryKey(decoded);
    if (!normalizedName) return null;
    return { normalizedName, decoded };
  } catch {
    return null;
  }
}

function formatExpenseRow(row) {
  const shop = row?.shop && typeof row.shop === 'object' ? row.shop : null;
  const category = row?.category && typeof row.category === 'object' ? row.category : null;
  const shopName = shop?.name || '';
  const shopCity = shop?.city || '';
  const locationType =
    shop?.type === WAREHOUSE_TYPES.MAIN
      ? 'Warehouse'
      : shop?.type === WAREHOUSE_TYPES.SUB
        ? 'Shop'
        : '';
  const locationCore = [shopName, shopCity].filter(Boolean).join(' · ');
  const location = locationCore
    ? locationType
      ? `${locationCore} (${locationType})`
      : locationCore
    : '—';

  return {
    _id: String(row._id),
    shopId: shop?._id ? String(shop._id) : String(row.shop || ''),
    categoryId: category?._id ? String(category._id) : String(row.category || ''),
    category: category?.name || '—',
    amount: Number(row.amount) || 0,
    description: String(row.description || '').trim(),
    location,
    locationType,
    shopName,
    shopCity,
    recordedBy: row?.recordedBy?.name || null,
    createdAt: row.createdAt,
  };
}

async function resolveActiveCategory(categoryId) {
  const id = String(categoryId || '').trim();
  if (!id) return null;
  return ExpenseCategory.findOne({ _id: id, isActive: true }).lean();
}

async function resolveActiveShop(shopId) {
  const id = String(shopId || '').trim();
  if (!id) return null;
  return Warehouse.findOne({
    _id: id,
    type: WAREHOUSE_TYPES.SUB,
    isActive: true,
  }).lean();
}

/** Active shop or main warehouse — used when admins record expenses. */
async function resolveActiveExpenseLocation(locationId) {
  const id = String(locationId || '').trim();
  if (!id) return null;
  return Warehouse.findOne({
    _id: id,
    type: { $in: [WAREHOUSE_TYPES.MAIN, WAREHOUSE_TYPES.SUB] },
    isActive: true,
  }).lean();
}

const getExpenseCategories = async (_req, res) => {
  try {
    const categories = await listActiveExpenseCategories();
    return res.status(200).json({ success: true, categories });
  } catch (error) {
    console.error('Error fetching expense categories:', error);
    return res.status(500).json({ message: 'Could not load expense categories.' });
  }
};

const addExpenseCategory = async (req, res) => {
  const adminId = req.user?.id || req.userId || null;
  const rawName = req.body?.name;
  const name = formatExpenseCategoryName(rawName);
  const normalizedName = normalizeExpenseCategoryKey(rawName);

  if (!name || name.length < 2) {
    return res.status(400).json({ message: 'Category name must be at least 2 characters.' });
  }
  if (name.length > 80) {
    return res.status(400).json({ message: 'Category name must be at most 80 characters.' });
  }

  try {
    const existing = await ExpenseCategory.findOne({ normalizedName }).lean();
    if (existing?.isActive) {
      return res.status(409).json({ message: `${existing.name} already exists.` });
    }
    if (existing) {
      await ExpenseCategory.updateOne(
        { _id: existing._id },
        {
          $set: {
            name,
            normalizedName,
            isActive: true,
            createdBy: adminId || null,
          },
        },
      );
    } else {
      await ExpenseCategory.create({
        name,
        normalizedName,
        isActive: true,
        createdBy: adminId || null,
      });
    }

    const categories = await listActiveExpenseCategories();
    return res.status(201).json({
      success: true,
      message: `${name} added.`,
      categories,
    });
  } catch (error) {
    console.error('Error adding expense category:', error);
    return res.status(500).json({ message: 'Could not add expense category.' });
  }
};

const updateExpenseCategory = async (req, res) => {
  const resolved = resolveCategoryParam(req.params.categoryKey);
  if (!resolved) {
    return res.status(400).json({ message: 'Invalid category.' });
  }

  const rawNewName = req.body?.name;
  const newName = formatExpenseCategoryName(rawNewName);
  const newNormalizedName = normalizeExpenseCategoryKey(rawNewName);

  if (!newName || newName.length < 2) {
    return res.status(400).json({ message: 'Category name must be at least 2 characters.' });
  }
  if (newName.length > 80) {
    return res.status(400).json({ message: 'Category name must be at most 80 characters.' });
  }

  try {
    const existing = await ExpenseCategory.findOne({
      normalizedName: resolved.normalizedName,
      isActive: true,
    }).lean();
    if (!existing) {
      return res.status(404).json({ message: 'Category not found.' });
    }

    if (newNormalizedName !== resolved.normalizedName) {
      const conflict = await ExpenseCategory.findOne({ normalizedName: newNormalizedName }).lean();
      if (conflict?.isActive) {
        return res.status(409).json({ message: `${conflict.name} already exists.` });
      }
      if (conflict) {
        await ExpenseCategory.deleteOne({ _id: conflict._id });
      }
    }

    await ExpenseCategory.updateOne(
      { _id: existing._id },
      { $set: { name: newName, normalizedName: newNormalizedName } },
    );

    const categories = await listActiveExpenseCategories();
    return res.status(200).json({
      success: true,
      message: `${newName} updated.`,
      categories,
    });
  } catch (error) {
    console.error('Error updating expense category:', error);
    return res.status(500).json({ message: 'Could not update expense category.' });
  }
};

const deleteExpenseCategory = async (req, res) => {
  const resolved = resolveCategoryParam(req.params.categoryKey);
  if (!resolved) {
    return res.status(400).json({ message: 'Invalid category.' });
  }

  try {
    const existing = await ExpenseCategory.findOne({
      normalizedName: resolved.normalizedName,
      isActive: true,
    }).lean();
    if (!existing) {
      return res.status(404).json({ message: 'Category not found.' });
    }

    const activeCount = await ExpenseCategory.countDocuments({ isActive: true });
    if (activeCount <= 1) {
      return res.status(400).json({ message: 'At least one expense category must remain.' });
    }

    await ExpenseCategory.updateOne({ _id: existing._id }, { $set: { isActive: false } });

    const categories = await listActiveExpenseCategories();
    return res.status(200).json({
      success: true,
      message: `${existing.name} deleted.`,
      categories,
    });
  } catch (error) {
    console.error('Error deleting expense category:', error);
    return res.status(500).json({ message: 'Could not delete expense category.' });
  }
};

const listAllExpenses = async (_req, res) => {
  try {
    const rows = await ShopExpense.find()
      .populate('shop', 'name city address type')
      .populate('category', 'name')
      .populate('recordedBy', 'name')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: rows.length,
      expenses: rows.map(formatExpenseRow),
    });
  } catch (error) {
    console.error('Error listing expenses:', error);
    return res.status(500).json({ message: 'Could not load expenses.' });
  }
};

const listShopExpenses = async (req, res) => {
  const shopId = String(req.params.shopId || req.params.id || '').trim();
  if (!shopId) {
    return res.status(400).json({ message: 'Shop id is required.' });
  }

  const role = String(req.user?.role || '').toLowerCase();
  const userId = req.user?.id || req.userId;

  try {
    if (role === ROLES.SALESMAN) {
      await assertSalesmanShopAccess(userId, shopId);
    } else if (role !== ROLES.ADMIN) {
      return res.status(403).json({ message: 'Forbidden.' });
    }

    const shop =
      role === ROLES.SALESMAN
        ? await resolveActiveShop(shopId)
        : await resolveActiveExpenseLocation(shopId);
    if (!shop) {
      return res.status(404).json({ message: 'Location not found.' });
    }

    const rows = await ShopExpense.find({ shop: shopId })
      .populate('shop', 'name city address type')
      .populate('category', 'name')
      .populate('recordedBy', 'name')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: rows.length,
      expenses: rows.map(formatExpenseRow),
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error('Error listing shop expenses:', error);
    return res.status(status).json({ message: error?.message || 'Could not load expenses.' });
  }
};

const createAdminExpense = async (req, res) => {
  const userId = req.user?.id || req.userId || null;
  const shopId = String(req.body?.shopId || '').trim();
  const categoryId = String(req.body?.categoryId || '').trim();
  const amount = Number(req.body?.amount);
  const description = String(req.body?.description || '').trim();

  if (!shopId) {
    return res.status(400).json({ message: 'Select a warehouse or shop for this expense.' });
  }
  if (!categoryId) {
    return res.status(400).json({ message: 'Select an expense category.' });
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ message: 'Enter a valid amount.' });
  }

  try {
    const shop = await resolveActiveExpenseLocation(shopId);
    if (!shop) {
      return res.status(404).json({ message: 'Warehouse or shop not found.' });
    }

    const category = await resolveActiveCategory(categoryId);
    if (!category) {
      return res.status(400).json({ message: 'Expense category not found.' });
    }

    const expense = await ShopExpense.create({
      shop: shopId,
      category: category._id,
      amount,
      description,
      recordedBy: userId,
    });

    const row = await ShopExpense.findById(expense._id)
      .populate('shop', 'name city address type')
      .populate('category', 'name')
      .populate('recordedBy', 'name')
      .lean();

    return res.status(201).json({
      success: true,
      message: 'Expense recorded.',
      expense: formatExpenseRow(row),
    });
  } catch (error) {
    console.error('Error creating expense:', error);
    return res.status(500).json({ message: 'Could not record expense.' });
  }
};

const createShopExpense = async (req, res) => {
  const userId = req.user?.id || req.userId || null;
  const shopId = String(req.params.shopId || req.params.id || '').trim();
  const categoryId = String(req.body?.categoryId || '').trim();
  const amount = Number(req.body?.amount);
  const description = String(req.body?.description || '').trim();
  const role = String(req.user?.role || '').toLowerCase();

  if (!shopId) {
    return res.status(400).json({ message: 'Shop id is required.' });
  }
  if (!categoryId) {
    return res.status(400).json({ message: 'Select an expense category.' });
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ message: 'Enter a valid amount.' });
  }

  try {
    if (role === ROLES.SALESMAN) {
      await assertSalesmanShopAccess(userId, shopId);
    } else if (role !== ROLES.ADMIN) {
      return res.status(403).json({ message: 'Forbidden.' });
    }

    const shop =
      role === ROLES.SALESMAN
        ? await resolveActiveShop(shopId)
        : await resolveActiveExpenseLocation(shopId);
    if (!shop) {
      return res.status(404).json({ message: 'Location not found.' });
    }

    const category = await resolveActiveCategory(categoryId);
    if (!category) {
      return res.status(400).json({ message: 'Expense category not found.' });
    }

    const expense = await ShopExpense.create({
      shop: shopId,
      category: category._id,
      amount,
      description,
      recordedBy: userId,
    });

    const row = await ShopExpense.findById(expense._id)
      .populate('shop', 'name city address type')
      .populate('category', 'name')
      .populate('recordedBy', 'name')
      .lean();

    return res.status(201).json({
      success: true,
      message: 'Expense recorded.',
      expense: formatExpenseRow(row),
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error('Error creating shop expense:', error);
    return res.status(status).json({ message: error?.message || 'Could not record expense.' });
  }
};

module.exports = {
  getExpenseCategories,
  addExpenseCategory,
  updateExpenseCategory,
  deleteExpenseCategory,
  listAllExpenses,
  listShopExpenses,
  createAdminExpense,
  createShopExpense,
};
