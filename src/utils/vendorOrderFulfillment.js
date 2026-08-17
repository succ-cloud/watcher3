const Product = require('../models/ItemsList');
const { SoldIme, SOLD_IME_STATUS } = require('../models/SoldIme');
const {
  normalizedImeList,
  applyImeFields,
  buildImeManifestLines,
} = require('./productIme');
const {
  productMatchesNameCapacity,
  orderReferenceFromOrder,
  buildImeOptions,
} = require('./vendorOrderInventoryMatch');

function normField(value) {
  return String(value || '').trim().toLowerCase();
}

function productsMatchAtShop(candidate, reference) {
  if (!candidate || !reference) return false;
  if (productMatchesNameCapacity(candidate, reference)) return true;
  return (
    normField(candidate.product_name) === normField(reference.product_name)
    && normField(candidate.brand) === normField(reference.brand)
    && normField(candidate.capacity) === normField(reference.capacity)
    && normField(candidate.color || 'standard') === normField(reference.color || 'standard')
  );
}

function effectiveUnitCount(product) {
  const imeCount = normalizedImeList(product).length;
  if (imeCount > 0) return imeCount;
  return Math.max(0, Number(product?.stock) || 0);
}

async function loadShopProductsForOrder(shopId) {
  const warehouseId = String(shopId || '').trim();
  if (!warehouseId) return [];
  return Product.find({
    currentWarehouse: warehouseId,
    shipmentStatus: { $ne: 'travelling' },
  }).select(
    'product_name brand product_type capacity color stock price shipmentStatus IME imeCodes currentWarehouse bulkBatchCode',
  );
}

async function findShopMatchesForOrder(shopId, order) {
  const ref = orderReferenceFromOrder(order);
  const rows = await loadShopProductsForOrder(shopId);
  return rows.filter((row) => productMatchesNameCapacity(row, ref));
}

/** Pick inventory row at the assigned shop for vendor fulfillment. */
async function resolveFulfillmentShopProduct({ shopId, referenceProduct, order, quantity = 1 }) {
  const warehouseId = String(shopId || '').trim();
  if (!warehouseId) return null;

  const qty = Math.max(1, Number(quantity) || 1);
  let matches = [];

  if (order) {
    matches = await findShopMatchesForOrder(warehouseId, order);
  }

  if (!matches.length && referenceProduct) {
    const rows = await loadShopProductsForOrder(warehouseId);
    matches = rows.filter((row) => productsMatchAtShop(row, referenceProduct));
  }

  if (!matches.length) return null;

  matches.sort((a, b) => {
    const unitsA = effectiveUnitCount(a);
    const unitsB = effectiveUnitCount(b);
    const okA = unitsA >= qty ? 1 : 0;
    const okB = unitsB >= qty ? 1 : 0;
    if (okB !== okA) return okB - okA;
    return unitsB - unitsA;
  });

  return matches[0];
}

function productRequiresImeSelection(product) {
  return normalizedImeList(product).length > 0;
}

function shopRequiresImeSelectionForOrder(matchingLines = []) {
  return buildImeOptions(matchingLines).length > 0;
}

function assertVendorOrderImeSelectionForShop(matchingLines, imeCodes, quantity, orderRef) {
  const options = buildImeOptions(matchingLines);
  if (!options.length) {
    return { required: false, taken: [], productsTouched: [] };
  }

  const qty = Math.max(1, Number(quantity) || 1);
  const codes = [...new Set((Array.isArray(imeCodes) ? imeCodes : [])
    .map((code) => String(code || '').trim())
    .filter(Boolean))];

  if (codes.length !== qty) {
    const err = new Error(
      `Select exactly ${qty} IME code(s) for ${orderRef?.productName || 'this product'}.`,
    );
    err.statusCode = 400;
    throw err;
  }

  const optionMap = new Map(options.map((row) => [row.ime, row]));
  for (const code of codes) {
    if (!optionMap.has(code)) {
      const err = new Error(`IME ${code} is not available in this shop for the ordered model.`);
      err.statusCode = 400;
      throw err;
    }
  }

  if (options.length < qty) {
    const err = new Error(
      `This shop only has ${options.length} available IME(s) for ${orderRef?.productName || 'this product'}, but the order requires ${qty}. Request stock from a warehouse.`,
    );
    err.statusCode = 400;
    throw err;
  }

  return { required: true, taken: codes, productsTouched: matchingLines };
}

function assertVendorOrderImeSelection(product, imeCodes, quantity) {
  const registered = normalizedImeList(product);
  if (!registered.length) {
    return { required: false, taken: [] };
  }

  const qty = Math.max(1, Number(quantity) || 1);
  const codes = [...new Set((Array.isArray(imeCodes) ? imeCodes : [])
    .map((code) => String(code || '').trim())
    .filter(Boolean))];

  if (codes.length !== qty) {
    const err = new Error(
      `Select exactly ${qty} IME code(s) for ${product?.product_name || 'this product'}.`,
    );
    err.statusCode = 400;
    throw err;
  }

  for (const code of codes) {
    if (!registered.includes(code)) {
      const err = new Error(`IME ${code} is not available on ${product?.product_name || 'this product'}.`);
      err.statusCode = 400;
      throw err;
    }
  }

  return { required: true, taken: codes };
}

function resolveVendorOrderUnitPrices(order, product, { listedUnitPrice, soldUnitPrice } = {}) {
  const qty = Math.max(1, Number(order?.quantity) || 1);
  const listed =
    Number(listedUnitPrice) > 0
      ? Number(listedUnitPrice)
      : Number(order?.productPrice) > 0
        ? Number(order.productPrice)
        : Number(product?.price) > 0
          ? Number(product.price)
          : 0;
  const sold =
    Number(soldUnitPrice) > 0
      ? Number(soldUnitPrice)
      : Number(order?.finalPrice) > 0
        ? Number(order.finalPrice) / qty
        : listed;
  return { listedPrice: listed, unitPrice: sold };
}

async function applyVendorOrderImeFulfillment({
  order,
  product,
  matchingLines,
  staff,
  imeCodes,
  listedUnitPrice,
  soldUnitPrice,
  session = null,
}) {
  const qty = Math.max(1, Number(order?.quantity) || 1);
  const shopLines = Array.isArray(matchingLines) ? matchingLines : product ? [product] : [];
  const ref = orderReferenceFromOrder(order);
  const { listedPrice, unitPrice } = resolveVendorOrderUnitPrices(order, product, {
    listedUnitPrice,
    soldUnitPrice,
  });

  if (shopRequiresImeSelectionForOrder(shopLines)) {
    const { required, taken } = assertVendorOrderImeSelectionForShop(shopLines, imeCodes, qty, ref);
    if (!required) {
      return { manifest: [], soldImeCodes: [] };
    }

    const assignment =
      order?.directSale && typeof order.directSale === 'object' ? order.directSale : {};

    const manifest = [];
    const byProductId = new Map();

    for (const code of taken) {
      const line = shopLines.find((row) => normalizedImeList(row).includes(code));
      if (!line) continue;
      const key = String(line._id);
      if (!byProductId.has(key)) byProductId.set(key, { product: line, codes: [] });
      byProductId.get(key).codes.push(code);
    }

    for (const { product: row, codes } of byProductId.values()) {
      const fresh = session
        ? await Product.findById(row._id).session(session)
        : await Product.findById(row._id);
      if (!fresh) continue;
      const remaining = normalizedImeList(fresh).filter((code) => !codes.includes(code));
      applyImeFields(fresh, remaining);
      await fresh.save({ session });
      manifest.push(
        ...buildImeManifestLines(fresh, codes).map((entry) => ({
          ...entry,
          productId: fresh._id,
          unitPrice,
        })),
      );
    }

    const soldRows = manifest.map((line) => ({
      ime: line.ime,
      productId: line.productId || shopLines[0]?._id,
      buyerUserId: order.userId,
      handledBy: staff._id,
      customerName: String(order?.businessName || '').trim(),
      saleType: 'wholesale',
      paymentMethod: 'cash',
      status: SOLD_IME_STATUS.SOLD_OUT,
      productName: line.productName || ref?.productName || '',
      brand: line.brand || '',
      capacity: line.capacity || '',
      color: line.color || '',
      bulkBatchCode: line.bulkBatchCode || null,
      listedPrice,
      unitPrice,
      assignedWarehouseId: assignment.assignedWarehouseId || null,
      assignedWarehouseName: assignment.assignedWarehouseName || '',
      soldAt: new Date(),
    }));

    if (soldRows.length) {
      await SoldIme.insertMany(soldRows, { session });
    }

    return { manifest, soldImeCodes: taken };
  }

  if (!product) {
    return { manifest: [], soldImeCodes: [] };
  }

  const { required, taken } = assertVendorOrderImeSelection(product, imeCodes, qty);
  if (!required) {
    return { manifest: [], soldImeCodes: [] };
  }

  const remaining = normalizedImeList(product).filter((code) => !taken.includes(code));
  applyImeFields(product, remaining);
  await product.save({ session });

  const manifest = buildImeManifestLines(product, taken).map((line) => ({
    ...line,
    listedPrice,
    unitPrice,
  }));

  const assignment =
    order?.directSale && typeof order.directSale === 'object' ? order.directSale : {};

  const soldRows = manifest.map((line) => ({
    ime: line.ime,
    productId: product._id,
    buyerUserId: order.userId,
    handledBy: staff._id,
    customerName: String(order?.businessName || '').trim(),
    saleType: 'wholesale',
    paymentMethod: 'cash',
    status: SOLD_IME_STATUS.SOLD_OUT,
    productName: line.productName || product.product_name,
    brand: line.brand || product.brand || '',
    capacity: line.capacity || product.capacity || '',
    color: line.color || product.color || '',
    bulkBatchCode: line.bulkBatchCode || null,
    listedPrice,
    unitPrice,
    assignedWarehouseId: assignment.assignedWarehouseId || null,
    assignedWarehouseName: assignment.assignedWarehouseName || '',
    soldAt: new Date(),
  }));

  if (soldRows.length) {
    await SoldIme.insertMany(soldRows, { session });
  }

  return { manifest, soldImeCodes: taken };
}

module.exports = {
  productsMatchAtShop,
  findShopMatchesForOrder,
  loadShopProductsForOrder,
  resolveFulfillmentShopProduct,
  productRequiresImeSelection,
  shopRequiresImeSelectionForOrder,
  assertVendorOrderImeSelection,
  assertVendorOrderImeSelectionForShop,
  applyVendorOrderImeFulfillment,
};
