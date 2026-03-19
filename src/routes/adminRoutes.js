const express = require('express');
const router = express.Router();
const {
    getPendingWholesalers,
    getAllWholesalers,
    approveWholesaler,
    rejectWholesaler,
    suspendWholesaler
} = require('../controllers/adminController');
const verifyJWT = require('../middleware/verifyJWT');
const { ROLES } = require('../models/User');

// All admin routes require JWT and admin role
router.use(verifyJWT);
router.use((req, res, next) => {
    if (req.user.role !== ROLES.ADMIN) {
        return res.status(403).json({ message: 'Access denied. Admin only.' });
    }
    next();
});

// Get all pending wholesalers
router.get('/wholesalers/pending', getPendingWholesalers);

// Get all wholesalers
router.get('/wholesalers', getAllWholesalers);

// Approve a wholesaler
router.put('/wholesalers/:userId/approve', approveWholesaler);

// Reject a wholesaler
router.put('/wholesalers/:userId/reject', rejectWholesaler);

// Suspend a wholesaler
router.put('/wholesalers/:userId/suspend', suspendWholesaler);

module.exports = router;