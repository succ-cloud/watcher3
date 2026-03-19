const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Define user roles
const ROLES = {
  WHOLESALER: 'wholesaler',
  SALESMAN: 'salesman',
  ADMIN: 'admin'
};

// Define account status
const ACCOUNT_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  REJECTED: 'rejected'
};

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    minlength: [2, 'Name must be at least 2 characters'],
    maxlength: [50, 'Name cannot exceed 50 characters']
  },
  
  businessName: {
    type: String,
    required: [true, 'Business name is required'],
    trim: true,
    minlength: [2, 'Business name must be at least 2 characters'],
    maxlength: [100, 'Business name cannot exceed 100 characters']
  },
  
  businessAddress: {
    type: String,
    required: [true, 'Business address is required'],
    trim: true,
    minlength: [5, 'Business address must be at least 5 characters'],
    maxlength: [200, 'Business address cannot exceed 200 characters']
  },
  
  tel: {
    type: String,
    required: [true, 'Telephone number is required'],
    unique: true,
    trim: true,
    validate: {
      validator: function (v) {
        const phoneRegex = /^(?:\+237|00237)?\d{9}$/;
        return phoneRegex.test(v.replace(/\s/g, ''));
      },
      message: 'Please enter a valid 9-digit phone number (e.g., 677184257 or +237677184257)'
    }
  },
  
  whatsappNumber: {
    type: String,
    required: [true, 'WhatsApp number is required'],
    trim: true,
    validate: {
      validator: function (v) {
        const phoneRegex = /^(?:\+237|00237)?\d{9}$/;
        return phoneRegex.test(v.replace(/\s/g, ''));
      },
      message: 'Please enter a valid 9-digit WhatsApp number (e.g., 677184257 or +237677184257)'
    }
  },
  
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters'],
  },
  
  role: {
    type: String,
    enum: Object.values(ROLES),
    default: ROLES.WHOLESALER
  },

  accountStatus: {
    type: String,
    enum: Object.values(ACCOUNT_STATUS),
    default: function() {
      // If role is wholesaler, default to pending, otherwise active
      return this.role === ROLES.WHOLESALER ? ACCOUNT_STATUS.PENDING : ACCOUNT_STATUS.ACTIVE;
    }
  },

  refreshToken: String,
  
  // Track when account was validated and by whom
  validatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  validatedAt: {
    type: Date
  },
  
  // Store rejection reason if any
  rejectionReason: {
    type: String
  },
  
  // Additional notes from admin
  adminNotes: {
    type: String
  }
}, {
  timestamps: true // Adds createdAt and updatedAt automatically
});

module.exports = mongoose.model('User', userSchema);
module.exports.ROLES = ROLES;
module.exports.ACCOUNT_STATUS = ACCOUNT_STATUS;