const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const isProduction = process.env.NODE_ENV === 'production';

const handleLogin = async (req, res) => {
    const { name, password } = req.body;
    if (!name || !password) {
        return res.status(400).json({ message: 'Username and password are required.' });
    }
    
    const foundUser = await User.findOne({ name: name }).exec();
    if (!foundUser) {
        return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    const match = await bcrypt.compare(password, foundUser.password);
    
    if (match) {
        const role = foundUser.role;
        const userName = foundUser.name;
        const userId = foundUser._id;
        const businessName = foundUser.businessName;
        const accountStatus = foundUser.accountStatus;
        
        // Create JWTs - Keep the structure consistent
        const accessToken = jwt.sign(
            {
                "UserInfo": {
                    "userId": userId.toString(), // Convert ObjectId to string
                    "name": userName,
                    "role": role
                }
            },
            process.env.ACCESS_TOKEN_SECRET,
            { expiresIn: '1h' }
        );
        
        const refreshToken = jwt.sign(
            { 
                "userId": userId.toString(),
                "name": userName 
            },
            process.env.REFRESH_TOKEN_SECRET,
            { expiresIn: '7d' } // 7 days
        );
        
        // Save refresh token
        foundUser.refreshToken = refreshToken;
        await foundUser.save();
        
        // Set cookie with refresh token
        res.cookie('jwt', refreshToken, { 
            httpOnly: true, 
            secure: isProduction,
            sameSite: isProduction ? 'None' : 'Lax',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });
        
        // Send response
        res.json({ 
            success: true,
            message: 'Login successful',
            user: {
                _id: userId,
                name: userName,
                role: role,
                businessName: businessName,
                accountStatus: accountStatus
            },
            accessToken
        });
    } else {
        res.status(401).json({ message: 'Invalid credentials' });
    }
}

module.exports = { handleLogin };
