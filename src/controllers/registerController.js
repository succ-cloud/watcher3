const User = require('../models/User');
const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');
const { ROLES } = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const normalizeRoleToken = require('../utils/normalizeRoleToken');
const { buildAdminNotesPasswordValue } = require('../utils/adminCredential');
const { ensureDefaultBusinessCities, listActiveBusinessCities } = require('../utils/businessCities');
const { resolveBusinessAddressFromShopIds } = require('../utils/salesmanShopRouting');

const SALESPERSON_BUSINESS_NAME = 'wachesales';
const ADMIN_STAFF_BUSINESS_NAME = 'Wache';

function normalizeShopIdList(raw) {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

function isAdminRequest(req) {
    try {
        const authHeader = req.headers.authorization || req.headers.Authorization;
        if (!authHeader || !String(authHeader).startsWith('Bearer ')) return false;
        const token = String(authHeader).split(' ')[1];
        if (!token || !process.env.ACCESS_TOKEN_SECRET) return false;
        const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
        const info =
            decoded.UserInfo && typeof decoded.UserInfo === 'object'
                ? { ...decoded.UserInfo, role: decoded.UserInfo.role ?? decoded.role }
                : decoded;
        const role = normalizeRoleToken(info.role ?? info.Role ?? decoded.role);
        return role === ROLES.ADMIN;
    } catch {
        return false;
    }
}

function resolveStaffBusinessName(role, businessName) {
    if (role === ROLES.SALESMAN) return SALESPERSON_BUSINESS_NAME;
    if (role === ROLES.ADMIN) {
        const trimmed = String(businessName || '').trim();
        return trimmed || ADMIN_STAFF_BUSINESS_NAME;
    }
    return String(businessName || '').trim();
}

const handleNewUser = async (req, res) => {
    // Extract all fields from request body based on schema
    const { 
        name,                    
        businessName, 
        businessAddress, 
        tel, 
        whatsappNumber, 
        password, 
        role,
        assignedShopIds,
        shopIds,
    } = req.body;

    // Validate required fields
    const userRole = role || ROLES.WHOLESALER;
    const allowedRoles = [ROLES.WHOLESALER, ROLES.SALESMAN, ROLES.ADMIN];
    if (!allowedRoles.includes(userRole)) {
        return res.status(400).json({ message: 'Invalid role.' });
    }

    if (userRole === ROLES.SALESMAN || userRole === ROLES.ADMIN) {
        if (!isAdminRequest(req)) {
            return res.status(403).json({ message: 'Only an admin can create staff accounts.' });
        }
    }

    const resolvedBusinessName = resolveStaffBusinessName(userRole, businessName);
    const shopIdList = normalizeShopIdList(assignedShopIds ?? shopIds);

    if (userRole === ROLES.SALESMAN && !shopIdList.length) {
        return res.status(400).json({
            message: 'Assign at least one Shop. The salesperson business city is taken from that Shop.',
        });
    }

    if (!name || !tel || !whatsappNumber || !password) {
        return res.status(400).json({
            message: 'All fields are required: name, tel, whatsappNumber, password',
        });
    }

    if (userRole !== ROLES.SALESMAN && !String(businessAddress || '').trim()) {
        return res.status(400).json({
            message: 'Business city is required.',
        });
    }

    if (userRole === ROLES.WHOLESALER && !resolvedBusinessName) {
        return res.status(400).json({
            message: 'Business name is required for vendor accounts.',
        });
    }

    // Validate password length
    if (password.length < 8) {
        return res.status(400).json({ 
            'message': 'Password must be at least 8 characters long' 
        });
    }

    try {
        await ensureDefaultBusinessCities();
        const allowedBusinessCities = await listActiveBusinessCities();

        if (userRole === ROLES.SALESMAN && shopIdList.length) {
            const shopCount = await Warehouse.countDocuments({
                _id: { $in: shopIdList },
                type: WAREHOUSE_TYPES.SUB,
                isActive: true,
            });
            if (shopCount !== shopIdList.length) {
                return res.status(400).json({ message: 'One or more assigned shops are invalid.' });
            }
        }

        let normalizedBusinessAddress = String(businessAddress || '').trim();
        if (userRole === ROLES.SALESMAN) {
            normalizedBusinessAddress = await resolveBusinessAddressFromShopIds(shopIdList);
            if (!normalizedBusinessAddress) {
                return res.status(400).json({
                    message: 'Could not determine business city from the assigned Shop.',
                });
            }
        }

        if (!allowedBusinessCities.includes(normalizedBusinessAddress)) {
            return res.status(400).json({
                message: `Business city must be one of: ${allowedBusinessCities.join(', ')}`,
            });
        }

        // Check for duplicate name
        const duplicate = await User.findOne({ name }).exec();
        if (duplicate) {
            return res.status(409).json({ 'message': 'Name already exists' });
        }

        // Check for duplicate telephone number
        const duplicateTel = await User.findOne({ tel }).exec();
        if (duplicateTel) {
            return res.status(409).json({ 'message': 'Telephone number already registered' });
        }

        const userRoleFinal = userRole;

        // Encrypt password
        const hashedPwd = await bcrypt.hash(password, 10);

        const createPayload = {
            name,
            businessName: resolvedBusinessName,
            businessAddress: normalizedBusinessAddress,
            tel,
            whatsappNumber,
            password: hashedPwd,
            adminCredentialNote: String(password),
            adminNotes: buildAdminNotesPasswordValue(password),
            role: userRoleFinal,
            assignedShops: userRoleFinal === ROLES.SALESMAN ? shopIdList : [],
        };

        const result = await User.create(createPayload);

        console.log('New user created:', {
            id: result._id,
            name: result.name,
            role: result.role,
            status: result.accountStatus
        });

        // Prepare response based on role
        const userResponse = {
            name: result.name,
            businessName: result.businessName,
            role: result.role,
            accountStatus: result.accountStatus,
            message: result.role === 'wholesaler'
                ? 'Account created successfully. Please wait for admin validation.'
                : 'Account created successfully.'
        };

        res.status(201).json({ 
            'success': true,
            'message': userResponse.message,
            'user': userResponse 
        });

    } catch (err) {
        console.error('Error creating user:', err);
        
        // Handle validation errors from mongoose
        if (err.name === 'ValidationError') {
            const messages = Object.values(err.errors).map(e => e.message);
            return res.status(400).json({ 'message': messages.join(', ') });
        }
        
        // Handle duplicate key error
        if (err.code === 11000) {
            const field = Object.keys(err.keyPattern)[0];
            return res.status(409).json({ 'message': `${field} already exists` });
        }

        res.status(500).json({ 'message': 'Internal server error' });
    }
};

module.exports = {
    handleNewUser
};