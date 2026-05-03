// models/Order.js - Complete Updated Schema

const mongoose = require('mongoose');

const ORDER_TYPES = {
  BUY: 'buy',
  OFFER: 'offer',
  PREORDER: 'preorder'
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

const PRODUCT_SOURCE = {
  CATALOG: 'catalog',
  CUSTOM: 'custom'
};

const URGENCY_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  URGENT: 'urgent'
};

const DELIVERY_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SHIPPED: 'shipped',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  FAILED: 'failed'
};

const orderSchema = new mongoose.Schema({
  // ==================== USER INFORMATION (REFERENCE) ====================
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // ==================== SNAPSHOT OF USER BUSINESS DETAILS AT ORDER TIME ====================
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
  
  // ==================== ORDER DETAILS ====================
  // Product ID - Now optional to support custom products
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: false,
    index: true,
    default: null
  },
  
  // Product name - Always required (for catalog products, this is the product name;
  // for custom products, this is the user's provided name)
  productName: {
    type: String,
    required: true,
    trim: true
  },
  
  // Product price - Optional for custom products (price negotiated later)
  productPrice: {
    type: Number,
    required: false,
    default: null,
    min: 0
  },
  
  // Track where the product came from
  productSource: {
    type: String,
    enum: Object.values(PRODUCT_SOURCE),
    default: PRODUCT_SOURCE.CATALOG
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
  
  // ==================== PRICE INFORMATION ====================
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
  
  // Original total price (quantity * product price) - Optional for custom products
  originalTotal: {
    type: Number,
    required: false,
    default: null,
    min: 0
  },
  
  // Final agreed price (if accepted)
  finalPrice: {
    type: Number,
    min: 0,
    default: null
  },
  
  // ==================== CUSTOM PRODUCT SUPPORT (FOR PREORDERS) ====================
  // Flag to indicate if this is a custom/unlisted product
  isCustomProduct: {
    type: Boolean,
    default: false
  },
  
  // Custom product details (for products not in database)
  customProduct: {
    name: {
      type: String,
      trim: true,
      default: null
    },
    description: {
      type: String,
      trim: true,
      default: null,
      maxlength: 1000
    },
    specifications: {
      type: String,
      trim: true,
      default: null,
      maxlength: 2000
    },
    brand: {
      type: String,
      trim: true,
      default: null
    },
    model: {
      type: String,
      trim: true,
      default: null
    },
    // For preorders - target price range
    targetPriceMin: {
      type: Number,
      default: null,
      min: 0
    },
    targetPriceMax: {
      type: Number,
      default: null,
      min: 0
    },
    // Additional custom fields
    color: {
      type: String,
      trim: true,
      default: null
    },
    size: {
      type: String,
      trim: true,
      default: null
    },
    weight: {
      type: String,
      trim: true,
      default: null
    },
    condition: {
      type: String,
      enum: ['new', 'refurbished', 'used', 'open_box'],
      default: 'new'
    },
    warranty: {
      type: String,
      trim: true,
      default: null
    }
  },
  
  // Store the placeholder product ID (for database reference integrity)
  placeholderProductId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    default: null,
    index: true
  },
  
  // ==================== PREORDER SPECIFIC FIELDS ====================
  preorderInfo: {
    expectedDeliveryDate: {
      type: Date,
      default: null
    },
    sourceCountry: {
      type: String,
      trim: true,
      default: null
    },
    quantityNeeded: {
      type: Number,
      min: 1,
      default: null
    },
    urgency: {
      type: String,
      enum: Object.values(URGENCY_LEVELS),
      default: URGENCY_LEVELS.MEDIUM
    },
    preferredSupplier: {
      type: String,
      trim: true,
      default: null
    },
    shippingMethod: {
      type: String,
      enum: ['air', 'sea', 'land', 'express'],
      default: null
    },
    customsClearance: {
      type: Boolean,
      default: false
    },
    qualityRequirements: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null
    },
    certificationNeeded: {
      type: [String],
      default: []
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null
    }
  },
  
  // ==================== ORDER STATUS & HANDLING ====================
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
    maxlength: 500,
    default: null
  },
  
  // Staff notes
  staffNotes: {
    type: String,
    trim: true,
    maxlength: 500,
    default: null
  },
  
  // User notes
  userNotes: {
    type: String,
    trim: true,
    maxlength: 500,
    default: null
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
      maxlength: 500,
      default: null
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
      maxlength: 500,
      default: null
    },
    deliveryStatus: {
      type: String,
      enum: Object.values(DELIVERY_STATUS),
      default: DELIVERY_STATUS.PENDING
    },
    // Additional delivery fields
    shippingCost: {
      type: Number,
      default: 0,
      min: 0
    },
    insurance: {
      type: Boolean,
      default: false
    },
    insuranceCost: {
      type: Number,
      default: 0,
      min: 0
    },
    deliveryPhotos: {
      type: [String],
      default: []
    },
    signatureRequired: {
      type: Boolean,
      default: false
    },
    signatureImage: {
      type: String,
      default: null
    }
  },
  
  // ==================== PAYMENT INFORMATION ====================
  paymentInfo: {
    paymentStatus: {
      type: String,
      enum: ['pending', 'partial', 'paid', 'refunded', 'failed'],
      default: 'pending'
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'bank_transfer', 'mobile_money', 'card', 'other'],
      default: null
    },
    paymentReference: {
      type: String,
      trim: true,
      default: null
    },
    amountPaid: {
      type: Number,
      default: 0,
      min: 0
    },
    paymentDate: {
      type: Date,
      default: null
    },
    paymentNotes: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null
    },
    transactionHistory: [
      {
        amount: { type: Number, required: true },
        method: { type: String, required: true },
        reference: { type: String },
        date: { type: Date, default: Date.now },
        status: { type: String, enum: ['success', 'failed', 'pending'], default: 'success' },
        notes: { type: String }
      }
    ]
  },
  
  // ==================== COMMUNICATION LOG ====================
  communicationLog: [
    {
      type: {
        type: String,
        enum: ['email', 'whatsapp', 'call', 'note', 'system'],
        required: true
      },
      content: {
        type: String,
        required: true
      },
      sentBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      sentTo: {
        type: String,
        trim: true
      },
      sentAt: {
        type: Date,
        default: Date.now
      },
      read: {
        type: Boolean,
        default: false
      },
      readAt: {
        type: Date,
        default: null
      }
    }
  ],
  
  // ==================== METADATA ====================
  metadata: {
    userAgent: {
      type: String,
      default: null
    },
    ipAddress: {
      type: String,
      default: null
    },
    source: {
      type: String,
      enum: ['web', 'mobile', 'whatsapp', 'api'],
      default: 'web'
    },
    tags: {
      type: [String],
      default: []
    },
    priority: {
      type: String,
      enum: ['low', 'normal', 'high', 'urgent'],
      default: 'normal'
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    reminderSent: {
      type: Boolean,
      default: false
    },
    lastReminderSentAt: {
      type: Date,
      default: null
    },
    autoReminderCount: {
      type: Number,
      default: 0
    }
  }
  
}, {
  timestamps: true
});

// ==================== INDEXES ====================
// Existing indexes
orderSchema.index({ userId: 1, status: 1 });
orderSchema.index({ notifyAudience: 1, status: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ 'deliveryInfo.deliveryStatus': 1 });
orderSchema.index({ 'deliveryInfo.estimatedDeliveryDate': 1 });
orderSchema.index({ tel: 1 });
orderSchema.index({ businessName: 1 });

// New indexes for custom products and preorders
orderSchema.index({ isCustomProduct: 1 });
orderSchema.index({ placeholderProductId: 1 });
orderSchema.index({ productSource: 1 });
orderSchema.index({ 'preorderInfo.expectedDeliveryDate': 1 });
orderSchema.index({ 'preorderInfo.urgency': 1 });
orderSchema.index({ 'paymentInfo.paymentStatus': 1 });
orderSchema.index({ 'metadata.priority': 1 });
orderSchema.index({ 'metadata.assignedTo': 1 });
orderSchema.index({ orderType: 1, productSource: 1 });

// Compound indexes for common queries
orderSchema.index({ orderType: 1, status: 1, createdAt: -1 });
orderSchema.index({ isCustomProduct: 1, status: 1, createdAt: -1 });
orderSchema.index({ userId: 1, orderType: 1, createdAt: -1 });
orderSchema.index({ 'preorderInfo.urgency': 1, status: 1 });

// ==================== VIRTUAL PROPERTIES ====================
// Virtual for total price based on order type
orderSchema.virtual('totalPrice').get(function() {
  if (this.orderType === ORDER_TYPES.OFFER && this.finalPrice) {
    return this.finalPrice;
  }
  if (this.orderType === ORDER_TYPES.PREORDER && this.finalPrice) {
    return this.finalPrice;
  }
  return this.originalTotal;
});

// Virtual to check if product is from catalog
orderSchema.virtual('isCatalogProduct').get(function() {
  return this.productSource === PRODUCT_SOURCE.CATALOG;
});

// Virtual to get custom product display name
orderSchema.virtual('customProductDisplayName').get(function() {
  if (this.isCustomProduct && this.customProduct.name) {
    return this.customProduct.name;
  }
  return this.productName;
});

// Virtual to get full product description
orderSchema.virtual('fullProductDescription').get(function() {
  if (this.isCustomProduct && this.customProduct.description) {
    return this.customProduct.description;
  }
  return `${this.productName} - ${this.quantity} units`;
});

// Virtual for payment balance due
orderSchema.virtual('balanceDue').get(function() {
  const total = this.totalPrice || this.finalPrice || this.originalTotal || 0;
  const paid = this.paymentInfo?.amountPaid || 0;
  return Math.max(0, total - paid);
});

// Virtual for payment percentage
orderSchema.virtual('paymentPercentage').get(function() {
  const total = this.totalPrice || this.finalPrice || this.originalTotal || 0;
  const paid = this.paymentInfo?.amountPaid || 0;
  if (total === 0) return 100;
  return Math.round((paid / total) * 100);
});

// ==================== VALIDATION ====================
// Pre-validation middleware
orderSchema.pre('validate', function(next) {
  // For preorders, either productId OR custom product details must exist
  if (this.orderType === ORDER_TYPES.PREORDER) {
    if (!this.productId && !this.isCustomProduct) {
      next(new Error('Preorder must have either a productId or be marked as custom product'));
    }
    
    // Set productSource
    if (this.productId && !this.isCustomProduct) {
      this.productSource = PRODUCT_SOURCE.CATALOG;
    } else if (this.isCustomProduct) {
      this.productSource = PRODUCT_SOURCE.CUSTOM;
      
      // Ensure custom product has at least a name
      if (!this.customProduct || !this.customProduct.name) {
        next(new Error('Custom product must have a name'));
      }
    }
    
    // For custom products, originalTotal is not required initially
    if (this.isCustomProduct && !this.productId) {
      this.productPrice = null;
      this.originalTotal = null;
    }
  }
  
  // For offer orders, validate offered price
  if (this.orderType === ORDER_TYPES.OFFER && !this.offeredPrice) {
    next(new Error('Offered price is required for offer orders'));
  }
  
  next();
});

// Pre-save middleware
orderSchema.pre('save', function(next) {
  // Update payment percentage if amount paid changes
  if (this.isModified('paymentInfo.amountPaid')) {
    const total = this.totalPrice || this.finalPrice || this.originalTotal || 0;
    const paid = this.paymentInfo?.amountPaid || 0;
    
    if (paid === 0) {
      this.paymentInfo.paymentStatus = 'pending';
    } else if (paid < total) {
      this.paymentInfo.paymentStatus = 'partial';
    } else if (paid >= total) {
      this.paymentInfo.paymentStatus = 'paid';
    }
  }
  
  // If order is delivered, update status
  if (this.deliveryInfo?.deliveryStatus === DELIVERY_STATUS.DELIVERED && 
      this.status !== ORDER_STATUS.DELIVERED) {
    this.status = ORDER_STATUS.DELIVERED;
    if (!this.deliveryInfo.actualDeliveryDate) {
      this.deliveryInfo.actualDeliveryDate = new Date();
    }
  }
  
  next();
});

// ==================== INSTANCE METHODS ====================
// Method to check if order is pending
orderSchema.methods.isPending = function() {
  return this.status === ORDER_STATUS.PENDING;
};

// Method to check if order is from custom product
orderSchema.methods.isCustom = function() {
  return this.isCustomProduct === true;
};

// Method to accept order
orderSchema.methods.accept = async function(handledById, finalPrice = null, deliveryData = null) {
  this.status = ORDER_STATUS.ACCEPTED;
  this.handledBy = handledById;
  this.handledAt = new Date();
  
  if ((this.orderType === ORDER_TYPES.OFFER || this.orderType === ORDER_TYPES.PREORDER) && finalPrice) {
    this.finalPrice = finalPrice;
  }
  
  // Set delivery information if provided
  if (deliveryData) {
    this.deliveryInfo = {
      ...this.deliveryInfo.toObject(),
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
    ...this.deliveryInfo.toObject(),
    ...deliveryData
  };
  
  // If delivery status is 'delivered', update order status
  if (deliveryData.deliveryStatus === DELIVERY_STATUS.DELIVERED) {
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

// Method to add payment transaction
orderSchema.methods.addPayment = async function(amount, method, reference, notes = null) {
  if (!this.paymentInfo.transactionHistory) {
    this.paymentInfo.transactionHistory = [];
  }
  
  this.paymentInfo.transactionHistory.push({
    amount,
    method,
    reference,
    notes,
    date: new Date(),
    status: 'success'
  });
  
  this.paymentInfo.amountPaid = (this.paymentInfo.amountPaid || 0) + amount;
  this.paymentInfo.paymentMethod = method;
  this.paymentInfo.paymentReference = reference;
  this.paymentInfo.paymentDate = new Date();
  
  if (notes) {
    this.paymentInfo.paymentNotes = notes;
  }
  
  return this.save();
};

// Method to add communication log entry
orderSchema.methods.addCommunication = async function(type, content, sentBy, sentTo = null) {
  if (!this.communicationLog) {
    this.communicationLog = [];
  }
  
  this.communicationLog.push({
    type,
    content,
    sentBy,
    sentTo,
    sentAt: new Date()
  });
  
  return this.save();
};

// Method to update custom product details
orderSchema.methods.updateCustomProduct = async function(updates) {
  if (!this.isCustomProduct) {
    throw new Error('Cannot update custom product details for catalog product orders');
  }
  
  this.customProduct = {
    ...this.customProduct.toObject(),
    ...updates
  };
  
  return this.save();
};

// ==================== STATIC METHODS ====================
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

// Static method to get custom product orders
orderSchema.statics.findCustomProductOrders = function(filters = {}) {
  const query = { isCustomProduct: true, ...filters };
  return this.find(query).sort({ createdAt: -1 });
};

// Static method to get preorders by urgency
orderSchema.statics.findPreordersByUrgency = function(urgency = null) {
  const query = { orderType: ORDER_TYPES.PREORDER, status: ORDER_STATUS.PENDING };
  if (urgency) {
    query['preorderInfo.urgency'] = urgency;
  }
  return this.find(query).sort({ 'preorderInfo.urgency': 1, createdAt: 1 });
};

// Static method to get orders needing attention (overdue, high priority)
orderSchema.statics.findOrdersNeedingAttention = async function() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.setDate(now.getDate() - 7));
  
  return this.find({
    status: ORDER_STATUS.PENDING,
    $or: [
      { createdAt: { $lt: sevenDaysAgo } }, // Older than 7 days
      { 'metadata.priority': 'urgent' },
      { 'metadata.priority': 'high' }
    ]
  }).sort({ 'metadata.priority': -1, createdAt: 1 });
};

// Static method to update delivery status for multiple orders
orderSchema.statics.bulkUpdateDeliveryStatus = async function(orderIds, deliveryStatus) {
  return this.updateMany(
    { _id: { $in: orderIds } },
    { 'deliveryInfo.deliveryStatus': deliveryStatus }
  );
};

// Static method to get order statistics
orderSchema.statics.getOrderStats = async function(startDate, endDate) {
  const match = {};
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = startDate;
    if (endDate) match.createdAt.$lte = endDate;
  }
  
  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          orderType: '$orderType',
          status: '$status',
          productSource: '$productSource'
        },
        count: { $sum: 1 },
        totalQuantity: { $sum: '$quantity' },
        totalValue: { $sum: { $ifNull: ['$finalPrice', '$originalTotal'] } }
      }
    },
    {
      $group: {
        _id: '$_id.orderType',
        statuses: {
          $push: {
            status: '$_id.status',
            count: '$count',
            totalQuantity: '$totalQuantity',
            totalValue: '$totalValue'
          }
        },
        byProductSource: {
          $push: {
            source: '$_id.productSource',
            status: '$_id.status',
            count: '$count'
          }
        }
      }
    }
  ]);
};

module.exports = {
  Order: mongoose.model('Order', orderSchema),
  ORDER_TYPES,
  ORDER_STATUS,
  NOTIFICATION_AUDIENCE,
  PRODUCT_SOURCE,
  URGENCY_LEVELS,
  DELIVERY_STATUS
};
