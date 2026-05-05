const mongoose = require('mongoose');

/** Matches storefront keys: `productId::buy` or `productId::offer::123` (or custom server keys). */
const cartItemSchema = new mongoose.Schema({
  lineKey: {
    type: String,
    required: true,
    trim: true,
    maxlength: 512,
  },
  orderType: {
    type: String,
    enum: ['buy', 'offer'],
    default: 'buy',
  },
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: false,
    default: undefined,
  },
  productName: {
    type: String,
    required: true,
  },
  productPrice: {
    type: Number,
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
    default: 1,
  },
  images: [
    {
      url: String,
      publicId: String,
      isPrimary: Boolean,
    },
  ],
  offeredPrice: {
    type: Number,
    default: null,
  },
  isPreorder: {
    type: Boolean,
    default: false,
  },
  customProduct: {
    name: String,
    description: String,
    specifications: String,
    targetPriceMin: Number,
    targetPriceMax: Number,
    color: String,
    size: String,
  },
  notes: {
    type: String,
    trim: true,
    maxlength: 500,
  },
  addedAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

const cartSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    items: [cartItemSchema],
    deliveryInfo: {
      deliveryAddress: { type: String, trim: true },
      specialInstructions: { type: String, trim: true, maxlength: 500 },
      contactPhone: { type: String, trim: true },
    },
    summary: {
      totalItems: { type: Number, default: 0 },
      totalAmount: { type: Number, default: 0 },
      lastCalculated: { type: Date, default: Date.now },
    },
    status: {
      type: String,
      enum: ['active', 'converted', 'abandoned'],
      default: 'active',
    },
    lastActive: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

cartSchema.index({ userId: 1, status: 1 });
cartSchema.index({ lastActive: -1 });

cartSchema.virtual('calculatedSummary').get(function () {
  let totalItems = 0;
  let totalAmount = 0;
  for (const item of this.items) {
    totalItems += item.quantity;
    const unit =
      String(item.orderType || 'buy') === 'offer' && item.offeredPrice != null
        ? Number(item.offeredPrice)
        : Number(item.productPrice);
    totalAmount += unit * item.quantity;
  }
  return { totalItems, totalAmount };
});

cartSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  this.lastActive = Date.now();
  const summary = this.calculatedSummary;
  this.summary.totalItems = summary.totalItems;
  this.summary.totalAmount = summary.totalAmount;
  this.summary.lastCalculated = new Date();
  next();
});

cartSchema.methods.addItem = async function (itemData) {
  const lineKey = String(itemData.lineKey || '').trim();
  if (!lineKey) throw new Error('lineKey is required');

  const idx = this.items.findIndex((item) => String(item.lineKey) === lineKey);
  if (idx > -1) {
    const q = Math.max(1, Math.floor(Number(itemData.quantity) || 1));
    this.items[idx].quantity = q;
    this.items[idx].updatedAt = new Date();
    if (itemData.notes) this.items[idx].notes = itemData.notes;
  } else {
    this.items.push({
      ...itemData,
      lineKey,
      addedAt: new Date(),
      updatedAt: new Date(),
    });
  }
  return this.save();
};

cartSchema.methods.updateItemQuantity = async function (lineKey, quantity) {
  const key = String(lineKey || '').trim();
  const item = this.items.find((i) => String(i.lineKey) === key);
  if (!item) return null;
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) {
    this.items = this.items.filter((i) => String(i.lineKey) !== key);
  } else {
    item.quantity = Math.floor(q);
    item.updatedAt = new Date();
  }
  return this.save();
};

cartSchema.methods.removeItem = async function (lineKey) {
  const key = String(lineKey || '').trim();
  this.items = this.items.filter((i) => String(i.lineKey) !== key);
  return this.save();
};

/** Empty cart after checkout; keep one document per user (unique userId). */
cartSchema.methods.clearCart = async function () {
  this.items = [];
  this.deliveryInfo = {};
  this.status = 'active';
  return this.save();
};

cartSchema.methods.getCartSummary = function () {
  return {
    items: this.items,
    summary: this.summary,
    deliveryInfo: this.deliveryInfo,
    totalItems: this.summary.totalItems,
    totalAmount: this.summary.totalAmount,
  };
};

cartSchema.statics.getOrCreateCart = async function (userId) {
  let cart = await this.findOne({ userId });
  if (!cart) {
    cart = await this.create({
      userId,
      items: [],
      deliveryInfo: {},
      summary: { totalItems: 0, totalAmount: 0 },
      status: 'active',
    });
  } else if (cart.status !== 'active') {
    cart.status = 'active';
    await cart.save();
  }
  return cart;
};

cartSchema.statics.getCartByUser = async function (userId) {
  return await this.findOne({ userId, status: 'active' }).populate(
    'items.productId',
    'product_name price images stock',
  );
};

cartSchema.statics.convertCartToOrder = async function (userId) {
  const cart = await this.findOne({ userId, status: 'active' });
  if (!cart) return null;
  cart.status = 'converted';
  await cart.save();
  return cart;
};

cartSchema.statics.cleanupAbandonedCarts = async function (days = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  return await this.updateMany(
    {
      status: 'active',
      lastActive: { $lt: cutoffDate },
      'items.0': { $exists: true },
    },
    { status: 'abandoned' },
  );
};

module.exports = mongoose.model('Cart', cartSchema);
