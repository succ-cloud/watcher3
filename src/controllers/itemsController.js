const Product = require('../models/ItemsList'); // Make sure this path is correct
const { cloudinary } = require('../config/cloudinary');

// ==================== BASIC CRUD OPERATIONS ====================

// @desc    Create a new product with images
// @route   POST /api/products
// @access  Public
const createProduct = async (req, res) => {
  try {
    let productData = req.body;
    
    // Parse JSON fields if they come as strings (for FormData)
    if (typeof productData === 'string') {
      productData = JSON.parse(productData);
    }

    // Validate required fields - Updated with brand and phoneLocation
    const requiredFields = [
      'product_type', 'product_name', 'brand', 'phoneLocation',
      'capacity', 'country', 'sim', 'color', 'price', 'description'
    ];
    
    const missingFields = requiredFields.filter(field => !productData[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`
      });
    }

    // Convert numeric fields
    if (productData.price) productData.price = parseFloat(productData.price);
    if (productData.stock) productData.stock = parseInt(productData.stock);

    // Create new product
    const product = new Product(productData);

    // Handle uploaded images
    if (req.files && req.files.length > 0) {
      req.files.forEach((file, index) => {
        product.images.push({
          url: file.path,
          publicId: file.filename,
          isPrimary: index === 0, // First image is primary
          alt: productData.product_name || 'product image'
        });
      });
    }

    const savedProduct = await product.save();

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: savedProduct
    });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating product',
      error: error.message
    });
  }
};

// @desc    Get all products with filtering, pagination, and sorting
// @route   GET /api/products
// @access  Public
const getAllProducts = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      product_type,
      brand,
      phoneLocation,
      minPrice,
      maxPrice,
      country,
      color,
      inStock
    } = req.query;

    // Build filter object - Updated with brand and phoneLocation
    const filter = {};

    if (product_type) filter.product_type = product_type;
    if (brand) filter.brand = { $regex: brand, $options: 'i' }; // Case-insensitive brand search
    if (phoneLocation) filter.phoneLocation = phoneLocation;
    if (country) filter.country = country;
    if (color) filter.color = color;
    
    // Price range filter
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    // Stock filter
    if (inStock === 'true') {
      filter.stock = { $gt: 0 };
    } else if (inStock === 'false') {
      filter.stock = { $lte: 0 };
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    // Execute query with pagination
    const products = await Product.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));

    // Get total count for pagination
    const totalProducts = await Product.countDocuments(filter);
    const totalPages = Math.ceil(totalProducts / parseInt(limit));

    res.status(200).json({
      success: true,
      count: products.length,
      totalProducts,
      totalPages,
      currentPage: parseInt(page),
      data: products
    });
  } catch (error) {
    console.error('Get all products error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching products',
      error: error.message
    });
  }
};

// @desc    Get single product by ID
// @route   GET /api/products/:id
// @access  Public
const getProductById = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.status(200).json({
      success: true,
      data: product
    });
  } catch (error) {
    console.error('Get product by ID error:', error);
    // Handle invalid ObjectId
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error fetching product',
      error: error.message
    });
  }
};

// @desc    Update product with images
// @route   PUT /api/products/:id
// @access  Public
const updateProduct = async (req, res) => {
  try {
    let updates = req.body;
    
    // Parse JSON fields if they come as strings
    if (typeof updates === 'string') {
      updates = JSON.parse(updates);
    }
    
    // Remove fields that shouldn't be updated directly
    delete updates._id;
    delete updates.createdAt;
    delete updates.__v;
    delete updates.images; // Don't update images directly through this endpoint

    // Convert numeric fields
    if (updates.price) updates.price = parseFloat(updates.price);
    if (updates.stock) updates.stock = parseInt(updates.stock);

    // Find product
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Update fields
    Object.keys(updates).forEach(key => {
      product[key] = updates[key];
    });

    // Handle new images
    if (req.files && req.files.length > 0) {
      req.files.forEach(file => {
        product.images.push({
          url: file.path,
          publicId: file.filename,
          isPrimary: product.images.length === 0, // First image becomes primary if none exist
          alt: product.product_name || 'product image'
        });
      });
    }

    const updatedProduct = await product.save();

    res.status(200).json({
      success: true,
      message: 'Product updated successfully',
      data: updatedProduct
    });
  } catch (error) {
    console.error('Update product error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error updating product',
      error: error.message
    });
  }
};

// @desc    Partially update product
// @route   PATCH /api/products/:id
// @access  Public
const patchProduct = async (req, res) => {
  try {
    let updates = req.body;
    
    // Parse JSON fields if they come as strings
    if (typeof updates === 'string') {
      updates = JSON.parse(updates);
    }
    
    // Remove fields that shouldn't be updated
    delete updates._id;
    delete updates.createdAt;
    delete updates.__v;
    delete updates.images;

    // Convert numeric fields
    if (updates.price) updates.price = parseFloat(updates.price);
    if (updates.stock) updates.stock = parseInt(updates.stock);

    // Find and update product (partial update)
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      {
        new: true,
        runValidators: true,
        context: 'query'
      }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Product updated successfully',
      data: product
    });
  } catch (error) {
    console.error('Patch product error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error updating product',
      error: error.message
    });
  }
};

// @desc    Delete product
// @route   DELETE /api/products/:id
// @access  Public
const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Delete images from Cloudinary
    if (product.images && product.images.length > 0) {
      for (const image of product.images) {
        try {
          await cloudinary.uploader.destroy(image.publicId);
        } catch (cloudinaryError) {
          console.error('Cloudinary delete error:', cloudinaryError);
          // Continue even if Cloudinary delete fails
        }
      }
    }

    // Delete product from database
    await Product.findByIdAndDelete(req.params.id);

    res.status(200).json({
      success: true,
      message: 'Product deleted successfully',
      data: {}
    });
  } catch (error) {
    console.error('Delete product error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error deleting product',
      error: error.message
    });
  }
};

// ==================== SEARCH OPERATIONS ====================

// @desc    Search products by name, brand, or description
// @route   GET /api/products/search
// @access  Public
const searchProductsByName = async (req, res) => {
  try {
    const { 
      q, // search query
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    if (!q) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required'
      });
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    // Search products by name, brand, or description (case-insensitive) - Updated with brand
    const searchRegex = new RegExp(q, 'i');
    
    const products = await Product.find({
      $or: [
        { product_name: searchRegex },
        { description: searchRegex },
        { brand: searchRegex }
      ]
    })
    .sort(sort)
    .skip(skip)
    .limit(parseInt(limit));

    // Get total count for pagination
    const totalProducts = await Product.countDocuments({
      $or: [
        { product_name: searchRegex },
        { description: searchRegex },
        { brand: searchRegex }
      ]
    });

    const totalPages = Math.ceil(totalProducts / parseInt(limit));

    res.status(200).json({
      success: true,
      count: products.length,
      totalProducts,
      totalPages,
      currentPage: parseInt(page),
      searchQuery: q,
      data: products
    });
  } catch (error) {
    console.error('Search products error:', error);
    res.status(500).json({
      success: false,
      message: 'Error searching products',
      error: error.message
    });
  }
};

// @desc    Advanced search with multiple fields and filters
// @route   POST /api/products/advanced-search
// @access  Public
const advancedSearch = async (req, res) => {
  try {
    const {
      searchTerm,
      product_type,
      brand,
      phoneLocation,
      minPrice,
      maxPrice,
      country,
      color,
      inStock,
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.body;

    // Build search filter
    const filter = {};

    // Text search across multiple fields - Updated with brand
    if (searchTerm) {
      const searchRegex = new RegExp(searchTerm, 'i');
      filter.$or = [
        { product_name: searchRegex },
        { description: searchRegex },
        { brand: searchRegex },
        { color: searchRegex }
      ];
    }

    // Apply filters - Updated with brand and phoneLocation
    if (product_type) filter.product_type = product_type;
    if (brand) filter.brand = new RegExp(brand, 'i');
    if (phoneLocation) filter.phoneLocation = phoneLocation;
    if (country) filter.country = country;
    if (color) filter.color = color;
    
    // Price range filter
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    // Stock filter
    if (inStock !== undefined) {
      if (inStock === true || inStock === 'true') {
        filter.stock = { $gt: 0 };
      } else if (inStock === false || inStock === 'false') {
        filter.stock = { $lte: 0 };
      }
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    // Execute search
    const products = await Product.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));

    const totalProducts = await Product.countDocuments(filter);
    const totalPages = Math.ceil(totalProducts / parseInt(limit));

    res.status(200).json({
      success: true,
      count: products.length,
      totalProducts,
      totalPages,
      currentPage: parseInt(page),
      filters: {
        searchTerm,
        product_type,
        brand,
        phoneLocation,
        minPrice,
        maxPrice,
        country,
        color,
        inStock
      },
      data: products
    });
  } catch (error) {
    console.error('Advanced search error:', error);
    res.status(500).json({
      success: false,
      message: 'Error performing advanced search',
      error: error.message
    });
  }
};

// ==================== BULK OPERATIONS ====================

// @desc    Bulk create products
// @route   POST /api/products/bulk
// @access  Public
const bulkCreateProducts = async (req, res) => {
  try {
    let products = req.body;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide an array of products'
      });
    }

    // Convert numeric fields for each product and validate required fields
    products = products.map(product => ({
      ...product,
      price: parseFloat(product.price) || 0,
      stock: parseInt(product.stock) || 0,
      // Ensure brand and phoneLocation are included
      brand: product.brand || 'Unknown',
      phoneLocation: product.phoneLocation || 'Other'
    }));

    // Insert multiple products
    const createdProducts = await Product.insertMany(products, {
      ordered: false // Continue even if some documents fail
    });

    res.status(201).json({
      success: true,
      message: `Successfully created ${createdProducts.length} products`,
      count: createdProducts.length,
      data: createdProducts
    });
  } catch (error) {
    console.error('Bulk create error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating products in bulk',
      error: error.message
    });
  }
};

// ==================== STOCK MANAGEMENT ====================

// @desc    Update product stock
// @route   PATCH /api/products/:id/stock
// @access  Public
const updateProductStock = async (req, res) => {
  try {
    const { quantity, operation = 'set' } = req.body;

    if (quantity === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Quantity is required'
      });
    }

    const numQuantity = parseInt(quantity);
    
    if (isNaN(numQuantity)) {
      return res.status(400).json({
        success: false,
        message: 'Quantity must be a number'
      });
    }

    let updateOperation;
    
    switch (operation) {
      case 'increment':
        updateOperation = { $inc: { stock: numQuantity } };
        break;
      case 'decrement':
        updateOperation = { $inc: { stock: -numQuantity } };
        break;
      case 'set':
      default:
        updateOperation = { $set: { stock: numQuantity } };
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      updateOperation,
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Product stock updated successfully',
      data: product
    });
  } catch (error) {
    console.error('Update stock error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error updating product stock',
      error: error.message
    });
  }
};

// @desc    Get low stock products
// @route   GET /api/products/stock/low
// @access  Public
const getLowStockProducts = async (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 5;
    
    const products = await Product.find({
      stock: { $gt: 0, $lte: threshold }
    }).sort({ stock: 1 });

    res.status(200).json({
      success: true,
      count: products.length,
      threshold,
      data: products
    });
  } catch (error) {
    console.error('Get low stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching low stock products',
      error: error.message
    });
  }
};

// @desc    Get out of stock products
// @route   GET /api/products/stock/out
// @access  Public
const getOutOfStockProducts = async (req, res) => {
  try {
    const products = await Product.find({
      stock: { $lte: 0 }
    }).sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: products.length,
      data: products
    });
  } catch (error) {
    console.error('Get out of stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching out of stock products',
      error: error.message
    });
  }
};

// ==================== IMAGE MANAGEMENT ====================

// @desc    Add images to existing product
// @route   POST /api/products/:id/images
// @access  Public
const addProductImages = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No images uploaded'
      });
    }

    // Add images
    req.files.forEach(file => {
      product.images.push({
        url: file.path,
        publicId: file.filename,
        isPrimary: product.images.length === 0, // First image becomes primary if none exist
        alt: product.product_name || 'product image'
      });
    });

    const updatedProduct = await product.save();

    res.status(200).json({
      success: true,
      message: `${req.files.length} image(s) added successfully`,
      data: updatedProduct
    });
  } catch (error) {
    console.error('Add images error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error adding images',
      error: error.message
    });
  }
};

// @desc    Delete image from product
// @route   DELETE /api/products/:id/images/:publicId
// @access  Public
const deleteProductImage = async (req, res) => {
  try {
    const { id, publicId } = req.params;

    const product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Find image
    const imageIndex = product.images.findIndex(img => img.publicId === publicId);
    
    if (imageIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Image not found'
      });
    }

    // Delete from Cloudinary
    try {
      await cloudinary.uploader.destroy(publicId);
    } catch (cloudinaryError) {
      console.error('Cloudinary delete error:', cloudinaryError);
      // Continue even if Cloudinary delete fails
    }

    // Check if deleting primary image
    const wasPrimary = product.images[imageIndex].isPrimary;

    // Remove from array
    product.images.splice(imageIndex, 1);

    // If we deleted the primary image and there are other images, set a new primary
    if (wasPrimary && product.images.length > 0) {
      product.images[0].isPrimary = true;
    }

    const updatedProduct = await product.save();

    res.status(200).json({
      success: true,
      message: 'Image deleted successfully',
      data: updatedProduct
    });
  } catch (error) {
    console.error('Delete image error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error deleting image',
      error: error.message
    });
  }
};

// @desc    Set primary image
// @route   PATCH /api/products/:id/images/:publicId/primary
// @access  Public
const setPrimaryImage = async (req, res) => {
  try {
    const { id, publicId } = req.params;

    const product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Check if image exists
    const imageExists = product.images.some(img => img.publicId === publicId);
    
    if (!imageExists) {
      return res.status(404).json({
        success: false,
        message: 'Image not found'
      });
    }

    // Set primary
    product.images.forEach(img => {
      img.isPrimary = img.publicId === publicId;
    });

    const updatedProduct = await product.save();

    res.status(200).json({
      success: true,
      message: 'Primary image updated',
      data: updatedProduct
    });
  } catch (error) {
    console.error('Set primary image error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error setting primary image',
      error: error.message
    });
  }
};

// @desc    Get product images
// @route   GET /api/products/:id/images
// @access  Public
const getProductImages = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).select('images product_name brand');

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.status(200).json({
      success: true,
      count: product.images.length,
      data: {
        productId: product._id,
        productName: product.product_name,
        brand: product.brand,
        images: product.images
      }
    });
  } catch (error) {
    console.error('Get images error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error fetching images',
      error: error.message
    });
  }
};

// ==================== FILTERS & CATEGORIES ====================

// @desc    Get all product types
// @route   GET /api/products/filters/types
// @access  Public
const getProductTypes = async (req, res) => {
  try {
    const types = await Product.distinct('product_type');
    res.status(200).json({
      success: true,
      data: types
    });
  } catch (error) {
    console.error('Get product types error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching product types',
      error: error.message
    });
  }
};

// @desc    Get all brands
// @route   GET /api/products/filters/brands
// @access  Public
const getAllBrands = async (req, res) => {
  try {
    const brands = await Product.distinct('brand');
    // Filter out null/undefined and sort alphabetically
    const filteredBrands = brands.filter(b => b && b !== 'Unknown').sort();
    res.status(200).json({
      success: true,
      data: filteredBrands
    });
  } catch (error) {
    console.error('Get brands error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching brands',
      error: error.message
    });
  }
};

// @desc    Get all phone locations
// @route   GET /api/products/filters/locations
// @access  Public
const getAllPhoneLocations = async (req, res) => {
  try {
    const locations = await Product.distinct('phoneLocation');
    // Sort locations in a specific order
    const locationOrder = ['Douala', 'Yaoundé', 'Bafoussam', 'Bamenda', 'Limbe', 'Other'];
    const sortedLocations = locationOrder.filter(loc => locations.includes(loc));
    res.status(200).json({
      success: true,
      data: sortedLocations
    });
  } catch (error) {
    console.error('Get locations error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching phone locations',
      error: error.message
    });
  }
};

// @desc    Get all countries
// @route   GET /api/products/filters/countries
// @access  Public
const getAllCountries = async (req, res) => {
  try {
    const countries = await Product.distinct('country');
    res.status(200).json({
      success: true,
      data: countries
    });
  } catch (error) {
    console.error('Get countries error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching countries',
      error: error.message
    });
  }
};

// @desc    Get all colors
// @route   GET /api/products/filters/colors
// @access  Public
const getAllColors = async (req, res) => {
  try {
    const colors = await Product.distinct('color');
    res.status(200).json({
      success: true,
      data: colors
    });
  } catch (error) {
    console.error('Get colors error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching colors',
      error: error.message
    });
  }
};

// ==================== STATISTICS ====================

// @desc    Get inventory statistics
// @route   GET /api/products/stats/inventory
// @access  Public
const getInventoryStats = async (req, res) => {
  try {
    const totalProducts = await Product.countDocuments();
    const totalStock = await Product.aggregate([
      { $group: { _id: null, total: { $sum: '$stock' } } }
    ]);
    const averagePrice = await Product.aggregate([
      { $group: { _id: null, avg: { $avg: '$price' } } }
    ]);
    const outOfStock = await Product.countDocuments({ stock: 0 });
    const lowStock = await Product.countDocuments({ stock: { $gt: 0, $lte: 5 } });
    
    // Brand and location statistics
    const totalBrands = await Product.distinct('brand').then(brands => brands.filter(b => b && b !== 'Unknown').length);
    const totalLocations = await Product.distinct('phoneLocation').then(locs => locs.length);

    res.status(200).json({
      success: true,
      data: {
        totalProducts,
        totalStock: totalStock[0]?.total || 0,
        averagePrice: averagePrice[0]?.avg || 0,
        outOfStock,
        lowStock,
        totalBrands,
        totalLocations
      }
    });
  } catch (error) {
    console.error('Get inventory stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching inventory statistics',
      error: error.message
    });
  }
};

// @desc    Get brand statistics
// @route   GET /api/products/stats/brands
// @access  Public
const getBrandStats = async (req, res) => {
  try {
    const stats = await Product.aggregate([
      {
        $match: { brand: { $ne: null, $ne: 'Unknown' } }
      },
      {
        $group: {
          _id: '$brand',
          count: { $sum: 1 },
          totalStock: { $sum: '$stock' },
          averagePrice: { $avg: '$price' },
          minPrice: { $min: '$price' },
          maxPrice: { $max: '$price' }
        }
      },
      {
        $project: {
          brand: '$_id',
          count: 1,
          totalStock: 1,
          averagePrice: { $round: ['$averagePrice', 2] },
          minPrice: 1,
          maxPrice: 1,
          _id: 0
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.status(200).json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Get brand stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching brand statistics',
      error: error.message
    });
  }
};

// @desc    Get location statistics
// @route   GET /api/products/stats/locations
// @access  Public
const getLocationStats = async (req, res) => {
  try {
    const stats = await Product.aggregate([
      {
        $group: {
          _id: '$phoneLocation',
          count: { $sum: 1 },
          totalStock: { $sum: '$stock' },
          averagePrice: { $avg: '$price' }
        }
      },
      {
        $project: {
          location: '$_id',
          count: 1,
          totalStock: 1,
          averagePrice: { $round: ['$averagePrice', 2] },
          _id: 0
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.status(200).json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Get location stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching location statistics',
      error: error.message
    });
  }
};

// @desc    Get products by type with brand and location breakdown
// @route   GET /api/products/stats/by-type
// @access  Public
const getProductsByType = async (req, res) => {
  try {
    const stats = await Product.aggregate([
      {
        $group: {
          _id: '$product_type',
          count: { $sum: 1 },
          totalStock: { $sum: '$stock' },
          averagePrice: { $avg: '$price' },
          brands: { $addToSet: '$brand' },
          locations: { $addToSet: '$phoneLocation' }
        }
      },
      {
        $project: {
          productType: '$_id',
          count: 1,
          totalStock: 1,
          averagePrice: { $round: ['$averagePrice', 2] },
          brandCount: { $size: { $filter: { input: '$brands', as: 'b', cond: { $and: [{ $ne: ['$$b', null] }, { $ne: ['$$b', 'Unknown'] }] } } } },
          locationCount: { $size: '$locations' },
          _id: 0
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.status(200).json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Get products by type error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching products by type',
      error: error.message
    });
  }
};

// ==================== FEATURED & RECOMMENDED ====================

// @desc    Get featured products
// @route   GET /api/products/featured
// @access  Public
const getFeaturedProducts = async (req, res) => {
  try {
    // Get products with images, in stock, and from popular brands
    const products = await Product.find({
      'images.0': { $exists: true },
      stock: { $gt: 0 },
      brand: { $ne: 'Unknown' }
    })
    .limit(10)
    .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: products.length,
      data: products
    });
  } catch (error) {
    console.error('Get featured products error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching featured products',
      error: error.message
    });
  }
};

// @desc    Get recommended products based on current product
// @route   GET /api/products/recommended/:id
// @access  Public
const getRecommendedProducts = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Find similar products based on type, brand, location, or price range
    const recommended = await Product.find({
      _id: { $ne: product._id },
      $or: [
        { product_type: product.product_type },
        { brand: product.brand },
        { phoneLocation: product.phoneLocation },
        {
          price: {
            $gte: product.price * 0.7,
            $lte: product.price * 1.3
          }
        }
      ]
    })
    .limit(6)
    .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: recommended.length,
      data: recommended
    });
  } catch (error) {
    console.error('Get recommended products error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error fetching recommended products',
      error: error.message
    });
  }
};

// @desc    Get products by brand
// @route   GET /api/products/brand/:brandName
// @access  Public
const getProductsByBrand = async (req, res) => {
  try {
    const { brandName } = req.params;
    const { page = 1, limit = 20 } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const products = await Product.find({ 
      brand: { $regex: brandName, $options: 'i' } 
    })
    .skip(skip)
    .limit(parseInt(limit))
    .sort({ createdAt: -1 });
    
    const total = await Product.countDocuments({ 
      brand: { $regex: brandName, $options: 'i' } 
    });
    
    res.status(200).json({
      success: true,
      count: products.length,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      data: products
    });
  } catch (error) {
    console.error('Get products by brand error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching products by brand',
      error: error.message
    });
  }
};

// @desc    Get products by location
// @route   GET /api/products/location/:location
// @access  Public
const getProductsByLocation = async (req, res) => {
  try {
    const { location } = req.params;
    const { page = 1, limit = 20 } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const products = await Product.find({ phoneLocation: location })
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });
    
    const total = await Product.countDocuments({ phoneLocation: location });
    
    res.status(200).json({
      success: true,
      count: products.length,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      data: products
    });
  } catch (error) {
    console.error('Get products by location error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching products by location',
      error: error.message
    });
  }
};

// @desc    Get new arrivals
// @route   GET /api/products/new-arrivals
// @access  Public
const getNewArrivals = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const date = new Date();
    date.setDate(date.getDate() - days);

    const products = await Product.find({
      createdAt: { $gte: date }
    })
    .limit(20)
    .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: products.length,
      days,
      data: products
    });
  } catch (error) {
    console.error('Get new arrivals error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching new arrivals',
      error: error.message
    });
  }
};

// ==================== DUPLICATE & CLONE ====================

// @desc    Clone an existing product
// @route   POST /api/products/:id/clone
// @access  Public
const cloneProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Create a clone (exclude _id and timestamps)
    const productData = product.toObject();
    delete productData._id;
    delete productData.createdAt;
    delete productData.updatedAt;
    delete productData.__v;

    // Modify name to indicate it's a copy
    productData.product_name = `${productData.product_name} (Copy)`;
    
    // Don't clone images (optional - you can decide to clone or not)
    // productData.images = []; // Uncomment if you don't want to clone images

    const clonedProduct = new Product(productData);
    await clonedProduct.save();

    res.status(201).json({
      success: true,
      message: 'Product cloned successfully',
      data: clonedProduct
    });
  } catch (error) {
    console.error('Clone product error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error cloning product',
      error: error.message
    });
  }
};

// ==================== EXPORT FUNCTIONS ====================

// @desc    Export products to CSV
// @route   GET /api/products/export/csv
// @access  Public
const exportProductsToCSV = async (req, res) => {
  try {
    const products = await Product.find({}).lean();

    if (products.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No products to export'
      });
    }

    // Define CSV headers - Updated with brand and phoneLocation
    const headers = [
      '_id', 'product_name', 'brand', 'phoneLocation', 'product_type', 
      'capacity', 'country', 'sim', 'color', 'price', 'stock', 
      'description', 'createdAt', 'status'
    ];

    // Create CSV rows
    const csvRows = [];
    csvRows.push(headers.join(','));

    for (const product of products) {
      const row = headers.map(header => {
        const value = product[header] || '';
        // Escape commas and quotes
        return `"${String(value).replace(/"/g, '""')}"`;
      });
      csvRows.push(row.join(','));
    }

    const csvString = csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=products.csv');
    res.status(200).send(csvString);
  } catch (error) {
    console.error('Export CSV error:', error);
    res.status(500).json({
      success: false,
      message: 'Error exporting products',
      error: error.message
    });
  }
};

// @desc    Export products to JSON
// @route   GET /api/products/export/json
// @access  Public
const exportProductsToJSON = async (req, res) => {
  try {
    const products = await Product.find({}).lean();

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=products.json');
    res.status(200).json(products);
  } catch (error) {
    console.error('Export JSON error:', error);
    res.status(500).json({
      success: false,
      message: 'Error exporting products',
      error: error.message
    });
  }
};

// ==================== MAINTENANCE ====================

// @desc    Clean up old products
// @route   DELETE /api/products/cleanup/old
// @access  Public (Should be protected in production)
const cleanupOldProducts = async (req, res) => {
  try {
    const { days = 365 } = req.query;
    const date = new Date();
    date.setDate(date.getDate() - parseInt(days));

    const result = await Product.deleteMany({
      createdAt: { $lt: date },
      stock: 0 // Only delete products that are out of stock
    });

    res.status(200).json({
      success: true,
      message: `Cleaned up ${result.deletedCount} old products`,
      data: result
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({
      success: false,
      message: 'Error cleaning up products',
      error: error.message
    });
  }
};

// ==================== EXPORT FUNCTIONS ====================

module.exports = {
  // Basic CRUD
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  patchProduct,
  deleteProduct,
  
  // Search
  searchProductsByName,
  advancedSearch,
  
  // Bulk Operations
  bulkCreateProducts,
  
  // Stock Management
  updateProductStock,
  getLowStockProducts,
  getOutOfStockProducts,
  
  // Image Management
  addProductImages,
  deleteProductImage,
  setPrimaryImage,
  getProductImages,
  
  // Filters & Categories - Updated
  getProductTypes,
  getAllBrands,
  getAllPhoneLocations,
  getAllCountries,
  getAllColors,
  
  // Statistics - Updated
  getInventoryStats,
  getBrandStats,
  getLocationStats,
  getProductsByType,
  
  // Featured & Recommended - Updated
  getFeaturedProducts,
  getRecommendedProducts,
  getProductsByBrand,
  getProductsByLocation,
  getNewArrivals,
  
  // Duplicate & Clone
  cloneProduct,
  
  // Export Functions - Updated
  exportProductsToCSV,
  exportProductsToJSON,
  
  // Maintenance
  cleanupOldProducts
};
