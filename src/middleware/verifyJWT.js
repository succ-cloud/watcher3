const jwt = require('jsonwebtoken');

/**
 * Verifies Bearer JWT. Sets `req.user` (decoded payload / UserInfo) and `req.userId` (Mongo id string).
 * Align with paybackend: decoded.UserInfo.userId is common.
 */
function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !String(authHeader).startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const token = String(authHeader).split(' ')[1];
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const secret = process.env.ACCESS_TOKEN_SECRET;
  if (!secret) {
    console.error('verifyJWT: ACCESS_TOKEN_SECRET is not set');
    return res.status(500).json({ message: 'Server auth misconfiguration' });
  }
  jwt.verify(token, secret, (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired token' });
    }
    /**
     * Paybackend-style tokens often put `userId` inside `UserInfo` but leave `role` at the
     * JWT root. If we only pass `UserInfo` to verifyRole, admins get 403 on routes like GET /users/:id.
     */
    let info;
    if (decoded.UserInfo && typeof decoded.UserInfo === 'object') {
      info = { ...decoded.UserInfo };
      if (info.role == null && info.Role == null) {
        if (decoded.role != null) info.role = decoded.role;
        else if (decoded.Role != null) info.role = decoded.Role;
      }
      if (!Array.isArray(info.roles) && Array.isArray(decoded.roles)) {
        info.roles = decoded.roles;
      }
    } else {
      info = { ...decoded };
    }
    req.user = info;
    req.userId =
      info.userId ||
      info.id ||
      info._id ||
      decoded.userId ||
      decoded.sub ||
      null;
    if (!req.userId) {
      return res.status(403).json({ message: 'Token missing user id' });
    }
    next();
  });
}

module.exports = verifyJWT;
