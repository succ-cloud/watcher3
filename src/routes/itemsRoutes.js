// routes/itemsRoutes.js
const express = require('express');
const router = express.Router();
const productController = require('../controllers/itemsController');
const { uploadProductImages, uploadMemory } = require('../config/cloudinary');
const verifyJWT = require('../middleware/verifyJWT');

// ==================== IMAGE UPLOAD ROUTES ====================

router.post(
  '/:id/images', 
  uploadProductImages.array('images', 10),
  productController.addProductImages
);

router.delete('/:id/images/:publicId', productController.deleteProductImage);

router.patch('/:id/images/:publicId/primary', productController.setPrimaryImage);

router.get('/:id/images', productController.getProductImages);

router.post(
  '/images/bulk-upload',
  uploadProductImages.array('images', 50),
  productController.bulkUploadImages
);

// ==================== WHATSAPP BROADCAST QUEUE ROUTES ====================

// ✅ Make sure these match the exported function names exactly
router.get(
  '/broadcast/queue-status',
  verifyJWT,
  productController.getBroadcastQueueStatus  // ✅ Must exist in controller
);

router.post(
  '/broadcast/force',
  verifyJWT,
  productController.forceBroadcastNow  
  // ✅ Must be forceBroadcastNow (not forceBroadcastNo)
);

// If you have clear queue route
// router.delete(
//   '/broadcast/queue',
//   verifyJWT,
//   productController.clearBroadcastQueue 
// );

// ==================== PRODUCT CRUD ROUTES ====================

router.post(
  '/', 
  verifyJWT,
  uploadProductImages.array('images', 10),
  productController.createProduct
);

router.put(
  '/:id', 
  verifyJWT,
  uploadProductImages.array('images', 10),
  productController.updateProduct
);

router.patch('/:id', verifyJWT, productController.patchProduct);

router.delete('/:id', verifyJWT, productController.deleteProduct);

router.patch('/:id/stock', verifyJWT, productController.updateProductStock);

// ==================== PUBLIC ROUTES ====================

router.get('/search', productController.searchProductsByName);
router.post('/advanced-search', productController.advancedSearch);
router.get('/', productController.getAllProducts);
router.get('/featured', productController.getFeaturedProducts);
router.get('/new-arrivals', productController.getNewArrivals);
router.get('/recommended/:id', productController.getRecommendedProducts);
router.get('/stock/low', productController.getLowStockProducts);
router.get('/stock/out', productController.getOutOfStockProducts);
router.get('/:id', productController.getProductById);

// ==================== BULK OPERATIONS ====================

router.post('/bulk', verifyJWT, productController.bulkCreateProducts);

// ==================== FILTERS & CATEGORIES ====================

router.get('/filters/types', productController.getProductTypes);
router.get('/filters/carriers', productController.getAllCarriers);
router.get('/filters/countries', productController.getAllCountries);
router.get('/filters/colors', productController.getAllColors);

// ==================== STATISTICS ====================

router.get('/stats/inventory', productController.getInventoryStats);
router.get('/stats/price-range', productController.getPriceRangeStats);
router.get('/stats/by-type', productController.getProductsByType);

// ==================== EXPORT ROUTES ====================

router.get('/export/csv', verifyJWT, productController.exportProductsToCSV);
router.get('/export/json', verifyJWT, productController.exportProductsToJSON);

// ==================== CLONE & DUPLICATE ====================

router.post('/:id/clone', verifyJWT, productController.cloneProduct);

// ==================== MAINTENANCE ====================

router.delete('/cleanup/old', verifyJWT, productController.cleanupOldProducts);
router.post('/maintenance/reindex', verifyJWT, productController.reindexProducts);

// ==================== VALIDATION & CHECK ====================

router.get('/check/imei/:imei', productController.checkIMEIExists);
router.get('/check/sku/:sku', productController.checkSKUExists);

// ==================== PRODUCT NOTIFICATION ====================

// router.post('/:id/resend-notification', verifyJWT, productController.resendProductNotification);

module.exports = router;
