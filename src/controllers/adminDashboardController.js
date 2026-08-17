const Product = require('../models/ItemsList');
const { SoldIme, SOLD_IME_STATUS } = require('../models/SoldIme');
const User = require('../models/User');
const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');
const { ROLES } = require('../models/User');
const { resolveUnitPriceFromOrder, resolveSaleShop } = require('../utils/saleShopResolution');

function parseMonthKey(raw) {
  const now = new Date();
  const fallback = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const key = String(raw || fallback).trim();
  if (!/^\d{4}-\d{2}$/.test(key)) return fallback;
  return key;
}

function monthRange(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const end = new Date(y, m, 1, 0, 0, 0, 0);
  return { start, end };
}

function isRetailSaleType(saleType) {
  return String(saleType || '').toLowerCase() === 'retail';
}

async function aggregateSalesByShop({ soldRows, shops, staffUsers, shopSales }) {
  const orderCache = new Map();
  const productCache = new Map();
  const shopDirectory = shops.map((s) => ({
    id: String(s._id),
    name: s.name,
    city: s.city || 'Other',
  }));

  let monthlySales = 0;
  let retailSold = 0;
  let wholesaleSold = 0;

  for (const sold of soldRows) {
    let price = 0;
    try {
      price = await resolveUnitPriceFromOrder(sold, orderCache);
    } catch (err) {
      // Skip malformed sales rows instead of failing whole dashboard.
      console.warn('aggregateSalesByShop: price resolution failed for sale', sold?._id, err?.message || err);
      continue;
    }
    if (price <= 0) continue;

    monthlySales += price;
    if (isRetailSaleType(sold.saleType)) {
      retailSold += price;
    } else {
      wholesaleSold += price;
    }

    let shopRef = { shopId: '', shopName: '' };
    try {
      shopRef = await resolveSaleShop(sold, {
        orderCache,
        productCache,
        staffUsers,
        shopDirectory,
      });
    } catch (err) {
      console.warn('aggregateSalesByShop: shop resolution failed for sale', sold?._id, err?.message || err);
      continue;
    }
    if (!shopRef.shopId) continue;

    const row = shopSales.get(shopRef.shopId);
    if (!row) continue;

    row.monthlySales += price;
    row.sold += price;
    if (isRetailSaleType(sold.saleType)) {
      row.retailSold += price;
    } else {
      row.wholesaleSold += price;
    }
    row.orderCount += 1;
  }

  return { monthlySales, retailSold, wholesaleSold };
}

/** GET /api/admin/dashboard — platform KPIs for admin overview */
async function getAdminDashboardStats(req, res) {
  try {
    const monthKey = parseMonthKey(req.query.month);
    const { start, end } = monthRange(monthKey);

    const productBaseFilter = { isActive: { $ne: false } };

    const [mainWarehouses, shops, soldRows, staffUsers] = await Promise.all([
      Warehouse.find({ type: WAREHOUSE_TYPES.MAIN, isActive: true }).select('_id name city'),
      Warehouse.find({ type: WAREHOUSE_TYPES.SUB, isActive: true })
        .select('name city address')
        .sort({ name: 1 }),
      SoldIme.find({
        soldAt: { $gte: start, $lt: end },
        status: SOLD_IME_STATUS.SOLD_OUT,
      })
        .populate('handledBy', 'name role assignedShops')
        .lean(),
      User.find({
        role: ROLES.SALESMAN,
        accountStatus: { $ne: 'suspended' },
      })
        .select('name assignedShops')
        .lean(),
    ]);

    const mainIds = mainWarehouses.map((w) => w._id);
    const shopIds = shops.map((s) => s._id);

    const stockUnitsExpr = { $max: [{ $ifNull: ['$stock', 0] }, 0] };
    const stockValueExpr = {
      $multiply: [stockUnitsExpr, { $ifNull: ['$price', 0] }],
    };

    const [
      totalProducts,
      inventoryAgg,
      warehouseInventoryAgg,
      shopInventoryAgg,
      platformOutOfStock,
      inventoryOutOfStock,
      shopOutOfStock,
      shopOutOfStockByWh,
    ] = await Promise.all([
      Product.countDocuments(productBaseFilter),
      Product.aggregate([
        { $match: productBaseFilter },
        {
          $group: {
            _id: null,
            units: { $sum: stockUnitsExpr },
            value: { $sum: stockValueExpr },
          },
        },
      ]),
      Product.aggregate([
        {
          $match: {
            ...productBaseFilter,
            currentWarehouse: { $in: mainIds },
          },
        },
        {
          $group: {
            _id: '$currentWarehouse',
            totalProducts: { $sum: 1 },
            units: { $sum: stockUnitsExpr },
            value: { $sum: stockValueExpr },
          },
        },
      ]),
      Product.aggregate([
        {
          $match: {
            ...productBaseFilter,
            currentWarehouse: { $in: shopIds },
          },
        },
        {
          $group: {
            _id: '$currentWarehouse',
            totalProducts: { $sum: 1 },
            units: { $sum: stockUnitsExpr },
            value: { $sum: stockValueExpr },
          },
        },
      ]),
      Product.countDocuments({ ...productBaseFilter, stock: { $lte: 0 } }),
      Product.countDocuments({
        ...productBaseFilter,
        stock: { $lte: 0 },
        currentWarehouse: { $in: mainIds },
      }),
      Product.countDocuments({
        ...productBaseFilter,
        stock: { $lte: 0 },
        currentWarehouse: { $in: shopIds },
      }),
      Product.aggregate([
        {
          $match: {
            ...productBaseFilter,
            stock: { $lte: 0 },
            currentWarehouse: { $in: shopIds },
          },
        },
        { $group: { _id: '$currentWarehouse', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    const inventoryRow = inventoryAgg[0] || { units: 0, value: 0 };
    const warehouseInventoryById = new Map(
      warehouseInventoryAgg.map((row) => [
        String(row._id),
        {
          totalProducts: row.totalProducts || 0,
          units: row.units || 0,
          value: row.value || 0,
        },
      ]),
    );
    const shopInventoryById = new Map(
      shopInventoryAgg.map((row) => [
        String(row._id),
        {
          totalProducts: row.totalProducts || 0,
          units: row.units || 0,
          value: row.value || 0,
        },
      ]),
    );

    const shopNameById = new Map(shops.map((s) => [String(s._id), s]));
    const outOfStockByShop = shopOutOfStockByWh.map((row) => {
      const shop = shopNameById.get(String(row._id));
      return {
        shopId: String(row._id),
        name: shop?.name || 'Shop',
        city: shop?.city || 'Other',
        outOfStockCount: row.count,
      };
    });

    let monthlySales = 0;
    let retailSold = 0;
    let wholesaleSold = 0;

    const shopSales = new Map();
    shops.forEach((shop) => {
      const key = String(shop._id);
      const inv = shopInventoryById.get(key) || { totalProducts: 0, units: 0, value: 0 };
      shopSales.set(key, {
        shopId: key,
        name: shop.name,
        city: shop.city || 'Other',
        totalProducts: inv.totalProducts,
        inventoryUnits: inv.units,
        inventoryValue: inv.value,
        monthlySales: 0,
        retailSold: 0,
        wholesaleSold: 0,
        sold: 0,
        orderCount: 0,
      });
    });

    ({ monthlySales, retailSold, wholesaleSold } = await aggregateSalesByShop({
      soldRows,
      shops,
      staffUsers,
      shopSales,
    }));

    const shopMetrics = [...shopSales.values()]
      .map((s) => ({
        shopId: s.shopId,
        name: s.name,
        city: s.city,
        totalProducts: s.totalProducts,
        inventoryUnits: s.inventoryUnits,
        inventoryValue: Math.round(s.inventoryValue || 0),
        monthlySales: Math.round(s.monthlySales),
        retailSold: Math.round(s.retailSold),
        wholesaleSold: Math.round(s.wholesaleSold),
        sold: Math.round(s.sold),
        orderCount: Math.round(s.orderCount * 10) / 10,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const shopPerformance = shopMetrics
      .filter((s) => s.sold > 0)
      .sort((a, b) => b.sold - a.sold);

    const warehouseMetrics = mainWarehouses
      .map((warehouse) => {
        const key = String(warehouse._id);
        const inv = warehouseInventoryById.get(key) || { totalProducts: 0, units: 0, value: 0 };
        return {
          warehouseId: key,
          name: warehouse.name,
          city: warehouse.city || 'Other',
          totalProducts: inv.totalProducts,
          inventoryUnits: inv.units,
          inventoryValue: Math.round(inv.value || 0),
          monthlySales: 0,
          retailSold: 0,
          wholesaleSold: 0,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({
      success: true,
      data: {
        month: monthKey,
        totalProducts,
        inventoryUnits: inventoryRow.units || 0,
        inventoryValue: Math.round(inventoryRow.value || 0),
        monthlySales: Math.round(monthlySales),
        retailSold: Math.round(retailSold),
        wholesaleSold: Math.round(wholesaleSold),
        warehouses: warehouseMetrics,
        shops: shopMetrics,
        shopPerformance,
        outOfStock: {
          platformTotal: platformOutOfStock,
          inventory: inventoryOutOfStock,
          shops: shopOutOfStock,
          byShop: outOfStockByShop,
        },
      },
    });
  } catch (err) {
    console.error('getAdminDashboardStats:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to load dashboard statistics.',
    });
  }
}

module.exports = {
  getAdminDashboardStats,
};
