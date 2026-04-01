const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const verifyJWT = require('../middleware/verifyJWT');
const ROLES_LIST = require('../config/role_list');
const verifyRole = require('../middleware/verifyRole');

/** 
 * Allow admin, wholesaler, or the authenticated user fetching their own document.
 * Updated to allow both ADMIN and WHOLESALER roles to view user details
 */
const allowSelfOrAdminOrWholesaler = (req, res, next) => {
    const requestedId = String(req.params.id || '');
    const selfId = String(req.userId || req.user?.userId || '');
    const role = String(req.role || req.user?.role || '').toLowerCase();
    
    console.log(`🔍 Access Check - Role: ${role}, Requested ID: ${requestedId}, Self ID: ${selfId}`);
    
    // Allow ADMIN to access any user
    if (role === ROLES_LIST.ADMIN) {
        console.log('✅ Admin access granted');
        return next();
    }
    
    // Allow WHOLESALER to access any user (for viewing salesmen, etc.)
    if (role === ROLES_LIST.WHOLESALER) {
        console.log('✅ Wholesaler access granted');
        return next();
    }
    
    // Allow user to access their own profile
    if (selfId && requestedId && selfId === requestedId) {
        console.log('✅ Self access granted');
        return next();
    }
    
    console.log('❌ Access denied');
    return res.status(403).json({
        success: false,
        message: 'You do not have permission to view this user profile.',
        allowedRoles: ['admin', 'wholesaler'],
        yourRole: role
    });
};

// Debug middleware to log incoming requests (optional)
router.use((req, res, next) => {
    console.log(`\n📡 User Route: ${req.method} ${req.originalUrl}`);
    console.log(`👤 User Role: ${req.role || req.user?.role}`);
    next();
});

// Protected routes - require authentication
router.use(verifyJWT);

// ==================== USER ROUTES ====================

/**
 * @route   GET /api/users/wholesalers
 * @desc    Get all wholesalers with filters
 * @access  Admin only
 */
router.get('/wholesalers', 
    verifyRole(ROLES_LIST.ADMIN), 
    userController.getAllWholesalers
);

/**
 * @route   GET /api/users/salesmen
 * @desc    Get all salesmen with filters
 * @access  Admin and Wholesaler (wholesalers can view their salesmen)
 */
router.get('/salesmen', 
    verifyRole([ROLES_LIST.ADMIN, ROLES_LIST.WHOLESALER]), 
    userController.getAllSalesmen
);

/**
 * @route   GET /api/users/all-staff
 * @desc    Get all staff users (wholesalers + salesmen)
 * @access  Admin only
 */
router.get('/all-staff', 
    verifyRole(ROLES_LIST.ADMIN), 
    userController.getAllUsersByRole
);

/**
 * @route   GET /api/users/stats
 * @desc    Get user statistics for dashboard
 * @access  Admin only
 */
router.get('/stats', 
    verifyRole(ROLES_LIST.ADMIN), 
    userController.getUserStats
);

/**
 * @route   GET /api/users/:id
 * @desc    Get single user by ID
 * @access  Admin, Wholesaler, or the same user (own profile)
 */
router.get('/:id', allowSelfOrAdminOrWholesaler, userController.getUserById);

/**
 * @route   PATCH /api/users/:id
 * @desc    Update user profile (name, business fields, tel, whatsApp)
 * @access  Admin, Wholesaler (for their salesmen), or own profile
 */
router.patch('/:id', allowSelfOrAdminOrWholesaler, userController.updateUserProfile);

/**
 * @route   PATCH /api/users/:id/status
 * @desc    Update user account status (activate, suspend, reject)
 * @access  Admin only
 * @body    { status, rejectionReason, adminNotes, validatedBy }
 */
router.patch('/:id/status', 
    verifyRole(ROLES_LIST.ADMIN), 
    userController.updateUserStatus
);

/**
 * @route   DELETE /api/users/:id
 * @desc    Delete user (admin only)
 * @access  Admin only
 */
router.delete('/:id', 
    verifyRole(ROLES_LIST.ADMIN), 
    userController.deleteUser
);

// ==================== WHOLESALER-SPECIFIC ROUTES ====================

/**
 * @route   GET /api/users/my-salesmen
 * @desc    Get salesmen associated with the logged-in wholesaler
 * @access  Wholesaler only
 */
router.get('/my-salesmen', 
    verifyRole(ROLES_LIST.WHOLESALER), 
    async (req, res) => {
        try {
            const wholesalerId = req.userId || req.user?._id;
            const salesmen = await userController.getSalesmenByWholesaler(wholesalerId);
            res.json({
                success: true,
                data: salesmen
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: 'Failed to fetch salesmen',
                error: error.message
            });
        }
    }
);

/**
 * @route   POST /api/users/create-salesman
 * @desc    Create a salesman under the logged-in wholesaler
 * @access  Wholesaler only
 */
router.post('/create-salesman', 
    verifyRole(ROLES_LIST.WHOLESALER), 
    userController.createSalesmanByWholesaler
);

// ==================== ADDITIONAL ROUTES (Optional) ====================

/**
 * @route   PATCH /api/users/:id/activate
 * @desc    Quick activate user (convenience route)
 * @access  Admin only
 */
router.patch('/:id/activate', 
    verifyRole(ROLES_LIST.ADMIN), 
    async (req, res) => {
        try {
            req.body.status = 'active';
            await userController.updateUserStatus(req, res);
        } catch (error) {
            res.status(500).json({
                success: false,
                message: 'Failed to activate user',
                error: error.message
            });
        }
    }
);

/**
 * @route   PATCH /api/users/:id/suspend
 * @desc    Quick suspend user (convenience route)
 * @access  Admin only
 */
router.patch('/:id/suspend', 
    verifyRole(ROLES_LIST.ADMIN), 
    async (req, res) => {
        try {
            req.body.status = 'suspended';
            await userController.updateUserStatus(req, res);
        } catch (error) {
            res.status(500).json({
                success: false,
                message: 'Failed to suspend user',
                error: error.message
            });
        }
    }
);

/**
 * @route   PATCH /api/users/:id/reject
 * @desc    Quick reject user (convenience route)
 * @access  Admin only
 */
router.patch('/:id/reject', 
    verifyRole(ROLES_LIST.ADMIN), 
    async (req, res) => {
        try {
            req.body.status = 'rejected';
            await userController.updateUserStatus(req, res);
        } catch (error) {
            res.status(500).json({
                success: false,
                message: 'Failed to reject user',
                error: error.message
            });
        }
    }
);

module.exports = router;
