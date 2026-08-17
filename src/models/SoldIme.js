const mongoose = require('mongoose');

const SOLD_IME_STATUS = {
  SOLD_OUT: 'sold_out',
};

const soldImeSchema = new mongoose.Schema(
  {
    ime: { type: String, required: true, trim: true, unique: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
    buyerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    customerName: { type: String, trim: true, default: '' },
    saleType: { type: String, enum: ['wholesale', 'retail'], default: 'wholesale' },
    paymentMethod: { type: String, trim: true, default: 'cash' },
    status: {
      type: String,
      enum: Object.values(SOLD_IME_STATUS),
      default: SOLD_IME_STATUS.SOLD_OUT,
    },
    productName: { type: String, trim: true, default: '' },
    brand: { type: String, trim: true, default: '' },
    capacity: { type: String, trim: true, default: '' },
    color: { type: String, trim: true, default: '' },
    bulkBatchCode: { type: String, trim: true, default: null },
    /** Catalog/list price at time of sale (before salesperson adjustment). */
    listedPrice: { type: Number, min: 0, default: null },
    /** Actual unit price the device was sold for. */
    unitPrice: { type: Number, min: 0, default: null },
    assignedWarehouseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Warehouse',
      default: null,
      index: true,
    },
    assignedWarehouseName: { type: String, trim: true, default: '' },
    soldAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

const SoldIme = mongoose.models.SoldIme || mongoose.model('SoldIme', soldImeSchema);

module.exports = { SoldIme, SOLD_IME_STATUS };
