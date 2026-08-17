const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');
const Product = require('../models/ItemsList');
const User = require('../models/User');
const WarehouseStockRequest = require('../models/WarehouseStockRequest');
const { REQUEST_STATUS } = require('../models/WarehouseStockRequest');
const { normalizeProductPhoneLocation } = require('../utils/normalizeProductPhoneLocation');
const { attachResolvedOriginWarehouses } = require('../utils/warehousePopulate');
const { resolveEffectiveLineStock } = require('../utils/productIme');
const {
  sumAvailableUnitsAtWarehouse,
  countOnHandProductNamesAtWarehouse,
} = require('../utils/warehouseInventoryStats');

function normalizeCity(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Other';
  const lower = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (lower === 'yaounde') return 'Yaounde';
  if (lower === 'usa' || lower === 'u.s.a.' || lower === 'united states') return 'USA';
  const allowed = ['Douala', 'Yaounde', 'Bafoussam', 'Bamenda', 'Limbe', 'Buea', 'USA', 'Other'];
  const match = allowed.find((c) => c.toLowerCase() === lower);
  return match || 'Other';
}

/** Warehouses without isActive explicitly false (includes legacy rows missing the field). */
function activeWarehouseFilter() {
  return { isActive: { $ne: false } };
}

function mainWarehouseCityFilter(normalizedCity) {
  if (normalizedCity === 'Other') return { city: 'Other' };
  const escaped = normalizedCity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { city: new RegExp(`^${escaped}$`, 'i') };
}

async function findActiveMainWarehouseInCity(normalizedCity) {
  if (normalizedCity === 'Other') return null;
  return Warehouse.findOne({
    type: WAREHOUSE_TYPES.MAIN,
    ...activeWarehouseFilter(),
    ...mainWarehouseCityFilter(normalizedCity),
  });
}

async function findInactiveMainWarehouseInCity(normalizedCity) {
  if (normalizedCity === 'Other') return null;
  return Warehouse.findOne({
    type: WAREHOUSE_TYPES.MAIN,
    isActive: false,
    ...mainWarehouseCityFilter(normalizedCity),
  });
}

function formatWarehouseWriteError(err, city) {
  if (err?.name === 'ValidationError') {
    const detail = Object.values(err.errors || {})
      .map((e) => e.message)
      .filter(Boolean)
      .join(' ');
    if (/enum/i.test(detail) && city === 'USA') {
      return `${detail} Redeploy the latest server so "USA" is allowed as a warehouse city.`;
    }
    return detail || 'Invalid warehouse data.';
  }
  if (err?.code === 11000) {
    return `A main warehouse already exists for ${city}. Check the Warehouses list or restore a previously deleted location.`;
  }
  return null;
}

/** @deprecated Prefer resolving main from sub-warehouse parent or explicit id. */
async function getActiveMainWarehouse() {
  return Warehouse.findOne({ type: WAREHOUSE_TYPES.MAIN, isActive: true }).sort({ createdAt: 1 });
}

async function getMainWarehouseById(id) {
  if (!id) return null;
  return Warehouse.findOne({ _id: id, type: WAREHOUSE_TYPES.MAIN, isActive: true });
}

async function resolveMainFromSubWarehouse(subId) {
  const sub = await Warehouse.findOne({
    _id: subId,
    type: WAREHOUSE_TYPES.SUB,
    isActive: true,
  });
  if (!sub?.parentWarehouse) return { sub: null, main: null };
  const main = await getMainWarehouseById(sub.parentWarehouse);
  return { sub, main };
}

/** GET /api/admin/warehouses */
async function listWarehouses(req, res) {
  try {
    const mainWarehouses = await Warehouse.find({
      type: WAREHOUSE_TYPES.MAIN,
      ...activeWarehouseFilter(),
    }).sort({ city: 1, name: 1 });

    const subWarehouses = await Warehouse.find({
      type: WAREHOUSE_TYPES.SUB,
      ...activeWarehouseFilter(),
    })
      .populate({ path: 'parentWarehouse', select: 'name city type' })
      .sort({ name: 1 });

    return res.status(200).json({
      success: true,
      data: {
        mainWarehouses,
        /** @deprecated use mainWarehouses */
        main: mainWarehouses[0] || null,
        subWarehouses,
      },
    });
  } catch (err) {
    console.error('listWarehouses:', err);
    return res.status(500).json({ success: false, message: 'Failed to load warehouses.' });
  }
}

/** POST /api/admin/warehouses/main — regional main warehouse (one per city/region) */
async function createMainWarehouse(req, res) {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Main warehouse name is required.' });
    }

    const city = normalizeCity(req.body?.city);
    const address = String(req.body?.address || '').trim();
    const description = String(req.body?.description || '').trim();
    const createdBy = req.user?.id || req.user?._id || req.user?.userId || null;

    if (city !== 'Other') {
      const existingInCity = await findActiveMainWarehouseInCity(city);
      if (existingInCity) {
        return res.status(409).json({
          success: false,
          message: `A main warehouse already exists for ${city} (${existingInCity.name}). Each region/city can have one main warehouse.`,
          data: existingInCity,
        });
      }

      const inactiveInCity = await findInactiveMainWarehouseInCity(city);
      if (inactiveInCity) {
        inactiveInCity.isActive = true;
        inactiveInCity.name = name;
        inactiveInCity.city = city;
        inactiveInCity.address = address;
        inactiveInCity.description = description;
        if (createdBy) inactiveInCity.createdBy = createdBy;
        await inactiveInCity.save();

        return res.status(200).json({
          success: true,
          message: `Main warehouse restored for ${city}.`,
          data: inactiveInCity,
        });
      }
    }

    const warehouse = await Warehouse.create({
      name,
      type: WAREHOUSE_TYPES.MAIN,
      city,
      address,
      description,
      createdBy,
    });

    return res.status(201).json({
      success: true,
      message: `Main warehouse created for ${city}.`,
      data: warehouse,
    });
  } catch (err) {
    console.error('createMainWarehouse:', err);
    const friendly = formatWarehouseWriteError(err, normalizeCity(req.body?.city));
    if (friendly) {
      const status = err?.name === 'ValidationError' ? 400 : 409;
      return res.status(status).json({ success: false, message: friendly });
    }
    return res.status(500).json({ success: false, message: 'Failed to create main warehouse.' });
  }
}

/** POST /api/admin/warehouses/sub — retail shop (independent of main warehouse by default) */
async function createSubWarehouse(req, res) {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Shop name is required.' });
    }

    const city = normalizeCity(req.body?.city);
    const parentId = req.body?.parentWarehouse ? String(req.body.parentWarehouse).trim() : '';
    let main = null;

    if (parentId) {
      main = await getMainWarehouseById(parentId);
      if (!main) {
        return res.status(400).json({
          success: false,
          message: 'Invalid parent main warehouse.',
        });
      }
    }

    const namePattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const duplicateQuery = {
      type: WAREHOUSE_TYPES.SUB,
      name: namePattern,
      isActive: true,
    };
    if (main) {
      duplicateQuery.parentWarehouse = main._id;
    } else {
      duplicateQuery.parentWarehouse = null;
      duplicateQuery.city = city;
    }

    const duplicate = await Warehouse.findOne(duplicateQuery);
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: main
          ? 'A shop with this name already exists under that main warehouse.'
          : `A shop named "${name}" already exists in ${city}.`,
      });
    }

    const warehouse = await Warehouse.create({
      name,
      type: WAREHOUSE_TYPES.SUB,
      parentWarehouse: main ? main._id : null,
      city,
      address: String(req.body?.address || '').trim(),
      description: String(req.body?.description || '').trim(),
      createdBy: req.user?.id || req.user?._id || null,
    });

    return res.status(201).json({
      success: true,
      message: 'Shop created.',
      data: warehouse,
    });
  } catch (err) {
    console.error('createSubWarehouse:', err);
    return res.status(500).json({ success: false, message: 'Failed to create Shop.' });
  }
}

/** PATCH /api/admin/warehouses/:id */
async function updateWarehouse(req, res) {
  try {
    const id = req.params.id;
    const warehouse = await Warehouse.findById(id);
    if (!warehouse || !warehouse.isActive) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }

    if (req.body?.name != null) {
      const name = String(req.body.name).trim();
      if (!name) {
        return res.status(400).json({ success: false, message: 'Name cannot be empty.' });
      }
      warehouse.name = name;
    }
    if (req.body?.city != null) {
      const nextCity = normalizeCity(req.body.city);
      if (warehouse.type === WAREHOUSE_TYPES.MAIN && nextCity !== 'Other' && nextCity !== warehouse.city) {
        const clash = await Warehouse.findOne({
          _id: { $ne: warehouse._id },
          type: WAREHOUSE_TYPES.MAIN,
          city: nextCity,
          isActive: true,
        });
        if (clash) {
          return res.status(409).json({
            success: false,
            message: `Another main warehouse already exists for ${nextCity}.`,
          });
        }
      }
      warehouse.city = nextCity;
    }
    if (req.body?.address != null) warehouse.address = String(req.body.address).trim();
    if (req.body?.description != null) warehouse.description = String(req.body.description).trim();

    await warehouse.save();

    return res.status(200).json({
      success: true,
      message: 'Warehouse updated.',
      data: warehouse,
    });
  } catch (err) {
    console.error('updateWarehouse:', err);
    return res.status(500).json({ success: false, message: 'Failed to update warehouse.' });
  }
}

/** GET /api/admin/warehouses/:id/products — stock physically at this warehouse */
async function getWarehouseProducts(req, res) {
  try {
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse || !warehouse.isActive) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }

    const filter = { currentWarehouse: warehouse._id };
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 500);

    const [products, totalProducts, onHandUnitCount, onHandProductCount] = await Promise.all([
      Product.find(filter)
        .select(
          'product_name brand product_type capacity color stock price costPrice priceMin priceMax shipmentStatus bulkBatchCode phoneLocation country createdAt destinationSubWarehouse destinationMainWarehouse originWarehouse currentWarehouse images primaryImage IME imeCodes locationHistory bulkShipment',
        )
        .populate([
          { path: 'destinationSubWarehouse', select: 'name city type' },
          { path: 'destinationMainWarehouse', select: 'name city type' },
          { path: 'originWarehouse', select: 'name city type', strictPopulate: false },
          { path: 'currentWarehouse', select: 'name city type' },
          { path: 'bulkShipment', select: 'mainWarehouse', populate: { path: 'mainWarehouse', select: 'name city type' } },
        ])
        .sort({ createdAt: -1 })
        .limit(limit),
      Product.countDocuments(filter),
      sumAvailableUnitsAtWarehouse(warehouse._id),
      countOnHandProductNamesAtWarehouse(warehouse._id),
    ]);

    await attachResolvedOriginWarehouses(products);

    const totalStock = products.reduce((sum, p) => sum + resolveEffectiveLineStock(p), 0);

    return res.status(200).json({
      success: true,
      data: {
        warehouse: {
          _id: warehouse._id,
          name: warehouse.name,
          type: warehouse.type,
          city: warehouse.city,
          address: warehouse.address,
        },
        count: products.length,
        totalProducts,
        onHandProductCount,
        onHandUnitCount,
        totalStock,
        products,
      },
    });
  } catch (err) {
    console.error('getWarehouseProducts:', err);
    return res.status(500).json({ success: false, message: 'Failed to load warehouse products.' });
  }
}

function warehouseProductReferenceFilter(warehouseId) {
  return {
    $or: [
      { currentWarehouse: warehouseId },
      { destinationSubWarehouse: warehouseId },
      { destinationMainWarehouse: warehouseId },
    ],
  };
}

/** GET /api/admin/warehouses/:id/delete-preview */
async function getWarehouseDeletePreview(req, res) {
  try {
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse || !warehouse.isActive) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }

    const whId = warehouse._id;
    const [productCount, stockAtLocation, legacyLinkedShops, pendingRequests] = await Promise.all([
      Product.countDocuments(warehouseProductReferenceFilter(whId)),
      Product.countDocuments({ currentWarehouse: whId }),
      warehouse.type === WAREHOUSE_TYPES.MAIN
        ? Warehouse.countDocuments({
            type: WAREHOUSE_TYPES.SUB,
            parentWarehouse: whId,
            isActive: true,
          })
        : Promise.resolve(0),
      WarehouseStockRequest.countDocuments({
        status: REQUEST_STATUS.PENDING,
        $or: [{ requestingShop: whId }, { requestingMain: whId }, { servingMain: whId }],
      }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        warehouse: {
          _id: warehouse._id,
          name: warehouse.name,
          type: warehouse.type,
          city: warehouse.city,
        },
        productCount,
        stockAtLocation,
        /** Shops with optional legacy parent link — they stay active after main warehouse delete */
        legacyLinkedShops,
        /** @deprecated use legacyLinkedShops */
        activeChildShops: legacyLinkedShops,
        pendingRequests,
        requiresReassignment: productCount > 0,
        canDelete: true,
      },
    });
  } catch (err) {
    console.error('getWarehouseDeletePreview:', err);
    return res.status(500).json({ success: false, message: 'Failed to load delete preview.' });
  }
}

async function reassignProductsFromWarehouse(source, target) {
  if (target.type !== WAREHOUSE_TYPES.MAIN) {
    throw new Error('Products must be reassigned to a main warehouse.');
  }

  const sourceId = source._id;
  const targetId = target._id;
  const phoneLoc = target.city ? normalizeProductPhoneLocation(target.city) : undefined;

  await Product.updateMany(
    { currentWarehouse: sourceId },
    {
      $set: {
        currentWarehouse: targetId,
        ...(phoneLoc ? { phoneLocation: phoneLoc } : {}),
      },
    },
  );

  await Product.updateMany(
    { destinationSubWarehouse: sourceId },
    { $set: { destinationSubWarehouse: null } },
  );

  await Product.updateMany(
    { destinationMainWarehouse: sourceId },
    { $set: { destinationMainWarehouse: targetId } },
  );
}

/** DELETE /api/admin/warehouses/:id — reassign products then soft-deactivate */
async function deactivateWarehouse(req, res) {
  try {
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse || !warehouse.isActive) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }

    const whId = warehouse._id;
    const reassignToWarehouseId = String(req.body?.reassignToWarehouseId || '').trim();
    const userId = req.user?.id || req.user?._id || null;

    const productCount = await Product.countDocuments(warehouseProductReferenceFilter(whId));
    let reassignTarget = null;

    if (productCount > 0) {
      if (!reassignToWarehouseId) {
        return res.status(400).json({
          success: false,
          message: `This location has ${productCount} product record(s). Choose another main warehouse to move them to before deleting.`,
          data: { productCount, requiresReassignment: true },
        });
      }

      reassignTarget = await Warehouse.findOne({
        _id: reassignToWarehouseId,
        type: WAREHOUSE_TYPES.MAIN,
        isActive: true,
      });
      if (!reassignTarget) {
        return res.status(400).json({
          success: false,
          message: 'Invalid reassignment warehouse. Choose an active main warehouse.',
        });
      }
      if (String(reassignTarget._id) === String(whId)) {
        return res.status(400).json({
          success: false,
          message: 'Choose a different warehouse for reassignment.',
        });
      }

      await reassignProductsFromWarehouse(warehouse, reassignTarget);
    }

    if (warehouse.type === WAREHOUSE_TYPES.MAIN) {
      await Warehouse.updateMany(
        { type: WAREHOUSE_TYPES.SUB, parentWarehouse: whId, isActive: true },
        { $set: { parentWarehouse: null } },
      );
    }

    await WarehouseStockRequest.updateMany(
      {
        status: REQUEST_STATUS.PENDING,
        $or: [{ requestingShop: whId }, { requestingMain: whId }, { servingMain: whId }],
      },
      {
        $set: {
          status: REQUEST_STATUS.REJECTED,
          adminNote: `Location "${warehouse.name}" was removed.`,
          resolvedAt: new Date(),
          resolvedBy: userId,
        },
      },
    );

    if (warehouse.type === WAREHOUSE_TYPES.SUB) {
      await User.updateMany({ assignedShops: whId }, { $pull: { assignedShops: whId } });
    }

    warehouse.isActive = false;
    await warehouse.save();

    return res.status(200).json({
      success: true,
      message:
        productCount > 0
          ? `${warehouse.name} deleted. ${productCount} product record(s) moved to ${reassignTarget.name}.`
          : warehouse.type === WAREHOUSE_TYPES.MAIN
            ? 'Main warehouse deleted.'
            : 'Shop deleted.',
      data: {
        reassignedProductCount: productCount,
        reassignToWarehouseId: reassignToWarehouseId || null,
      },
    });
  } catch (err) {
    console.error('deactivateWarehouse:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete warehouse.' });
  }
}

module.exports = {
  listWarehouses,
  createMainWarehouse,
  createSubWarehouse,
  updateWarehouse,
  deactivateWarehouse,
  getWarehouseDeletePreview,
  getWarehouseProducts,
  getActiveMainWarehouse,
  getMainWarehouseById,
  resolveMainFromSubWarehouse,
  normalizeCity,
};
