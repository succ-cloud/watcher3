const mongoose = require('mongoose');
const { buildCatalogKey, hasCatalogIdentity } = require('../utils/pricingCatalog');

const productPricingSchema = new mongoose.Schema(
  {
    productName: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
      maxlength: [200, 'Product name cannot exceed 200 characters'],
    },
    brand: {
      type: String,
      required: [true, 'Brand is required'],
      trim: true,
      maxlength: [120, 'Brand cannot exceed 120 characters'],
    },
    capacity: {
      type: String,
      required: [true, 'Capacity is required'],
      trim: true,
      maxlength: [80, 'Capacity cannot exceed 80 characters'],
    },
    /** Normalized lookup key: name|brand|capacity (lowercase). */
    catalogKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    retailPrice: {
      type: Number,
      required: [true, 'Retail price is required'],
      min: [0, 'Retail price cannot be negative'],
      set(value) {
        return Math.round(Number(value) * 100) / 100;
      },
    },
    /** Wholesale shop listing price — applied to inventory `price` on upload. */
    wholesalePrice: {
      type: Number,
      min: [0, 'Wholesale price cannot be negative'],
      default: null,
      set(value) {
        if (value == null || value === '') return null;
        return Math.round(Number(value) * 100) / 100;
      },
    },
    /** Default product photo applied on inventory upload when no images are provided. */
    imageUrl: {
      type: String,
      trim: true,
      default: '',
    },
    imagePublicId: {
      type: String,
      trim: true,
      default: '',
    },
    imageAlt: {
      type: String,
      trim: true,
      maxlength: [200, 'Image alt text cannot exceed 200 characters'],
      default: '',
    },
    /** Up to 5 catalog photos — primary is mirrored on imageUrl for legacy clients. */
    images: [
      {
        url: { type: String, required: true, trim: true },
        publicId: { type: String, trim: true, default: '' },
        isPrimary: { type: Boolean, default: false },
        alt: { type: String, trim: true, maxlength: 200, default: 'product image' },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true, collection: 'product_pricing' },
);

productPricingSchema.pre('validate', function setCatalogKey(next) {
  if (!hasCatalogIdentity(this)) {
    return next(new Error('Product name, brand, and capacity are required.'));
  }
  this.catalogKey = buildCatalogKey(this);
  next();
});

productPricingSchema.statics.findByCatalogKey = function findByCatalogKey(parts) {
  const key = buildCatalogKey(parts);
  if (!key.replace(/\|/g, '').length) return Promise.resolve(null);
  return this.findOne({ catalogKey: key });
};

productPricingSchema.statics.findByProduct = function findByProduct(product) {
  const key = buildCatalogKey({
    productName: product?.product_name ?? product?.productName,
    brand: product?.brand,
    capacity: product?.capacity,
  });
  if (!key.replace(/\|/g, '').length) return Promise.resolve(null);
  return this.findOne({ catalogKey: key });
};

const ProductPricing =
  mongoose.models.ProductPricing || mongoose.model('ProductPricing', productPricingSchema);

module.exports = ProductPricing;
