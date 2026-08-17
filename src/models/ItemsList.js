// models/ItemsList.js - Complete Product Schema

const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  // ==================== BASIC PRODUCT INFORMATION ====================
  product_type: {
    type: String,
    required: [true, 'Product type is required'],
    enum: ['Smartphone', 'tablet', 'laptop', 'accessory', 'other'],
    trim: true
  },
  
  product_name: {
    type: String,
    required: [true, 'Product name is required'],
    trim: true,
    maxlength: [200, 'Product name cannot exceed 200 characters'],
    index: true
  },
  
  brand: {
    type: String,
    trim: true,
    maxlength: [100, 'Brand name cannot exceed 100 characters'],
    index: true
  },
  
  // ==================== PRODUCT SPECIFICATIONS ====================
  capacity: {
    type: String,
    required: [true, 'Capacity is required'],
    trim: true
  },
  
  country: {
    type: String,
    required: [true, 'Country of origin is required'],
    trim: true
  },
  
  sim: {
    type: String,
    required: [true, 'SIM type is required'],
    enum: ['Physical SIM', 'eSIM', 'Dual SIM', 'Physical SIM + eSIM'],
    trim: true
  },
  
  color: {
    type: String,
    required: [true, 'Color is required'],
    trim: true
  },

  /** Optional phone battery health percentage (0–100). */
  batteryHealth: {
    type: Number,
    min: [0, 'Battery health must be between 0 and 100'],
    max: [100, 'Battery health must be between 0 and 100'],
    default: null,
  },
  
  // Phone Location Information
  phoneLocation: {
    type: String,
    trim: true,
    enum: {
      values: ['Douala', 'Yaounde', 'Bafoussam', 'Bamenda', 'Limbe', 'Other'],
      message: 'Phone location must be one of: Douala, Yaounde, Bafoussam, Bamenda, Limbe, Other'
    },
    default: 'Other',
    index: true
  },

  // ==================== WAREHOUSE TRACKING ====================
  /** Physical location right now (main warehouse while travelling, sub-warehouse after arrival). */
  currentWarehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse',
    default: null,
    index: true,
  },

  /** Sub-warehouse this stock is assigned to before it leaves the main warehouse. */
  destinationSubWarehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse',
    default: null,
    index: true,
  },

  /** Regional main warehouse stock is travelling toward (inter-warehouse transfer). */
  destinationMainWarehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse',
    default: null,
    index: true,
  },

  /** Main warehouse or shop stock was sent from (set on transfer, cleared on receive). */
  originWarehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse',
    default: null,
    index: true,
  },

  shipmentStatus: {
    type: String,
    enum: {
      values: ['travelling', 'arrived'],
      message: 'Shipment status must be travelling or arrived',
    },
    default: 'arrived',
    index: true,
  },

  arrivedAt: {
    type: Date,
    default: null,
  },

  locationHistory: [
    {
      warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
      status: { type: String, enum: ['travelling', 'arrived'] },
      movedAt: { type: Date, default: Date.now },
      movedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      note: { type: String, trim: true, default: '' },
    },
  ],

  /** Bulk upload batch — all products in one bulk upload share this shipment. */
  bulkShipment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BulkShipment',
    default: null,
    index: true,
  },

  /** Denormalized tracking code (e.g. BULK-20260530-A1B2C3) for display and search. */
  bulkBatchCode: {
    type: String,
    trim: true,
    default: null,
    index: true,
  },
  
  // Additional specifications (optional)
  models: {
    type: String,
    trim: true,
    default: null
  },
  
  carrier: {
    type: String,
    trim: true,
    default: null
  },
  
  IME: {
    type: String,
    trim: true,
  },

  /** All unit IME/serial codes registered for this stock line (USA uploads). */
  imeCodes: {
    type: [String],
    default: [],
  },
  
  // ==================== IMAGES ====================
  images: [{
    url: {
      type: String,
      required: true
    },
    publicId: {
      type: String,
      required: true
    },
    isPrimary: {
      type: Boolean,
      default: false
    },
    alt: {
      type: String,
      default: 'product image'
    },
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // ==================== INVENTORY & PRICING ====================
  // Denormalized primary image (kept in sync with images[].isPrimary in controller / pre-save)
  primaryImage: {
    url: String,
    publicId: String,
    alt: String,
  },

  stock: {
    type: Number,
    required: [true, 'Stock quantity is required'],
    min: [0, 'Stock cannot be negative'],
    default: 0,
    index: true
  },
  
  /** Wholesale selling price — required (> 0) before listing on the Shop catalog. */
  price: {
    type: Number,
    default: 0,
    min: [0, 'Price cannot be negative'],
    set: function(value) {
      return Math.round(value * 100) / 100;
    },
    index: true
  },

  /** Unit cost — required on USA WACHE upload. */
  costPrice: {
    type: Number,
    min: [0, 'Cost price cannot be negative'],
    default: null,
  },

  /** Optional allowed selling price band. */
  priceMin: {
    type: Number,
    min: [0, 'Minimum price cannot be negative'],
    default: null,
  },

  priceMax: {
    type: Number,
    min: [0, 'Maximum price cannot be negative'],
    default: null,
  },
  
  // Discount pricing (optional)
  discountedPrice: {
    type: Number,
    min: [0, 'Discounted price cannot be negative'],
    default: null,
    validate: {
      validator: function(value) {
        if (value && this.price) {
          return value < this.price;
        }
        return true;
      },
      message: 'Discounted price must be less than original price'
    }
  },
  
  // ==================== DESCRIPTION ====================
  description: {
    type: String,
    required: [true, 'Description is required'],
    trim: true,
    maxlength: [2000, 'Description cannot exceed 2000 characters']
  },
  
  // ==================== CATEGORIZATION ====================
  category: {
    type: String,
    trim: true,
    default: null,
    index: true
  },
  
  subcategory: {
    type: String,
    trim: true,
    default: null
  },
  
  tags: {
    type: [String],
    default: [],
    index: true
  },
  
  // ==================== PRODUCT STATUS ====================
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  
  isFeatured: {
    type: Boolean,
    default: false
  },
  
  isPlaceholder: {
    type: Boolean,
    default: false,
    description: 'Used as placeholder for custom preorders'
  },
  
  // ==================== WHATSAPP NOTIFICATION TRACKING ====================
  whatsappNotificationSent: {
    type: Boolean,
    default: false,
    description: 'Whether WhatsApp notification has been sent for this product'
  },
  
  whatsappNotificationSentAt: {
    type: Date,
    default: null
  },
  
  whatsappNotificationCount: {
    type: Number,
    default: 0,
    description: 'Number of times WhatsApp notification was sent'
  },
  
  lastWhatsappNotification: {
    type: Date,
    default: null
  },
  
  // Track stock update notifications separately
  lastStockNotificationSentAt: {
    type: Date,
    default: null
  },
  
  lastStockValueAtNotification: {
    type: Number,
    default: null
  },
  
  // ==================== AUDIT & METADATA ====================
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  metadata: {
    views: {
      type: Number,
      default: 0
    },
    orders: {
      type: Number,
      default: 0
    },
    rating: {
      type: Number,
      min: 0,
      max: 5,
      default: 0
    },
    reviews: {
      type: Number,
      default: 0
    }
  },
  
  // ==================== TIMESTAMPS ====================
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// ==================== VIRTUAL PROPERTIES ====================
// primaryImage is a real schema path above — do not define a virtual with the same name (Mongoose error).

// Virtual for formatted price
productSchema.virtual('formattedPrice').get(function() {
  if (this.price === undefined || this.price === null) {
    return '$0.00';
  }
  return `$${this.price.toFixed(2)}`;
});

// Virtual for formatted discounted price
productSchema.virtual('formattedDiscountedPrice').get(function() {
  if (this.discountedPrice && this.discountedPrice > 0) {
    return `$${this.discountedPrice.toFixed(2)}`;
  }
  return null;
});

// Virtual for current active price (discounted if available)
productSchema.virtual('currentPrice').get(function() {
  if (this.discountedPrice && this.discountedPrice > 0) {
    return this.discountedPrice;
  }
  return this.price || 0;
});

// Virtual for formatted current price
productSchema.virtual('formattedCurrentPrice').get(function() {
  return `$${this.currentPrice.toFixed(2)}`;
});

// Virtual for discount percentage
productSchema.virtual('discountPercentage').get(function() {
  if (this.discountedPrice && this.price > 0 && this.discountedPrice < this.price) {
    return Math.round(((this.price - this.discountedPrice) / this.price) * 100);
  }
  return 0;
});

// Virtual for in stock status
productSchema.virtual('inStock').get(function() {
  return this.stock > 0;
});

// Virtual for stock status text
productSchema.virtual('stockStatus').get(function() {
  if (this.stock <= 0) return 'Out of Stock';
  if (this.stock <= 5) return 'Low Stock';
  if (this.stock <= 20) return 'Limited Stock';
  return 'In Stock';
});

// Virtual for full product info (for WhatsApp messages)
productSchema.virtual('whatsappInfo').get(function() {
  return {
    name: this.product_name || 'Unknown',
    type: this.product_type || 'Unknown',
    brand: this.brand || 'Unknown',
    capacity: this.capacity || 'Unknown',
    color: this.color || 'Unknown',
    price: this.currentPrice || 0,
    formattedPrice: this.formattedCurrentPrice || '$0',
    stock: this.stock || 0,
    location: this.phoneLocation || 'Unknown',
    description: this.description ? this.description.substring(0, 150) : 'No description available'
  };
});
// ==================== INDEXES ====================

// Text search index
productSchema.index({ 
  product_name: 'text', 
  description: 'text', 
  brand: 'text',
  tags: 'text'
});

// Compound indexes for common queries
productSchema.index({ product_type: 1, isActive: 1 });
productSchema.index({ price: 1, inStock: 1 });
productSchema.index({ createdAt: -1, isActive: 1 });
productSchema.index({ phoneLocation: 1, isActive: 1 });
productSchema.index({ shipmentStatus: 1, currentWarehouse: 1 });
productSchema.index({ bulkShipment: 1, shipmentStatus: 1 });
productSchema.index({ brand: 1, product_type: 1 });
productSchema.index({ whatsappNotificationSent: 1, createdAt: -1 });

/**
 * After deploy: if create still fails on IME_1, rebuild the index in mongosh:
 *   use paylink
 *   db.products.dropIndex("IME_1")
 * Then restart the app so Mongoose creates the partial unique index, or run syncIndexes once.
 */
productSchema.index(
  { IME: 1 },
  {
    unique: true,
    partialFilterExpression: { IME: { $type: 'string', $gt: '' } },
  },
);

// ==================== PRE-SAVE MIDDLEWARE ====================

// Update timestamp on save
productSchema.pre('save', function(next) {
  this.updatedAt = Date.now();

  const ime = this.get('IME');
  if (ime == null || String(ime).trim() === '') {
    this.set('IME', undefined);
  } else {
    this.set('IME', String(ime).trim());
  }
  
  // Clear discounted price if it's not less than original price
  if (this.discountedPrice && this.price && this.discountedPrice >= this.price) {
    this.discountedPrice = null;
  }

  // Keep denormalized primaryImage in sync with images[].isPrimary
  if (this.images && this.images.length > 0) {
    const p = this.images.find((img) => img.isPrimary) || this.images[0];
    if (p && p.url) {
      this.primaryImage = {
        url: p.url,
        publicId: p.publicId,
        alt: p.alt || this.product_name || 'product image',
      };
    }
  } else {
    this.primaryImage = undefined;
  }

  next();
});

// Validate that at least one image exists for active products (optional - can be commented out)
productSchema.pre('save', function(next) {
  if (this.isActive && this.images.length === 0 && !this.isPlaceholder) {
    console.warn(`Warning: Active product "${this.product_name}" has no images`);
    // Don't block save, just warn
  }
  next();
});

// ==================== INSTANCE METHODS ====================

// Method to add image
productSchema.methods.addImage = function(imageData) {
  // If this is the first image, make it primary
  if (this.images.length === 0) {
    imageData.isPrimary = true;
  }
  this.images.push(imageData);
  return this.save();
};

// Method to remove image
productSchema.methods.removeImage = async function(publicId) {
  const imageToRemove = this.images.find(img => img.publicId === publicId);
  
  // If removing primary image, set another as primary
  if (imageToRemove && imageToRemove.isPrimary && this.images.length > 1) {
    const newPrimary = this.images.find(img => img.publicId !== publicId);
    if (newPrimary) {
      newPrimary.isPrimary = true;
    }
  }
  
  this.images = this.images.filter(img => img.publicId !== publicId);
  return this.save();
};

// Method to set primary image
productSchema.methods.setPrimaryImage = function(publicId) {
  this.images.forEach(img => {
    img.isPrimary = img.publicId === publicId;
  });
  return this.save();
};

// Method to update stock
productSchema.methods.updateStock = function(quantity, operation = 'set') {
  switch (operation) {
    case 'increment':
      this.stock += quantity;
      break;
    case 'decrement':
      this.stock -= quantity;
      break;
    case 'set':
    default:
      this.stock = quantity;
  }
  
  // Ensure stock doesn't go negative
  if (this.stock < 0) this.stock = 0;
  
  return this.save();
};

// Method to mark WhatsApp notification as sent
productSchema.methods.markWhatsappNotificationSent = async function() {
  this.whatsappNotificationSent = true;
  this.whatsappNotificationSentAt = new Date();
  this.whatsappNotificationCount += 1;
  this.lastWhatsappNotification = new Date();
  return this.save();
};

// Method to mark stock notification as sent
productSchema.methods.markStockNotificationSent = async function(currentStock) {
  this.lastStockNotificationSentAt = new Date();
  this.lastStockValueAtNotification = currentStock;
  return this.save();
};

// Method to check if stock notification should be sent
productSchema.methods.shouldSendStockNotification = function(newStock) {
  // Don't send if stock decreased
  if (newStock <= this.stock) return false;
  
  // Don't send if we already notified at this stock level
  if (this.lastStockValueAtNotification === newStock) return false;
  
  // Don't send if last notification was less than 1 hour ago (rate limiting)
  if (this.lastStockNotificationSentAt) {
    const hoursSinceLastNotification = (Date.now() - this.lastStockNotificationSentAt) / (1000 * 60 * 60);
    if (hoursSinceLastNotification < 1) return false;
  }
  
  return true;
};

// Method to increment view count
productSchema.methods.incrementViews = function() {
  this.metadata.views += 1;
  return this.save();
};

// Method to increment order count
productSchema.methods.incrementOrders = function(quantity = 1) {
  this.metadata.orders += quantity;
  return this.save();
};

// ==================== STATIC METHODS ====================

// Static method to find products with images
productSchema.statics.findWithImages = function() {
  return this.find({ 'images.0': { $exists: true } });
};

// Static method to find products that need WhatsApp notifications
productSchema.statics.findProductsNeedingNotification = function(limit = 10) {
  return this.find({
    isActive: true,
    isPlaceholder: { $ne: true },
    whatsappNotificationSent: false,
    stock: { $gt: 0 }
  })
  .sort({ createdAt: -1 })
  .limit(limit);
};

// Static method to get featured products
productSchema.statics.getFeaturedProducts = function(limit = 10) {
  return this.find({
    isActive: true,
    isFeatured: true,
    stock: { $gt: 0 }
  })
  .sort({ createdAt: -1 })
  .limit(limit);
};

// Static method to get products by location
productSchema.statics.findByLocation = function(location, limit = 50) {
  return this.find({
    isActive: true,
    phoneLocation: location,
    stock: { $gt: 0 }
  })
  .sort({ createdAt: -1 })
  .limit(limit);
};

// Static method to get low stock products
productSchema.statics.findLowStock = function(threshold = 10) {
  return this.find({
    isActive: true,
    stock: { $gt: 0, $lte: threshold }
  })
  .sort({ stock: 1 });
};

// Static method to get out of stock products
productSchema.statics.findOutOfStock = function() {
  return this.find({
    isActive: true,
    stock: { $lte: 0 }
  })
  .sort({ createdAt: -1 });
};

// Static method to search products
productSchema.statics.searchProducts = function(searchTerm, filters = {}) {
  const query = {
    isActive: true,
    $text: { $search: searchTerm }
  };
  
  if (filters.product_type) query.product_type = filters.product_type;
  if (filters.brand) query.brand = filters.brand;
  if (filters.phoneLocation) query.phoneLocation = filters.phoneLocation;
  if (filters.minPrice || filters.maxPrice) {
    query.price = {};
    if (filters.minPrice) query.price.$gte = filters.minPrice;
    if (filters.maxPrice) query.price.$lte = filters.maxPrice;
  }
  
  return this.find(query)
    .sort({ score: { $meta: 'textScore' } })
    .limit(filters.limit || 50);
};

// Static method to get inventory summary
productSchema.statics.getInventorySummary = async function() {
  const summary = await this.aggregate([
    {
      $group: {
        _id: null,
        totalProducts: { $sum: 1 },
        totalStock: { $sum: '$stock' },
        totalValue: { $sum: { $multiply: ['$price', '$stock'] } },
        averagePrice: { $avg: '$price' },
        productsWithImages: { $sum: { $cond: [{ $gt: [{ $size: '$images' }, 0] }, 1, 0] } },
        outOfStock: { $sum: { $cond: [{ $lte: ['$stock', 0] }, 1, 0] } },
        lowStock: { $sum: { $cond: [{ $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', 10] }] }, 1, 0] } }
      }
    }
  ]);
  
  return summary[0] || {
    totalProducts: 0,
    totalStock: 0,
    totalValue: 0,
    averagePrice: 0,
    productsWithImages: 0,
    outOfStock: 0,
    lowStock: 0
  };
};

// Static method to get products by type with counts
productSchema.statics.getProductsByType = function() {
  return this.aggregate([
    {
      $group: {
        _id: '$product_type',
        count: { $sum: 1 },
        totalStock: { $sum: '$stock' },
        averagePrice: { $avg: '$price' }
      }
    },
    { $sort: { count: -1 } }
  ]);
};

// ==================== EXPORT ====================

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
