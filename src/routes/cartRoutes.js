const express = require('express');
const router = express.Router();
const cartController = require('../controllers/cartController');
const verifyJWT = require('../middleware/verifyJWT');

router.use(verifyJWT);

router.get('/', cartController.getCart);
router.delete('/', cartController.clearCart);
router.get('/summary', cartController.getCartSummary);

router.post('/items', cartController.addToCart);
router.put('/items', cartController.updateCartItem);
router.delete('/items', cartController.removeCartItem);

router.put('/delivery-info', cartController.updateDeliveryInfo);

module.exports = router;
