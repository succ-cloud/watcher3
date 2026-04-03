const mongoose = require('mongoose');

const ORDER_TYPES = {
  BUY: 'buy',
  OFFER: 'offer'
};

const ORDER_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  DELIVERED: 'delivered'
};

const NOTIFICATION_AUDIENCE = {
  SALESMAN: 'salesman',
  ADMIN: 'admin',
  USER: 'user'
};

const orderSchema = new mongoose.Schema({
  // User Information (reference)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // ==================== SNAPSHOT OF USER BUSINESS DETAILS AT ORDER TIME ====================
  // These fields capture the user's business information at the moment of order creation
  businessName: {
    type: String,
    required: true,
    trim: true
  },
  
  businessAddress: {
    type: String,
    required: true,
    trim: true
  },
  
  tel: {
    type: String,
    required: true,
    trim: true
  },
  
  whatsappNumber: {
    type: String,
    required: true,
    trim: true
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
  },
  
  // ==================== DELIVERY INFORMATION ====================
  deliveryInfo: {
    estimatedDeliveryDate: {
      type: Date,
      default: null
    },
    actualDeliveryDate: {
      type: Date,
      default: null
    },
    deliveryAddress: {
      type: String,
      trim: true,
      maxlength: 500
    },
    trackingNumber: {
      type: String,
      trim: true,
      default: ''
    },
    courierService: {
      type: String,
      trim: true,
      default: ''
    },
    deliveryNotes: {
      type: String,
      trim: true,
      maxlength: 500
    },
    deliveryStatus: {
      type: String,
      enum: ['pending', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'failed'],
      default: 'pending'
    }
  }
}, {
  timestamps: true
});

// Indexes for better query performance
orderSchema.index({ userId: 1, status: 1 });
orderSchema.index({ notifyAudience: 1, status: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ 'deliveryInfo.deliveryStatus': 1 });
orderSchema.index({ 'deliveryInfo.estimatedDeliveryDate': 1 });
orderSchema.index({ tel: 1 });
orderSchema.index({ businessName: 1 });

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
orderSchema.methods.accept = async function(handledById, finalPrice = null, deliveryData = null) {
  this.status = ORDER_STATUS.ACCEPTED;
  this.handledBy = handledById;
  this.handledAt = new Date();
  
  if (this.orderType === ORDER_TYPES.OFFER && finalPrice) {
    this.finalPrice = finalPrice;
  }
  
  // Set delivery information if provided
  if (deliveryData) {
    this.deliveryInfo = {
      ...this.deliveryInfo,
      ...deliveryData
    };
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

// Method to update delivery information
orderSchema.methods.updateDeliveryInfo = async function(deliveryData) {
  this.deliveryInfo = {
    ...this.deliveryInfo,
    ...deliveryData
  };
  
  // If delivery status is 'delivered', update order status
  if (deliveryData.deliveryStatus === 'delivered') {
    this.status = ORDER_STATUS.DELIVERED;
    this.deliveryInfo.actualDeliveryDate = new Date();
  }
  
  return this.save();
};

// Method to set delivery date
orderSchema.methods.setDeliveryDate = async function(estimatedDate) {
  this.deliveryInfo.estimatedDeliveryDate = estimatedDate;
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

// Static method to get orders by delivery status
orderSchema.statics.findByDeliveryStatus = function(deliveryStatus) {
  return this.find({ 'deliveryInfo.deliveryStatus': deliveryStatus })
    .sort({ 'deliveryInfo.estimatedDeliveryDate': 1 });
};

module.exports = {
  Order: mongoose.model('Order', orderSchema),
  ORDER_TYPES,
  ORDER_STATUS,
  NOTIFICATION_AUDIENCE
};
