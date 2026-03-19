const User = require('../models/User');
const bcrypt = require('bcrypt');

const handleNewUser = async (req, res) => {
    // Extract all fields from request body based on schema
    const { 
        name,                    
        businessName, 
        businessAddress, 
        tel, 
        whatsappNumber, 
        password, 
        role 
    } = req.body;

    // Validate required fields
    if (!name || !businessName || !businessAddress || !tel || !whatsappNumber || !password) {
        return res.status(400).json({ 
            'message': 'All fields are required: name, businessName, businessAddress, tel, whatsappNumber, password' 
        });
    }

    // Validate password length
    if (password.length < 8) {
        return res.status(400).json({ 
            'message': 'Password must be at least 8 characters long' 
        });
    }

    try {
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

        // Encrypt password
        const hashedPwd = await bcrypt.hash(password, 10);

        // Create new user
        const result = await User.create({
            name,
            businessName,
            businessAddress,
            tel,
            whatsappNumber,
            password: hashedPwd,
            role: role || 'wholesaler'
            // accountStatus will be set automatically by the schema default function
        });

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