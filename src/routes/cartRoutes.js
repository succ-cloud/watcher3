const express = require('express');
const router = express.Router();
const cartController = require('../controllers/cartController');
const verifyJWT = require('../middleware/verifyJWT');

// All cart routes require authentication
router.use(verifyJWT);

// Cart routes
router.get('/', cartController.getCart);
router.delete('/', cartController.clearCart);
router.get('/summary', cartController.getCartSummary);

// Cart items routes
router.post('/items', cartController.addToCart);
router.put('/items/:productId', cartController.updateCartItem);
router.delete('/items/:productId', cartController.removeCartItem);

// Delivery info route
router.put('/delivery-info', cartController.updateDeliveryInfo);

module.exports = router;
