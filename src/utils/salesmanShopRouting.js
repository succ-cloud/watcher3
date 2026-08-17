const User = require('../models/User');
const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');
const { ROLES, ACCOUNT_STATUS } = require('../models/User');

const CITY_LABELS = ['Douala', 'Yaounde', 'Bafoussam', 'Bamenda', 'Limbe', 'Buea', 'Other'];
const DEFAULT_FULFILLMENT_CITY = 'Yaounde';

function cityFromAddress(address) {
  const hay = String(address || '').toLowerCase();
  if (!hay) return null;
  for (const city of CITY_LABELS) {
    if (hay.includes(city.toLowerCase())) return city;
  }
  if (hay.includes('yaoundé')) return 'Yaounde';
  return null;
}

function normalizeCityLabel(city) {
  const raw = String(city || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower === 'yaoundé' || lower === 'yaounde') return 'Yaounde';
  for (const label of CITY_LABELS) {
    if (lower === label.toLowerCase()) return label;
  }
  return raw;
}

async function findActiveShopsInCity(city) {
  const normalized = normalizeCityLabel(city);
  if (!normalized) return [];
  const shops = await Warehouse.find({
    type: WAREHOUSE_TYPES.SUB,
    isActive: true,
    city: { $regex: new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
  })
    .select('_id name city address type isActive')
    .sort({ name: 1 })
    .lean();

  if (shops.length <= 1) return shops;

  const withStaff = [];
  for (const shop of shops) {
    const staffCount = await User.countDocuments({
      role: ROLES.SALESMAN,
      accountStatus: ACCOUNT_STATUS.ACTIVE,
      assignedShops: String(shop._id),
    });
    if (staffCount > 0) withStaff.push(shop);
  }

  const preferred = withStaff.length ? withStaff : shops;
  preferred.sort((a, b) => {
    const aName = String(a?.name || '').toLowerCase();
    const bName = String(b?.name || '').toLowerCase();
    const aWache = aName.includes('wache') ? 1 : 0;
    const bWache = bName.includes('wache') ? 1 : 0;
    if (bWache !== aWache) return bWache - aWache;
    return aName.localeCompare(bName);
  });

  const ranked = preferred.length ? preferred : shops;
  const rankedIds = new Set(ranked.map((shop) => String(shop._id)));
  const tail = shops.filter((shop) => !rankedIds.has(String(shop._id)));
  return [...ranked, ...tail];
}

/**
 * Resolve which shop fulfills a vendor web order.
 * Uses the vendor city when a shop exists there; otherwise routes to Yaounde.
 */
async function resolveVendorOrderFulfillmentShop(deliveryAddress) {
  const vendorCity = cityFromAddress(deliveryAddress);
  let shops = vendorCity ? await findActiveShopsInCity(vendorCity) : [];
  let fallbackUsed = false;

  if (!shops.length) {
    shops = await findActiveShopsInCity(DEFAULT_FULFILLMENT_CITY);
    fallbackUsed = true;
  }

  const shop = shops[0] || null;
  return {
    shop,
    fallbackUsed,
    vendorCity: vendorCity ? normalizeCityLabel(vendorCity) : null,
    fulfillmentCity: shop?.city ? normalizeCityLabel(shop.city) : null,
  };
}

function buildVendorWebDirectSale(fulfillmentAssignment) {
  if (!fulfillmentAssignment?.shop) return null;
  return {
    source: 'vendor_web',
    assignedWarehouseId: fulfillmentAssignment.shop._id,
    assignedWarehouseName: fulfillmentAssignment.shop.name,
    assignedWarehouseCity: fulfillmentAssignment.fulfillmentCity || fulfillmentAssignment.shop.city || null,
    fulfillmentFallback: Boolean(fulfillmentAssignment.fallbackUsed),
    vendorCity: fulfillmentAssignment.vendorCity || null,
  };
}

/**
 * Ensure vendor buy orders carry a fulfillment shop assignment (Yaounde fallback when needed).
 * Mutates and persists the order when a shop is resolved.
 */
async function ensureVendorBuyOrderFulfillment(orderLike) {
  if (!orderLike || String(orderLike.orderType || '').toLowerCase() !== 'buy') {
    return orderLike;
  }
  if (orderLike.isCustomProduct) return orderLike;

  const existingId = String(
    orderLike?.directSale?.assignedWarehouseId?._id ??
      orderLike?.directSale?.assignedWarehouseId ??
      '',
  ).trim();
  if (existingId) return orderLike;

  const address =
    orderLike?.deliveryInfo?.deliveryAddress ||
    orderLike?.deliveryAddress ||
    orderLike?.businessAddress ||
    '';
  const fulfillmentAssignment = await resolveVendorOrderFulfillmentShop(address);
  const directSale = buildVendorWebDirectSale(fulfillmentAssignment);
  if (!directSale) return orderLike;

  orderLike.directSale = {
    ...(orderLike.directSale && typeof orderLike.directSale === 'object' ? orderLike.directSale : {}),
    ...directSale,
  };

  if (orderLike._id) {
    const Order = require('../models/Order').Order;
    await Order.updateOne({ _id: orderLike._id }, { $set: { directSale: orderLike.directSale } });
  }

  return orderLike;
}

async function findSalespeopleForFulfillmentShop(shopId) {
  const id = String(shopId || '').trim();
  if (!id) return [];

  return User.find({
    role: ROLES.SALESMAN,
    accountStatus: ACCOUNT_STATUS.ACTIVE,
    assignedShops: id,
    whatsappNumber: { $exists: true, $ne: '' },
  }).select('_id name businessAddress whatsappNumber assignedShops');
}

/**
 * Active salespeople to notify for a buy order delivery address.
 * Prefers explicit shop assignments; falls back to legacy businessAddress match.
 */
async function findSalespeopleForOrderAddress(deliveryAddress) {
  const address = String(deliveryAddress || '').trim();
  if (!address) return [];

  const fulfillment = await resolveVendorOrderFulfillmentShop(address);
  if (fulfillment.shop) {
    const assigned = await findSalespeopleForFulfillmentShop(fulfillment.shop._id);
    if (assigned.length) return assigned;
  }

  const city = cityFromAddress(address);
  let shopIds = [];

  if (city) {
    const shops = await Warehouse.find({
      type: WAREHOUSE_TYPES.SUB,
      isActive: true,
      city,
    }).select('_id');
    shopIds = shops.map((s) => s._id);
  }

  let salesmen = [];

  if (shopIds.length) {
    salesmen = await User.find({
      role: ROLES.SALESMAN,
      accountStatus: ACCOUNT_STATUS.ACTIVE,
      assignedShops: { $in: shopIds },
      whatsappNumber: { $exists: true, $ne: '' },
    }).select('_id name businessAddress whatsappNumber assignedShops');
  }

  if (!salesmen.length) {
    salesmen = await User.find({
      role: ROLES.SALESMAN,
      accountStatus: ACCOUNT_STATUS.ACTIVE,
      businessAddress: { $regex: new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
      whatsappNumber: { $exists: true, $ne: '' },
    }).select('_id name businessAddress whatsappNumber assignedShops');
  }

  const seen = new Set();
  return salesmen.filter((s) => {
    const key = String(s._id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Derive a salesperson business city from their assigned shop(s).
 * Uses the city of the first shop id in the provided order.
 */
async function resolveBusinessAddressFromShopIds(shopIdList) {
  const ids = [...new Set((Array.isArray(shopIdList) ? shopIdList : []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return null;

  const shops = await Warehouse.find({
    _id: { $in: ids },
    type: WAREHOUSE_TYPES.SUB,
    isActive: true,
  })
    .select('city name')
    .lean();

  if (shops.length !== ids.length) return null;

  const byId = new Map(shops.map((shop) => [String(shop._id), shop]));
  const ordered = ids.map((id) => byId.get(String(id))).filter(Boolean);
  const primaryCity = normalizeCityLabel(ordered[0]?.city);
  if (!primaryCity) return null;

  const { ensureDefaultBusinessCities, listActiveBusinessCities, formatBusinessCityName } = require('./businessCities');
  await ensureDefaultBusinessCities();
  const allowed = await listActiveBusinessCities();
  const match =
    allowed.find((city) => String(city).trim().toLowerCase() === primaryCity.toLowerCase()) || null;
  if (match) return formatBusinessCityName(match);

  return formatBusinessCityName(primaryCity);
}

module.exports = {
  cityFromAddress,
  normalizeCityLabel,
  DEFAULT_FULFILLMENT_CITY,
  resolveVendorOrderFulfillmentShop,
  buildVendorWebDirectSale,
  ensureVendorBuyOrderFulfillment,
  findSalespeopleForFulfillmentShop,
  findSalespeopleForOrderAddress,
  resolveBusinessAddressFromShopIds,
};
