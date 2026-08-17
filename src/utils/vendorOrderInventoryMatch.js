const Warehouse = require('../models/Warehouse');
const Product = require('../models/ItemsList');
const { normalizedImeList } = require('./productIme');

function normalizeProductName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeCapacity(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function orderReferenceFromOrder(order) {
  const product = order?.productId && typeof order.productId === 'object' ? order.productId : {};
  return {
    productName: String(product.product_name || order?.productName || '').trim(),
    capacity: String(product.capacity || '').trim(),
    brand: String(product.brand || '').trim(),
  };
}

/** Match shop inventory lines by phone name + capacity (any color). */
function productMatchesNameCapacity(product, ref) {
  if (!product || !ref?.productName) return false;
  return (
    normalizeProductName(product.product_name) === normalizeProductName(ref.productName)
    && normalizeCapacity(product.capacity) === normalizeCapacity(ref.capacity)
  );
}

function warehouseLabel(product) {
  const wh = product?.currentWarehouse;
  if (wh && typeof wh === 'object') {
    const kind = String(wh.type || '').toLowerCase() === 'main' ? 'Warehouse' : 'Shop';
    const city = String(wh.city || '').trim();
    const name = String(wh.name || '').trim();
    if (name && city) return `${name} (${kind}) · ${city}`;
    if (name) return `${name} (${kind})`;
    if (city) return `${city} (${kind})`;
  }
  const city = String(product?.phoneLocation || '').trim();
  return city || 'Other';
}

function warehouseKey(product) {
  const wh = product?.currentWarehouse;
  if (wh && typeof wh === 'object') return String(wh._id ?? wh.id ?? '');
  return String(product?.phoneLocation || 'other').trim().toLowerCase();
}

function unitCountForProduct(product) {
  const imeCount = normalizedImeList(product).length;
  if (imeCount > 0) return imeCount;
  return Math.max(0, Number(product?.stock) || 0);
}

function buildImeOptions(products = []) {
  const options = [];
  for (const product of products) {
    const productId = String(product?._id ?? product?.id ?? '');
    for (const ime of normalizedImeList(product)) {
      options.push({
        ime,
        productId,
        productName: product?.product_name || '',
        brand: product?.brand || '',
        capacity: product?.capacity || '',
        color: product?.color || '',
      });
    }
  }
  return options;
}

function summarizeAvailabilityElsewhere(products = [], shopWarehouseId, ref) {
  const shopId = String(shopWarehouseId || '').trim();
  const byLocation = new Map();

  for (const product of products) {
    if (!productMatchesNameCapacity(product, ref)) continue;
    const key = warehouseKey(product);
    const whId =
      product?.currentWarehouse && typeof product.currentWarehouse === 'object'
        ? String(product.currentWarehouse._id ?? product.currentWarehouse.id ?? '')
        : key;
    if (shopId && whId === shopId) continue;

    const units = unitCountForProduct(product);
    if (units <= 0) continue;

    const label = warehouseLabel(product);
    const existing = byLocation.get(key) || {
      key,
      warehouseId: whId || null,
      label,
      city:
        (product?.currentWarehouse && typeof product.currentWarehouse === 'object'
          ? product.currentWarehouse.city
          : product?.phoneLocation) || '',
      kind:
        product?.currentWarehouse && typeof product.currentWarehouse === 'object'
          ? product.currentWarehouse.type
          : 'unknown',
      availableUnits: 0,
      availableImes: 0,
    };
    existing.availableUnits += units;
    existing.availableImes += normalizedImeList(product).length;
    byLocation.set(key, existing);
  }

  return [...byLocation.values()].sort((a, b) => b.availableUnits - a.availableUnits);
}

function buildVendorFulfillmentPreview({ order, shopProducts = [], platformProducts = [], shopId }) {
  const ref = orderReferenceFromOrder(order);
  const qty = Math.max(1, Number(order?.quantity) || 1);
  const matchingLines = (Array.isArray(shopProducts) ? shopProducts : []).filter((row) =>
    productMatchesNameCapacity(row, ref),
  );
  const imeOptions = buildImeOptions(matchingLines);
  const shopAvailableImes = imeOptions.length;
  const shopStockUnits = matchingLines.reduce((sum, row) => sum + unitCountForProduct(row), 0);
  const tracksImes = shopAvailableImes > 0;
  const requiresImeAssignment = tracksImes;
  const canFulfillFromShop = tracksImes ? shopAvailableImes >= qty : shopStockUnits >= qty;

  return {
    orderReference: ref,
    quantity: qty,
    matchingLineCount: matchingLines.length,
    matchingLines: matchingLines.map((row) => ({
      _id: row._id,
      product_name: row.product_name,
      brand: row.brand,
      capacity: row.capacity,
      color: row.color,
      stock: Number(row.stock) || 0,
      imeCount: normalizedImeList(row).length,
    })),
    imeOptions,
    shopAvailableImes,
    shopStockUnits,
    tracksImes,
    requiresImeAssignment,
    canFulfillFromShop,
    shortage: tracksImes ? Math.max(0, qty - shopAvailableImes) : Math.max(0, qty - shopStockUnits),
    availabilityElsewhere: summarizeAvailabilityElsewhere(platformProducts, shopId, ref),
    productFoundInShop: matchingLines.length > 0,
  };
}

async function loadRegionalInventoryProducts(excludeUsa = true) {
  const warehouses = await Warehouse.find({ isActive: true }).select('_id city type name').lean();
  const warehouseIds = warehouses
    .filter((w) => !(excludeUsa && String(w.city || '').trim().toUpperCase() === 'USA'))
    .map((w) => w._id);

  if (!warehouseIds.length) return [];

  return Product.find({
    currentWarehouse: { $in: warehouseIds },
    shipmentStatus: { $ne: 'travelling' },
  })
    .select(
      'product_name brand capacity color stock shipmentStatus IME imeCodes currentWarehouse phoneLocation',
    )
    .populate({ path: 'currentWarehouse', select: 'name city type' })
    .lean();
}

module.exports = {
  normalizeProductName,
  normalizeCapacity,
  orderReferenceFromOrder,
  productMatchesNameCapacity,
  buildImeOptions,
  buildVendorFulfillmentPreview,
  loadRegionalInventoryProducts,
  unitCountForProduct,
};
