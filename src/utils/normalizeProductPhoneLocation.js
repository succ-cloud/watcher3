const { WAREHOUSE_TYPES } = require('../models/Warehouse');

/** Legacy spellings → canonical city keys used in older inventory rows */
const LEGACY_CITY_ALIASES = {
  yaounde: 'Yaounde',
};

/** Normalize a raw location label for ItemsList.phoneLocation (free-form string). */
function normalizeProductPhoneLocation(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  const lower = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (LEGACY_CITY_ALIASES[lower]) return LEGACY_CITY_ALIASES[lower];
  return s;
}

/**
 * Resolve phoneLocation when stock arrives at or is assigned to a warehouse/shop.
 * Shops use their registered name (e.g. "Buea B2"); main warehouses use city.
 */
function resolveProductPhoneLocationForWarehouse(warehouse) {
  if (!warehouse) return null;
  const name = String(warehouse.name || '').trim();
  if (warehouse.type === WAREHOUSE_TYPES.SUB && name) {
    return normalizeProductPhoneLocation(name);
  }
  const city = String(warehouse.city || '').trim();
  if (city) return normalizeProductPhoneLocation(city);
  return name || null;
}

module.exports = {
  normalizeProductPhoneLocation,
  resolveProductPhoneLocationForWarehouse,
};
