const User = require('../models/User');
const { ROLES, ACCOUNT_STATUS } = require('../models/User');

// Get all pending wholesalers
const getPendingWholesalers = async (req, res) => {
    try {
        const pendingWholesalers = await User.find({
            role: ROLES.WHOLESALER,
            accountStatus: ACCOUNT_STATUS.PENDING
        }).select('-password -refreshToken');

        res.status(200).json({
            success: true,
            count: pendingWholesalers.length,
            users: pendingWholesalers
        });
    } catch (error) {
        console.error('Error fetching pending wholesalers:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Get all wholesalers (both pending and active)
const getAllWholesalers = async (req, res) => {
    try {
        const wholesalers = await User.find({
            role: ROLES.WHOLESALER
        }).select('-password -refreshToken');

        res.status(200).json({
            success: true,
            count: wholesalers.length,
            users: wholesalers
        });
    } catch (error) {
        console.error('Error fetching wholesalers:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Approve a wholesaler account
const approveWholesaler = async (req, res) => {
    const { userId } = req.params;
    const adminId = req.user.id; // Assuming you have user info from verifyJWT

    try {
        const wholesaler = await User.findById(userId);

        if (!wholesaler) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (wholesaler.role !== ROLES.WHOLESALER) {
            return res.status(400).json({ message: 'User is not a wholesaler' });
        }

        if (wholesaler.accountStatus === ACCOUNT_STATUS.ACTIVE) {
            return res.status(400).json({ message: 'Account is already active' });
        }

        wholesaler.accountStatus = ACCOUNT_STATUS.ACTIVE;
        wholesaler.validatedBy = adminId;
        wholesaler.validatedAt = new Date();

        await wholesaler.save();

        res.status(200).json({
            success: true,
            message: 'Wholesaler account approved successfully',
            user: {
                id: wholesaler._id,
                name: wholesaler.name,
                businessName: wholesaler.businessName,
                accountStatus: wholesaler.accountStatus
            }
        });

    } catch (error) {
        console.error('Error approving wholesaler:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Reject a wholesaler account
const rejectWholesaler = async (req, res) => {
    const { userId } = req.params;
    const { reason } = req.body;
    const adminId = req.user.id;

    if (!reason) {
        return res.status(400).json({ message: 'Rejection reason is required' });
    }

    try {
        const wholesaler = await User.findById(userId);

        if (!wholesaler) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (wholesaler.role !== ROLES.WHOLESALER) {
            return res.status(400).json({ message: 'User is not a wholesaler' });
        }

        wholesaler.accountStatus = ACCOUNT_STATUS.REJECTED;
        wholesaler.rejectionReason = reason;
        wholesaler.validatedBy = adminId;
        wholesaler.validatedAt = new Date();

        await wholesaler.save();

        res.status(200).json({
            success: true,
            message: 'Wholesaler account rejected',
            user: {
                id: wholesaler._id,
                name: wholesaler.name,
                businessName: wholesaler.businessName,
                accountStatus: wholesaler.accountStatus
            }
        });

    } catch (error) {
        console.error('Error rejecting wholesaler:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Suspend a wholesaler account
const suspendWholesaler = async (req, res) => {
    const { userId } = req.params;
    const { reason } = req.body;
    const adminId = req.user.id;

    try {
        const wholesaler = await User.findById(userId);

        if (!wholesaler) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (wholesaler.role !== ROLES.WHOLESALER) {
            return res.status(400).json({ message: 'User is not a wholesaler' });
        }

        wholesaler.accountStatus = ACCOUNT_STATUS.SUSPENDED;
        wholesaler.adminNotes = reason || 'Account suspended';
        wholesaler.validatedBy = adminId;
        wholesaler.validatedAt = new Date();

        await wholesaler.save();

        res.status(200).json({
            success: true,
            message: 'Wholesaler account suspended',
            user: {
                id: wholesaler._id,
                name: wholesaler.name,
                businessName: wholesaler.businessName,
                accountStatus: wholesaler.accountStatus
            }
        });

    } catch (error) {
        console.error('Error suspending wholesaler:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = {
    getPendingWholesalers,
    getAllWholesalers,
    approveWholesaler,
    rejectWholesaler,
    suspendWholesaler
};