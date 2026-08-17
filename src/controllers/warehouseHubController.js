const mongoose = require('mongoose');

const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');
const Product = require('../models/ItemsList');
const BulkShipment = require('../models/BulkShipment');
const { BULK_SHIPMENT_STATUS } = require('../models/BulkShipment');
const WarehouseStockRequest = require('../models/WarehouseStockRequest');
const { REQUEST_STATUS } = require('../models/WarehouseStockRequest');
const User = require('../models/User');
const { ROLES } = require('../models/User');

const { resolveMainFromSubWarehouse } = require('../utils/warehouseResolve');
const { findBulkShipmentByIdOrCode } = require('./bulkShipmentController');
const {
  applyProductArrival,
  applyProductReceivedAtWarehouse,
  applyProductSentToShop,
  transferProductQuantityToShop,
  transferProductImesToShop,
  transferProductQuantityToMainWarehouse,
  transferProductImesToMainWarehouse,
} = require('../utils/productWarehouseArrival');
const { normalizedImeList, buildImeManifestLines } = require('../utils/productIme');
const {
  sumAvailableUnitsAtWarehouse,
  sumReadyToTransferUnitsAtWarehouse,
  countOnHandProductNamesAtWarehouse,
} = require('../utils/warehouseInventoryStats');
const { normalizeProductPhoneLocation } = require('../utils/normalizeProductPhoneLocation');
const { attachResolvedOriginWarehouses, WAREHOUSE_POPULATE } = require('../utils/warehousePopulate');

const transferImesToMainWarehouse =
  typeof transferProductImesToMainWarehouse === 'function'
    ? transferProductImesToMainWarehouse
    : async (product, dest, userId, selectedImes, note) =>
        transferProductQuantityToMainWarehouse(
          product,
          dest,
          userId,
          Array.isArray(selectedImes) ? selectedImes.length : 0,
          note,
        );

function warehouseSummary(w) {
  if (!w) return null;
  return {
    _id: w._id,
    id: w._id,
    name: w.name,
    type: w.type,
    city: w.city,
    address: w.address,
    parentWarehouse: w.parentWarehouse,
  };
}

const TRANSFER_NOTE_PATTERN = /Sent|Transferred/i;

function parseTransferNote(note) {
  const text = String(note || '').trim();
  if (!text) return { from: null, to: null };
  const fromTo = text.match(/Transferred from (.+?) to (.+?)(?:\.|$)/i);
  if (fromTo) return { from: fromTo[1].trim(), to: fromTo[2].trim() };
  const sentTo = text.match(/Sent .* to (.+?)(?:\.|$)/i);
  if (sentTo) return { from: null, to: sentTo[1].trim() };
  return { from: null, to: null };
}

function productUnitsExpr() {
  return {
    $cond: [{ $gt: [{ $ifNull: ['$stock', 0] }, 0] }, '$stock', 1],
  };
}

/** Recent and in-progress product transfers (warehouse ↔ warehouse, warehouse ↔ shop). */
async function loadRecentProductTransfers(warehouseIds, { limit = 12 } = {}) {
  if (!Array.isArray(warehouseIds) || warehouseIds.length === 0) return [];

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const whObjectIds = warehouseIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)),
  );

  const [activeGroups, historyEvents] = await Promise.all([
    Product.aggregate([
      {
        $match: {
          shipmentStatus: 'travelling',
          originWarehouse: { $ne: null },
          currentWarehouse: { $in: whObjectIds },
        },
      },
      {
        $group: {
          _id: {
            from: '$originWarehouse',
            to: '$currentWarehouse',
            productName: '$product_name',
            brand: '$brand',
            capacity: '$capacity',
          },
          units: { $sum: productUnitsExpr() },
          movedAt: { $max: '$updatedAt' },
        },
      },
      { $sort: { movedAt: -1 } },
      { $limit: limit * 2 },
    ]),
    Product.aggregate([
      {
        $match: {
          locationHistory: {
            $elemMatch: {
              status: 'travelling',
              movedAt: { $gte: since },
              note: { $regex: TRANSFER_NOTE_PATTERN.source, $options: 'i' },
            },
          },
        },
      },
      { $unwind: '$locationHistory' },
      {
        $match: {
          'locationHistory.status': 'travelling',
          'locationHistory.movedAt': { $gte: since },
          'locationHistory.note': { $regex: TRANSFER_NOTE_PATTERN.source, $options: 'i' },
        },
      },
      {
        $project: {
          productName: '$product_name',
          brand: '$brand',
          capacity: '$capacity',
          units: productUnitsExpr(),
          fromWarehouse: '$originWarehouse',
          toWarehouse: '$locationHistory.warehouse',
          movedAt: '$locationHistory.movedAt',
          note: '$locationHistory.note',
          shipmentStatus: '$shipmentStatus',
        },
      },
      { $sort: { movedAt: -1 } },
      { $limit: limit * 3 },
    ]),
  ]);

  const whIdSet = new Set();
  const rawRows = [];

  activeGroups.forEach((row) => {
    const fromId = row._id?.from;
    const toId = row._id?.to;
    if (fromId) whIdSet.add(String(fromId));
    if (toId) whIdSet.add(String(toId));
    rawRows.push({
      productName: row._id?.productName || 'Product',
      brand: row._id?.brand || '',
      capacity: row._id?.capacity || '',
      units: row.units || 1,
      fromId,
      toId,
      movedAt: row.movedAt,
      isActive: true,
    });
  });

  historyEvents.forEach((row) => {
    if (row.fromWarehouse) whIdSet.add(String(row.fromWarehouse));
    if (row.toWarehouse) whIdSet.add(String(row.toWarehouse));
    rawRows.push({
      productName: row.productName || 'Product',
      brand: row.brand || '',
      capacity: row.capacity || '',
      units: row.units || 1,
      fromId: row.fromWarehouse,
      toId: row.toWarehouse,
      movedAt: row.movedAt,
      isActive: row.shipmentStatus === 'travelling',
      note: row.note,
    });
  });

  if (rawRows.length === 0) return [];

  const warehouses = await Warehouse.find({ _id: { $in: [...whIdSet] } }).select('name type city');
  const whMap = new Map(warehouses.map((w) => [String(w._id), w]));

  const seen = new Set();
  const merged = [];

  rawRows
    .sort((a, b) => new Date(b.movedAt || 0) - new Date(a.movedAt || 0))
    .forEach((row) => {
      const movedKey = row.movedAt ? new Date(row.movedAt).getTime() : 0;
      const dedupeKey = [
        String(row.fromId || ''),
        String(row.toId || ''),
        row.productName,
        row.brand,
        row.capacity,
        movedKey,
      ].join('|');
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      const fromWh = row.fromId ? whMap.get(String(row.fromId)) : null;
      const toWh = row.toId ? whMap.get(String(row.toId)) : null;
      const parsed = parseTransferNote(row.note);

      merged.push({
        productName: row.productName,
        brand: row.brand,
        capacity: row.capacity,
        units: row.units,
        fromName: fromWh?.name || parsed.from || '—',
        fromType: fromWh?.type || null,
        fromCity: fromWh?.city || null,
        toName: toWh?.name || parsed.to || 'Destination',
        toType: toWh?.type || null,
        toCity: toWh?.city || null,
        movedAt: row.movedAt,
        isActive: Boolean(row.isActive),
      });
    });

  return merged.slice(0, limit);
}

/** Distinct upload batches at a warehouse (bulkBatchCode groups; non-batch lines share one "_single" bucket). */
async function countProductBatchesAtWarehouse(warehouseId, extraFilter = {}) {
  const whObjectId =
    warehouseId instanceof mongoose.Types.ObjectId
      ? warehouseId
      : new mongoose.Types.ObjectId(String(warehouseId));

  const result = await Product.aggregate([
    { $match: { currentWarehouse: whObjectId, ...extraFilter } },
    {
      $group: {
        _id: {
          $cond: [
            {
              $gt: [
                {
                  $strLenCP: {
                    $trim: {
                      input: {
                        $convert: {
                          input: { $ifNull: ['$bulkBatchCode', ''] },
                          to: 'string',
                          onError: '',
                          onNull: '',
                        },
                      },
                    },
                  },
                },
                0,
              ],
            },
            '$bulkBatchCode',
            '_single',
          ],
        },
      },
    },
    { $count: 'batches' },
  ]);

  return Number(result[0]?.batches) || 0;
}

function isUsaWarehouseCity(city) {
  return String(city || '').trim().toUpperCase() === 'USA';
}

async function resolveRequestIsUsaAdmin(req) {
  const userId = req.user?.userId || req.user?.id || req.userId || null;
  if (!userId) return false;
  const user = await User.findById(userId).select('businessAddress role').lean();
  if (!user || String(user.role || '').toLowerCase() !== 'admin') return false;
  const { isUsaBusinessAddress } = require('../utils/adminAccountRegion');
  return isUsaBusinessAddress(user.businessAddress);
}

async function findActiveUsaMainWarehouse() {
  return Warehouse.findOne({
    type: WAREHOUSE_TYPES.MAIN,
    city: 'USA',
    isActive: { $ne: false },
  });
}

function pendingRequestFilterForWarehouse(warehouse) {
  if (warehouse.type !== WAREHOUSE_TYPES.MAIN) {
    return { requestingShop: warehouse._id, status: REQUEST_STATUS.PENDING };
  }
  if (isUsaWarehouseCity(warehouse.city)) {
    return {
      servingMain: warehouse._id,
      requestingMain: { $ne: null },
      status: REQUEST_STATUS.PENDING,
    };
  }
  return {
    servingMain: warehouse._id,
    requestingShop: { $ne: null },
    status: REQUEST_STATUS.PENDING,
  };
}

function listRequestFilterForWarehouse(warehouse) {
  if (warehouse.type !== WAREHOUSE_TYPES.MAIN) {
    return { requestingShop: warehouse._id };
  }
  if (isUsaWarehouseCity(warehouse.city)) {
    return { servingMain: warehouse._id, requestingMain: { $ne: null } };
  }
  return {
    $or: [
      { servingMain: warehouse._id, requestingShop: { $ne: null } },
      { requestingMain: warehouse._id },
    ],
  };
}

/** GET /api/admin/warehouses/overview — dashboard aggregates */
async function getWarehousesDashboardOverview(req, res) {
  try {
    const [mainWarehouses, subWarehouses] = await Promise.all([
      Warehouse.find({ type: WAREHOUSE_TYPES.MAIN, isActive: { $ne: false } }).sort({ city: 1, name: 1 }),
      Warehouse.find({ type: WAREHOUSE_TYPES.SUB, isActive: { $ne: false } })
        .populate({ path: 'parentWarehouse', select: 'name city' })
        .sort({ name: 1 }),
    ]);

    const whIds = [...mainWarehouses, ...subWarehouses].map((w) => w._id);

    const [
      travellingByWh,
      arrivedByWh,
      noPhotoTravelling,
      pendingRequests,
      recentRequests,
      travellingBatches,
      totalProducts,
      recentProductTransfers,
    ] = await Promise.all([
      Product.aggregate([
        { $match: { shipmentStatus: 'travelling', currentWarehouse: { $in: whIds } } },
        { $group: { _id: '$currentWarehouse', count: { $sum: 1 } } },
      ]),
      Product.aggregate([
        { $match: { shipmentStatus: 'arrived', currentWarehouse: { $in: whIds } } },
        { $group: { _id: '$currentWarehouse', count: { $sum: 1 } } },
      ]),
      Product.countDocuments({
        shipmentStatus: 'travelling',
        currentWarehouse: { $in: whIds },
        $or: [{ images: { $size: 0 } }, { images: { $exists: false } }],
      }),
      WarehouseStockRequest.countDocuments({ status: REQUEST_STATUS.PENDING }),
      WarehouseStockRequest.find({ status: REQUEST_STATUS.PENDING })
        .populate({ path: 'requestingShop', select: 'name city' })
        .populate({ path: 'servingMain', select: 'name city' })
        .sort({ createdAt: -1 })
        .limit(8),
      BulkShipment.find({ status: BULK_SHIPMENT_STATUS.TRAVELLING })
        .populate({ path: 'mainWarehouse', select: 'name city' })
        .populate({ path: 'destinationSubWarehouse', select: 'name city' })
        .sort({ createdAt: -1 })
        .limit(10),
      Product.countDocuments({ currentWarehouse: { $in: whIds } }),
      loadRecentProductTransfers(whIds, { limit: 15 }),
    ]);

    const travellingMap = new Map(travellingByWh.map((r) => [String(r._id), r.count]));
    const arrivedMap = new Map(arrivedByWh.map((r) => [String(r._id), r.count]));

    const enrich = (w) => {
      const id = String(w._id);
      const isMain = w.type === WAREHOUSE_TYPES.MAIN;
      const shopCount = isMain
        ? subWarehouses.filter((s) => String(s.parentWarehouse?._id || s.parentWarehouse) === id).length
        : 0;
      return {
        ...warehouseSummary(w),
        isMain,
        isShop: !isMain,
        travellingCount: travellingMap.get(id) || 0,
        arrivedCount: arrivedMap.get(id) || 0,
        shopCount,
        parentName: w.parentWarehouse?.name || null,
      };
    };

    const locations = [
      ...mainWarehouses.map(enrich),
      ...subWarehouses.map(enrich),
    ];

    const travellingTotal = [...travellingMap.values()].reduce((a, b) => a + b, 0);
    const arrivedTotal = [...arrivedMap.values()].reduce((a, b) => a + b, 0);
    const stockHealthPct =
      totalProducts > 0 ? Math.round((arrivedTotal / totalProducts) * 100) : 0;

    const chartByMain = mainWarehouses.map((m) => {
      const id = String(m._id);
      const subs = subWarehouses.filter(
        (s) => String(s.parentWarehouse?._id || s.parentWarehouse) === id,
      );
      const subIds = subs.map((s) => s._id);
      const allIds = [m._id, ...subIds];
      let travelling = 0;
      let arrived = 0;
      allIds.forEach((oid) => {
        travelling += travellingMap.get(String(oid)) || 0;
        arrived += arrivedMap.get(String(oid)) || 0;
      });
      return {
        mainId: id,
        name: m.name,
        city: m.city,
        travelling,
        arrived,
        shopCount: subs.length,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        totals: {
          mainWarehouses: mainWarehouses.length,
          shops: subWarehouses.length,
          travelling: travellingTotal,
          arrived: arrivedTotal,
          pendingRequests,
          travellingBatches: travellingBatches.length,
          awaitingPhotos: noPhotoTravelling,
          stockHealthPct,
        },
        locations,
        chartByMain,
        recentRequests: recentRequests.map((r) => ({
          _id: r._id,
          productName: r.productName,
          brand: r.brand,
          capacity: r.capacity,
          quantity: r.quantity,
          status: r.status,
          shopName: r.requestingShop?.name,
          shopCity: r.requestingShop?.city,
          mainName: r.servingMain?.name,
          createdAt: r.createdAt,
        })),
        travellingBatches: travellingBatches.map((b) => ({
          batchCode: b.batchCode,
          productCount: b.productCount,
          mainName: b.mainWarehouse?.name,
          mainCity: b.mainWarehouse?.city,
          destName: b.destinationSubWarehouse?.name,
        })),
        recentProductTransfers,
      },
    });
  } catch (err) {
    console.error('getWarehousesDashboardOverview:', err);
    return res.status(500).json({ success: false, message: 'Failed to load warehouse overview.' });
  }
}

/** GET /api/admin/warehouses/:id/hub */
async function getWarehouseHub(req, res) {
  try {
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse || warehouse.isActive === false) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }

    const isMain = warehouse.type === WAREHOUSE_TYPES.MAIN;
    let parentMain = null;
    let shops = [];

    if (isMain) {
      shops = await Warehouse.find({
        type: WAREHOUSE_TYPES.SUB,
        isActive: true,
      }).sort({ city: 1, name: 1 });
    } else {
      const resolved = await resolveMainFromSubWarehouse(warehouse._id);
      parentMain = resolved.main;
      shops = await Warehouse.find({
        type: WAREHOUSE_TYPES.SUB,
        isActive: true,
        _id: { $ne: warehouse._id },
      }).sort({ city: 1, name: 1 });
    }

    const whId = warehouse._id;
    const [
      travellingCount,
      arrivedCount,
      readyToTransferCount,
      readyToTransferUnitCount,
      availableUnitCount,
      onHandProductCount,
      pendingRequestCount,
      travellingBatches,
      assignedSalespeople,
      inventoryBatchCount,
      readyToTransferBatchCount,
      inventoryProductCount,
      inventoryUnitCount,
    ] = await Promise.all([
      Product.countDocuments({ currentWarehouse: whId, shipmentStatus: 'travelling' }),
      Product.countDocuments({ currentWarehouse: whId, shipmentStatus: 'arrived' }),
      Product.countDocuments({
        currentWarehouse: whId,
        shipmentStatus: 'arrived',
        stock: { $gt: 0 },
      }),
      sumReadyToTransferUnitsAtWarehouse(whId),
      sumAvailableUnitsAtWarehouse(whId),
      countOnHandProductNamesAtWarehouse(whId),
      isMain
        ? WarehouseStockRequest.countDocuments(pendingRequestFilterForWarehouse(warehouse))
        : WarehouseStockRequest.countDocuments({
            requestingShop: whId,
            status: REQUEST_STATUS.PENDING,
          }),
      isMain
        ? BulkShipment.countDocuments({
            mainWarehouse: whId,
            status: BULK_SHIPMENT_STATUS.TRAVELLING,
          })
        : Promise.resolve(0),
      isMain
        ? Promise.resolve([])
        : User.find({
            role: ROLES.SALESMAN,
            assignedShops: whId,
          })
            .select('name accountStatus tel')
            .sort({ name: 1 }),
      countProductBatchesAtWarehouse(whId),
      countProductBatchesAtWarehouse(whId, {
        shipmentStatus: 'arrived',
        stock: { $gt: 0 },
      }),
      Product.countDocuments({ currentWarehouse: whId }),
      sumAvailableUnitsAtWarehouse(whId),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        warehouse: warehouseSummary(warehouse),
        isMain,
        isShop: !isMain,
        parentMain: warehouseSummary(parentMain),
        shops: shops.map(warehouseSummary),
        assignedSalespeople: assignedSalespeople.map((u) => ({
          _id: u._id,
          name: u.name,
          accountStatus: u.accountStatus,
        })),
        stats: {
          travellingCount,
          arrivedCount,
          readyToTransferCount,
          readyToTransferUnitCount,
          availableUnitCount,
          onHandProductCount,
          pendingRequestCount,
          travellingBatches,
          inventoryBatchCount,
          readyToTransferBatchCount,
          inventoryProductCount,
          inventoryUnitCount,
          shopCount: shops.length,
          assignedSalespeopleCount: assignedSalespeople.length,
        },
      },
    });
  } catch (err) {
    console.error('getWarehouseHub:', err);
    return res.status(500).json({ success: false, message: 'Failed to load warehouse hub.' });
  }
}

/** GET /api/admin/warehouses/:id/incoming — travelling stock at this warehouse */
async function getWarehouseIncoming(req, res) {
  try {
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse || !warehouse.isActive) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }

    const products = await Product.find({
      currentWarehouse: warehouse._id,
      shipmentStatus: 'travelling',
    })
      .select(
        'product_name brand capacity color stock price bulkBatchCode bulkShipment country destinationSubWarehouse destinationMainWarehouse originWarehouse currentWarehouse images shipmentStatus locationHistory createdAt',
      )
      .populate([
        { path: 'destinationSubWarehouse', select: 'name city type' },
        { path: 'destinationMainWarehouse', select: 'name city type' },
        { path: 'originWarehouse', select: 'name city type', strictPopulate: false },
        { path: 'currentWarehouse', select: 'name city type' },
        { path: 'bulkShipment', select: 'mainWarehouse batchCode', populate: { path: 'mainWarehouse', select: 'name city type' } },
      ])
      .sort({ createdAt: -1 })
      .limit(500);

    await attachResolvedOriginWarehouses(products);

    let batches = [];
    if (warehouse.type === WAREHOUSE_TYPES.MAIN) {
      batches = await BulkShipment.find({
        mainWarehouse: warehouse._id,
        status: BULK_SHIPMENT_STATUS.TRAVELLING,
      })
        .populate({ path: 'destinationSubWarehouse', select: 'name city' })
        .sort({ createdAt: -1 })
        .limit(100);
    }

    return res.status(200).json({
      success: true,
      data: {
        products,
        batches,
        count: products.length,
      },
    });
  } catch (err) {
    console.error('getWarehouseIncoming:', err);
    return res.status(500).json({ success: false, message: 'Failed to load incoming stock.' });
  }
}

/** GET /api/admin/warehouses/:id/ready-to-transfer — arrived stock ready to send to a shop */
async function getWarehouseReadyToTransfer(req, res) {
  try {
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse || !warehouse.isActive) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }
    const isMain = warehouse.type === WAREHOUSE_TYPES.MAIN;
    const isShop = warehouse.type === WAREHOUSE_TYPES.SUB;
    if (!isMain && !isShop) {
      return res.status(400).json({
        success: false,
        message: 'Ready-to-transfer stock is listed at a main warehouse or shop.',
      });
    }

    const products = await Product.find({
      currentWarehouse: warehouse._id,
      shipmentStatus: 'arrived',
      stock: { $gt: 0 },
    })
      .select(
        'product_name brand capacity color stock price bulkBatchCode bulkShipment phoneLocation shipmentStatus destinationSubWarehouse createdAt IME imeCodes images primaryImage',
      )
      .populate({ path: 'destinationSubWarehouse', select: 'name city' })
      .sort({ bulkBatchCode: 1, createdAt: -1 })
      .limit(500);

    const batchMap = new Map();
    products.forEach((p) => {
      const code = p.bulkBatchCode || '_single';
      if (!batchMap.has(code)) {
        batchMap.set(code, {
          batchCode: p.bulkBatchCode || null,
          products: [],
          count: 0,
          totalStock: 0,
        });
      }
      const row = batchMap.get(code);
      row.products.push(p);
      row.count += 1;
      row.totalStock = (row.totalStock || 0) + Math.max(0, Number(p.stock) || 0);
    });

    const batches = isMain
      ? [...batchMap.values()].sort((a, b) =>
          String(b.batchCode || '').localeCompare(String(a.batchCode || '')),
        )
      : [];

    return res.status(200).json({
      success: true,
      data: {
        products,
        batches,
        count: products.length,
      },
    });
  } catch (err) {
    console.error('getWarehouseReadyToTransfer:', err);
    return res.status(500).json({ success: false, message: 'Failed to load stock ready to transfer.' });
  }
}

/** GET /api/admin/warehouses/:id/stock-requests */
async function listStockRequests(req, res) {
  try {
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse || !warehouse.isActive) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }

    const status = req.query.status;
    const filter = listRequestFilterForWarehouse(warehouse);

    if (status && Object.values(REQUEST_STATUS).includes(String(status))) {
      filter.status = status;
    }

    const requests = await WarehouseStockRequest.find(filter)
      .populate({ path: 'requestingShop', select: 'name city type' })
      .populate({ path: 'requestingMain', select: 'name city type' })
      .populate({ path: 'servingMain', select: 'name city type' })
      .sort({ createdAt: -1 })
      .limit(200);

    return res.status(200).json({
      success: true,
      count: requests.length,
      data: requests,
    });
  } catch (err) {
    console.error('listStockRequests:', err);
    return res.status(500).json({ success: false, message: 'Failed to load stock requests.' });
  }
}

/** POST /api/admin/warehouses/:id/stock-requests */
async function createStockRequest(req, res) {
  try {
    const target = await Warehouse.findById(req.params.id);
    if (!target || !target.isActive) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }

    const productName = String(req.body?.productName || '').trim();
    if (!productName) {
      return res.status(400).json({ success: false, message: 'productName is required.' });
    }

    const userId = req.user?.userId || req.user?.id || req.userId || null;
    const payload = {
      productName,
      brand: String(req.body?.brand || '').trim(),
      capacity: String(req.body?.capacity || '').trim(),
      color: String(req.body?.color || '').trim(),
      quantity: Math.max(1, parseInt(req.body?.quantity, 10) || 1),
      notes: String(req.body?.notes || '').trim(),
      createdBy: userId,
    };

    if (target.type === WAREHOUSE_TYPES.SUB) {
      const { main } = await resolveMainFromSubWarehouse(target._id);
      if (!main) {
        return res.status(400).json({
          success: false,
          message: 'This shop has no linked regional main warehouse.',
        });
      }
      if (isUsaWarehouseCity(main.city)) {
        return res.status(400).json({
          success: false,
          message: 'Shops cannot request stock from the USA warehouse. Only regional main warehouses can request from USA.',
        });
      }

      const doc = await WarehouseStockRequest.create({
        ...payload,
        requestingShop: target._id,
        servingMain: main._id,
      });

      await doc.populate([
        { path: 'requestingShop', select: 'name city' },
        { path: 'servingMain', select: 'name city' },
      ]);

      return res.status(201).json({
        success: true,
        message: `Request sent to ${main.name}.`,
        data: doc,
      });
    }

    if (target.type !== WAREHOUSE_TYPES.MAIN) {
      return res.status(400).json({ success: false, message: 'Invalid warehouse for stock requests.' });
    }

    if (isUsaWarehouseCity(target.city)) {
      const requestingMainId = req.body?.requestingMain;
      if (!requestingMainId) {
        return res.status(400).json({
          success: false,
          message: 'requestingMain is required when requesting stock from the USA warehouse.',
        });
      }

      const requestingMain = await Warehouse.findOne({
        _id: requestingMainId,
        type: WAREHOUSE_TYPES.MAIN,
        isActive: true,
      });
      if (!requestingMain || isUsaWarehouseCity(requestingMain.city)) {
        return res.status(400).json({
          success: false,
          message: 'Choose an active regional main warehouse (not USA) as the requester.',
        });
      }

      const doc = await WarehouseStockRequest.create({
        ...payload,
        requestingMain: requestingMain._id,
        servingMain: target._id,
      });

      await doc.populate([
        { path: 'requestingMain', select: 'name city' },
        { path: 'servingMain', select: 'name city' },
      ]);

      return res.status(201).json({
        success: true,
        message: `Request sent to ${target.name} from ${requestingMain.name}.`,
        data: doc,
      });
    }

    const usaMain = await findActiveUsaMainWarehouse();
    if (!usaMain) {
      return res.status(404).json({
        success: false,
        message: 'No active USA main warehouse found.',
      });
    }

    const doc = await WarehouseStockRequest.create({
      ...payload,
      requestingMain: target._id,
      servingMain: usaMain._id,
    });

    await doc.populate([
      { path: 'requestingMain', select: 'name city' },
      { path: 'servingMain', select: 'name city' },
    ]);

    return res.status(201).json({
      success: true,
      message: `Request sent to ${usaMain.name}.`,
      data: doc,
    });
  } catch (err) {
    console.error('createStockRequest:', err);
    return res.status(500).json({ success: false, message: 'Failed to create stock request.' });
  }
}

/** PATCH /api/admin/stock-requests/:requestId */
async function updateStockRequest(req, res) {
  try {
    const doc = await WarehouseStockRequest.findById(req.params.requestId);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }

    const nextStatus = String(req.body?.status || '').trim().toLowerCase();
    if (!Object.values(REQUEST_STATUS).includes(nextStatus)) {
      return res.status(400).json({
        success: false,
        message: `status must be one of: ${Object.values(REQUEST_STATUS).join(', ')}`,
      });
    }

    const userId = req.user?.userId || req.user?.id || req.userId || null;
    doc.status = nextStatus;
    if (req.body?.adminNote != null) doc.adminNote = String(req.body.adminNote).trim();
    if (nextStatus !== REQUEST_STATUS.PENDING) {
      doc.resolvedBy = userId;
      doc.resolvedAt = new Date();
    }

    await doc.save();
    await doc.populate([
      { path: 'requestingShop', select: 'name city' },
      { path: 'requestingMain', select: 'name city' },
      { path: 'servingMain', select: 'name city' },
    ]);

    return res.status(200).json({
      success: true,
      message: `Request marked as ${nextStatus}.`,
      data: doc,
    });
  } catch (err) {
    console.error('updateStockRequest:', err);
    return res.status(500).json({ success: false, message: 'Failed to update stock request.' });
  }
}

/** PATCH /api/admin/bulk-shipments/:idOrCode/assign — set destination shop for a batch */
async function assignBulkShipmentDestination(req, res) {
  try {
    const shipment = await findBulkShipmentByIdOrCode(req.params.idOrCode);
    if (!shipment) {
      return res.status(404).json({ success: false, message: 'Bulk shipment not found.' });
    }

    const destId = req.body?.destinationSubWarehouse;
    if (!destId) {
      return res.status(400).json({ success: false, message: 'destinationSubWarehouse is required.' });
    }

    const sub = await Warehouse.findOne({
      _id: destId,
      type: WAREHOUSE_TYPES.SUB,
      isActive: true,
      parentWarehouse: shipment.mainWarehouse,
    });
    if (!sub) {
      return res.status(400).json({
        success: false,
        message: 'Choose an active Shop under this regional main Warehouse.',
      });
    }

    shipment.destinationSubWarehouse = sub._id;
    await shipment.save();

    await Product.updateMany(
      { bulkShipment: shipment._id },
      { $set: { destinationSubWarehouse: sub._id } },
    );

    await shipment.populate({ path: 'destinationSubWarehouse', select: 'name city' });

    return res.status(200).json({
      success: true,
      message: `Batch ${shipment.batchCode} assigned to shop ${sub.name}.`,
      data: shipment,
    });
  } catch (err) {
    console.error('assignBulkShipmentDestination:', err);
    return res.status(500).json({ success: false, message: 'Failed to assign destination shop.' });
  }
}

/** POST /api/admin/warehouses/:id/receive-stock — travelling → arrived (after warehouse-to-warehouse or warehouse-to-shop send) */
async function receiveStockAtWarehouse(req, res) {
  try {
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse || !warehouse.isActive) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }

    const userId = req.user?.userId || req.user?.id || req.userId || null;
    const batchCode = String(req.body?.batchCode || '').trim();
    const productIds = Array.isArray(req.body?.productIds)
      ? req.body.productIds.filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
      : [];
    const transferItems = Array.isArray(req.body?.transferItems)
      ? req.body.transferItems
          .map((item) => ({
            productId: String(item?.productId || '').trim(),
            ime: String(item?.ime || '').trim(),
          }))
          .filter((item) => mongoose.Types.ObjectId.isValid(item.productId))
      : [];

    let products = [];

    if (batchCode) {
      const code = batchCode.toUpperCase();
      products = await Product.find({
        currentWarehouse: warehouse._id,
        shipmentStatus: 'travelling',
        bulkBatchCode: code,
      });
      if (!products.length) {
        const shipment = await BulkShipment.findOne({ batchCode: code });
        if (shipment && String(shipment.mainWarehouse) === String(warehouse._id)) {
          products = await Product.find({
            bulkShipment: shipment._id,
            currentWarehouse: warehouse._id,
            shipmentStatus: 'travelling',
          });
        }
      }
    } else if (transferItems.length) {
      const imeGroups = new Map();
      const unitCounts = new Map();

      for (const item of transferItems) {
        const pid = item.productId;
        if (item.ime) {
          if (!imeGroups.has(pid)) imeGroups.set(pid, []);
          imeGroups.get(pid).push(item.ime);
        } else {
          unitCounts.set(pid, (unitCounts.get(pid) || 0) + 1);
        }
      }

      const allProductIds = [
        ...new Set([...imeGroups.keys(), ...unitCounts.keys()].map(String)),
      ];
      const products = await Product.find({
        _id: { $in: allProductIds },
        currentWarehouse: source._id,
        shipmentStatus: 'arrived',
        stock: { $gt: 0 },
      });
      const productById = new Map(products.map((p) => [String(p._id), p]));

      if (!products.length) {
        return res.status(400).json({
          success: false,
          message: 'No products at this location found to transfer.',
        });
      }

      for (const [pid, imes] of imeGroups) {
        let product = productById.get(String(pid));
        if (!product) {
          return res.status(404).json({
            success: false,
            message: 'One or more selected product lines were not found at this location.',
          });
        }
        const { transferredImes } = await transferProductImesToShop(
          product,
          sub,
          userId,
          imes,
          note,
        );
        appendManifest(product, transferredImes);
        unitsTransferred += imes.length;
        if (unitCounts.has(pid)) {
          const refreshed = await Product.findById(product._id);
          if (refreshed) productById.set(String(pid), refreshed);
        }
      }

      for (const [pid, count] of unitCounts) {
        const product = productById.get(String(pid));
        if (!product) {
          return res.status(404).json({
            success: false,
            message: 'One or more selected product lines were not found at this location.',
          });
        }
        const { transferredImes } = await transferProductQuantityToShop(
          product,
          sub,
          userId,
          count,
          note,
        );
        appendManifest(product, transferredImes);
        unitsTransferred += count;
      }
    } else if (productIds.length) {
      products = await Product.find({
        _id: { $in: productIds },
        currentWarehouse: warehouse._id,
        shipmentStatus: 'travelling',
      });
    } else {
      return res.status(400).json({
        success: false,
        message: 'Provide batchCode or productIds to confirm receipt.',
      });
    }

    if (!products.length) {
      return res.status(400).json({
        success: false,
        message: 'No travelling stock found to mark as received.',
      });
    }

    const note =
      warehouse.type === WAREHOUSE_TYPES.SUB
        ? `Received at shop ${warehouse.name}`
        : `Received at ${warehouse.name}`;
    for (const product of products) {
      if (
        warehouse.type === WAREHOUSE_TYPES.SUB &&
        String(product.currentWarehouse) === String(warehouse._id)
      ) {
        await applyProductArrival(product, warehouse, userId, note);
      } else {
        await applyProductReceivedAtWarehouse(product, warehouse, userId, note);
      }
    }

    return res.status(200).json({
      success: true,
      message: `${products.length} product(s) marked as received at ${warehouse.name}.`,
      data: { count: products.length, warehouse: warehouseSummary(warehouse) },
    });
  } catch (err) {
    console.error('receiveStockAtWarehouse:', err);
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    return res.status(status).json({
      success: false,
      message: err.message || 'Failed to update travelling status.',
    });
  }
}

async function unitsRemainingAtMainForBatch(shipmentId, mainId) {
  const rows = await Product.find({
    bulkShipment: shipmentId,
    currentWarehouse: mainId,
    stock: { $gt: 0 },
  }).select('stock');
  return rows.reduce((sum, p) => sum + Math.max(0, Number(p.stock) || 0), 0);
}

/** POST /api/admin/warehouses/:id/transfer-to-shop — main or shop → shop */
async function transferToShop(req, res) {
  try {
    const source = await Warehouse.findById(req.params.id);
    if (!source || !source.isActive) {
      return res.status(404).json({ success: false, message: 'Source location not found.' });
    }

    const isMainSource = source.type === WAREHOUSE_TYPES.MAIN;
    const isShopSource = source.type === WAREHOUSE_TYPES.SUB;
    if (!isMainSource && !isShopSource) {
      return res.status(400).json({
        success: false,
        message: 'Transfers to shops are done from a main warehouse or a shop.',
      });
    }

    const destId = req.body?.destinationSubWarehouse;
    if (!destId) {
      return res.status(400).json({ success: false, message: 'destinationSubWarehouse is required.' });
    }

    const sub = await Warehouse.findOne({
      _id: destId,
      type: WAREHOUSE_TYPES.SUB,
      isActive: true,
    });
    if (!sub) {
      return res.status(400).json({
        success: false,
        message: 'Invalid destination shop.',
      });
    }

    if (isShopSource && String(sub._id) === String(source._id)) {
      return res.status(400).json({
        success: false,
        message: 'Destination shop must be different from the source shop.',
      });
    }

    const userId = req.user?.userId || req.user?.id || req.userId || null;
    const batchCode = String(req.body?.batchCode || '').trim();
    const singleProductId = req.body?.productId
      ? String(req.body.productId).trim()
      : null;
    const productIds = Array.isArray(req.body?.productIds)
      ? req.body.productIds.filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
      : [];
    const transferItems = Array.isArray(req.body?.transferItems)
      ? req.body.transferItems
          .map((item) => ({
            productId: String(item?.productId || '').trim(),
            ime: String(item?.ime || '').trim(),
          }))
          .filter((item) => mongoose.Types.ObjectId.isValid(item.productId))
      : [];
    const quantityRaw = req.body?.quantity;
    const hasQuantity =
      quantityRaw !== undefined && quantityRaw !== null && String(quantityRaw).trim() !== '';
    const quantity = hasQuantity ? Math.max(1, parseInt(quantityRaw, 10) || 0) : null;

    const note = isShopSource
      ? `Transferred from ${source.name} to ${sub.name}`
      : `Transferred to shop ${sub.name}`;
    let unitsTransferred = 0;
    let shipment = null;
    const imeManifest = [];
    const sourceLocationLabel = isShopSource ? 'shop' : 'main warehouse';

    const appendManifest = (product, transferredImes) => {
      imeManifest.push(...buildImeManifestLines(product, transferredImes));
    };

    const transferWholeProduct = async (product) => {
      const stock = Math.max(0, Number(product.stock) || 0);
      const transferredImes = normalizedImeList(product);
      const originId = product.currentWarehouse || source._id;
      product.destinationSubWarehouse = sub._id;
      await applyProductSentToShop(product, sub, userId, note, originId);
      appendManifest(product, transferredImes);
      unitsTransferred += stock > 0 ? stock : 1;
    };

    if (singleProductId && mongoose.Types.ObjectId.isValid(singleProductId)) {
      const product = await Product.findOne({
        _id: singleProductId,
        currentWarehouse: source._id,
        shipmentStatus: 'arrived',
        stock: { $gt: 0 },
      });
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product line not found at this ${sourceLocationLabel}.`,
        });
      }
      const stock = Math.max(0, Number(product.stock) || 0);
      const qty = quantity || stock;
      const { transferredImes } = await transferProductQuantityToShop(product, sub, userId, qty, note);
      appendManifest(product, transferredImes);
      unitsTransferred += qty;
      if (isMainSource && product.bulkShipment) {
        shipment = await BulkShipment.findById(product.bulkShipment);
      }
    } else if (batchCode) {
      if (!isMainSource) {
        return res.status(400).json({
          success: false,
          message: 'Batch transfers are only available from a main warehouse.',
        });
      }
      shipment = await BulkShipment.findOne({ batchCode: batchCode.toUpperCase() });
      if (!shipment || String(shipment.mainWarehouse) !== String(source._id)) {
        return res.status(404).json({ success: false, message: 'Bulk batch not found at this warehouse.' });
      }

      const batchProducts = await Product.find({
        bulkShipment: shipment._id,
        currentWarehouse: source._id,
        shipmentStatus: 'arrived',
        stock: { $gt: 0 },
      }).sort({ createdAt: 1 });

      if (!batchProducts.length) {
        return res.status(400).json({
          success: false,
          message: 'No received stock left in this batch at the main warehouse.',
        });
      }

      if (quantity) {
        let remaining = quantity;
        for (const product of batchProducts) {
          if (remaining <= 0) break;
          const available = Math.max(0, Number(product.stock) || 0);
          const take = Math.min(remaining, available);
          const { transferredImes } = await transferProductQuantityToShop(product, sub, userId, take, note);
          appendManifest(product, transferredImes);
          unitsTransferred += take;
          remaining -= take;
        }
        if (remaining > 0) {
          return res.status(400).json({
            success: false,
            message: `Batch only has ${quantity - remaining} unit(s) available; requested ${quantity}.`,
          });
        }
      } else {
        for (const product of batchProducts) {
          await transferWholeProduct(product);
        }
      }
    } else if (transferItems.length) {
      const imeGroups = new Map();
      const unitCounts = new Map();

      for (const item of transferItems) {
        const pid = item.productId;
        if (item.ime) {
          if (!imeGroups.has(pid)) imeGroups.set(pid, []);
          imeGroups.get(pid).push(item.ime);
        } else {
          unitCounts.set(pid, (unitCounts.get(pid) || 0) + 1);
        }
      }

      const allProductIds = [
        ...new Set([...imeGroups.keys(), ...unitCounts.keys()].map(String)),
      ];
      const products = await Product.find({
        _id: { $in: allProductIds },
        currentWarehouse: source._id,
        shipmentStatus: 'arrived',
        stock: { $gt: 0 },
      });
      const productById = new Map(products.map((p) => [String(p._id), p]));

      if (!products.length) {
        return res.status(400).json({
          success: false,
          message: `No products at this ${sourceLocationLabel} found to transfer.`,
        });
      }

      for (const [pid, imes] of imeGroups) {
        let product = productById.get(String(pid));
        if (!product) {
          return res.status(404).json({
            success: false,
            message: `One or more selected product lines were not found at this ${sourceLocationLabel}.`,
          });
        }
        const { transferredImes } = await transferProductImesToShop(
          product,
          sub,
          userId,
          imes,
          note,
        );
        appendManifest(product, transferredImes);
        unitsTransferred += imes.length;
        if (unitCounts.has(pid)) {
          const refreshed = await Product.findById(product._id);
          if (refreshed) productById.set(String(pid), refreshed);
        }
        if (isMainSource && product.bulkShipment && !shipment) {
          shipment = await BulkShipment.findById(product.bulkShipment);
        }
      }

      for (const [pid, count] of unitCounts) {
        const product = productById.get(String(pid));
        if (!product) {
          return res.status(404).json({
            success: false,
            message: `One or more selected product lines were not found at this ${sourceLocationLabel}.`,
          });
        }
        const { transferredImes } = await transferProductQuantityToShop(
          product,
          sub,
          userId,
          count,
          note,
        );
        appendManifest(product, transferredImes);
        unitsTransferred += count;
        if (isMainSource && product.bulkShipment && !shipment) {
          shipment = await BulkShipment.findById(product.bulkShipment);
        }
      }
    } else if (productIds.length) {
      const products = await Product.find({
        _id: { $in: productIds },
        currentWarehouse: source._id,
        shipmentStatus: 'arrived',
        stock: { $gt: 0 },
      });
      if (!products.length) {
        return res.status(400).json({
          success: false,
          message: `No products at this ${sourceLocationLabel} found to transfer.`,
        });
      }
      if (quantity && products.length === 1) {
        const { transferredImes } = await transferProductQuantityToShop(products[0], sub, userId, quantity, note);
        appendManifest(products[0], transferredImes);
        unitsTransferred += quantity;
      } else {
        for (const product of products) {
          await transferWholeProduct(product);
        }
      }
    } else {
      return res.status(400).json({
        success: false,
        message: 'Provide batchCode, productId, productIds, or transferItems to transfer.',
      });
    }

    if (isMainSource && shipment) {
      const remainingUnits = await unitsRemainingAtMainForBatch(shipment._id, source._id);
      shipment.destinationSubWarehouse = sub._id;
      if (remainingUnits === 0) {
        shipment.status = BULK_SHIPMENT_STATUS.ARRIVED;
        shipment.arrivedAt = new Date();
        shipment.arrivedBy = userId;
      }
      await shipment.save();
    }

    const locationLabel = normalizeProductPhoneLocation(sub.city);

    return res.status(200).json({
      success: true,
      message: isShopSource
        ? `${unitsTransferred} unit(s) sent from ${source.name} to ${sub.name}. The destination shop must mark them received when stock arrives.`
        : `${unitsTransferred} unit(s) sent to ${sub.name}. The shop must mark them received when stock arrives.`,
      data: {
        count: unitsTransferred,
        unitsTransferred,
        shop: warehouseSummary(sub),
        city: sub.city,
        phoneLocation: locationLabel,
        imeManifest,
        imeCount: imeManifest.length,
      },
    });
  } catch (err) {
    console.error('transferToShop:', err);
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    return res.status(status).json({
      success: false,
      message: err.message || 'Failed to transfer to shop.',
    });
  }
}

/** POST /api/admin/warehouses/:id/transfer-to-warehouse — send arrived stock to another main warehouse */
async function transferToWarehouse(req, res) {
  try {
    const source = await Warehouse.findById(req.params.id);
    if (!source || !source.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Source location not found.',
      });
    }

    const isMainSource = source.type === WAREHOUSE_TYPES.MAIN;
    const isShopSource = source.type === WAREHOUSE_TYPES.SUB;
    if (!isMainSource && !isShopSource) {
      return res.status(400).json({
        success: false,
        message: 'Send to warehouse is only available from a main warehouse or a shop.',
      });
    }

    if (isMainSource && isUsaWarehouseCity(source.city)) {
      const isUsaAdmin = await resolveRequestIsUsaAdmin(req);
      if (!isUsaAdmin) {
        return res.status(403).json({
          success: false,
          message: 'Only USA WACHE accounts can send stock from the USA warehouse.',
        });
      }
    } else if (isMainSource) {
      return res.status(400).json({
        success: false,
        message: 'Send to warehouse is only available from the USA main warehouse.',
      });
    }

    const destId = req.body?.destinationMainWarehouse;
    if (!destId) {
      return res.status(400).json({ success: false, message: 'destinationMainWarehouse is required.' });
    }

    const dest = await Warehouse.findOne({
      _id: destId,
      type: WAREHOUSE_TYPES.MAIN,
      isActive: true,
    });
    if (!dest) {
      return res.status(400).json({
        success: false,
        message: 'Invalid destination main warehouse.',
      });
    }
    if (String(dest._id) === String(source._id)) {
      return res.status(400).json({
        success: false,
        message: 'Choose a different warehouse as the destination.',
      });
    }
    if (isShopSource && isUsaWarehouseCity(dest.city)) {
      return res.status(400).json({
        success: false,
        message: 'Shops can only send stock to regional main warehouses.',
      });
    }

    const userId = req.user?.userId || req.user?.id || req.userId || null;
    const batchCode = String(req.body?.batchCode || '').trim();
    const singleProductId = req.body?.productId ? String(req.body.productId).trim() : null;
    const productIds = Array.isArray(req.body?.productIds)
      ? req.body.productIds.filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
      : [];
    const transferItems = Array.isArray(req.body?.transferItems)
      ? req.body.transferItems
          .map((item) => ({
            productId: String(item?.productId || '').trim(),
            ime: String(item?.ime || '').trim(),
          }))
          .filter((item) => mongoose.Types.ObjectId.isValid(item.productId))
      : [];
    const quantityRaw = req.body?.quantity;
    const hasQuantity =
      quantityRaw !== undefined && quantityRaw !== null && String(quantityRaw).trim() !== '';
    const quantity = hasQuantity ? Math.max(1, parseInt(quantityRaw, 10) || 0) : null;

    const note = isShopSource
      ? `Transferred from shop ${source.name} to main warehouse ${dest.name}`
      : `Sent to main warehouse ${dest.name}`;
    let unitsTransferred = 0;
    const imeManifest = [];

    const appendManifest = (product, transferredImes) => {
      imeManifest.push(...buildImeManifestLines(product, transferredImes));
    };

    if (singleProductId && mongoose.Types.ObjectId.isValid(singleProductId)) {
      const product = await Product.findOne({
        _id: singleProductId,
        currentWarehouse: source._id,
        shipmentStatus: 'arrived',
        stock: { $gt: 0 },
      });
      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product line not found at this warehouse.',
        });
      }
      const stock = Math.max(0, Number(product.stock) || 0);
      const qty = quantity || stock;
      const { transferredImes } = await transferProductQuantityToMainWarehouse(
        product,
        dest,
        userId,
        qty,
        note,
      );
      appendManifest(product, transferredImes);
      unitsTransferred += qty;
    } else if (batchCode) {
      const code = batchCode.toUpperCase();
      const batchProducts = await Product.find({
        currentWarehouse: source._id,
        shipmentStatus: 'arrived',
        stock: { $gt: 0 },
        bulkBatchCode: code,
      }).sort({ createdAt: 1 });

      if (!batchProducts.length) {
        const shipment = await BulkShipment.findOne({ batchCode: code });
        if (shipment && String(shipment.mainWarehouse) === String(source._id)) {
          const byShipment = await Product.find({
            bulkShipment: shipment._id,
            currentWarehouse: source._id,
            shipmentStatus: 'arrived',
            stock: { $gt: 0 },
          }).sort({ createdAt: 1 });
          batchProducts.push(...byShipment);
        }
      }

      if (!batchProducts.length) {
        return res.status(400).json({
          success: false,
          message: 'No received stock left in this batch at the warehouse.',
        });
      }

      if (quantity) {
        let remaining = quantity;
        for (const product of batchProducts) {
          if (remaining <= 0) break;
          const available = Math.max(0, Number(product.stock) || 0);
          const take = Math.min(remaining, available);
          const { transferredImes } = await transferProductQuantityToMainWarehouse(
            product,
            dest,
            userId,
            take,
            note,
          );
          appendManifest(product, transferredImes);
          unitsTransferred += take;
          remaining -= take;
        }
        if (remaining > 0) {
          return res.status(400).json({
            success: false,
            message: `Batch only has ${quantity - remaining} unit(s) available; requested ${quantity}.`,
          });
        }
      } else {
        for (const product of batchProducts) {
          const stock = Math.max(0, Number(product.stock) || 0);
          const { transferredImes } = await transferProductQuantityToMainWarehouse(
            product,
            dest,
            userId,
            stock,
            note,
          );
          appendManifest(product, transferredImes);
          unitsTransferred += stock > 0 ? stock : 1;
        }
      }
    } else if (transferItems.length) {
      const imeGroups = new Map();
      const unitCounts = new Map();

      for (const item of transferItems) {
        const pid = item.productId;
        if (item.ime) {
          if (!imeGroups.has(pid)) imeGroups.set(pid, []);
          imeGroups.get(pid).push(item.ime);
        } else {
          unitCounts.set(pid, (unitCounts.get(pid) || 0) + 1);
        }
      }

      const allProductIds = [...new Set([...imeGroups.keys(), ...unitCounts.keys()].map(String))];
      const products = await Product.find({
        _id: { $in: allProductIds },
        currentWarehouse: source._id,
        shipmentStatus: 'arrived',
        stock: { $gt: 0 },
      });
      const productById = new Map(products.map((p) => [String(p._id), p]));

      if (!products.length) {
        return res.status(400).json({
          success: false,
          message: 'No products at this location found to transfer.',
        });
      }

      for (const [pid, imes] of imeGroups) {
        let product = productById.get(String(pid));
        if (!product) {
          return res.status(404).json({
            success: false,
            message: 'One or more selected product lines were not found at this location.',
          });
        }
        const { transferredImes } = await transferImesToMainWarehouse(
          product,
          dest,
          userId,
          imes,
          note,
        );
        appendManifest(product, transferredImes);
        unitsTransferred += imes.length;
        if (unitCounts.has(pid)) {
          const refreshed = await Product.findById(product._id);
          if (refreshed) productById.set(String(pid), refreshed);
        }
      }

      for (const [pid, count] of unitCounts) {
        const product = productById.get(String(pid));
        if (!product) {
          return res.status(404).json({
            success: false,
            message: 'One or more selected product lines were not found at this location.',
          });
        }
        const { transferredImes } = await transferProductQuantityToMainWarehouse(
          product,
          dest,
          userId,
          count,
          note,
        );
        appendManifest(product, transferredImes);
        unitsTransferred += count;
      }
    } else if (productIds.length) {
      const products = await Product.find({
        _id: { $in: productIds },
        currentWarehouse: source._id,
        shipmentStatus: 'arrived',
        stock: { $gt: 0 },
      });
      if (!products.length) {
        return res.status(400).json({
          success: false,
          message: 'No products at this warehouse found to transfer.',
        });
      }
      if (quantity && products.length === 1) {
        const { transferredImes } = await transferProductQuantityToMainWarehouse(
          products[0],
          dest,
          userId,
          quantity,
          note,
        );
        appendManifest(products[0], transferredImes);
        unitsTransferred += quantity;
      } else {
        for (const product of products) {
          const stock = Math.max(0, Number(product.stock) || 0);
          const { transferredImes } = await transferProductQuantityToMainWarehouse(
            product,
            dest,
            userId,
            stock,
            note,
          );
          appendManifest(product, transferredImes);
          unitsTransferred += stock > 0 ? stock : 1;
        }
      }
    } else {
      return res.status(400).json({
        success: false,
        message: 'Provide batchCode, productId, productIds, or transferItems to transfer.',
      });
    }

    return res.status(200).json({
      success: true,
      message: isShopSource
        ? `${unitsTransferred} unit(s) sent from ${source.name} to ${dest.name} (${dest.city || 'Other'}). Mark received at the destination warehouse when stock arrives.`
        : `${unitsTransferred} unit(s) sent to ${dest.name} (${dest.city || 'Other'}). Mark received at the destination warehouse when stock arrives.`,
      data: {
        count: unitsTransferred,
        unitsTransferred,
        destination: warehouseSummary(dest),
        imeManifest,
        imeCount: imeManifest.length,
      },
    });
  } catch (err) {
    console.error('transferToWarehouse:', err);
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    return res.status(status).json({
      success: false,
      message: err.message || 'Failed to transfer to warehouse.',
    });
  }
}

/** GET /api/admin/warehouses/:id/lookup?ime= — find stock at this location by IME */
async function lookupImeAtWarehouse(req, res) {
  try {
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse || !warehouse.isActive) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }

    const query = String(req.query.ime || req.query.q || '').trim();
    if (query.length < 3) {
      return res.status(400).json({
        success: false,
        message: 'Enter at least 3 characters of the IME to search.',
      });
    }

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');

    const products = await Product.find({
      currentWarehouse: warehouse._id,
      $or: [{ IME: regex }, { imeCodes: regex }],
    })
      .select(
        'product_name brand capacity color stock shipmentStatus bulkBatchCode IME imeCodes phoneLocation country destinationSubWarehouse destinationMainWarehouse originWarehouse currentWarehouse createdAt',
      )
      .populate([
        { path: 'destinationSubWarehouse', select: 'name city type' },
        { path: 'destinationMainWarehouse', select: 'name city type' },
        { path: 'originWarehouse', select: 'name city type', strictPopulate: false },
        { path: 'currentWarehouse', select: 'name city type' },
      ])
      .sort({ updatedAt: -1 })
      .limit(100);

    const results = [];
    products.forEach((p) => {
      const codes = normalizedImeList(p);
      const matching = codes.filter((code) => regex.test(code));
      const lines = matching.length ? matching : codes.length === 0 && regex.test(String(p.IME || '')) ? [String(p.IME).trim()] : matching;

      lines.forEach((ime) => {
        results.push({
          ime,
          productId: p._id,
          productName: p.product_name,
          brand: p.brand,
          capacity: p.capacity,
          color: p.color,
          stock: p.stock,
          shipmentStatus: p.shipmentStatus,
          bulkBatchCode: p.bulkBatchCode || null,
          phoneLocation: p.phoneLocation || null,
          destinationShop: p.destinationSubWarehouse?.name || null,
        });
      });
    });

    return res.status(200).json({
      success: true,
      data: {
        query,
        warehouse: warehouseSummary(warehouse),
        count: results.length,
        results,
      },
    });
  } catch (err) {
    console.error('lookupImeAtWarehouse:', err);
    return res.status(500).json({ success: false, message: 'Failed to search by IME.' });
  }
}

module.exports = {
  getWarehousesDashboardOverview,
  getWarehouseHub,
  getWarehouseIncoming,
  getWarehouseReadyToTransfer,
  listStockRequests,
  createStockRequest,
  updateStockRequest,
  assignBulkShipmentDestination,
  receiveStockAtWarehouse,
  transferToShop,
  transferToWarehouse,
  lookupImeAtWarehouse,
};