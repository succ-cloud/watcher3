const User = require('../models/User');
const { ACCOUNT_STATUS, ROLES } = require('../models/User');

const checkAccountStatus = async (req, res, next) => {
    try {
        // Get user from database using the ID from the token
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(401).json({ message: 'User not found' });
        }

        // Admins can always proceed
        if (user.role === ROLES.ADMIN) {
            return next();
        }

        // Check account status
        switch (user.accountStatus) {
            case ACCOUNT_STATUS.PENDING:
                return res.status(403).json({ 
                    message: 'Your account is pending approval. Please wait for admin validation.',
                    status: 'pending'
                });
            
            case ACCOUNT_STATUS.SUSPENDED:
                return res.status(403).json({ 
                    message: 'Your account has been suspended. Contact admin for more information.',
                    status: 'suspended'
                });
            
            case ACCOUNT_STATUS.REJECTED:
                return res.status(403).json({ 
                    message: 'Your account application was rejected.',
                    status: 'rejected',
                    reason: user.rejectionReason
                });
            
            case ACCOUNT_STATUS.ACTIVE:
                return next();
            
            default:
                return res.status(403).json({ message: 'Invalid account status' });
        }
    } catch (error) {
        console.error('Error checking account status:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = checkAccountStatus;