const mongoose = require('mongoose');

const BULK_SHIPMENT_STATUS = {
  TRAVELLING: 'travelling',
  ARRIVED: 'arrived',
};

const bulkShipmentSchema = new mongoose.Schema(
  {
    /** Human-readable tracking id, e.g. BULK-20260530-A1B2C3 */
    batchCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(BULK_SHIPMENT_STATUS),
      default: BULK_SHIPMENT_STATUS.TRAVELLING,
      index: true,
    },
    mainWarehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Warehouse',
      required: true,
    },
    destinationSubWarehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Warehouse',
      default: null,
    },
    productCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    arrivedAt: {
      type: Date,
      default: null,
    },
    arrivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { timestamps: true, collection: 'bulk_shipments' },
);

bulkShipmentSchema.index({ status: 1, createdAt: -1 });
bulkShipmentSchema.index({ destinationSubWarehouse: 1, status: 1 });

module.exports = mongoose.model('BulkShipment', bulkShipmentSchema);
module.exports.BULK_SHIPMENT_STATUS = BULK_SHIPMENT_STATUS;
