const mongoose = require('mongoose');

/**
 * Loose schema so this repo works with existing paybackend `orders` documents.
 * Constants mirror values used in `orderController.js`.
 */
const ORDER_TYPES = {
  BUY: 'buy',
  OFFER: 'offer',
  PREORDER: 'preorder',
};

const ORDER_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
};

const NOTIFICATION_AUDIENCE = {
  SALESMAN: 'salesman',
  ADMIN: 'admin',
  USER: 'user',
};

const PRODUCT_SOURCE = {
  CUSTOM: 'custom',
  CATALOG: 'catalog',
};

const orderSchema = new mongoose.Schema(
  {},
  {
    collection: 'orders',
    strict: false,
    timestamps: false,
  },
);

const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);

module.exports = {
  Order,
  ORDER_TYPES,
  ORDER_STATUS,
  NOTIFICATION_AUDIENCE,
  PRODUCT_SOURCE,
};
