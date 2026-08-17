const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');

/** Shared warehouse refs for product list/detail responses. */
const WAREHOUSE_POPULATE = [
  { path: 'currentWarehouse', select: 'name type city address' },
  { path: 'destinationSubWarehouse', select: 'name type city address' },
  { path: 'destinationMainWarehouse', select: 'name type city address' },
  { path: 'originWarehouse', select: 'name type city address', strictPopulate: false },
];

function warehouseId(ref) {
  if (!ref) return null;
  if (typeof ref === 'object') return ref._id || ref.id || null;
  return ref;
}

/** Last warehouse stock was at before the current in-transit leg (legacy rows missing originWarehouse). */
function inferOriginWarehouseId(product) {
  const explicit = warehouseId(product?.originWarehouse);
  if (explicit) return explicit;

  const history = Array.isArray(product?.locationHistory) ? product.locationHistory : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (String(entry?.status || '').toLowerCase() === 'travelling') {
      for (let j = i - 1; j >= 0; j -= 1) {
        const prev = history[j];
        if (prev?.warehouse) return prev.warehouse;
      }
      break;
    }
    if (entry?.warehouse) return entry.warehouse;
  }

  return null;
}

function needsOriginResolve(product) {
  if (String(product?.shipmentStatus || '').toLowerCase() !== 'travelling') return false;
  const origin = product?.originWarehouse;
  if (!origin) return true;
  if (typeof origin === 'object' && String(origin.name || '').trim()) return false;
  return true;
}

/**
 * Populate originWarehouse with the main warehouse the product left from (name, city, type).
 */
async function attachResolvedOriginWarehouses(products) {
  const docs = Array.isArray(products) ? products : [products];
  const idSet = new Set();

  docs.forEach((product) => {
    if (!needsOriginResolve(product)) return;
    const id = inferOriginWarehouseId(product);
    if (id) idSet.add(String(id));
  });

  if (!idSet.size) return products;

  const rows = await Warehouse.find({ _id: { $in: [...idSet] } })
    .select('name type city address')
    .lean();

  const byId = new Map(rows.map((row) => [String(row._id), row]));

  docs.forEach((product) => {
    if (!needsOriginResolve(product)) return;
    const id = inferOriginWarehouseId(product);
    const resolved = id ? byId.get(String(id)) : null;
    if (!resolved) return;
    if (resolved.type !== WAREHOUSE_TYPES.MAIN && product?.originWarehouse) return;
    product.originWarehouse = resolved;
  });

  return products;
}

module.exports = {
  WAREHOUSE_POPULATE,
  inferOriginWarehouseId,
  attachResolvedOriginWarehouses,
};
