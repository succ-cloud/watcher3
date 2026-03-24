const jwt = require('jsonwebtoken');

const verifyJWT = (req, res, next) => {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log('No token provided or invalid format');
        return res.status(401).json({ message: 'No token provided' });
    }
    
    const token = authHeader.split(' ')[1];
    
    console.log('Verifying token...');
    
    jwt.verify(
        token,
        process.env.ACCESS_TOKEN_SECRET,
        (err, decoded) => {
            if (err) {
                console.log('JWT verification error:', err.message);
                console.log('Token:', token.substring(0, 20) + '...'); // Log first 20 chars
                
                if (err.name === 'TokenExpiredError') {
                    return res.status(403).json({ message: 'Token has expired' });
                }
                if (err.name === 'JsonWebTokenError') {
                    return res.status(403).json({ message: 'Invalid token' });
                }
                return res.status(403).json({ message: 'Invalid or expired token' });
            }
            
            console.log('Token verified successfully');
            console.log('Decoded payload:', decoded);
            
            // Add user info to request object
            req.user = decoded.UserInfo;
            req.userId = decoded.UserInfo.userId;
            req.userName = decoded.UserInfo.name;
            req.role = decoded.UserInfo.role;
            
            next();
        }
    );
};

module.exports = verifyJWT;
