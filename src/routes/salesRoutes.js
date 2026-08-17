const express = require('express');
const router = express.Router();
const verifyJWT = require('../middleware/verifyJWT');
const verifyRole = require('../middleware/verifyRole');
const ROLES_LIST = require('../config/role_list');

/** Lazy-bind salesperson handlers so a partial deploy cannot crash route registration. */
function salesHandler(methodName) {
  return (req, res, next) => {
    const controller = require('../controllers/salesmanShopController');
    const fn = controller[methodName];
    if (typeof fn !== 'function') {
      return res.status(500).json({
        success: false,
        message: `Sales handler "${methodName}" is not available. Deploy the latest salesmanShopController.js.`,
      });
    }
    return fn(req, res, next);
  };
}

function directSaleHandler(methodName) {
  return (req, res, next) => {
    const controller = require('../controllers/directSaleController');
    const fn = controller[methodName];
    if (typeof fn !== 'function') {
      return res.status(500).json({
        success: false,
        message: `Direct sale handler "${methodName}" is not available. Deploy the latest directSaleController.js.`,
      });
    }
    return fn(req, res, next);
  };
}

function adminHandler(methodName) {
  return (req, res, next) => {
    const controller = require('../controllers/adminController');
    const fn = controller[methodName];
    if (typeof fn !== 'function') {
      return res.status(500).json({
        success: false,
        message: `Admin handler "${methodName}" is not available. Deploy the latest adminController.js.`,
      });
    }
    return fn(req, res, next);
  };
}

function itemsHandler(methodName) {
  return (req, res, next) => {
    const controller = require('../controllers/itemsController');
    const fn = controller[methodName];
    if (typeof fn !== 'function') {
      return res.status(500).json({
        success: false,
        message: `Inventory handler "${methodName}" is not available. Deploy the latest itemsController.js.`,
      });
    }
    return fn(req, res, next);
  };
}

function expenseHandler(methodName) {
  return (req, res, next) => {
    const controller = require('../controllers/expenseController');
    const fn = controller[methodName];
    if (typeof fn !== 'function') {
      return res.status(500).json({
        success: false,
        message: `Expense handler "${methodName}" is not available. Deploy the latest expenseController.js.`,
      });
    }
    return fn(req, res, next);
  };
}

router.use(verifyJWT);
router.use(verifyRole([ROLES_LIST.ADMIN, ROLES_LIST.SALESMAN]));

router.get('/shops/:id/expenses', expenseHandler('listShopExpenses'));
router.post('/shops/:id/expenses', expenseHandler('createShopExpense'));
router.get('/expense-categories', expenseHandler('getExpenseCategories'));

router.get('/shops', salesHandler('listMyShops'));
router.get('/shops/:id/incoming', salesHandler('getMyShopIncoming'));
router.post('/shops/:id/receive-stock', salesHandler('receiveMyShopStock'));
router.get('/shops/:id/products', salesHandler('getMyShopProducts'));
router.get('/shops/:id', salesHandler('getMyShopDetail'));

router.post('/direct-sale/wholesale/preview', directSaleHandler('previewWholesaleDirectSale'));
router.post('/direct-sale/wholesale/confirm', directSaleHandler('confirmWholesaleDirectSale'));
router.post('/direct-sale/retail/confirm', directSaleHandler('confirmRetailDirectSale'));
router.post('/wholesalers', adminHandler('createWholesaler'));

router.get('/general-inventory/products', salesHandler('listAllGeneralInventoryProducts'));
router.get('/general-inventory/warehouses', salesHandler('listGeneralInventoryWarehouses'));
router.get(
  '/general-inventory/warehouses/:warehouseId/products',
  salesHandler('getGeneralInventoryProducts'),
);
router.post('/general-inventory/requests', salesHandler('createGeneralInventoryRequest'));
router.get('/inventory/ime-lookup', itemsHandler('lookupInventoryByIme'));
router.get('/orders/:orderId/vendor-fulfillment', salesHandler('getVendorOrderFulfillmentPreview'));

module.exports = router;
