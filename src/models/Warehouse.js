const mongoose = require('mongoose');

const WAREHOUSE_TYPES = {
  MAIN: 'main',
  SUB: 'sub',
};

const warehouseSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Warehouse name is required'],
      trim: true,
      maxlength: [120, 'Warehouse name cannot exceed 120 characters'],
    },
    type: {
      type: String,
      enum: Object.values(WAREHOUSE_TYPES),
      required: true,
      index: true,
    },
    /** Optional on shops (type=sub). Legacy link to a regional main warehouse; shops may exist without one. */
    parentWarehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Warehouse',
      default: null,
    },
    /** Region/city grouping label; product phoneLocation may use the shop name instead. */
    city: {
      type: String,
      trim: true,
      enum: {
        values: ['Douala', 'Yaounde', 'Bafoussam', 'Bamenda', 'Limbe', 'Buea', 'USA', 'Other'],
        message: 'City must be one of: Douala, Yaounde, Bafoussam, Bamenda, Limbe, Buea, USA, Other',
      },
      default: 'Other',
    },
    address: {
      type: String,
      trim: true,
      maxlength: [300, 'Address cannot exceed 300 characters'],
      default: '',
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Description cannot exceed 500 characters'],
      default: '',
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true, collection: 'warehouses' },
);

/** One active main warehouse per region (city), except "Other" which allows multiple. */
warehouseSchema.index(
  { city: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      type: WAREHOUSE_TYPES.MAIN,
      isActive: true,
      city: { $ne: 'Other' },
    },
  },
);

warehouseSchema.index({ type: 1, isActive: 1 });
warehouseSchema.index({ parentWarehouse: 1, isActive: 1 });
warehouseSchema.index({ city: 1, isActive: 1 });

module.exports = mongoose.model('Warehouse', warehouseSchema);
module.exports.WAREHOUSE_TYPES = WAREHOUSE_TYPES;
