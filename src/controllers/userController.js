const User = require('../models/User');
const { ROLES, ACCOUNT_STATUS } = require('../models/User');

/**
 * Get all wholesalers with optional filters
 * @route GET /api/users/wholesalers
 */
const getAllWholesalers = async (req, res) => {
  try {
    const { status, search, limit = 50, page = 1 } = req.query;
    
    // Build filter
    const filter = { role: ROLES.WHOLESALER };
    
    // Add status filter if provided
    if (status && Object.values(ACCOUNT_STATUS).includes(status)) {
      filter.accountStatus = status;
    }
    
    // Add search filter (search by name or business name)
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
    
    // Fetch wholesalers
    const wholesalers = await User.find(filter)
      .select('-password -refreshToken') // Exclude sensitive data
      .sort({ createdAt: -1 })
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
    const { status, search, limit = 50, page = 1 } = req.query;
    
    // Build filter
    const filter = { role: ROLES.SALESMAN };
    
    // Add status filter if provided
    if (status && Object.values(ACCOUNT_STATUS).includes(status)) {
      filter.accountStatus = status;
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
    const salesmen = await User.find(filter)
      .select('-password -refreshToken')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);
    
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
        { tel: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);
    
    // Fetch users
    const users = await User.find(filter)
      .select('-password -refreshToken')
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
      data: users,
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
    
    const user = await User.findById(id)
      .select('-password -refreshToken')
      .populate('validatedBy', 'name role');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    res.json({
      success: true,
      data: user
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
 * Delete user (admin only)
 * @route DELETE /api/users/:id
 */
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    
    const user = await User.findByIdAndDelete(id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    res.json({
      success: true,
      message: `User ${user.name} deleted successfully`
    });
    
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user',
      error: error.message
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

module.exports = {
  getAllWholesalers,
  getAllSalesmen,
  getAllUsersByRole,
  getUserById,
  updateUserStatus,
  deleteUser,
  getUserStats
};