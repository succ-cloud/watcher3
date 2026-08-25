const Product = require('../models/ItemsList');
const { resolveProductPhoneLocationForWarehouse } = require('./normalizeProductPhoneLocation');
const { applyImeFields, normalizedImeList, splitImeCodes, takeSpecificImeCodes } = require('./productIme');

/**
 * Confirm receipt at the product's current warehouse (e.g. bulk landed at main).
 * Keeps currentWarehouse unchanged; only shipmentStatus becomes arrived.
 */
async function applyProductReceivedAtWarehouse(product, warehouse, userId, note) {
  if (product.shipmentStatus === 'arrived') {
    return product;
  }

  const whId = warehouse._id || warehouse.id;
  if (String(product.currentWarehouse) !== String(whId)) {
    const err = new Error('Product is not at this warehouse.');
    err.statusCode = 400;
    throw err;
  }

  product.shipmentStatus = 'arrived';
  product.arrivedAt = new Date();
  product.originWarehouse = null;
  if (userId) product.updatedBy = userId;

  if (!Array.isArray(product.locationHistory)) product.locationHistory = [];
  product.locationHistory.push({
    warehouse: whId,
    status: 'arrived',
    movedAt: new Date(),
    movedBy: userId || null,
    note: note || `Received at ${warehouse.name}`,
  });

  await product.save();
  return product;
}

/**
 * Mark a product document as arrived at a sub-warehouse (shop region).
 * Mutates and saves the product.
 */
async function applyProductArrival(product, subWarehouse, userId, note) {
  product.currentWarehouse = subWarehouse._id;
  product.shipmentStatus = 'arrived';
  product.arrivedAt = new Date();
  product.originWarehouse = null;
  const location = resolveProductPhoneLocationForWarehouse(subWarehouse);
  if (location) {
    product.phoneLocation = location;
  }
  if (userId) product.updatedBy = userId;

  if (!Array.isArray(product.locationHistory)) product.locationHistory = [];
  product.locationHistory.push({
    warehouse: subWarehouse._id,
    status: 'arrived',
    movedAt: new Date(),
    movedBy: userId || null,
    note: note || `Arrived at ${subWarehouse.name}`,
  });

  await product.save();
  return product;
}

/**
 * Send stock from a main warehouse to a shop — in transit until the shop marks it received.
 */
async function applyProductSentToShop(product, subWarehouse, userId, note, originWarehouseId) {
  const subId = subWarehouse._id || subWarehouse.id;
  const originId = originWarehouseId || product.currentWarehouse;
  if (originId) product.originWarehouse = originId;
  product.currentWarehouse = subId;
  product.destinationSubWarehouse = subId;
  product.shipmentStatus = 'travelling';
  product.arrivedAt = null;
  if (userId) product.updatedBy = userId;

  if (!Array.isArray(product.locationHistory)) product.locationHistory = [];
  product.locationHistory.push({
    warehouse: subId,
    status: 'travelling',
    movedAt: new Date(),
    movedBy: userId || null,
    note: note || `Sent to ${subWarehouse.name}`,
  });

  await product.save();
  return product;
}

/**
 * Move a quantity of units from a product at the main warehouse to a shop.
 * If quantity equals all stock, moves the whole document; otherwise splits stock.
 * Stock stays travelling at the shop until marked received.
 */
async function transferProductQuantityToShop(product, subWarehouse, userId, quantity, note) {
  const qty = Math.max(1, parseInt(quantity, 10) || 0);
  const available = Math.max(0, Number(product.stock) || 0);
  if (!qty || qty > available) {
    const err = new Error(`Invalid quantity. Only ${available} unit(s) available on this product line.`);
    err.statusCode = 400;
    throw err;
  }

  const subId = subWarehouse._id || subWarehouse.id;
  const transferNote = note || `Sent ${qty} unit(s) to ${subWarehouse.name}`;
  const { taken, remaining } = splitImeCodes(product, qty);

  if (qty === available) {
    product.destinationSubWarehouse = subId;
    const transferredImes = normalizedImeList(product);
    const originId = product.currentWarehouse;
    await applyProductSentToShop(product, subWarehouse, userId, transferNote, originId);
    return { product, transferredImes };
  }

  applyImeFields(product, remaining);
  product.stock = available - qty;
  if (userId) product.updatedBy = userId;
  await product.save();

  const matchFilter = {
    product_name: product.product_name,
    brand: product.brand,
    capacity: product.capacity,
    color: product.color,
    currentWarehouse: subId,
    shipmentStatus: 'travelling',
    destinationSubWarehouse: subId,
    bulkBatchCode: product.bulkBatchCode || null,
  };

  let dest = await Product.findOne(matchFilter);
  if (dest) {
    dest.stock = (Number(dest.stock) || 0) + qty;
    dest.destinationSubWarehouse = subId;
    if (!dest.originWarehouse && product.currentWarehouse) {
      dest.originWarehouse = product.currentWarehouse;
    }
    if (userId) dest.updatedBy = userId;
    if (!Array.isArray(dest.locationHistory)) dest.locationHistory = [];
    dest.locationHistory.push({
      warehouse: subId,
      status: 'travelling',
      movedAt: new Date(),
      movedBy: userId || null,
      note: transferNote,
    });
    applyImeFields(dest, [...normalizedImeList(dest), ...taken]);
    await dest.save();
    return { product: dest, transferredImes: taken };
  }

  const clone = product.toObject();
  delete clone._id;
  delete clone.__v;
  clone.stock = qty;
  clone.currentWarehouse = subId;
  clone.destinationSubWarehouse = subId;
  clone.originWarehouse = product.currentWarehouse;
  clone.shipmentStatus = 'travelling';
  clone.arrivedAt = null;
  clone.locationHistory = [
    {
      warehouse: subId,
      status: 'travelling',
      movedAt: new Date(),
      movedBy: userId || null,
      note: transferNote,
    },
  ];
  if (userId) clone.updatedBy = userId;
  applyImeFields(clone, taken);

  const created = await Product.create(clone);
  return { product: created, transferredImes: taken };
}

/**
 * Move specific IME units from a product at the main warehouse to a shop.
 */
async function transferProductImesToShop(product, subWarehouse, userId, selectedImes, note) {
  const { taken, remaining } = takeSpecificImeCodes(product, selectedImes);
  const qty = taken.length;
  if (!qty) {
    const err = new Error('Select at least one IME to transfer.');
    err.statusCode = 400;
    throw err;
  }

  const available = Math.max(0, Number(product.stock) || 0);
  if (qty > available) {
    const err = new Error(`Invalid quantity. Only ${available} unit(s) available on this product line.`);
    err.statusCode = 400;
    throw err;
  }

  const subId = subWarehouse._id || subWarehouse.id;
  const transferNote = note || `Sent ${qty} unit(s) to ${subWarehouse.name}`;

  if (qty === available && remaining.length === 0) {
    product.destinationSubWarehouse = subId;
    const transferredImes = normalizedImeList(product);
    const originId = product.currentWarehouse;
    await applyProductSentToShop(product, subWarehouse, userId, transferNote, originId);
    return { product, transferredImes };
  }

  applyImeFields(product, remaining);
  product.stock = available - qty;
  if (userId) product.updatedBy = userId;
  await product.save();

  const matchFilter = {
    product_name: product.product_name,
    brand: product.brand,
    capacity: product.capacity,
    color: product.color,
    currentWarehouse: subId,
    shipmentStatus: 'travelling',
    destinationSubWarehouse: subId,
    bulkBatchCode: product.bulkBatchCode || null,
  };

  let dest = await Product.findOne(matchFilter);
  if (dest) {
    dest.stock = (Number(dest.stock) || 0) + qty;
    dest.destinationSubWarehouse = subId;
    if (!dest.originWarehouse && product.currentWarehouse) {
      dest.originWarehouse = product.currentWarehouse;
    }
    if (userId) dest.updatedBy = userId;
    if (!Array.isArray(dest.locationHistory)) dest.locationHistory = [];
    dest.locationHistory.push({
      warehouse: subId,
      status: 'travelling',
      movedAt: new Date(),
      movedBy: userId || null,
      note: transferNote,
    });
    applyImeFields(dest, [...normalizedImeList(dest), ...taken]);
    await dest.save();
    return { product: dest, transferredImes: taken };
  }

  const clone = product.toObject();
  delete clone._id;
  delete clone.__v;
  clone.stock = qty;
  clone.currentWarehouse = subId;
  clone.destinationSubWarehouse = subId;
  clone.originWarehouse = product.currentWarehouse;
  clone.shipmentStatus = 'travelling';
  clone.arrivedAt = null;
  clone.locationHistory = [
    {
      warehouse: subId,
      status: 'travelling',
      movedAt: new Date(),
      movedBy: userId || null,
      note: transferNote,
    },
  ];
  if (userId) clone.updatedBy = userId;
  applyImeFields(clone, taken);

  const created = await Product.create(clone);
  return { product: created, transferredImes: taken };
}

/**
 * Move a quantity of units from a product at one main warehouse to another main warehouse.
 * Destination stock stays travelling until received at the destination main.
 */
async function transferProductQuantityToMainWarehouse(product, destMain, userId, quantity, note) {
  const qty = Math.max(1, parseInt(quantity, 10) || 0);
  const available = Math.max(0, Number(product.stock) || 0);
  if (!qty || qty > available) {
    const err = new Error(`Invalid quantity. Only ${available} unit(s) available on this product line.`);
    err.statusCode = 400;
    throw err;
  }

  const destId = destMain._id || destMain.id;
  const sourceId = product.currentWarehouse;
  const transferNote = note || `Sent ${qty} unit(s) to ${destMain.name}`;
  const { taken, remaining } = splitImeCodes(product, qty);

  if (qty === available) {
    product.originWarehouse = sourceId;
    product.currentWarehouse = destId;
    product.destinationMainWarehouse = destId;
    product.destinationSubWarehouse = null;
    product.shipmentStatus = 'travelling';
    product.arrivedAt = null;
    applyImeFields(product, taken);
    if (userId) product.updatedBy = userId;

    if (!Array.isArray(product.locationHistory)) product.locationHistory = [];
    product.locationHistory.push({
      warehouse: destId,
      status: 'travelling',
      movedAt: new Date(),
      movedBy: userId || null,
      note: transferNote,
    });

    await product.save();
    return { product, transferredImes: taken };
  }

  applyImeFields(product, remaining);
  product.stock = available - qty;
  if (userId) product.updatedBy = userId;
  await product.save();

  const matchFilter = {
    product_name: product.product_name,
    brand: product.brand,
    capacity: product.capacity,
    color: product.color,
    currentWarehouse: destId,
    shipmentStatus: 'travelling',
    destinationMainWarehouse: destId,
    bulkBatchCode: product.bulkBatchCode || null,
  };

  let dest = await Product.findOne(matchFilter);
  if (dest) {
    dest.stock = (Number(dest.stock) || 0) + qty;
    if (!dest.originWarehouse && sourceId) dest.originWarehouse = sourceId;
    if (userId) dest.updatedBy = userId;
    if (!Array.isArray(dest.locationHistory)) dest.locationHistory = [];
    dest.locationHistory.push({
      warehouse: destId,
      status: 'travelling',
      movedAt: new Date(),
      movedBy: userId || null,
      note: transferNote,
    });
    applyImeFields(dest, [...normalizedImeList(dest), ...taken]);
    await dest.save();
    return { product: dest, transferredImes: taken };
  }

  const clone = product.toObject();
  delete clone._id;
  delete clone.__v;
  clone.stock = qty;
  clone.currentWarehouse = destId;
  clone.destinationMainWarehouse = destId;
  clone.originWarehouse = sourceId;
  clone.destinationSubWarehouse = null;
  clone.shipmentStatus = 'travelling';
  clone.arrivedAt = null;
  clone.locationHistory = [
    {
      warehouse: destId,
      status: 'travelling',
      movedAt: new Date(),
      movedBy: userId || null,
      note: transferNote,
    },
  ];
  if (userId) clone.updatedBy = userId;
  applyImeFields(clone, taken);

  const created = await Product.create(clone);
  return { product: created, transferredImes: taken };
}

/**
 * Move specific IME units from a product line to another main warehouse.
 */
async function transferProductImesToMainWarehouse(product, destMain, userId, selectedImes, note) {
  const { taken, remaining } = takeSpecificImeCodes(product, selectedImes);
  const qty = taken.length;
  if (!qty) {
    const err = new Error('Select at least one IME to transfer.');
    err.statusCode = 400;
    throw err;
  }

  const available = Math.max(0, Number(product.stock) || 0);
  if (qty > available) {
    const err = new Error(`Invalid quantity. Only ${available} unit(s) available on this product line.`);
    err.statusCode = 400;
    throw err;
  }

  const destId = destMain._id || destMain.id;
  const sourceId = product.currentWarehouse;
  const transferNote = note || `Sent ${qty} unit(s) to ${destMain.name}`;

  if (qty === available && remaining.length === 0) {
    product.originWarehouse = sourceId;
    product.currentWarehouse = destId;
    product.destinationMainWarehouse = destId;
    product.destinationSubWarehouse = null;
    product.shipmentStatus = 'travelling';
    product.arrivedAt = null;
    applyImeFields(product, taken);
    if (userId) product.updatedBy = userId;
    if (!Array.isArray(product.locationHistory)) product.locationHistory = [];
    product.locationHistory.push({
      warehouse: destId,
      status: 'travelling',
      movedAt: new Date(),
      movedBy: userId || null,
      note: transferNote,
    });
    await product.save();
    return { product, transferredImes: taken };
  }

  applyImeFields(product, remaining);
  product.stock = available - qty;
  if (userId) product.updatedBy = userId;
  await product.save();

  const matchFilter = {
    product_name: product.product_name,
    brand: product.brand,
    capacity: product.capacity,
    color: product.color,
    currentWarehouse: destId,
    shipmentStatus: 'travelling',
    destinationMainWarehouse: destId,
    bulkBatchCode: product.bulkBatchCode || null,
  };

  let dest = await Product.findOne(matchFilter);
  if (dest) {
    dest.stock = (Number(dest.stock) || 0) + qty;
    if (!dest.originWarehouse && sourceId) dest.originWarehouse = sourceId;
    if (userId) dest.updatedBy = userId;
    if (!Array.isArray(dest.locationHistory)) dest.locationHistory = [];
    dest.locationHistory.push({
      warehouse: destId,
      status: 'travelling',
      movedAt: new Date(),
      movedBy: userId || null,
      note: transferNote,
    });
    applyImeFields(dest, [...normalizedImeList(dest), ...taken]);
    await dest.save();
    return { product: dest, transferredImes: taken };
  }

  const clone = product.toObject();
  delete clone._id;
  delete clone.__v;
  clone.stock = qty;
  clone.currentWarehouse = destId;
  clone.destinationMainWarehouse = destId;
  clone.originWarehouse = sourceId;
  clone.destinationSubWarehouse = null;
  clone.shipmentStatus = 'travelling';
  clone.arrivedAt = null;
  clone.locationHistory = [
    {
      warehouse: destId,
      status: 'travelling',
      movedAt: new Date(),
      movedBy: userId || null,
      note: transferNote,
    },
  ];
  if (userId) clone.updatedBy = userId;
  applyImeFields(clone, taken);

  const created = await Product.create(clone);
  return { product: created, transferredImes: taken };
}

module.exports = {
  applyProductArrival,
  applyProductReceivedAtWarehouse,
  applyProductSentToShop,
  transferProductQuantityToShop,
  transferProductImesToShop,
  transferProductQuantityToMainWarehouse,
  transferProductImesToMainWarehouse,
};
