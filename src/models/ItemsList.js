const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  // Basic Product Information
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
    maxlength: [200, 'Product name cannot exceed 200 characters']
  },
  
  // Product Specifications

  
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
    enum: ['Physical SIM','eSIM'],
    trim: true
  },
  

  
  color: {
    type: String,
    required: [true, 'Color is required'],
    trim: true
  },

  brand: {
    type: String,
    
    trim: true,
    maxlength: [100, 'Brand name cannot exceed 100 characters'],
    index: true // For faster brand searches
  },
  
  // Phone Location Information - NEW FIELD
  phoneLocation: {
    type: String,
    required: [true, 'Phone location is required'],
    trim: true,
    enum: {
      values: ['Douala', 'Yaounde', 'Bafoussam', 'Bamenda', 'Limbe', 'Other'],
      message: 'Phone location must be one of: Douala, Yaoundé, Bafoussam, Bamenda, Limbe, Other'
    },
    default: 'Other',
    index: true // For faster location-based searches
  },
  // Default IMEI with default value "clean"

  
  // Images - NEW FIELD
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
    }
  }],
  
  // Inventory & Pricing
  stock: {
    type: Number,
    required: [true, 'Stock quantity is required'],
    min: [0, 'Stock cannot be negative'],
    default: 0
  },
  
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price cannot be negative'],
    set: function(value) {
      return Math.round(value * 100) / 100;
    }
  },
  
  description: {
    type: String,
    required: [true, 'Description is required'],
    trim: true,
    maxlength: [2000, 'Description cannot exceed 2000 characters']
  },
  
  // Timestamps for tracking
  createdAt: {
    type: Date,
    default: Date.now
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

// Virtual for primary image
productSchema.virtual('primaryImage').get(function() {
  return this.images.find(img => img.isPrimary) || this.images[0];
});

// Virtual for formatted price
productSchema.virtual('formattedPrice').get(function() {
  return `$${this.price.toFixed(2)}`;
});

// Indexes
productSchema.index({ product_name: 'text', description: 'text' });
productSchema.index({ product_type: 1 });
productSchema.index({ price: 1 });
productSchema.index({ stock: 1 });
productSchema.index({ 'images.isPrimary': 1 });

// Pre-save middleware
productSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

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
productSchema.methods.removeImage = function(publicId) {
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

// Static method to find products by image count
productSchema.statics.findWithImages = function() {
  return this.find({ 'images.0': { $exists: true } });
};

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
