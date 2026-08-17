const express = require('express');
const router = express.Router();
const verifyJWT = require('../middleware/verifyJWT');
const verifyRole = require('../middleware/verifyRole');
const { ROLES } = require('../models/User');
const ROLES_LIST = require('../config/role_list');
const { uploadProductImages } = require('../config/cloudinary');
const pricingController = require('../controllers/pricingController');

router.use(verifyJWT);

/** Same multer field name as inventory/product uploads: `images`. */
function pricingImageUpload(maxCount = 1) {
  return (req, res, next) => {
    uploadProductImages.array('images', maxCount)(req, res, (err) => {
      if (!err) return next();
      const message =
        err?.message ||
        'Could not upload the pricing images. Use JPEG, PNG, GIF, or WebP under 5 MB (up to 5 images).';
      return res.status(400).json({ success: false, message });
    });
  };
}

/** Admin + salesperson can browse the retail pricing catalog. */
router.get('/', verifyRole([ROLES.ADMIN, ROLES_LIST.SALESMAN]), pricingController.listPricing);

/** Any authenticated user — pricing-table photos only (for vendor shop listing). */
router.get('/images/shop', pricingController.listShopPricingImages);

/** Admin-only writes. Optional multipart `images` (same as /api/products, up to 5). */
router.post('/', verifyRole(ROLES.ADMIN), pricingImageUpload(5), pricingController.createPricing);

router.post(
  '/:id/image',
  verifyRole(ROLES.ADMIN),
  pricingImageUpload(5),
  pricingController.uploadPricingImage,
);

router.patch('/:id', verifyRole(ROLES.ADMIN), pricingImageUpload(5), pricingController.updatePricing);

module.exports = router;
