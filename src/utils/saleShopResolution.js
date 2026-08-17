const { Order } = require('../models/Order');
const Product = require('../models/ItemsList');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');

async function loadOrderForReport(orderId, orderCache) {
  const id = String(orderId || '').trim();
  if (!id) return null;
  if (orderCache.has(id)) return orderCache.get(id);
  const order = await Order.findById(id)
    .select('productPrice finalPrice quantity directSale')
    .lean();
  if (order) orderCache.set(id, order);
  return order;
}

async function resolveUnitPriceFromOrder(soldRow, orderCache) {
  const direct = Number(soldRow?.unitPrice);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const order = await loadOrderForReport(soldRow?.orderId, orderCache);
  if (!order) return 0;

  const qty = Math.max(1, Number(order.quantity) || 1);
  const lineTotal = Number(order.finalPrice ?? order.productPrice ?? 0);
  if (lineTotal > 0 && qty > 0) return Math.round(lineTotal / qty);
  return Number(order.productPrice) || 0;
}

function shopRefFromAssignment(assignment) {
  if (!assignment || typeof assignment !== 'object') {
    return { shopId: '', shopName: '' };
  }
  const shopId = assignment.assignedWarehouseId ? String(assignment.assignedWarehouseId) : '';
  const shopName = assignment.assignedWarehouseName || '';
  if (!shopId && !shopName) return { shopId: '', shopName: '' };
  return { shopId, shopName: shopName || 'Shop' };
}

async function resolveShopFromOrder(soldRow, orderCache) {
  const fromSold = shopRefFromAssignment({
    assignedWarehouseId: soldRow?.assignedWarehouseId,
    assignedWarehouseName: soldRow?.assignedWarehouseName,
  });
  if (fromSold.shopId) return fromSold;

  const order = await loadOrderForReport(soldRow?.orderId, orderCache);
  return shopRefFromAssignment(order?.directSale);
}

async function loadProductForReport(productId, productCache) {
  const id = String(productId || '').trim();
  if (!id) return null;
  if (productCache.has(id)) return productCache.get(id);
  const product = await Product.findById(id)
    .select('destinationSubWarehouse currentWarehouse')
    .populate('destinationSubWarehouse', 'name city type isActive')
    .populate('currentWarehouse', 'name city type isActive')
    .lean();
  productCache.set(id, product || null);
  return product;
}

function shopRefFromWarehouseDoc(warehouse) {
  if (!warehouse || warehouse.isActive === false) {
    return { shopId: '', shopName: '' };
  }
  return {
    shopId: String(warehouse._id),
    shopName: warehouse.name || 'Shop',
  };
}

async function resolveShopFromProduct(soldRow, productCache) {
  const product = await loadProductForReport(soldRow?.productId, productCache);
  if (!product) return { shopId: '', shopName: '' };

  const dest = product.destinationSubWarehouse;
  if (dest && String(dest.type || '') === WAREHOUSE_TYPES.SUB) {
    return shopRefFromWarehouseDoc(dest);
  }

  const current = product.currentWarehouse;
  if (current && String(current.type || '') === WAREHOUSE_TYPES.SUB) {
    return shopRefFromWarehouseDoc(current);
  }

  if (dest) return shopRefFromWarehouseDoc(dest);
  if (current) return shopRefFromWarehouseDoc(current);

  return { shopId: '', shopName: '' };
}

function resolveShopFromStaff(staffUser, shopDirectory) {
  const staffId = staffUser?._id
    ? String(staffUser._id)
    : staffUser?.id
      ? String(staffUser.id)
      : typeof staffUser === 'string'
        ? staffUser
        : '';
  if (!staffId) return { shopId: '', shopName: '' };

  const assigned = Array.isArray(staffUser?.assignedShops) ? staffUser.assignedShops : [];
  if (assigned.length !== 1) return { shopId: '', shopName: '' };

  const shopId = String(assigned[0]);
  const match = shopDirectory.find((s) => String(s.id) === shopId);
  return {
    shopId,
    shopName: match?.name || 'Shop',
  };
}

async function resolveSaleShop(soldRow, { orderCache, productCache, staffUsers, shopDirectory }) {
  if (soldRow?.assignedWarehouseId) {
    const shopId = String(soldRow.assignedWarehouseId);
    const match = shopDirectory.find((s) => String(s.id) === shopId);
    return {
      shopId,
      shopName: soldRow.assignedWarehouseName || match?.name || 'Shop',
    };
  }

  const fromOrder = await resolveShopFromOrder(soldRow, orderCache);
  if (fromOrder.shopId) return fromOrder;

  const fromProduct = await resolveShopFromProduct(soldRow, productCache);
  if (fromProduct.shopId) return fromProduct;

  const staff = soldRow.handledBy;
  const staffId = staff?._id ? String(staff._id) : soldRow.handledBy ? String(soldRow.handledBy) : '';
  const staffRecord =
    staff && typeof staff === 'object' && staff.assignedShops
      ? staff
      : staffUsers.find((u) => String(u._id) === staffId);
  return resolveShopFromStaff(staffRecord, shopDirectory);
}

module.exports = {
  loadOrderForReport,
  resolveUnitPriceFromOrder,
  resolveSaleShop,
};
