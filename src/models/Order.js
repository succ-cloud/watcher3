const mongoose = require('mongoose');

const ORDER_TYPES = {
  BUY: 'buy',
  OFFER: 'offer'
};

const ORDER_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled'
};

const NOTIFICATION_AUDIENCE = {
  SALESMAN: 'salesman',
  ADMIN: 'admin',
  USER: 'user'
};

const orderSchema = new mongoose.Schema({
  // User Information
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Order Details
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
    index: true
  },
  
  productName: {
    type: String,
    required: true,
    trim: true
  },
  
  productPrice: {
    type: Number,
    required: true
  },
  
  orderType: {
    type: String,
    enum: Object.values(ORDER_TYPES),
    required: true,
    index: true
  },
  
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  
  // For offer orders (negotiation)
  offeredPrice: {
    type: Number,
    min: 0,
    validate: {
      validator: function(value) {
        // Only required for offer orders
        if (this.orderType === ORDER_TYPES.OFFER) {
          return value != null && value > 0;
        }
        return true;
      },
      message: 'Offered price is required for offer orders'
    }
  },
  
  // Original total price (quantity * product price)
  originalTotal: {
    type: Number,
    required: true
  },
  
  // Final agreed price (if accepted)
  finalPrice: {
    type: Number,
    min: 0
  },
  
  // Order Status
  status: {
    type: String,
    enum: Object.values(ORDER_STATUS),
    default: ORDER_STATUS.PENDING,
    index: true
  },
  
  // Who should handle this order
  notifyAudience: {
    type: String,
    enum: Object.values(NOTIFICATION_AUDIENCE),
    required: true
  },
  
  // Who handled/processed this order
  handledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  handledAt: {
    type: Date,
    default: null
  },
  
  // Rejection reason if applicable
  rejectionReason: {
    type: String,
    trim: true,
    maxlength: 500
  },
  
  // Staff notes
  staffNotes: {
    type: String,
    trim: true,
    maxlength: 500
  },
  
  // User notes
  userNotes: {
    type: String,
    trim: true,
    maxlength: 500
  }
}, {
  timestamps: true
});

// Indexes for better query performance
orderSchema.index({ userId: 1, status: 1 });
orderSchema.index({ notifyAudience: 1, status: 1 });
orderSchema.index({ createdAt: -1 });

// Virtual for total price based on order type
orderSchema.virtual('totalPrice').get(function() {
  if (this.orderType === ORDER_TYPES.OFFER && this.finalPrice) {
    return this.finalPrice;
  }
  return this.originalTotal;
});

// Method to check if order is pending
orderSchema.methods.isPending = function() {
  return this.status === ORDER_STATUS.PENDING;
};

// Method to accept order
orderSchema.methods.accept = async function(handledById, finalPrice = null) {
  this.status = ORDER_STATUS.ACCEPTED;
  this.handledBy = handledById;
  this.handledAt = new Date();
  
  if (this.orderType === ORDER_TYPES.OFFER && finalPrice) {
    this.finalPrice = finalPrice;
  }
  
  return this.save();
};

// Method to reject order
orderSchema.methods.reject = async function(handledById, reason) {
  this.status = ORDER_STATUS.REJECTED;
  this.handledBy = handledById;
  this.handledAt = new Date();
  this.rejectionReason = reason;
  
  return this.save();
};

// Method to cancel order (by user)
orderSchema.methods.cancel = async function() {
  this.status = ORDER_STATUS.CANCELLED;
  return this.save();
};

// Static method to get orders by user
orderSchema.statics.findByUser = function(userId) {
  return this.find({ userId }).sort({ createdAt: -1 });
};

// Static method to get pending orders by audience
orderSchema.statics.findPendingByAudience = function(audience) {
  return this.find({ 
    notifyAudience: audience, 
    status: ORDER_STATUS.PENDING 
  }).sort({ createdAt: -1 });
};

module.exports = {
  Order: mongoose.model('Order', orderSchema),
  ORDER_TYPES,
  ORDER_STATUS,
  NOTIFICATION_AUDIENCE
};