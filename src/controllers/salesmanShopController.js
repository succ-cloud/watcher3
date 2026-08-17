const User = require('../models/User');
const mongoose = require('mongoose');
const Product = require('../models/ItemsList');
const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');
const BulkShipment = require('../models/BulkShipment');
const WarehouseStockRequest = require('../models/WarehouseStockRequest');
const { REQUEST_STATUS } = require('../models/WarehouseStockRequest');
const { Order } = require('../models/Order');
const { resolveMainFromSubWarehouse } = require('../utils/warehouseResolve');
const { applyProductArrival } = require('../utils/productWarehouseArrival');
const { attachResolvedOriginWarehouses } = require('../utils/warehousePopulate');
const {
  loadSalesmanWithShops,
  assertSalesmanShopAccess,
  orderMatchesAssignedShops,
} = require('../utils/salesmanShopAccess');
const {
  buildVendorFulfillmentPreview,
  loadRegionalInventoryProducts,
} = require('../utils/vendorOrderInventoryMatch');
const { loadShopProductsForOrder } = require('../utils/vendorOrderFulfillment');
const { ensureVendorBuyOrderFulfillment } = require('../utils/salesmanShopRouting');

function isUsaWarehouseCity(city) {
  return String(city || '').trim().toUpperCase() === 'USA';
}

function shopSummary(w) {
  if (!w) return null;
  return {
    _id: w._id,
    id: w._id,
    name: w.name,
    city: w.city,
    address: w.address,
    type: w.type,
  };
}

function resolveStaffUserId(req) {
  return String(req.userId || req.user?.userId || req.user?.id || req.user?._id || '').trim();
}

/** On-hand phone units at a shop (IME count when registered, else stock). Excludes in-transit lines. */
async function sumAvailableUnitsAtShop(warehouseId) {
  const { sumAvailableUnitsAtWarehouse } = require('../utils/warehouseInventoryStats');
  return sumAvailableUnitsAtWarehouse(warehouseId);
}

/** GET /api/sales/shops — shops assigned to the logged-in salesperson */
async function listMyShops(req, res) {
  try {
    const userId = resolveStaffUserId(req);
    const salesman = await loadSalesmanWithShops(userId);
    if (!salesman) {
      return res.status(403).json({ success: false, message: 'Salesperson access only.' });
    }

    const shops = (salesman.assignedShops || []).filter(Boolean);
    const enriched = await Promise.all(
      shops.map(async (shop) => {
        const whId = shop._id;
        const [travellingCount, arrivedCount, pendingRequestCount] = await Promise.all([
          Product.countDocuments({ currentWarehouse: whId, shipmentStatus: 'travelling' }),
          Product.countDocuments({ currentWarehouse: whId, shipmentStatus: 'arrived' }),
          WarehouseStockRequest.countDocuments({
            requestingShop: whId,
            status: REQUEST_STATUS.PENDING,
          }),
        ]);
        return {
          ...shopSummary(shop),
          travellingCount,
          arrivedCount,
          pendingRequestCount,
        };
      }),
    );

    return res.status(200).json({
      success: true,
      count: enriched.length,
      data: enriched,
    });
  } catch (err) {
    console.error('listMyShops:', err);
    return res.status(500).json({ success: false, message: 'Failed to load your Shops.' });
  }
}

/** GET /api/sales/shops/:id — shop detail for assigned salesperson */
async function getMyShopDetail(req, res) {
  try {
    const userId = resolveStaffUserId(req);
    const { shop } = await assertSalesmanShopAccess(userId, req.params.id);

    const whId = shop._id;
    const { main } = await resolveMainFromSubWarehouse(whId);

    const [travellingCount, arrivedCount, pendingRequestCount, assignedSalespeople, unitsAtShop] =
      await Promise.all([
      Product.countDocuments({ currentWarehouse: whId, shipmentStatus: 'travelling' }),
      Product.countDocuments({ currentWarehouse: whId, shipmentStatus: 'arrived' }),
      WarehouseStockRequest.countDocuments({
        requestingShop: whId,
        status: REQUEST_STATUS.PENDING,
      }),
      User.find({ role: 'salesman', assignedShops: whId })
        .select('name accountStatus tel whatsappNumber businessName businessAddress email')
        .sort({ name: 1 }),
      sumAvailableUnitsAtShop(whId),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        shop: shopSummary(shop),
        parentMain: main ? shopSummary(main) : null,
        teamAtShop: assignedSalespeople.map((u) => ({
          _id: u._id,
          name: u.name,
          accountStatus: u.accountStatus,
          tel: u.tel,
          whatsappNumber: u.whatsappNumber,
          businessName: u.businessName,
          businessAddress: u.businessAddress,
          email: u.email,
        })),
        stats: {
          travellingCount,
          arrivedCount,
          pendingRequestCount,
          unitsAtShop,
        },
      },
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('getMyShopDetail:', err);
    return res.status(status).json({
      success: false,
      message: err.message || 'Failed to load shop.',
    });
  }
}

/** GET /api/sales/shops/:id/products — stock at shop (read-only) */
async function getMyShopProducts(req, res) {
  try {
    const userId = resolveStaffUserId(req);
    const { shop } = await assertSalesmanShopAccess(userId, req.params.id);

    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 500);
    const products = await Product.find({
      currentWarehouse: shop._id,
      shipmentStatus: { $ne: 'travelling' },
    })
      .select(
        'product_name brand product_type capacity color stock price shipmentStatus bulkBatchCode phoneLocation country IME imeCodes createdAt destinationSubWarehouse destinationMainWarehouse originWarehouse currentWarehouse images primaryImage',
      )
      .populate([
        { path: 'destinationSubWarehouse', select: 'name city type' },
        { path: 'destinationMainWarehouse', select: 'name city type' },
        { path: 'originWarehouse', select: 'name city type', strictPopulate: false },
        { path: 'currentWarehouse', select: 'name city type' },
      ])
      .sort({ createdAt: -1 })
      .limit(limit);

    const totalStock = products.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);

    return res.status(200).json({
      success: true,
      data: {
        shop: shopSummary(shop),
        count: products.length,
        totalStock,
        products,
      },
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('getMyShopProducts:', err);
    return res.status(status).json({
      success: false,
      message: err.message || 'Failed to load shop products.',
    });
  }
}

/** GET /api/sales/general-inventory/products — all regional inventory (USA excluded) */
async function listAllGeneralInventoryProducts(req, res) {
  try {
    const userId = resolveStaffUserId(req);
    const salesman = await loadSalesmanWithShops(userId);
    if (!salesman) {
      return res.status(403).json({ success: false, message: 'Salesperson access only.' });
    }

    const warehouses = await Warehouse.find({ isActive: true }).select('_id city');
    const warehouseIds = warehouses
      .filter((w) => !isUsaWarehouseCity(w.city))
      .map((w) => w._id);

    if (!warehouseIds.length) {
      return res.status(200).json({
        success: true,
        data: { count: 0, totalStock: 0, products: [] },
      });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 2000);
    const products = await Product.find({
      currentWarehouse: { $in: warehouseIds },
      shipmentStatus: { $ne: 'travelling' },
      stock: { $gt: 0 },
    })
      .select(
        'product_name brand product_type capacity color stock price shipmentStatus bulkBatchCode phoneLocation country createdAt destinationSubWarehouse destinationMainWarehouse originWarehouse currentWarehouse IME imeCodes images primaryImage',
      )
      .populate([
        { path: 'destinationSubWarehouse', select: 'name city type' },
        { path: 'destinationMainWarehouse', select: 'name city type' },
        { path: 'originWarehouse', select: 'name city type', strictPopulate: false },
        { path: 'currentWarehouse', select: 'name city type' },
      ])
      .sort({ product_name: 1, createdAt: -1 })
      .limit(limit);

    const totalStock = products.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);

    return res.status(200).json({
      success: true,
      data: {
        count: products.length,
        totalStock,
        products,
      },
    });
  } catch (err) {
    console.error('listAllGeneralInventoryProducts:', err);
    return res.status(500).json({ success: false, message: 'Failed to load general inventory.' });
  }
}

/** GET /api/sales/general-inventory/warehouses — active warehouses except USA */
async function listGeneralInventoryWarehouses(req, res) {
  try {
    const userId = resolveStaffUserId(req);
    const salesman = await loadSalesmanWithShops(userId);
    if (!salesman) {
      return res.status(403).json({ success: false, message: 'Salesperson access only.' });
    }

    const warehouses = await Warehouse.find({ isActive: true })
      .select('name city address type parentWarehouse')
      .populate({ path: 'parentWarehouse', select: 'name city type' })
      .sort({ type: 1, city: 1, name: 1 });

    const filtered = warehouses
      .filter((w) => !isUsaWarehouseCity(w.city))
      .map((w) => shopSummary(w));

    return res.status(200).json({
      success: true,
      count: filtered.length,
      data: filtered,
    });
  } catch (err) {
    console.error('listGeneralInventoryWarehouses:', err);
    return res.status(500).json({ success: false, message: 'Failed to load warehouses.' });
  }
}

/** GET /api/sales/general-inventory/warehouses/:warehouseId/products */
async function getGeneralInventoryProducts(req, res) {
  try {
    const userId = resolveStaffUserId(req);
    const salesman = await loadSalesmanWithShops(userId);
    if (!salesman) {
      return res.status(403).json({ success: false, message: 'Salesperson access only.' });
    }

    const warehouse = await Warehouse.findOne({
      _id: req.params.warehouseId,
      isActive: true,
    });
    if (!warehouse) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }
    if (isUsaWarehouseCity(warehouse.city)) {
      return res.status(403).json({
        success: false,
        message: 'USA warehouse inventory is not available here.',
      });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 500);
    const products = await Product.find({
      currentWarehouse: warehouse._id,
      shipmentStatus: { $ne: 'travelling' },
      stock: { $gt: 0 },
    })
      .select(
        'product_name brand product_type capacity color stock price shipmentStatus bulkBatchCode phoneLocation country createdAt destinationSubWarehouse destinationMainWarehouse originWarehouse currentWarehouse IME imeCodes images primaryImage',
      )
      .populate([
        { path: 'destinationSubWarehouse', select: 'name city type' },
        { path: 'destinationMainWarehouse', select: 'name city type' },
        { path: 'originWarehouse', select: 'name city type', strictPopulate: false },
        { path: 'currentWarehouse', select: 'name city type' },
      ])
      .sort({ product_name: 1, createdAt: -1 })
      .limit(limit);

    const totalStock = products.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);

    return res.status(200).json({
      success: true,
      data: {
        warehouse: shopSummary(warehouse),
        count: products.length,
        totalStock,
        products,
      },
    });
  } catch (err) {
    console.error('getGeneralInventoryProducts:', err);
    return res.status(500).json({ success: false, message: 'Failed to load warehouse products.' });
  }
}

/** POST /api/sales/general-inventory/requests — request stock from a regional warehouse to assigned shop */
async function createGeneralInventoryRequest(req, res) {
  try {
    const userId = resolveStaffUserId(req);
    const shopId = String(req.body?.shopId || '').trim();
    const warehouseId = String(req.body?.warehouseId || '').trim();
    const productName = String(req.body?.productName || '').trim();

    if (!shopId || !warehouseId || !productName) {
      return res.status(400).json({
        success: false,
        message: 'shopId, warehouseId, and productName are required.',
      });
    }

    await assertSalesmanShopAccess(userId, shopId);

    const sourceWarehouse = await Warehouse.findOne({ _id: warehouseId, isActive: true });
    if (!sourceWarehouse) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }
    if (isUsaWarehouseCity(sourceWarehouse.city)) {
      return res.status(403).json({
        success: false,
        message: 'Cannot request stock from the USA warehouse.',
      });
    }

    let servingMain = null;
    if (sourceWarehouse.type === WAREHOUSE_TYPES.MAIN) {
      servingMain = sourceWarehouse;
    } else if (sourceWarehouse.type === WAREHOUSE_TYPES.SUB) {
      const { main } = await resolveMainFromSubWarehouse(sourceWarehouse._id);
      servingMain = main;
    }

    if (!servingMain || isUsaWarehouseCity(servingMain.city)) {
      return res.status(400).json({
        success: false,
        message: 'This warehouse is not linked to a regional main warehouse.',
      });
    }

    const brand = String(req.body?.brand || '').trim();
    const capacity = String(req.body?.capacity || '').trim();
    const color = String(req.body?.color || '').trim();
    const quantity = Math.max(1, parseInt(req.body?.quantity, 10) || 1);
    const userNotes = String(req.body?.notes || '').trim();
    const catalogNote = `Requested from ${sourceWarehouse.name} (${sourceWarehouse.city || 'Other'}) inventory.`;
    const notes = userNotes ? `${catalogNote} ${userNotes}` : catalogNote;

    const doc = await WarehouseStockRequest.create({
      productName,
      brand,
      capacity,
      color,
      quantity,
      notes,
      requestingShop: shopId,
      servingMain: servingMain._id,
      createdBy: userId,
    });

    await doc.populate([
      { path: 'requestingShop', select: 'name city' },
      { path: 'servingMain', select: 'name city' },
    ]);

    return res.status(201).json({
      success: true,
      message: `Request sent to ${servingMain.name}.`,
      data: doc,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('createGeneralInventoryRequest:', err);
    return res.status(status).json({
      success: false,
      message: err.message || 'Failed to submit stock request.',
    });
  }
}

/** GET /api/sales/shops/:id/incoming — travelling stock waiting to be accepted at this shop */
async function getMyShopIncoming(req, res) {
  try {
    const userId = resolveStaffUserId(req);
    const { shop } = await assertSalesmanShopAccess(userId, req.params.id);

    const products = await Product.find({
      currentWarehouse: shop._id,
      shipmentStatus: 'travelling',
    })
      .select(
        'product_name brand capacity color stock price bulkBatchCode bulkShipment country destinationSubWarehouse destinationMainWarehouse originWarehouse currentWarehouse shipmentStatus locationHistory createdAt',
      )
      .populate([
        { path: 'destinationSubWarehouse', select: 'name city type' },
        { path: 'destinationMainWarehouse', select: 'name city type' },
        { path: 'originWarehouse', select: 'name city type', strictPopulate: false },
        { path: 'currentWarehouse', select: 'name city type' },
      ])
      .sort({ createdAt: -1 })
      .limit(500);

    await attachResolvedOriginWarehouses(products);

    const batchCodes = [
      ...new Set(products.map((p) => String(p.bulkBatchCode || '').trim()).filter(Boolean)),
    ];
    const batches = batchCodes.map((batchCode) => {
      const rows = products.filter((p) => String(p.bulkBatchCode || '').trim() === batchCode);
      return {
        batchCode,
        count: rows.length,
        totalStock: rows.reduce((sum, p) => sum + Math.max(0, Number(p.stock) || 0), 0),
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        shop: shopSummary(shop),
        products,
        batches,
        count: products.length,
      },
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('getMyShopIncoming:', err);
    return res.status(status).json({
      success: false,
      message: err.message || 'Failed to load incoming stock.',
    });
  }
}

/** POST /api/sales/shops/:id/receive-stock — salesperson accepts incoming stock at assigned shop */
async function receiveMyShopStock(req, res) {
  try {
    const userId = resolveStaffUserId(req);
    const { shop } = await assertSalesmanShopAccess(userId, req.params.id);

    const batchCode = String(req.body?.batchCode || '').trim();
    const productIds = Array.isArray(req.body?.productIds)
      ? req.body.productIds.filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
      : [];

    let products = [];

    if (batchCode) {
      const code = batchCode.toUpperCase();
      products = await Product.find({
        currentWarehouse: shop._id,
        shipmentStatus: 'travelling',
        bulkBatchCode: code,
      });
      if (!products.length) {
        const shipment = await BulkShipment.findOne({ batchCode: code });
        if (shipment) {
          products = await Product.find({
            bulkShipment: shipment._id,
            currentWarehouse: shop._id,
            shipmentStatus: 'travelling',
          });
        }
      }
    } else if (productIds.length) {
      products = await Product.find({
        _id: { $in: productIds },
        currentWarehouse: shop._id,
        shipmentStatus: 'travelling',
      });
    } else {
      return res.status(400).json({
        success: false,
        message: 'Provide batchCode or productIds to accept incoming stock.',
      });
    }

    if (!products.length) {
      return res.status(400).json({
        success: false,
        message: 'No incoming stock found to accept at this shop.',
      });
    }

    const note = `Received at shop ${shop.name}`;
    for (const product of products) {
      await applyProductArrival(product, shop, userId, note);
    }

    return res.status(200).json({
      success: true,
      message: `${products.length} product(s) accepted at ${shop.name}.`,
      data: { count: products.length, shop: shopSummary(shop) },
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('receiveMyShopStock:', err);
    return res.status(status).json({
      success: false,
      message: err.message || 'Failed to accept incoming stock.',
    });
  }
}

/** GET /api/sales/orders/:orderId/vendor-fulfillment — shop match + IME availability preview */
async function getVendorOrderFulfillmentPreview(req, res) {
  try {
    const userId = resolveStaffUserId(req);
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'Order id is required.' });
    }

    let order = await Order.findById(orderId)
      .populate('productId', 'product_name brand capacity color price')
      .lean();
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    await ensureVendorBuyOrderFulfillment(order);
    const salesman = await loadSalesmanWithShops(userId);
    if (!orderMatchesAssignedShops(order, salesman?.assignedShops || [])) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this order.',
      });
    }

    const assignedShopId = String(
      order?.directSale?.assignedWarehouseId?._id ??
        order?.directSale?.assignedWarehouseId ??
        '',
    ).trim();
    if (!assignedShopId) {
      return res.status(400).json({
        success: false,
        message: 'This order is not assigned to a fulfillment shop yet.',
      });
    }

    await assertSalesmanShopAccess(userId, assignedShopId);

    const [shopProducts, platformProducts] = await Promise.all([
      loadShopProductsForOrder(assignedShopId),
      loadRegionalInventoryProducts(true),
    ]);

    const preview = buildVendorFulfillmentPreview({
      order,
      shopProducts,
      platformProducts,
      shopId: assignedShopId,
    });

    return res.status(200).json({
      success: true,
      data: {
        orderId: order._id,
        shopId: assignedShopId,
        shopName: order?.directSale?.assignedWarehouseName || '',
        ...preview,
      },
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('getVendorOrderFulfillmentPreview:', err);
    return res.status(status).json({
      success: false,
      message: err.message || 'Failed to load vendor fulfillment preview.',
    });
  }
}

module.exports = {
  listMyShops,
  getMyShopDetail,
  getMyShopProducts,
  getMyShopIncoming,
  receiveMyShopStock,
  listAllGeneralInventoryProducts,
  listGeneralInventoryWarehouses,
  getGeneralInventoryProducts,
  createGeneralInventoryRequest,
  getVendorOrderFulfillmentPreview,
};
