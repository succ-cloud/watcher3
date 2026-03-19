const jwt = require('jsonwebtoken');

const verifyJWT = (req, res, next) => {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'No token provided' });
    }
    
    const token = authHeader.split(' ')[1];
    
    jwt.verify(
        token,
        process.env.ACCESS_TOKEN_SECRET,
        (err, decoded) => {
            if (err) {
                console.log('JWT verification error:', err.message);
                return res.status(403).json({ message: 'Invalid or expired token' });
            }
            
            // Add user info to request object
            req.user = decoded.UserInfo.name;
            req.role = decoded.UserInfo.role;
            next();
        }
    );
};

module.exports = verifyJWT;