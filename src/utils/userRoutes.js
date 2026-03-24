const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const verifyJWT = require('../middleware/verifyJWT');
const ROLES_LIST = require('../config/role_list');
const verifyRole = require('../middleware/verifyRole');

// Debug middleware to log incoming requests (optional)
router.use((req, res, next) => {
    console.log(`\n📡 User Route: ${req.method} ${req.originalUrl}`);
    console.log(`👤 User Role: ${req.role}`);
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
 * @access  Admin only
 */
router.get('/salesmen', 
    verifyRole(ROLES_LIST.ADMIN), 
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
 * @access  Admin only (or users could access their own profile - modify as needed)
 */
router.get('/:id', 
    verifyRole(ROLES_LIST.ADMIN), 
    userController.getUserById
);

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