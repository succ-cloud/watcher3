const mongoose = require('mongoose');

const NOTIFICATION_TYPES = {
  ORDER_SUBMITTED: 'order_submitted',
  ORDER_ACCEPTED: 'order_accepted',
  ORDER_REJECTED: 'order_rejected',
  ORDER_CANCELLED: 'order_cancelled',
  ORDER_UPDATED: 'order_updated'
};

const NOTIFICATION_AUDIENCE = {
  SALESMAN: 'salesman',
  ADMIN: 'admin',
  USER: 'user'
};

const notificationSchema = new mongoose.Schema({
  // Who receives this notification
  audience: {
    type: String,
    enum: Object.values(NOTIFICATION_AUDIENCE),
    required: true,
    index: true
  },
  
  // Specific user (for USER audience)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    sparse: true
  },
  
  // Related order
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
    index: true
  },
  
  // Notification type
  type: {
    type: String,
    enum: Object.values(NOTIFICATION_TYPES),
    required: true
  },
  
  // Notification content
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  
  message: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500
  },
  
  // Whether notification has been read
  read: {
    type: Boolean,
    default: false,
    index: true
  },
  
  readAt: {
    type: Date,
    default: null
  },
  
  // Additional metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Indexes
notificationSchema.index({ audience: 1, read: 1 });
notificationSchema.index({ userId: 1, read: 1 });
notificationSchema.index({ createdAt: -1 });

// Method to mark as read
notificationSchema.methods.markAsRead = async function() {
  this.read = true;
  this.readAt = new Date();
  return this.save();
};

// Static method to get unread count
notificationSchema.statics.getUnreadCount = async function(audience, userId = null) {
  const query = { audience, read: false };
  if (userId && audience === NOTIFICATION_AUDIENCE.USER) {
    query.userId = userId;
  }
  return this.countDocuments(query);
};

// Static method to get notifications for a user
notificationSchema.statics.getUserNotifications = async function(userId, limit = 50) {
  return this.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('orderId', 'orderType quantity status');
};

// Static method to get notifications for staff (salesman/admin)
notificationSchema.statics.getStaffNotifications = async function(audience, limit = 50) {
  return this.find({ audience })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('orderId', 'orderType quantity status productName')
    .populate('orderId.userId', 'name businessName tel');
};

module.exports = {
  Notification: mongoose.model('Notification', notificationSchema),
  NOTIFICATION_TYPES,
  NOTIFICATION_AUDIENCE
};