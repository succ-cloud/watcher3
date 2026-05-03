// routes/itemsController.js
const express = require('express');
const router = express.Router();
const productController = require('../controllers/itemsController');
const { uploadProductImages, uploadMemory } = require('../config/cloudinary');
const verifyJWT = require('../middleware/verifyJWT');

// ==================== IMAGE UPLOAD ROUTES ====================

/**
 * @route   POST /api/products/:id/images
 * @desc    Add images to existing product
 * @access  Public (consider adding verifyJWT for production)
 */
router.post(
  '/:id/images', 
  uploadProductImages.array('images', 10), // Max 10 images
  productController.addProductImages
);

/**
 * @route   DELETE /api/products/:id/images/:publicId
 * @desc    Delete image from product
 * @access  Public (consider adding verifyJWT for production)
 */
router.delete('/:id/images/:publicId', productController.deleteProductImage);

/**
 * @route   PATCH /api/products/:id/images/:publicId/primary
 * @desc    Set primary image
 * @access  Public (consider adding verifyJWT for production)
 */
router.patch('/:id/images/:publicId/primary', productController.setPrimaryImage);

/**
 * @route   GET /api/products/:id/images
 * @desc    Get all images for a product
 * @access  Public
 */
router.get('/:id/images', productController.getProductImages);

/**
 * @route   POST /api/products/images/bulk-upload
 * @desc    Bulk upload images for multiple products
 * @access  Public (consider adding verifyJWT for production)
 */
router.post(
  '/images/bulk-upload',
  uploadProductImages.array('images', 50), // Max 50 images total
  productController.bulkUploadImages
);

// ==================== WHATSAPP BROADCAST QUEUE ROUTES (ADMIN ONLY) ====================

/**
 * @route   GET /api/products/broadcast/queue-status
 * @desc    Get current broadcast queue status
 * @access  Admin only (requires JWT and admin role)
 */
router.get(
  '/broadcast/queue-status',
  verifyJWT,
  productController.getBroadcastQueueStatus
);

/**
 * @route   POST /api/products/broadcast/force
 * @desc    Force immediate broadcast of queued products
 * @access  Admin only (requires JWT and admin role)
 */
router.post(
  '/broadcast/force',
  verifyJWT,
  productController.forceBroadcastNow
);

/**
 * @route   DELETE /api/products/broadcast/queue
 * @desc    Clear all products from broadcast queue
 * @access  Admin only (requires JWT and admin role)
 */
router.delete(
  '/broadcast/queue',
  verifyJWT,
  productController.clearBroadcastQueue
);

// ==================== PRODUCT CRUD ROUTES ====================

/**
 * @route   POST /api/products
 * @desc    Create a new product with images
 * @access  Admin only (consider adding verifyJWT for production)
 */
router.post(
  '/', 
  verifyJWT, // Add this for production
  uploadProductImages.array('images', 10),
  productController.createProduct
);

/**
 * @route   PUT /api/products/:id
 * @desc    Update product with images
 * @access  Admin only (consider adding verifyJWT for production)
 */
router.put(
  '/:id', 
  verifyJWT, // Add this for production
  uploadProductImages.array('images', 10),
  productController.updateProduct
);

/**
 * @route   PATCH /api/products/:id
 * @desc    Partially update product
 * @access  Admin only (consider adding verifyJWT for production)
 */
router.patch(
  '/:id',
  verifyJWT, // Add this for production
  productController.patchProduct
);

/**
 * @route   DELETE /api/products/:id
 * @desc    Delete product
 * @access  Admin only (consider adding verifyJWT for production)
 */
router.delete(
  '/:id',
  verifyJWT, // Add this for production
  productController.deleteProduct
);

// ==================== STOCK MANAGEMENT ROUTES ====================

/**
 * @route   PATCH /api/products/:id/stock
 * @desc    Update product stock
 * @access  Admin only (consider adding verifyJWT for production)
 */
router.patch(
  '/:id/stock',
  verifyJWT, // Add this for production
  productController.updateProductStock
);

/**
 * @route   GET /api/products/stock/low
 * @desc    Get low stock products
 * @access  Public (or admin only based on your needs)
 */
router.get('/stock/low', productController.getLowStockProducts);

/**
 * @route   GET /api/products/stock/out
 * @desc    Get out of stock products
 * @access  Public (or admin only based on your needs)
 */
router.get('/stock/out', productController.getOutOfStockProducts);

// ==================== SEARCH & FILTER ROUTES ====================

/**
 * @route   GET /api/products/search
 * @desc    Search products by name
 * @access  Public
 */
router.get('/search', productController.searchProductsByName);

/**
 * @route   POST /api/products/advanced-search
 * @desc    Advanced search with multiple filters
 * @access  Public
 */
router.post('/advanced-search', productController.advancedSearch);

// ==================== GET PRODUCTS ROUTES ====================

/**
 * @route   GET /api/products
 * @desc    Get all products with filtering, pagination, and sorting
 * @access  Public
 */
router.get('/', productController.getAllProducts);

/**
 * @route   GET /api/products/featured
 * @desc    Get featured products
 * @access  Public
 */
router.get('/featured', productController.getFeaturedProducts);

/**
 * @route   GET /api/products/new-arrivals
 * @desc    Get new arrivals
 * @access  Public
 */
router.get('/new-arrivals', productController.getNewArrivals);

/**
 * @route   GET /api/products/recommended/:id
 * @desc    Get recommended products based on current product
 * @access  Public
 */
router.get('/recommended/:id', productController.getRecommendedProducts);

/**
 * @route   GET /api/products/:id
 * @desc    Get single product by ID
 * @access  Public
 */
router.get('/:id', productController.getProductById);

// ==================== BULK OPERATIONS ====================

/**
 * @route   POST /api/products/bulk
 * @desc    Bulk create products
 * @access  Admin only (consider adding verifyJWT for production)
 */
router.post(
  '/bulk',
  verifyJWT, // Add this for production
  productController.bulkCreateProducts
);

// ==================== FILTERS & CATEGORIES ====================

/**
 * @route   GET /api/products/filters/types
 * @desc    Get all product types
 * @access  Public
 */
router.get('/filters/types', productController.getProductTypes);

/**
 * @route   GET /api/products/filters/carriers
 * @desc    Get all carriers
 * @access  Public
 */
router.get('/filters/carriers', productController.getAllCarriers);

/**
 * @route   GET /api/products/filters/countries
 * @desc    Get all countries
 * @access  Public
 */
router.get('/filters/countries', productController.getAllCountries);

/**
 * @route   GET /api/products/filters/colors
 * @desc    Get all colors
 * @access  Public
 */
router.get('/filters/colors', productController.getAllColors);

// ==================== STATISTICS ROUTES ====================

/**
 * @route   GET /api/products/stats/inventory
 * @desc    Get inventory statistics
 * @access  Public (or admin only based on your needs)
 */
router.get('/stats/inventory', productController.getInventoryStats);

/**
 * @route   GET /api/products/stats/price-range
 * @desc    Get price range statistics
 * @access  Public
 */
router.get('/stats/price-range', productController.getPriceRangeStats);

/**
 * @route   GET /api/products/stats/by-type
 * @desc    Get products by type statistics
 * @access  Public
 */
router.get('/stats/by-type', productController.getProductsByType);

// ==================== EXPORT ROUTES ====================

/**
 * @route   GET /api/products/export/csv
 * @desc    Export products to CSV
 * @access  Admin only (consider adding verifyJWT for production)
 */
router.get(
  '/export/csv',
  verifyJWT, // Add this for production
  productController.exportProductsToCSV
);

/**
 * @route   GET /api/products/export/json
 * @desc    Export products to JSON
 * @access  Admin only (consider adding verifyJWT for production)
 */
router.get(
  '/export/json',
  verifyJWT, // Add this for production
  productController.exportProductsToJSON
);

// ==================== CLONE & DUPLICATE ROUTES ====================

/**
 * @route   POST /api/products/:id/clone
 * @desc    Clone an existing product
 * @access  Admin only (consider adding verifyJWT for production)
 */
router.post(
  '/:id/clone',
  verifyJWT, // Add this for production
  productController.cloneProduct
);

// ==================== MAINTENANCE ROUTES ====================

/**
 * @route   DELETE /api/products/cleanup/old
 * @desc    Clean up old products
 * @access  Admin only (consider adding verifyJWT for production)
 */
router.delete(
  '/cleanup/old',
  verifyJWT, // Add this for production
  productController.cleanupOldProducts
);

/**
 * @route   POST /api/products/maintenance/reindex
 * @desc    Reindex products for search
 * @access  Admin only (consider adding verifyJWT for production)
 */
router.post(
  '/maintenance/reindex',
  verifyJWT, // Add this for production
  productController.reindexProducts
);

// ==================== VALIDATION & CHECK ROUTES ====================

/**
 * @route   GET /api/products/check/imei/:imei
 * @desc    Check if IMEI exists
 * @access  Public (or admin only)
 */
router.get('/check/imei/:imei', productController.checkIMEIExists);

/**
 * @route   GET /api/products/check/sku/:sku
 * @desc    Check if SKU exists
 * @access  Public (or admin only)
 */
router.get('/check/sku/:sku', productController.checkSKUExists);

// ==================== PRODUCT NOTIFICATION ROUTES ====================

/**
 * @route   POST /api/products/:id/resend-notification
 * @desc    Resend WhatsApp notification for a specific product
 * @access  Admin only
 */
router.post(
  '/:id/resend-notification',
  verifyJWT,
  productController.resendProductNotification
);

module.exports = router;
