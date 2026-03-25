const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const verifyJWT = require('../middleware/verifyJWT');
const verifyRole = require('../middleware/verifyRole');
const ROLES_LIST = require('../config/role_list');

// Add JSON parser for this router
router.use(express.json());

// All order routes require authentication
router.use(verifyJWT);

// ORDER ROUTES
router.post('/orders', orderController.createOrder);
router.get('/orders', orderController.getOrders);
router.get('/orders/:id', orderController.getOrderById);
router.patch('/orders/:id/accept', orderController.acceptOrder);
router.patch('/orders/:id/reject', orderController.rejectOrder);
router.patch('/orders/:id/cancel', orderController.cancelOrder);

// DELIVERY ROUTES (Admin only)
router.patch('/orders/:id/delivery', 
    verifyRole(ROLES_LIST.ADMIN), 
    orderController.updateDeliveryInfo
);
router.get('/orders/delivery/pending', 
    verifyRole(ROLES_LIST.ADMIN), 
    orderController.getPendingDeliveryOrders
);

// NOTIFICATION ROUTES
router.get('/notifications', orderController.getNotifications);
router.patch('/notifications/:id/read', orderController.markNotificationRead);
router.patch('/notifications/mark-all-read', orderController.markAllNotificationsRead);

module.exports = router;
