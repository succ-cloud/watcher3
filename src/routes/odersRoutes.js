const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const directSaleController = require('../controllers/directSaleController');
const verifyJWT = require('../middleware/verifyJWT');
const verifyRole = require('../middleware/verifyRole');
const ROLES_LIST = require('../config/role_list');

function bind(method, handler) {
  if (typeof handler !== 'function') {
    throw new Error(
      `orders route "${method}" handler is missing — deploy the latest orderController (expected export for this route).`,
    );
  }
  return handler;
}

if (typeof verifyJWT !== 'function') {
  throw new Error('verifyJWT middleware is not a function — check server/src/middleware/verifyJWT.js');
}

router.use(verifyJWT);

// ORDER ROUTES
router.post('/orders', bind('POST /orders', orderController.createOrder));
router.get('/orders', bind('GET /orders', orderController.getOrders));
/** List routes with static path segments before `/:id` so Express does not capture them as ids. */
router.get(
  '/orders/delivery/pending',
  verifyRole(ROLES_LIST.ADMIN),
  bind('GET /orders/delivery/pending', orderController.getPendingDeliveryOrders),
);
router.post(
  '/orders/direct-sale/wholesale/preview',
  verifyRole([ROLES_LIST.ADMIN, ROLES_LIST.SALESMAN]),
  bind('POST /orders/direct-sale/wholesale/preview', directSaleController.previewWholesaleDirectSale),
);
router.post(
  '/orders/direct-sale/wholesale/confirm',
  verifyRole([ROLES_LIST.ADMIN, ROLES_LIST.SALESMAN]),
  bind('POST /orders/direct-sale/wholesale/confirm', directSaleController.confirmWholesaleDirectSale),
);
router.post(
  '/orders/direct-sale/retail/confirm',
  verifyRole([ROLES_LIST.ADMIN, ROLES_LIST.SALESMAN]),
  bind('POST /orders/direct-sale/retail/confirm', directSaleController.confirmRetailDirectSale),
);
router.get('/orders/:id', bind('GET /orders/:id', orderController.getOrderById));
router.patch('/orders/:id/accept', bind('PATCH /orders/:id/accept', orderController.acceptOrder));
router.patch('/orders/:id/reject', bind('PATCH /orders/:id/reject', orderController.rejectOrder));
router.patch('/orders/:id/cancel', bind('PATCH /orders/:id/cancel', orderController.cancelOrder));

/**
 * DELETE /api/orders/:id
 * Permanently delete an order (admin or order owner — enforced in controller).
 */
router.delete('/orders/:id', bind('DELETE /orders/:id', orderController.deleteOrder));

router.patch(
  '/orders/:id/delivery',
  verifyRole(ROLES_LIST.ADMIN),
  bind('PATCH /orders/:id/delivery', orderController.updateDeliveryInfo),
);

router.patch(
  '/orders/:id/receipt',
  verifyRole(ROLES_LIST.ADMIN),
  bind('PATCH /orders/:id/receipt', orderController.updateOrderReceipt),
);

router.get('/notifications', bind('GET /notifications', orderController.getNotifications));
router.patch(
  '/notifications/:id/read',
  bind('PATCH /notifications/:id/read', orderController.markNotificationRead),
);
router.patch(
  '/notifications/mark-all-read',
  bind('PATCH /notifications/mark-all-read', orderController.markAllNotificationsRead),
);

module.exports = router;
