const User = require('../models/User');
const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');
const { ROLES } = require('../models/User');
const { cityFromAddress, normalizeCityLabel } = require('./salesmanShopRouting');

async function loadSalesmanWithShops(userId) {
  const id = String(userId || '').trim();
  if (!id) return null;
  return User.findOne({ _id: id, role: ROLES.SALESMAN })
    .select('name role assignedShops accountStatus')
    .populate({
      path: 'assignedShops',
      match: { type: WAREHOUSE_TYPES.SUB, isActive: true },
      select: 'name city address type isActive',
    });
}

function getAssignedShopIds(user) {
  const shops = Array.isArray(user?.assignedShops) ? user.assignedShops : [];
  return shops.map((s) => String(s._id || s.id || s)).filter(Boolean);
}

async function assertSalesmanShopAccess(userId, shopId) {
  const salesman = await loadSalesmanWithShops(userId);
  if (!salesman) {
    const err = new Error('Salesperson account not found.');
    err.status = 403;
    throw err;
  }
  const allowed = getAssignedShopIds(salesman);
  const key = String(shopId || '').trim();
  if (!key || !allowed.includes(key)) {
    const err = new Error('You do not have access to this shop.');
    err.status = 403;
    throw err;
  }
  const shop = await Warehouse.findOne({
    _id: key,
    type: WAREHOUSE_TYPES.SUB,
    isActive: true,
  });
  if (!shop) {
    const err = new Error('Shop not found.');
    err.status = 404;
    throw err;
  }
  return { salesman, shop };
}

/** Mongo filter: buy orders visible to this salesperson's assigned shop cities. */
async function buildSalesmanOrdersFilter(userId) {
  const salesman = await loadSalesmanWithShops(userId);
  if (!salesman) {
    return { _id: null };
  }
  const shops = (salesman.assignedShops || []).filter(Boolean);
  if (!shops.length) {
    return { _id: null };
  }

  const cities = [...new Set(shops.map((s) => s.city).filter(Boolean))];
  if (!cities.length) {
    return { _id: null };
  }

  const shopIds = shops.map((s) => s._id).filter(Boolean);
  const shopIdStrings = shopIds.map((id) => String(id));

  const cityClauses = cities.flatMap((city) => {
    const re = new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return [
      { businessAddress: re },
      { 'deliveryInfo.deliveryAddress': re },
      { deliveryAddress: re },
    ];
  });

  const directSaleClauses = [];
  if (shopIds.length) {
    directSaleClauses.push({ 'directSale.assignedWarehouseId': { $in: shopIds } });
  }
  if (shopIdStrings.length) {
    directSaleClauses.push({ 'directSale.assignedWarehouseId': { $in: shopIdStrings } });
  }

  return {
    orderType: 'buy',
    $or: [...cityClauses, ...directSaleClauses],
  };
}

function orderMatchesAssignedShops(order, shops) {
  if (!shops?.length) return false;

  const shopIds = new Set(
    shops.map((s) => String(s?._id ?? s?.id ?? s ?? '').trim()).filter(Boolean),
  );
  const assignedId = String(
    order?.directSale?.assignedWarehouseId?._id ??
      order?.directSale?.assignedWarehouseId ??
      '',
  ).trim();
  if (assignedId && shopIds.has(assignedId)) return true;

  const assignedName = String(order?.directSale?.assignedWarehouseName || '').trim().toLowerCase();
  if (assignedName) {
    const nameMatch = shops.some(
      (s) => String(s?.name || '').trim().toLowerCase() === assignedName,
    );
    if (nameMatch) return true;
  }

  const addr =
    order?.deliveryInfo?.deliveryAddress ||
    order?.deliveryAddress ||
    order?.businessAddress ||
    '';
  const city = cityFromAddress(addr);
  if (!city) return false;
  const normalizedCity = normalizeCityLabel(city);
  return shops.some((s) => {
    const shopCity = normalizeCityLabel(s.city);
    return shopCity === normalizedCity || String(s.city || '') === city;
  });
}

module.exports = {
  loadSalesmanWithShops,
  getAssignedShopIds,
  assertSalesmanShopAccess,
  buildSalesmanOrdersFilter,
  orderMatchesAssignedShops,
};
