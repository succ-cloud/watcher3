
// token model


const mongoose = require('mongoose');

const tokenSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  token: {
    type: String,
    required: true
  },
  
  type: {
    type: String,
    enum: ['refresh', 'access', 'password-reset', 'email-verification'],
    required: true,
    index: true
  },
  
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  
  blacklisted: {
    type: Boolean,
    default: false,
    index: true
  },
  
  userAgent: String,
  ipAddress: String,
  
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 60 * 60 * 24 * 7 // Automatically delete after 7 days
  }
});

// Compound index for efficient queries
tokenSchema.index({ userId: 1, type: 1, blacklisted: 1 });
tokenSchema.index({ token: 1 }, { unique: true, sparse: true });

// Static method to blacklist all user tokens
tokenSchema.statics.blacklistAllUserTokens = async function(userId, type = null) {
  const query = { userId };
  if (type) query.type = type;
  
  return this.updateMany(query, { blacklisted: true });
};

// Static method to cleanup expired tokens
tokenSchema.statics.cleanup = async function() {
  return this.deleteMany({ expiresAt: { $lt: new Date() } });
};

const Token = mongoose.model('Token', tokenSchema);

module.exports = Token;