const User = require('../models/User');
const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');
const { ROLES, ACCOUNT_STATUS } = require('../models/User');
const bcrypt = require('bcrypt');
const { attachPasswordDisplay, recordPasswordForAdmin, buildAdminNotesPasswordValue } = require('../utils/adminCredential');
const { ensureDefaultBusinessCities, listActiveBusinessCities } = require('../utils/businessCities');
const {
  ensureDefaultTransactionMethods,
  listActiveTransactionMethods,
} = require('../utils/transactionMethods');
const { listActiveExpenseCategories } = require('../utils/expenseCategories');
const { resolveBusinessAddressFromShopIds } = require('../utils/salesmanShopRouting');

function normalizeShopIdList(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

async function validateActiveShopIds(shopIds) {
  if (!shopIds.length) return true;
  const count = await Warehouse.countDocuments({
    _id: { $in: shopIds },
    type: WAREHOUSE_TYPES.SUB,
    isActive: true,
  });
  return count === shopIds.length;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePhone(raw) {
  return String(raw || '').replace(/\s/g, '');
}

function isValidCmPhone(raw) {
  const v = normalizePhone(raw);
  return /^(?:\+237|00237)?\d{9}$/.test(v);
}

function isValidEmail(raw) {
  const v = String(raw || '').trim();
  if (!v) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

const getBusinessCities = async (_req, res) => {
  try {
    await ensureDefaultBusinessCities();
    const cities = await listActiveBusinessCities();
    return res.json({
      success: true,
      cities,
    });
  } catch (error) {
    console.error('Error fetching business cities:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load business cities',
      error: error.message,
    });
  }
};

const getTransactionMethods = async (_req, res) => {
  try {
    await ensureDefaultTransactionMethods();
    const methods = await listActiveTransactionMethods();
    return res.json({
      success: true,
      methods,
    });
  } catch (error) {
    console.error('Error fetching transaction methods:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load transaction methods',
      error: error.message,
    });
  }
};

const getExpenseCategories = async (_req, res) => {
  try {
    const categories = await listActiveExpenseCategories();
    return res.json({
      success: true,
      categories,
    });
  } catch (error) {
    console.error('Error fetching expense categories:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load expense categories',
      error: error.message,
    });
  }
};

/**
 * Get all wholesalers with optional filters
 * @route GET /api/users/wholesalers
 */
const getAllWholesalers = async (req, res) => {
  try {
    const { status, search, limit = 50, page = 1, prefix, forDirectSale } = req.query;
    const directSaleLookup = String(forDirectSale || '').toLowerCase() === 'true';
    
    // Build filter — always wholesalers only
    const filter = { role: ROLES.WHOLESALER };
    
    // Direct-sale picker: any wholesaler account (active or pending), not suspended/rejected
    if (directSaleLookup) {
      filter.accountStatus = { $in: [ACCOUNT_STATUS.ACTIVE, ACCOUNT_STATUS.PENDING] };
    } else if (status && Object.values(ACCOUNT_STATUS).includes(status)) {
      filter.accountStatus = status;
    }
    
    // Prefix / search on login name (and business name for direct sale)
    if (search) {
      const raw = String(search).trim();
      const term = escapeRegex(raw);
      const usePrefix = String(prefix || '').toLowerCase() === 'true' || directSaleLookup;
      const namePattern = usePrefix ? `^${term}` : term;
      filter.$or = [
        { name: { $regex: namePattern, $options: 'i' } },
        { businessName: { $regex: namePattern, $options: 'i' } },
      ];
      if (!usePrefix) {
        filter.$or.push({ tel: { $regex: term, $options: 'i' } });
      }
    }
    
    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);
    
    // Fetch wholesalers
    const wholesalers = await User.find(filter)
      .select('-password -refreshToken') // Exclude sensitive data
      .sort(directSaleLookup ? { name: 1 } : { createdAt: -1 })
      .skip(skip)
      .limit(limitNum);
    
    // Get total count for pagination
    const total = await User.countDocuments(filter);
    
    // Get counts by status
    const statusCounts = await User.aggregate([
      { $match: { role: ROLES.WHOLESALER } },
      { $group: { _id: '$accountStatus', count: { $sum: 1 } } }
    ]);
    
    const counts = {
      total,
      pending: statusCounts.find(s => s._id === ACCOUNT_STATUS.PENDING)?.count || 0,
      active: statusCounts.find(s => s._id === ACCOUNT_STATUS.ACTIVE)?.count || 0,
      suspended: statusCounts.find(s => s._id === ACCOUNT_STATUS.SUSPENDED)?.count || 0,
      rejected: statusCounts.find(s => s._id === ACCOUNT_STATUS.REJECTED)?.count || 0
    };
    
    res.json({
      success: true,
      data: wholesalers,
      counts,
      pagination: {
        page: parseInt(page),
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
    
  } catch (error) {
    console.error('Error fetching wholesalers:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch wholesalers',
      error: error.message
    });
  }
};

/**
 * Get all salesmen with optional filters
 * @route GET /api/users/salesmen
 */
const getAllSalesmen = async (req, res) => {
  try {
    const { status, search, limit = 50, page = 1, shopId, warehouseId } = req.query;
    const shopFilter = String(shopId || warehouseId || '').trim();

    // Build filter
    const filter = { role: ROLES.SALESMAN };

    if (shopFilter) {
      if (!require('mongoose').Types.ObjectId.isValid(shopFilter)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid shop id.',
        });
      }
      filter.assignedShops = shopFilter;
    }

    // Add status filter if provided; default to active when scoping to a shop
    if (status && Object.values(ACCOUNT_STATUS).includes(status)) {
      filter.accountStatus = status;
    } else if (shopFilter) {
      filter.accountStatus = ACCOUNT_STATUS.ACTIVE;
    }
    
    // Add search filter
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { businessName: { $regex: search, $options: 'i' } },
        { tel: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);
    
    // Fetch salesmen
    let salesmenQuery = User.find(filter)
      .select('-password -refreshToken')
      .sort(shopFilter ? { name: 1 } : { createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    if (!shopFilter) {
      salesmenQuery = salesmenQuery.populate({
        path: 'assignedShops',
        select: 'name city type isActive',
        strictPopulate: false,
      });
    }

    const salesmen = await salesmenQuery;
    
    // Get total count
    const total = await User.countDocuments(filter);
    
    // Get counts by status
    const statusCounts = await User.aggregate([
      { $match: { role: ROLES.SALESMAN } },
      { $group: { _id: '$accountStatus', count: { $sum: 1 } } }
    ]);
    
    const counts = {
      total,
      active: statusCounts.find(s => s._id === ACCOUNT_STATUS.ACTIVE)?.count || 0,
      suspended: statusCounts.find(s => s._id === ACCOUNT_STATUS.SUSPENDED)?.count || 0
    };
    
    res.json({
      success: true,
      data: salesmen,
      counts,
      pagination: {
        page: parseInt(page),
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
    
  } catch (error) {
    console.error('Error fetching salesmen:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch salesmen',
      error: error.message
    });
  }
};

/**
 * Get both wholesalers and salesmen combined
 * @route GET /api/users/all-staff
 */
const getAllUsersByRole = async (req, res) => {
  try {
    const { role, status, search, limit = 50, page = 1 } = req.query;
    
    // Build filter
    const filter = {};
    
    // Filter by role if provided
    if (role) {
      if (role === 'wholesaler') filter.role = ROLES.WHOLESALER;
      if (role === 'salesman') filter.role = ROLES.SALESMAN;
      if (role === 'admin') filter.role = ROLES.ADMIN;
    }
    
    // Add status filter
    if (status && Object.values(ACCOUNT_STATUS).includes(status)) {
      filter.accountStatus = status;
    }
    
    // Add search filter
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { businessName: { $regex: search, $options: 'i' } },
        { tel: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { role: { $regex: search, $options: 'i' } },
      ];
    }
    
    // Pagination
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);
    const skip = (pageNum - 1) * limitNum;
    
    // Fetch users
    const users = await User.find(filter)
      .select('-password -refreshToken')
      .populate({ path: 'assignedShops', select: 'name city type isActive', strictPopulate: false })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);
    
    // Get total count
    const total = await User.countDocuments(filter);
    
    // Get counts by role
    const roleCounts = await User.aggregate([
      { $match: filter },
      { $group: { _id: '$role', count: { $sum: 1 } } }
    ]);
    
    const counts = {
      total,
      wholesalers: roleCounts.find(r => r._id === ROLES.WHOLESALER)?.count || 0,
      salesmen: roleCounts.find(r => r._id === ROLES.SALESMAN)?.count || 0,
      admins: roleCounts.find(r => r._id === ROLES.ADMIN)?.count || 0
    };
    
    res.json({
      success: true,
      data: users.map((u) => attachPasswordDisplay(u)),
      counts,
      pagination: {
        page: parseInt(page),
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
    
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: error.message
    });
  }
};

/**
 * Get single user by ID
 * @route GET /api/users/:id
 */
const getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const requesterRole = String(req.user?.role || req.role || '').toLowerCase();
    const requesterId = String(req.userId || req.user?.userId || req.user?.id || '').trim();

    if (requesterRole === ROLES.SALESMAN && requesterId && String(id) !== requesterId) {
      return res.status(403).json({
        success: false,
        message: 'You can only view your own profile.',
      });
    }
    
    const requesterIsAdmin = requesterRole === ROLES.ADMIN;
    const user = await User.findById(id)
      .select(requesterIsAdmin ? '-password -refreshToken' : '-password -refreshToken -adminCredentialNote')
      .populate('validatedBy', 'name role')
      .populate({ path: 'assignedShops', select: 'name city address type isActive', strictPopulate: false });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    res.json({
      success: true,
      data: attachPasswordDisplay(user),
    });
    
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user',
      error: error.message
    });
  }
};

/**
 * Update user profile fields (self-service or admin).
 * @route PATCH /api/users/:id
 */
const updateUserProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const requesterRole = String(req.user?.role || req.role || '').toLowerCase();
    const requesterId = String(req.userId || req.user?.userId || req.user?.id || '').trim();
    const isAdmin = requesterRole === ROLES.ADMIN;

    if (!isAdmin && requesterId && String(id) !== requesterId) {
      return res.status(403).json({
        success: false,
        message: 'You can only edit your own profile.',
      });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const {
      name,
      businessName,
      businessAddress,
      tel,
      whatsappNumber,
      email,
      accountStatus,
      adminNotes,
    } = req.body;

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (trimmed.length < 2) {
        return res.status(400).json({
          success: false,
          message: 'Name must be at least 2 characters',
        });
      }
      const duplicateName = await User.findOne({ name: trimmed, _id: { $ne: id } }).exec();
      if (duplicateName) {
        return res.status(409).json({
          success: false,
          message: 'Name already exists',
        });
      }
      user.name = trimmed;
    }

    if (businessName !== undefined) {
      const trimmed = String(businessName).trim();
      if (trimmed.length < 2) {
        return res.status(400).json({
          success: false,
          message: 'Business name must be at least 2 characters',
        });
      }
      user.businessName = trimmed;
    }

    if (businessAddress !== undefined) {
      const trimmed = String(businessAddress).trim();
      await ensureDefaultBusinessCities();
      const allowedBusinessCities = await listActiveBusinessCities();
      if (!allowedBusinessCities.includes(trimmed)) {
        return res.status(400).json({
          success: false,
          message: `Business city must be one of: ${allowedBusinessCities.join(', ')}`,
        });
      }
      user.businessAddress = trimmed;
    }

    if (tel !== undefined) {
      const normalizedTel = normalizePhone(tel);
      if (!isValidCmPhone(normalizedTel)) {
        return res.status(400).json({
          success: false,
          message: 'Please enter a valid 9-digit phone number (e.g., 677184257 or +237677184257)',
        });
      }
      const duplicateTel = await User.findOne({ tel: normalizedTel, _id: { $ne: id } }).exec();
      if (duplicateTel) {
        return res.status(409).json({
          success: false,
          message: 'Telephone number already registered',
        });
      }
      user.tel = normalizedTel;
    }

    if (whatsappNumber !== undefined) {
      const normalizedWhatsapp = normalizePhone(whatsappNumber);
      if (!isValidCmPhone(normalizedWhatsapp)) {
        return res.status(400).json({
          success: false,
          message: 'Please enter a valid 9-digit WhatsApp number (e.g., 677184257 or +237677184257)',
        });
      }
      user.whatsappNumber = normalizedWhatsapp;
    }

    if (email !== undefined) {
      const trimmedEmail = String(email || '').trim().toLowerCase();
      if (!isValidEmail(trimmedEmail)) {
        return res.status(400).json({
          success: false,
          message: 'Please enter a valid email address, or leave it blank',
        });
      }
      user.email = trimmedEmail || undefined;
    }

    if (isAdmin) {
      if (accountStatus !== undefined) {
        const status = String(accountStatus).toLowerCase();
        if (!Object.values(ACCOUNT_STATUS).includes(status)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid account status. Must be: pending, active, suspended, or rejected',
          });
        }
        user.accountStatus = status;
        if (status === ACCOUNT_STATUS.ACTIVE) {
          user.validatedAt = new Date();
          if (requesterId) user.validatedBy = requesterId;
        }
      }

      if (adminNotes !== undefined) {
        user.adminNotes = String(adminNotes || '').trim() || undefined;
      }
    }

    await user.save();
    await user.populate({ path: 'assignedShops', select: 'name city type isActive', strictPopulate: false });

    return res.json({
      success: true,
      message: 'Account updated.',
      data: attachPasswordDisplay(user),
    });
  } catch (error) {
    console.error('Error updating user profile:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update account',
      error: error.message,
    });
  }
};

/**
 * Update user status (activate, suspend, reject)
 * @route PATCH /api/users/:id/status
 */
const updateUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason, adminNotes, validatedBy } = req.body;
    
    // Validate status
    if (!Object.values(ACCOUNT_STATUS).includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be: pending, active, suspended, or rejected'
      });
    }
    
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Update user
    user.accountStatus = status;
    
    if (status === ACCOUNT_STATUS.ACTIVE) {
      user.validatedAt = new Date();
      if (validatedBy) user.validatedBy = validatedBy;
    }
    
    if (status === ACCOUNT_STATUS.REJECTED && rejectionReason) {
      user.rejectionReason = rejectionReason;
    }
    
    if (adminNotes) {
      user.adminNotes = adminNotes;
    }
    
    await user.save();
    
    res.json({
      success: true,
      message: `User status updated to ${status}`,
      data: {
        _id: user._id,
        name: user.name,
        role: user.role,
        accountStatus: user.accountStatus
      }
    });
    
  } catch (error) {
    console.error('Error updating user status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user status',
      error: error.message
    });
  }
};

/**
 * Replace shop assignments for a salesperson (admin only).
 * @route PATCH /api/users/:id/shops
 * @body { shopIds: string[] }
 */
const updateSalesmanShops = async (req, res) => {
  try {
    const { id } = req.params;
    const shopIds = normalizeShopIdList(req.body?.shopIds);

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (user.role !== ROLES.SALESMAN) {
      return res.status(400).json({
        success: false,
        message: 'Shop assignments apply only to salespeople.',
      });
    }

    const valid = await validateActiveShopIds(shopIds);
    if (!valid) {
      return res.status(400).json({
        success: false,
        message: 'One or more shop ids are invalid or inactive.',
      });
    }

    user.assignedShops = shopIds;

    if (shopIds.length) {
      const derivedCity = await resolveBusinessAddressFromShopIds(shopIds);
      if (!derivedCity) {
        return res.status(400).json({
          success: false,
          message: 'Could not determine business city from the assigned Shop(s).',
        });
      }
      await ensureDefaultBusinessCities();
      const allowed = await listActiveBusinessCities();
      if (!allowed.includes(derivedCity)) {
        return res.status(400).json({
          success: false,
          message: `Shop city must match a configured business city (${allowed.join(', ')}).`,
        });
      }
      user.businessAddress = derivedCity;
    } else {
      user.businessAddress = '';
    }

    await user.save();
    await user.populate({ path: 'assignedShops', select: 'name city type isActive', strictPopulate: false });

    return res.json({
      success: true,
      message: shopIds.length
        ? `Assigned to ${shopIds.length} shop(s).`
        : 'Removed from all shops.',
      data: user,
    });
  } catch (error) {
    console.error('Error updating salesman shops:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update shop assignments',
      error: error.message,
    });
  }
};

/**
 * Delete user (admin only)
 * @route DELETE /api/users/:id
 */
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const requesterId = String(req.userId || req.user?.userId || req.user?.id || req.user?._id || '').trim();

    if (requesterId && String(id) === requesterId) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own account.',
      });
    }

    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (String(user.role || '').toLowerCase() === ROLES.ADMIN) {
      const adminCount = await User.countDocuments({ role: ROLES.ADMIN });
      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete the last admin account.',
        });
      }
    }

    await User.findByIdAndDelete(id);

    res.json({
      success: true,
      message: `User ${user.name} deleted successfully`,
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user',
      error: error.message,
    });
  }
};

/**
 * Get statistics for dashboard
 * @route GET /api/users/stats
 */
const getUserStats = async (req, res) => {
  try {
    // Get counts by role
    const roleStats = await User.aggregate([
      { $group: { _id: '$role', count: { $sum: 1 } } }
    ]);
    
    // Get counts by account status
    const statusStats = await User.aggregate([
      { $group: { _id: '$accountStatus', count: { $sum: 1 } } }
    ]);
    
    // Get recent registrations (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const recentRegistrations = await User.countDocuments({
      createdAt: { $gte: sevenDaysAgo }
    });
    
    // Get pending wholesalers
    const pendingWholesalers = await User.countDocuments({
      role: ROLES.WHOLESALER,
      accountStatus: ACCOUNT_STATUS.PENDING
    });
    
    res.json({
      success: true,
      data: {
        total: {
          wholesalers: roleStats.find(r => r._id === ROLES.WHOLESALER)?.count || 0,
          salesmen: roleStats.find(r => r._id === ROLES.SALESMAN)?.count || 0,
          admins: roleStats.find(r => r._id === ROLES.ADMIN)?.count || 0
        },
        accountStatus: {
          pending: statusStats.find(s => s._id === ACCOUNT_STATUS.PENDING)?.count || 0,
          active: statusStats.find(s => s._id === ACCOUNT_STATUS.ACTIVE)?.count || 0,
          suspended: statusStats.find(s => s._id === ACCOUNT_STATUS.SUSPENDED)?.count || 0,
          rejected: statusStats.find(s => s._id === ACCOUNT_STATUS.REJECTED)?.count || 0
        },
        recentRegistrations,
        pendingWholesalers
      }
    });
    
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user statistics',
      error: error.message
    });
  }
};

/**
 * Admin sets a new password and records it for account directory visibility.
 * @route PATCH /api/users/:id/password
 */
const setUserPasswordByAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || String(password).length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long',
      });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const hashedPwd = await bcrypt.hash(password, 10);
    await recordPasswordForAdmin(User, user._id, password);
    user.password = hashedPwd;
    await user.save();

    res.json({
      success: true,
      message: 'Password updated.',
      data: attachPasswordDisplay({
        ...(user.toObject ? user.toObject() : user),
        adminCredentialNote: String(password),
        adminNotes: buildAdminNotesPasswordValue(password),
      }),
    });
  } catch (error) {
    console.error('Error setting user password:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update password',
      error: error.message,
    });
  }
};

module.exports = {
  getBusinessCities,
  getTransactionMethods,
  getExpenseCategories,
  getAllWholesalers,
  getAllSalesmen,
  getAllUsersByRole,
  getUserById,
  updateUserProfile,
  updateUserStatus,
  updateSalesmanShops,
  deleteUser,
  getUserStats,
  setUserPasswordByAdmin,
};