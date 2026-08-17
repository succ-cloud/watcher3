const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');

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
  if (!sub?.parentWarehouse) {
    return { sub: null, main: null };
  }
  const main = await Warehouse.findOne({
    _id: sub.parentWarehouse,
    type: WAREHOUSE_TYPES.MAIN,
    isActive: true,
  });
  return { sub, main };
}

module.exports = {
  getMainWarehouseById,
  resolveMainFromSubWarehouse,
};
