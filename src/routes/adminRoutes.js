const express = require('express');
const router = express.Router();
const {
    getPendingWholesalers,
    getAllWholesalers,
    approveWholesaler,
    rejectWholesaler,
    suspendWholesaler,
    createWholesaler,
    getBusinessCities,
    addBusinessCity,
    updateBusinessCity,
    deleteBusinessCity,
    getTransactionMethods,
    addTransactionMethod,
    updateTransactionMethod,
    deleteTransactionMethod,
} = require('../controllers/adminController');
const {
    getExpenseCategories,
    addExpenseCategory,
    updateExpenseCategory,
    deleteExpenseCategory,
    listAllExpenses,
    createAdminExpense,
} = require('../controllers/expenseController');
const { getAdminDashboardStats } = require('../controllers/adminDashboardController');
const verifyJWT = require('../middleware/verifyJWT');
const verifyRole = require('../middleware/verifyRole');
const { ROLES } = require('../models/User');

// All admin routes require JWT and admin role
router.use(verifyJWT);
router.use(verifyRole(ROLES.ADMIN));

// Platform overview dashboard
router.get('/dashboard', getAdminDashboardStats);

const productControllerRaw = require('../controllers/itemsController');
const productController = new Proxy(productControllerRaw, {
  get(target, prop) {
    const value = target[prop];
    if (typeof value === 'function') return value;
    if (prop === 'then' || typeof prop === 'symbol') return value;
    const name = String(prop);
    console.warn(`itemsController.${name} is missing — admin inventory route will return 500 until updated.`);
    return (req, res) => {
      res.status(500).json({
        success: false,
        message: `Product handler "${name}" is not available. Deploy the latest itemsController.js.`,
      });
    };
  },
});
router.get('/inventory/products', productController.getAdminInventoryProducts);
router.get('/inventory/sold-out', productController.listSoldOutInventory);
router.patch('/inventory/sold-out/:soldImeId/revoke', productController.revokeSoldOutInventoryUnit);
router.get('/inventory/ime-lookup', productController.lookupInventoryByIme);

// Get all pending wholesalers
router.get('/wholesalers/pending', getPendingWholesalers);

// Get all wholesalers
router.get('/wholesalers', getAllWholesalers);

// Create a wholesaler account
router.post('/wholesalers', createWholesaler);
router.get('/business-cities', getBusinessCities);
router.post('/business-cities', addBusinessCity);
router.patch('/business-cities/:cityName', updateBusinessCity);
router.delete('/business-cities/:cityName', deleteBusinessCity);
router.get('/transaction-methods', getTransactionMethods);
router.post('/transaction-methods', addTransactionMethod);
router.patch('/transaction-methods/:methodKey', updateTransactionMethod);
router.delete('/transaction-methods/:methodKey', deleteTransactionMethod);
router.get('/expense-categories', getExpenseCategories);
router.post('/expense-categories', addExpenseCategory);
router.patch('/expense-categories/:categoryKey', updateExpenseCategory);
router.delete('/expense-categories/:categoryKey', deleteExpenseCategory);
router.get('/expenses', listAllExpenses);
router.post('/expenses', createAdminExpense);

// Approve a wholesaler
router.put('/wholesalers/:userId/approve', approveWholesaler);

// Reject a wholesaler
router.put('/wholesalers/:userId/reject', rejectWholesaler);

// Suspend a wholesaler
router.put('/wholesalers/:userId/suspend', suspendWholesaler);

// Warehouses (admin only)
const warehouseController = require('../controllers/warehouseController');

/** Lazy-load hub controller so a partial/circular require cannot crash route registration. */
function warehouseHubHandler(methodName) {
  return (req, res, next) => {
    const hub = require('../controllers/warehouseHubController');
    const fn = hub[methodName];
    if (typeof fn !== 'function') {
      return res.status(500).json({
        success: false,
        message: `Warehouse handler "${methodName}" is not available. Deploy the latest server (warehouseHubController.js).`,
      });
    }
    return fn(req, res, next);
  };
}

router.get('/warehouses/overview', warehouseHubHandler('getWarehousesDashboardOverview'));
router.get('/warehouses', warehouseController.listWarehouses);
router.get('/warehouses/:id/hub', warehouseHubHandler('getWarehouseHub'));
router.get('/warehouses/:id/incoming', warehouseHubHandler('getWarehouseIncoming'));
router.get('/warehouses/:id/ready-to-transfer', warehouseHubHandler('getWarehouseReadyToTransfer'));
router.get('/warehouses/:id/lookup', warehouseHubHandler('lookupImeAtWarehouse'));
router.get('/warehouses/:id/stock-requests', warehouseHubHandler('listStockRequests'));
router.post('/warehouses/:id/stock-requests', warehouseHubHandler('createStockRequest'));
router.post('/warehouses/:id/receive-stock', warehouseHubHandler('receiveStockAtWarehouse'));
router.post('/warehouses/:id/transfer-to-shop', warehouseHubHandler('transferToShop'));
router.post('/warehouses/:id/transfer-to-warehouse', warehouseHubHandler('transferToWarehouse'));
router.get('/warehouses/:id/products', warehouseController.getWarehouseProducts);
router.get('/warehouses/:id/delete-preview', warehouseController.getWarehouseDeletePreview);
router.post('/warehouses/main', warehouseController.createMainWarehouse);
router.post('/warehouses/sub', warehouseController.createSubWarehouse);
router.patch('/warehouses/:id', warehouseController.updateWarehouse);
router.delete('/warehouses/:id', warehouseController.deactivateWarehouse);

// Bulk shipment tracking (admin)
const bulkShipmentController = require('../controllers/bulkShipmentController');
router.get('/bulk-shipments', bulkShipmentController.listBulkShipments);
router.get('/bulk-shipments/:idOrCode', bulkShipmentController.getBulkShipment);
router.patch('/bulk-shipments/:idOrCode/arrive', bulkShipmentController.markBulkShipmentArrived);
router.patch(
  '/bulk-shipments/:idOrCode/assign',
  warehouseHubHandler('assignBulkShipmentDestination'),
);

router.patch('/stock-requests/:requestId', warehouseHubHandler('updateStockRequest'));

const salesReportController = require('../controllers/salesReportController');
router.get('/reports/monthly-sales', salesReportController.getMonthlySalesReport);

router.use('/exchange', require('./exchangeRoutes'));

module.exports = router;
