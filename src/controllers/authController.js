const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const isProduction = process.env.NODE_ENV === 'production';

const handleLogin = async (req, res) => {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ 'message': 'Username and password are required.' });
    
    const foundUser = await User.findOne({ name: name }).exec();
    if (!foundUser) return res.sendStatus(401); //Unauthorized 
    
    console.log(foundUser);
    const match = await bcrypt.compare(password, foundUser.password);
    console.log(match);
    
    if (match) {
        const role = foundUser.role;
        const name = foundUser.name;
        const userId = foundUser._id; // ← GET THE USER ID
        const businessName = foundUser.businessName; // ← ADD BUSINESS NAME
        const accountStatus = foundUser.accountStatus; // ← ADD ACCOUNT STATUS
        
        // Create JWTs
        const accessToken = jwt.sign(
            {
                "UserInfo": {
                    "userId": userId, // ← ADD USER ID TO TOKEN
                    "name": foundUser.name,
                    "role": role
                }
            },
            process.env.ACCESS_TOKEN_SECRET,
            { expiresIn: '20s' } // Consider increasing this to '15m' or '1h' for production
        );
        
        const refreshToken = jwt.sign(
            { 
                "userId": userId, // ← ADD USER ID TO REFRESH TOKEN
                "name": foundUser.name 
            },
            process.env.REFRESH_TOKEN_SECRET,
            { expiresIn: '1d' }
        );
        
        // Saving refreshToken with current user
        foundUser.refreshToken = refreshToken;
        await foundUser.save(); // Added await
        console.log('Refresh token saved for user:', foundUser.name);

        // Creates Secure Cookie with refresh token
        res.cookie('jwt', refreshToken, { 
            httpOnly: true, 
            secure: isProduction,
            sameSite: isProduction ? 'None' : 'Lax',
            maxAge: 24 * 60 * 60 * 1000 
        });

        console.log('Cookie set with refresh token');
        
        // Send user data to frontend including _id
        res.json({ 
            success: true,
            message: 'Login successful',
            user: {
                _id: userId, // ← USER ID SENT TO FRONTEND
                name: name,
                role: role,
                businessName: businessName,
                accountStatus: accountStatus
            },
            accessToken,
            // Optionally include other user data your frontend needs
            // refreshToken is NOT sent to frontend for security (only in HTTP-only cookie)
        });

    } else {
        res.sendStatus(401);
    }
}

module.exports = { handleLogin };
