const mongoose = require('mongoose');
const Product = require('../models/ItemsList');
const { productLineUnitCountExpr } = require('./productIme');

function toWarehouseObjectId(warehouseId) {
  return warehouseId instanceof mongoose.Types.ObjectId
    ? warehouseId
    : new mongoose.Types.ObjectId(String(warehouseId));
}

async function safeAggregateStat(label, fn, fallback = 0) {
  try {
    return await fn();
  } catch (err) {
    console.error(`warehouseInventoryStats (${label}):`, err);
    return fallback;
  }
}

/** Sum physical units for products matching filter (IME count when registered, else stock). */
async function sumUnitsAtWarehouse(warehouseId, extraMatch = {}) {
  const whObjectId = toWarehouseObjectId(warehouseId);

  const [row] = await Product.aggregate([
    { $match: { currentWarehouse: whObjectId, ...extraMatch } },
    { $addFields: { unitCount: productLineUnitCountExpr() } },
    { $match: { unitCount: { $gt: 0 } } },
    { $group: { _id: null, totalUnits: { $sum: '$unitCount' } } },
  ]);

  return Number(row?.totalUnits) || 0;
}

/** On-hand units at a location (excludes in-transit lines). */
async function sumAvailableUnitsAtWarehouse(warehouseId) {
  return safeAggregateStat('sumAvailableUnitsAtWarehouse', () =>
    sumUnitsAtWarehouse(warehouseId, { shipmentStatus: { $ne: 'travelling' } }),
  );
}

/** Units on arrived stock that can be sent to another shop or warehouse. */
async function sumReadyToTransferUnitsAtWarehouse(warehouseId) {
  return safeAggregateStat('sumReadyToTransferUnitsAtWarehouse', () =>
    sumUnitsAtWarehouse(warehouseId, {
      shipmentStatus: 'arrived',
      stock: { $gt: 0 },
    }),
  );
}

/** Distinct product names with on-hand units at a location (excludes in-transit). */
async function countOnHandProductNamesAtWarehouse(warehouseId) {
  return safeAggregateStat('countOnHandProductNamesAtWarehouse', async () => {
    const whObjectId = toWarehouseObjectId(warehouseId);

    const rows = await Product.aggregate([
      { $match: { currentWarehouse: whObjectId, shipmentStatus: { $ne: 'travelling' } } },
      { $addFields: { unitCount: productLineUnitCountExpr() } },
      { $match: { unitCount: { $gt: 0 } } },
      {
        $group: {
          _id: {
            $toLower: {
              $trim: {
                input: {
                  $convert: {
                    input: { $ifNull: ['$product_name', ''] },
                    to: 'string',
                    onError: '',
                    onNull: '',
                  },
                },
              },
            },
          },
        },
      },
      { $match: { _id: { $nin: ['', null] } } },
      { $count: 'names' },
    ]);

    return Number(rows[0]?.names) || 0;
  });
}

module.exports = {
  sumAvailableUnitsAtWarehouse,
  sumReadyToTransferUnitsAtWarehouse,
  countOnHandProductNamesAtWarehouse,
};
