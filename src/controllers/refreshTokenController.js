// refreshTokenController.js
const User = require('../models/User');
const jwt = require('jsonwebtoken');

const handleRefreshToken = async (req, res) => {
    console.log('Refresh endpoint called');
    console.log('Cookies received:', req.cookies);
    
    const cookies = req.cookies;
    if (!cookies?.jwt) {
        console.log('No JWT cookie found');
        return res.status(401).json({"message": "No refresh token cookie found"});
    }
    
    console.log('Refresh token found:', cookies.jwt.substring(0, 20) + '...');
    const refreshToken = cookies.jwt;
    
    try {
        const foundUser = await User.findOne({ refreshToken }).exec();
        if (!foundUser) {
            console.log('No user found with this refresh token');
            return res.status(403).json({"message": "Invalid refresh token"});
        }
        
        console.log('User found:', foundUser.name);

        jwt.verify(
            refreshToken,
            process.env.REFRESH_TOKEN_SECRET,
            async (err, decoded) => {
                if (err) {
                    console.log('JWT verification error:', err.message);
                    return res.status(403).json({"message": "Token verification failed"});
                }
                
                console.log('Decoded token:', decoded);
                
                if (foundUser.name !== decoded.name) {
                    console.log('Username mismatch:', foundUser.name, 'vs', decoded.name);
                    return res.status(403).json({"message": "Token mismatch"});
                }
                
                const role = foundUser.role;
                
                const accessToken = jwt.sign(
                    {
                        "UserInfo": {
                            "name": decoded.name,
                            "role": role
                        }
                    },
                    process.env.ACCESS_TOKEN_SECRET,
                    { expiresIn: '20s' }
                );
               
                const newRefreshToken = jwt.sign(
                    { "name": foundUser.name },
                    process.env.REFRESH_TOKEN_SECRET,
                    { expiresIn: '1d' }
                );
                
                foundUser.refreshToken = newRefreshToken;
                await foundUser.save();
                console.log('New refresh token saved for user:', foundUser.name);
                
                res.cookie('jwt', newRefreshToken, { 
                    httpOnly: true, 
                    secure: false,
                    sameSite: 'Lax',
                    maxAge: 24 * 60 * 60 * 1000 
                });
                
                res.json({ role, accessToken });
            }
        );
    } catch (error) {
        console.error("Refresh token error:", error);
        res.status(500).json({"message": "Server error"});
    }
}

// Make sure this export matches what you're importing
module.exports = {
    handleRefreshToken
};