// refreshTokenController.js
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const isProduction = process.env.NODE_ENV === 'production';
const ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || '10m';
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '1d';

const handleRefreshToken = async (req, res) => {
    const cookies = req.cookies;
    if (!cookies?.jwt) {
        return res.status(401).json({"message": "No refresh token cookie found"});
    }

    const refreshToken = cookies.jwt;
    
    try {
        const foundUser = await User.findOne({ refreshToken }).exec();
        if (!foundUser) {
            return res.status(403).json({"message": "Invalid refresh token"});
        }

        jwt.verify(
            refreshToken,
            process.env.REFRESH_TOKEN_SECRET,
            async (err, decoded) => {
                if (err) {
                    return res.status(403).json({"message": "Token verification failed"});
                }

                const decodedUserId = String(decoded?.userId || '').trim();
                const dbUserId = String(foundUser?._id || '').trim();
                if ((decodedUserId && decodedUserId !== dbUserId) || (!decodedUserId && foundUser.name !== decoded.name)) {
                    return res.status(403).json({"message": "Token mismatch"});
                }
                
                const role = foundUser.role;
                
                const accessToken = jwt.sign(
                    {
                        "UserInfo": {
                            "userId": dbUserId,
                            "name": decoded.name,
                            "role": role
                        }
                    },
                    process.env.ACCESS_TOKEN_SECRET,
                    { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
                );
               
                const newRefreshToken = jwt.sign(
                    {
                        "userId": dbUserId,
                        "name": foundUser.name,
                        "role": role,
                    },
                    process.env.REFRESH_TOKEN_SECRET,
                    { expiresIn: REFRESH_TOKEN_EXPIRES_IN }
                );
                
                foundUser.refreshToken = newRefreshToken;
                await foundUser.save();
                
                res.cookie('jwt', newRefreshToken, { 
                    httpOnly: true, 
                    secure: isProduction,
                    sameSite: isProduction ? 'None' : 'Lax',
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
