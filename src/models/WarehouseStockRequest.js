const mongoose = require('mongoose');

const REQUEST_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  FULFILLED: 'fulfilled',
};

const warehouseStockRequestSchema = new mongoose.Schema(
  {
    /** Shop requesting stock from its regional main warehouse. */
    requestingShop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Warehouse',
      default: null,
      index: true,
    },
    /** Regional main warehouse requesting stock from the USA warehouse. */
    requestingMain: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Warehouse',
      default: null,
      index: true,
    },
    servingMain: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Warehouse',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(REQUEST_STATUS),
      default: REQUEST_STATUS.PENDING,
      index: true,
    },
    productName: { type: String, trim: true, required: true },
    brand: { type: String, trim: true, default: '' },
    capacity: { type: String, trim: true, default: '' },
    color: { type: String, trim: true, default: '' },
    quantity: { type: Number, default: 1, min: 1 },
    notes: { type: String, trim: true, default: '' },
    adminNote: { type: String, trim: true, default: '' },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'warehouse_stock_requests' },
);

warehouseStockRequestSchema.index({ servingMain: 1, status: 1, createdAt: -1 });
warehouseStockRequestSchema.index({ requestingMain: 1, status: 1, createdAt: -1 });

warehouseStockRequestSchema.pre('validate', function validateRequestSource(next) {
  const hasShop = Boolean(this.requestingShop);
  const hasMain = Boolean(this.requestingMain);
  if (hasShop === hasMain) {
    next(new Error('Exactly one of requestingShop or requestingMain is required.'));
    return;
  }
  next();
});

module.exports = mongoose.model('WarehouseStockRequest', warehouseStockRequestSchema);
module.exports.REQUEST_STATUS = REQUEST_STATUS;
