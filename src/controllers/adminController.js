const User = require('../models/User');
const { ROLES, ACCOUNT_STATUS } = require('../models/User');
const bcrypt = require('bcrypt');
const { buildAdminNotesPasswordValue } = require('../utils/adminCredential');
const BusinessCity = require('../models/BusinessCity');
const TransactionMethod = require('../models/TransactionMethod');
const { Order } = require('../models/Order');
const { SoldIme } = require('../models/SoldIme');
const {
    formatBusinessCityName,
    listActiveBusinessCities,
    normalizeBusinessCityName,
    ensureDefaultBusinessCities,
} = require('../utils/businessCities');
const {
    formatTransactionMethodName,
    listActiveTransactionMethods,
    normalizeTransactionMethodKey,
    ensureDefaultTransactionMethods,
} = require('../utils/transactionMethods');

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveBusinessCityParam(rawParam) {
    const decoded = decodeURIComponent(String(rawParam || '').trim());
    const normalizedName = normalizeBusinessCityName(decoded);
    if (!normalizedName) return null;
    return { decoded, normalizedName };
}

function resolveTransactionMethodParam(rawParam) {
    const decoded = decodeURIComponent(String(rawParam || '').trim());
    const normalizedName = normalizeTransactionMethodKey(decoded);
    if (!normalizedName) return null;
    return { decoded, normalizedName };
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
            return res.status(400).json({ message: 'User is not a vendor' });
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
            message: 'Vendor account approved successfully',
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
            return res.status(400).json({ message: 'User is not a vendor' });
        }

        wholesaler.accountStatus = ACCOUNT_STATUS.REJECTED;
        wholesaler.rejectionReason = reason;
        wholesaler.validatedBy = adminId;
        wholesaler.validatedAt = new Date();

        await wholesaler.save();

        res.status(200).json({
            success: true,
            message: 'Vendor account rejected',
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
            return res.status(400).json({ message: 'User is not a vendor' });
        }

        wholesaler.accountStatus = ACCOUNT_STATUS.SUSPENDED;
        wholesaler.adminNotes = reason || 'Account suspended';
        wholesaler.validatedBy = adminId;
        wholesaler.validatedAt = new Date();

        await wholesaler.save();

        res.status(200).json({
            success: true,
            message: 'Vendor account suspended',
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

// Create a wholesaler account (admin only; active by default)
const createWholesaler = async (req, res) => {
    const adminId = String(
        req.userId || req.user?.userId || req.user?.id || req.user?._id || '',
    ).trim();
    const {
        name,
        businessName,
        businessAddress,
        tel,
        whatsappNumber,
        password,
        email,
    } = req.body;

    if (!name || !businessName || !businessAddress || !tel || !whatsappNumber || !password) {
        return res.status(400).json({
            message: 'All fields are required: name, businessName, businessAddress, tel, whatsappNumber, password',
        });
    }

    const trimmedName = String(name).trim();
    const trimmedBusinessName = String(businessName).trim();
    const trimmedAddress = String(businessAddress).trim();
    const normalizedTel = normalizePhone(tel);
    const normalizedWhatsapp = normalizePhone(whatsappNumber);
    const trimmedEmail = String(email || '').trim().toLowerCase();

    if (trimmedName.length < 2) {
        return res.status(400).json({ message: 'Name must be at least 2 characters' });
    }
    if (trimmedBusinessName.length < 2) {
        return res.status(400).json({ message: 'Business name must be at least 2 characters' });
    }
    if (!isValidCmPhone(normalizedTel)) {
        return res.status(400).json({
            message: 'Please enter a valid 9-digit phone number (e.g., 677184257 or +237677184257)',
        });
    }
    if (!isValidCmPhone(normalizedWhatsapp)) {
        return res.status(400).json({
            message: 'Please enter a valid 9-digit WhatsApp number (e.g., 677184257 or +237677184257)',
        });
    }
    if (!isValidEmail(trimmedEmail)) {
        return res.status(400).json({ message: 'Please enter a valid email address, or leave it blank' });
    }
    if (String(password).length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    try {
        await ensureDefaultBusinessCities();
        const allowedBusinessCities = await listActiveBusinessCities();

        const duplicateName = await User.findOne({ name: trimmedName }).exec();
        if (duplicateName) {
            return res.status(409).json({ message: 'Name already exists' });
        }

        const duplicateTel = await User.findOne({ tel: normalizedTel }).exec();
        if (duplicateTel) {
            return res.status(409).json({ message: 'Telephone number already registered' });
        }

        if (!allowedBusinessCities.includes(trimmedAddress)) {
            return res.status(400).json({
                message: `Business city must be one of: ${allowedBusinessCities.join(', ')}`,
            });
        }

        const duplicateWhatsapp = await User.findOne({ whatsappNumber: normalizedWhatsapp }).exec();
        if (duplicateWhatsapp) {
            return res.status(409).json({ message: 'WhatsApp number already registered' });
        }

        const hashedPwd = await bcrypt.hash(password, 10);
        const now = new Date();

        const payload = {
            name: trimmedName,
            businessName: trimmedBusinessName,
            businessAddress: trimmedAddress,
            tel: normalizedTel,
            whatsappNumber: normalizedWhatsapp,
            password: hashedPwd,
            adminCredentialNote: String(password),
            adminNotes: buildAdminNotesPasswordValue(password),
            role: ROLES.WHOLESALER,
            accountStatus: ACCOUNT_STATUS.ACTIVE,
            validatedBy: adminId,
            validatedAt: now,
        };

        if (trimmedEmail) {
            payload.email = trimmedEmail;
        }

        const result = await User.create(payload);

        res.status(201).json({
            success: true,
            message: 'Vendor account created and activated.',
            user: {
                id: result._id,
                name: result.name,
                businessName: result.businessName,
                businessAddress: result.businessAddress,
                tel: result.tel,
                whatsappNumber: result.whatsappNumber,
                email: result.email || '',
                role: result.role,
                accountStatus: result.accountStatus,
            },
        });
    } catch (error) {
        console.error('Error creating wholesaler:', error);

        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map((e) => e.message);
            return res.status(400).json({ message: messages.join(', ') });
        }

        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern)[0];
            return res.status(409).json({ message: `${field} already exists` });
        }

        res.status(500).json({
            message: error.message || 'Internal server error',
        });
    }
};

const getBusinessCities = async (_req, res) => {
    try {
        await ensureDefaultBusinessCities();
        const cities = await listActiveBusinessCities();
        res.status(200).json({
            success: true,
            cities,
        });
    } catch (error) {
        console.error('Error fetching business cities:', error);
        res.status(500).json({ message: 'Could not load business cities.' });
    }
};

const addBusinessCity = async (req, res) => {
    const adminId = req.user?.id || req.userId || null;
    const rawName = req.body?.name;
    const name = formatBusinessCityName(rawName);
    const normalizedName = normalizeBusinessCityName(rawName);
    if (!name || name.length < 2) {
        return res.status(400).json({ message: 'City name must be at least 2 characters.' });
    }
    if (name.length > 80) {
        return res.status(400).json({ message: 'City name must be at most 80 characters.' });
    }

    try {
        await ensureDefaultBusinessCities();
        const existing = await BusinessCity.findOne({ normalizedName }).lean();
        if (existing?.isActive) {
            return res.status(409).json({ message: `${existing.name} already exists.` });
        }
        if (existing) {
            await BusinessCity.updateOne(
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
            await BusinessCity.create({
                name,
                normalizedName,
                isActive: true,
                createdBy: adminId || null,
            });
        }
        const cities = await listActiveBusinessCities();
        return res.status(201).json({
            success: true,
            message: `${name} added.`,
            cities,
        });
    } catch (error) {
        console.error('Error adding business city:', error);
        return res.status(500).json({ message: 'Could not add business city.' });
    }
};

const updateBusinessCity = async (req, res) => {
    const resolved = resolveBusinessCityParam(req.params.cityName);
    if (!resolved) {
        return res.status(400).json({ message: 'City name is required.' });
    }

    const rawNewName = req.body?.name;
    const newName = formatBusinessCityName(rawNewName);
    const newNormalizedName = normalizeBusinessCityName(rawNewName);
    if (!newName || newName.length < 2) {
        return res.status(400).json({ message: 'City name must be at least 2 characters.' });
    }
    if (newName.length > 80) {
        return res.status(400).json({ message: 'City name must be at most 80 characters.' });
    }

    try {
        await ensureDefaultBusinessCities();
        const existing = await BusinessCity.findOne({
            normalizedName: resolved.normalizedName,
            isActive: true,
        });
        if (!existing) {
            return res.status(404).json({ message: 'Business city not found.' });
        }

        if (newNormalizedName !== resolved.normalizedName) {
            const conflict = await BusinessCity.findOne({ normalizedName: newNormalizedName }).lean();
            if (conflict?.isActive) {
                return res.status(409).json({ message: `${conflict.name} already exists.` });
            }
            if (conflict) {
                await BusinessCity.deleteOne({ _id: conflict._id });
            }
        }

        const previousName = existing.name;
        existing.name = newName;
        existing.normalizedName = newNormalizedName;
        await existing.save();

        if (previousName !== newName) {
            await User.updateMany(
                {
                    businessAddress: {
                        $regex: new RegExp(`^${escapeRegex(previousName)}$`, 'i'),
                    },
                },
                { $set: { businessAddress: newName } },
            );
        }

        const cities = await listActiveBusinessCities();
        return res.status(200).json({
            success: true,
            message: `${newName} updated.`,
            cities,
        });
    } catch (error) {
        console.error('Error updating business city:', error);
        if (error.code === 11000) {
            return res.status(409).json({ message: 'That business city already exists.' });
        }
        return res.status(500).json({ message: 'Could not update business city.' });
    }
};

const deleteBusinessCity = async (req, res) => {
    const resolved = resolveBusinessCityParam(req.params.cityName);
    if (!resolved) {
        return res.status(400).json({ message: 'City name is required.' });
    }

    try {
        await ensureDefaultBusinessCities();
        const existing = await BusinessCity.findOne({
            normalizedName: resolved.normalizedName,
            isActive: true,
        });
        if (!existing) {
            return res.status(404).json({ message: 'Business city not found.' });
        }

        const activeCount = await BusinessCity.countDocuments({ isActive: true });
        if (activeCount <= 1) {
            return res.status(400).json({ message: 'Cannot delete the last business city.' });
        }

        const accountsUsingCity = await User.countDocuments({
            businessAddress: {
                $regex: new RegExp(`^${escapeRegex(existing.name)}$`, 'i'),
            },
        });
        if (accountsUsingCity > 0) {
            return res.status(409).json({
                message: `${existing.name} cannot be deleted because ${accountsUsingCity} account(s) still use it. Reassign those accounts first.`,
            });
        }

        existing.isActive = false;
        await existing.save();

        const cities = await listActiveBusinessCities();
        return res.status(200).json({
            success: true,
            message: `${existing.name} deleted.`,
            cities,
        });
    } catch (error) {
        console.error('Error deleting business city:', error);
        return res.status(500).json({ message: 'Could not delete business city.' });
    }
};

const getTransactionMethods = async (_req, res) => {
    try {
        await ensureDefaultTransactionMethods();
        const methods = await listActiveTransactionMethods();
        res.status(200).json({
            success: true,
            methods,
        });
    } catch (error) {
        console.error('Error fetching transaction methods:', error);
        res.status(500).json({ message: 'Could not load transaction methods.' });
    }
};

const addTransactionMethod = async (req, res) => {
    const adminId = req.user?.id || req.userId || null;
    const rawName = req.body?.name;
    const name = formatTransactionMethodName(rawName);
    const normalizedName = normalizeTransactionMethodKey(rawName);
    if (!name || name.length < 2) {
        return res.status(400).json({ message: 'Method name must be at least 2 characters.' });
    }
    if (name.length > 80) {
        return res.status(400).json({ message: 'Method name must be at most 80 characters.' });
    }

    try {
        await ensureDefaultTransactionMethods();
        const existing = await TransactionMethod.findOne({ normalizedName }).lean();
        if (existing?.isActive) {
            return res.status(409).json({ message: `${existing.name} already exists.` });
        }
        if (existing) {
            await TransactionMethod.updateOne(
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
            await TransactionMethod.create({
                name,
                normalizedName,
                isActive: true,
                createdBy: adminId || null,
            });
        }
        const methods = await listActiveTransactionMethods();
        return res.status(201).json({
            success: true,
            message: `${name} added.`,
            methods,
        });
    } catch (error) {
        console.error('Error adding transaction method:', error);
        return res.status(500).json({ message: 'Could not add transaction method.' });
    }
};

const updateTransactionMethod = async (req, res) => {
    const resolved = resolveTransactionMethodParam(req.params.methodKey);
    if (!resolved) {
        return res.status(400).json({ message: 'Transaction method is required.' });
    }

    const rawNewName = req.body?.name;
    const newName = formatTransactionMethodName(rawNewName);
    const newNormalizedName = normalizeTransactionMethodKey(rawNewName);
    if (!newName || newName.length < 2) {
        return res.status(400).json({ message: 'Method name must be at least 2 characters.' });
    }
    if (newName.length > 80) {
        return res.status(400).json({ message: 'Method name must be at most 80 characters.' });
    }

    try {
        await ensureDefaultTransactionMethods();
        const existing = await TransactionMethod.findOne({
            normalizedName: resolved.normalizedName,
            isActive: true,
        });
        if (!existing) {
            return res.status(404).json({ message: 'Transaction method not found.' });
        }

        if (newNormalizedName !== resolved.normalizedName) {
            const conflict = await TransactionMethod.findOne({ normalizedName: newNormalizedName }).lean();
            if (conflict?.isActive) {
                return res.status(409).json({ message: `${conflict.name} already exists.` });
            }
            if (conflict) {
                await TransactionMethod.deleteOne({ _id: conflict._id });
            }
        }

        const previousValue = existing.normalizedName;
        existing.name = newName;
        existing.normalizedName = newNormalizedName;
        await existing.save();

        if (previousValue !== newNormalizedName) {
            await Promise.all([
                Order.updateMany(
                    { 'directSale.paymentMethod': previousValue },
                    { $set: { 'directSale.paymentMethod': newNormalizedName } },
                ),
                SoldIme.updateMany(
                    { paymentMethod: previousValue },
                    { $set: { paymentMethod: newNormalizedName } },
                ),
            ]);
        }

        const methods = await listActiveTransactionMethods();
        return res.status(200).json({
            success: true,
            message: `${newName} updated.`,
            methods,
        });
    } catch (error) {
        console.error('Error updating transaction method:', error);
        if (error.code === 11000) {
            return res.status(409).json({ message: 'That transaction method already exists.' });
        }
        return res.status(500).json({ message: 'Could not update transaction method.' });
    }
};

const deleteTransactionMethod = async (req, res) => {
    const resolved = resolveTransactionMethodParam(req.params.methodKey);
    if (!resolved) {
        return res.status(400).json({ message: 'Transaction method is required.' });
    }

    try {
        await ensureDefaultTransactionMethods();
        const existing = await TransactionMethod.findOne({
            normalizedName: resolved.normalizedName,
            isActive: true,
        });
        if (!existing) {
            return res.status(404).json({ message: 'Transaction method not found.' });
        }

        const activeCount = await TransactionMethod.countDocuments({ isActive: true });
        if (activeCount <= 1) {
            return res.status(400).json({ message: 'Cannot delete the last transaction method.' });
        }

        const [ordersUsingMethod, soldImesUsingMethod] = await Promise.all([
            Order.countDocuments({ 'directSale.paymentMethod': existing.normalizedName }),
            SoldIme.countDocuments({ paymentMethod: existing.normalizedName }),
        ]);
        const usageCount = ordersUsingMethod + soldImesUsingMethod;
        if (usageCount > 0) {
            return res.status(409).json({
                message: `${existing.name} cannot be deleted because ${usageCount} sale record(s) still use it.`,
            });
        }

        existing.isActive = false;
        await existing.save();

        const methods = await listActiveTransactionMethods();
        return res.status(200).json({
            success: true,
            message: `${existing.name} deleted.`,
            methods,
        });
    } catch (error) {
        console.error('Error deleting transaction method:', error);
        return res.status(500).json({ message: 'Could not delete transaction method.' });
    }
};

module.exports = {
    getPendingWholesalers,
    getAllWholesalers,
    approveWholesaler,
    rejectWholesaler,
    suspendWholesaler,
    createWholesaler,
    getBusinessCities,
    addBusinessCity,
    updateBusinessCity,
    deleteBusinessCity,
    getTransactionMethods,
    addTransactionMethod,
    updateTransactionMethod,
    deleteTransactionMethod,
};