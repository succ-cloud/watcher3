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
  DELIVERED: 'delivered',
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
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  {
    collection: 'orders',
    strict: false,
    strictPopulate: false,
    timestamps: false,
  },
);

// Instance helpers used by orderController (accept / reject / cancel / delivery PATCH)
orderSchema.methods.accept = async function acceptOrderDoc(handledById, finalPrice, deliveryData) {
  this.status = ORDER_STATUS.ACCEPTED;
  this.handledBy = handledById;
  if (finalPrice != null && finalPrice !== '' && Number.isFinite(Number(finalPrice))) {
    this.finalPrice = Number(finalPrice);
  }
  this.handledAt = new Date();
  if (deliveryData && typeof deliveryData === 'object' && Object.keys(deliveryData).length > 0) {
    const base =
      this.deliveryInfo &&
      typeof this.deliveryInfo === 'object' &&
      !Array.isArray(this.deliveryInfo)
        ? { ...this.deliveryInfo }
        : {};
    this.deliveryInfo = { ...base, ...deliveryData };
  }
  return this.save();
};

orderSchema.methods.reject = async function rejectOrderDoc(handledById, rejectionReason) {
  this.status = ORDER_STATUS.REJECTED;
  this.handledBy = handledById;
  this.rejectionReason = String(rejectionReason || '');
  this.handledAt = new Date();
  return this.save();
};

orderSchema.methods.cancel = async function cancelOrderDoc() {
  this.status = ORDER_STATUS.CANCELLED;
  return this.save();
};

orderSchema.methods.updateDeliveryInfo = async function updateDeliveryInfoDoc(deliveryData) {
  if (!deliveryData || typeof deliveryData !== 'object') {
    return this.save();
  }
  const base =
    this.deliveryInfo &&
    typeof this.deliveryInfo === 'object' &&
    !Array.isArray(this.deliveryInfo)
      ? { ...this.deliveryInfo }
      : {};
  this.deliveryInfo = { ...base, ...deliveryData };
  return this.save();
};

const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);

module.exports = {
  Order,
  ORDER_TYPES,
  ORDER_STATUS,
  NOTIFICATION_AUDIENCE,
  PRODUCT_SOURCE,
};
