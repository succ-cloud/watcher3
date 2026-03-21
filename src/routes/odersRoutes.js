const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');

// Add JSON parser for this router
router.use(express.json());

// ORDER ROUTES
router.post('/orders', orderController.createOrder);
router.get('/orders', orderController.getOrders);
router.get('/orders/:id', orderController.getOrderById);
router.patch('/orders/:id/accept', orderController.acceptOrder);
router.patch('/orders/:id/reject', orderController.rejectOrder);
router.patch('/orders/:id/cancel', orderController.cancelOrder);

// NOTIFICATION ROUTES - These need to be at the root level
router.get('/notifications', orderController.getNotifications);
router.patch('/notifications/:id/read', orderController.markNotificationRead);
router.patch('/notifications/mark-all-read', orderController.markAllNotificationsRead);

module.exports = router;