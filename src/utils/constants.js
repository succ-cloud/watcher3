
// src/utils/jwt.js)

const jwt = require('jsonwebtoken');

// Generate tokens
const generateToken = (payload, secret, expiresIn) => {
  return jwt.sign(payload, secret, {
    expiresIn,
    issuer: 'product-api',
    audience: 'product-client'
  });
};

// Verify token
const verifyToken = (token, secret) => {
  try {
    return jwt.verify(token, secret, {
      issuer: 'product-api',
      audience: 'product-client'
    });
  } catch (error) {
    throw error;
  }
};

// Decode token without verification
const decodeToken = (token) => {
  return jwt.decode(token);
};

module.exports = {
  generateToken,
  verifyToken,
  decodeToken
};