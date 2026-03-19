const express = require('express');
const router = express.Router();
const productController = require('../controllers/itemsController');
const { uploadProductImages, uploadMemory } = require('../config/cloudinary');
const verifyJWT = require('../middleware/verifyJWT')
// ==================== IMAGE UPLOAD ROUTES ====================

/**
 * @route   POST /api/products/:id/images
 * @desc    Add images to existing product
 * @access  Public
 */
router.post(
  '/:id/images', 
  uploadProductImages.array('images', 10), // Max 10 images
  productController.addProductImages
);

/**
 * @route   DELETE /api/products/:id/images/:publicId
 * @desc    Delete image from product
 * @access  Public
 */
router.delete('/:id/images/:publicId', productController.deleteProductImage);

/**
 * @route   PATCH /api/products/:id/images/:publicId/primary
 * @desc    Set primary image
 * @access  Public
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
 * @access  Public
 */
router.post(
  '/images/bulk-upload',
  uploadProductImages.array('images', 50), // Max 50 images total
  productController.bulkUploadImages
);

// ==================== EXISTING ROUTES (UPDATED) ====================

/**
 * @route   POST /api/products
 * @desc    Create a new product with images
 * @access  Public
 */
router.post(
  '/', 
   uploadProductImages.array('images', 10),
  productController.createProduct
);

/**
 * @route   PUT /api/products/:id
 * @desc    Update product with images
 * @access  Public
 */
router.put(
  '/:id', 
  uploadProductImages.array('images', 10),
  productController.updateProduct
);

// ... rest of your existing routes
router.get('/search', productController.searchProductsByName);
router.post('/advanced-search', productController.advancedSearch);
router.get('/', verifyJWT, productController.getAllProducts);
router.get('/:id', productController.getProductById);
router.post('/bulk', productController.bulkCreateProducts);
router.patch('/:id', productController.patchProduct);
router.delete('/:id', productController.deleteProduct);
router.patch('/:id/stock', productController.updateProductStock);

module.exports = router;