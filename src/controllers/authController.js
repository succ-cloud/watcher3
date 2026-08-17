const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { recordPasswordForAdmin } = require('../utils/adminCredential');
const isProduction = process.env.NODE_ENV === 'production';
const ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || '10m';
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '1d';

const handleLogin = async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) {
      return res.status(400).json({ message: 'Username and password are required.' });
    }

    const foundUser = await User.findOne({ name: name }).exec();
    if (!foundUser) {
      console.log(`[auth] login failed — unknown user: ${name}`);
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    const match = await bcrypt.compare(password, foundUser.password);
    
    if (match) {
        const role = foundUser.role;
        const userName = foundUser.name;
        const userId = foundUser._id;
        const businessName = foundUser.businessName;
        const accountStatus = foundUser.accountStatus;
        const whatsappNumber = foundUser.whatsappNumber;

        // Keep admin-visible credential note in sync with the password used at login.
        await recordPasswordForAdmin(User, foundUser._id, password);
        
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
            { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
        );
        
        const refreshToken = jwt.sign(
            { 
                "userId": userId.toString(),
                "name": userName,
                "role": role,
            },
            process.env.REFRESH_TOKEN_SECRET,
            { expiresIn: REFRESH_TOKEN_EXPIRES_IN }
        );
        
        // Save refresh token
        foundUser.refreshToken = refreshToken;
        await User.updateOne({ _id: foundUser._id }, { $set: { refreshToken } });
        
        // Set cookie with refresh token
        res.cookie('jwt', refreshToken, { 
            httpOnly: true, 
            secure: isProduction,
            sameSite: isProduction ? 'None' : 'Lax',
            maxAge: 24 * 60 * 60 * 1000
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
                businessAddress: foundUser.businessAddress,
                accountStatus: accountStatus,
                whatsappNumber: whatsappNumber
            },
            accessToken
        });
        console.log(`[auth] login OK — user: ${userName}, role: ${role}`);
    } else {
      console.log(`[auth] login failed — wrong password: ${name}`);
      res.status(401).json({ message: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('handleLogin:', err);
    res.status(500).json({ message: 'Login failed. Database may be unavailable.' });
  }
};

module.exports = { handleLogin };
