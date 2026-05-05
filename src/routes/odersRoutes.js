const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const verifyJWT = require('../middleware/verifyJWT');
const verifyRole = require('../middleware/verifyRole');
const ROLES_LIST = require('../config/role_list');

router.use(express.json());
router.use(verifyJWT);

// ORDER ROUTES
router.post('/orders', orderController.createOrder);
router.get('/orders', orderController.getOrders);
/** List routes with static path segments before `/:id` so Express does not capture them as ids. */
router.get('/orders/delivery/pending', verifyRole(ROLES_LIST.ADMIN), orderController.getPendingDeliveryOrders);
router.get('/orders/:id', orderController.getOrderById);
router.patch('/orders/:id/accept', orderController.acceptOrder);
router.patch('/orders/:id/reject', orderController.rejectOrder);
router.patch('/orders/:id/cancel', orderController.cancelOrder);

/**
 * DELETE /api/orders/:id
 * Permanently delete an order (admin or order owner — enforced in controller).
 * Matches frontend: axios.delete(`/orders/${id}`) with baseURL ending in /api.
 */
router.delete('/orders/:id', orderController.deleteOrder);

router.patch('/orders/:id/delivery', verifyRole(ROLES_LIST.ADMIN), orderController.updateDeliveryInfo);

router.get('/notifications', orderController.getNotifications);
router.patch('/notifications/:id/read', orderController.markNotificationRead);
router.patch('/notifications/mark-all-read', orderController.markAllNotificationsRead);

module.exports = router;
