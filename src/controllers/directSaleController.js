const Product = require('../models/ItemsList');
const User = require('../models/User');
const Warehouse = require('../models/Warehouse');
const { Order, ORDER_TYPES, ORDER_STATUS, PRODUCT_SOURCE } = require('../models/Order');
const { SoldIme, SOLD_IME_STATUS } = require('../models/SoldIme');
const ROLES_LIST = require('../config/role_list');
const {
  normalizedImeList,
  splitImeCodes,
  applyImeFields,
  buildImeManifestLines,
} = require('../utils/productIme');
const {
  assertDirectSalePaymentMethod,
  normalizeDirectSalePaymentMethod,
} = require('../utils/directSalePaymentMethod');
const { runInTransaction } = require('../utils/mongoTransaction');
const { friendlySaleErrorMessage } = require('../utils/saleErrorMessage');
const { allocateOrderDisplayCode } = require('../utils/orderDisplayCode');

const DIRECT_SALE_TYPE = {
  RETAIL: 'retail',
  WHOLESALE: 'wholesale',
};

function resolveStaffUserId(req) {
  return String(req.userId || req.user?.userId || req.user?.id || req.user?._id || '').trim();
}

function resolveRequestedSaleType(req) {
  return String(req.body?.saleType || '').trim().toLowerCase();
}

function assertRequestedSaleType(req, expectedType) {
  const requested = resolveRequestedSaleType(req);
  if (!requested) return;
  if (requested === expectedType) return;
  const err = new Error(`Invalid saleType "${requested}" for this endpoint.`);
  err.status = 400;
  throw err;
}

function normalizeRequestedPaymentMethod(raw) {
  return normalizeDirectSalePaymentMethod(raw);
}

async function assertRequestedPaymentMethod(req) {
  return assertDirectSalePaymentMethod(req.body?.paymentMethod);
}

function assertStaffRole(user) {
  const role = String(user?.role || '').toLowerCase();
  if (role !== ROLES_LIST.ADMIN && role !== ROLES_LIST.SALESMAN) {
    const err = new Error('Only admins or salespeople can record direct sales.');
    err.status = 403;
    throw err;
  }
}

function deliveryAddressFromKey(key) {
  const city = String(key || 'Douala').trim();
  return `${city}, Cameroon`;
}

async function resolveAssignedWarehouse(warehouseId, session = null) {
  const id = String(warehouseId || '').trim();
  if (!id) return null;
  const q = Warehouse.findById(id).select('name city type isActive');
  if (session) q.session(session);
  const warehouse = await q;
  if (!warehouse || warehouse.isActive === false) {
    const err = new Error('Selected warehouse or shop not found.');
    err.status = 400;
    throw err;
  }
  return {
    _id: warehouse._id,
    name: warehouse.name,
    city: warehouse.city,
    type: warehouse.type,
  };
}

function directSaleAssignmentFields(assignedWarehouse) {
  if (!assignedWarehouse) return {};
  return {
    assignedWarehouseId: assignedWarehouse._id,
    assignedWarehouseName: assignedWarehouse.name,
    assignedWarehouseCity: assignedWarehouse.city || null,
    assignedWarehouseType: assignedWarehouse.type || null,
  };
}

/** Resolve shop/warehouse for a direct sale from request, staff assignment, or product location. */
async function resolveSaleAssignmentFields(body, productMap, staff, session = null) {
  let assignedWarehouseId = String(body?.assignedWarehouseId || '').trim();

  if (!assignedWarehouseId) {
    const assignedShops = Array.isArray(staff?.assignedShops) ? staff.assignedShops : [];
    if (assignedShops.length === 1) {
      assignedWarehouseId = String(assignedShops[0]);
    }
  }

  if (assignedWarehouseId) {
    const warehouse = await resolveAssignedWarehouse(assignedWarehouseId, session);
    return directSaleAssignmentFields(warehouse);
  }

  const seen = new Set();
  for (const product of productMap.values()) {
    const candidates = [product.destinationSubWarehouse, product.currentWarehouse].filter(Boolean);
    for (const candidateId of candidates) {
      const key = String(candidateId);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const warehouse = await resolveAssignedWarehouse(key, session);
        if (warehouse) return directSaleAssignmentFields(warehouse);
      } catch {
        /* try next candidate */
      }
    }
  }

  return {};
}

function resolveProductRetailUnitPrice(product) {
  const candidates = [product?.retailPrice, product?.price, product?.priceMax, product?.priceMin];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return resolveProductWholesaleUnitPrice(product);
}

function soldImeCreatePayload({
  imeLine,
  product,
  staff,
  buyer,
  customerName,
  saleType,
  paymentMethod,
  listedPrice,
  unitPrice,
  orderId,
  assignmentFields,
}) {
  return {
    ime: imeLine.ime,
    productId: product._id,
    orderId: orderId || null,
    buyerUserId: buyer._id,
    handledBy: staff._id,
    customerName: String(customerName || '').trim(),
    saleType,
    paymentMethod,
    status: SOLD_IME_STATUS.SOLD_OUT,
    productName: imeLine.productName || product.product_name,
    brand: imeLine.brand || product.brand || '',
    capacity: imeLine.capacity || product.capacity || '',
    color: imeLine.color || product.color || '',
    bulkBatchCode: imeLine.bulkBatchCode || null,
    listedPrice: Number(listedPrice) > 0 ? Number(listedPrice) : null,
    unitPrice: Number(unitPrice) > 0 ? Number(unitPrice) : null,
    assignedWarehouseId: assignmentFields?.assignedWarehouseId || null,
    assignedWarehouseName: assignmentFields?.assignedWarehouseName || '',
    soldAt: new Date(),
  };
}

function normalizeSaleItems(body) {
  const mapRow = (row) => {
    const imeCodes = Array.isArray(row?.imeCodes)
      ? row.imeCodes.map((c) => String(c || '').trim()).filter(Boolean)
      : [];
    const requestedUnitPrice = Number(row?.unitPrice);
    const requestedWholesaleUnitPrice = Number(row?.wholesaleUnitPrice);
    return {
      productId: String(row?.productId || '').trim(),
      quantity: Math.max(1, parseInt(row?.quantity, 10) || 1),
      unitPrice: Number.isFinite(requestedUnitPrice) && requestedUnitPrice > 0 ? requestedUnitPrice : null,
      wholesaleUnitPrice:
        Number.isFinite(requestedWholesaleUnitPrice) && requestedWholesaleUnitPrice > 0
          ? requestedWholesaleUnitPrice
          : null,
      imeCodes,
    };
  };

  if (Array.isArray(body?.items) && body.items.length) {
    return body.items.map(mapRow).filter((row) => row.productId);
  }
  const productId = String(body?.productId || '').trim();
  if (!productId) return [];
  return [mapRow(body)];
}

function warehouseObjectIdString(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    const raw = value._id ?? value.id ?? value;
    if (raw && raw !== value) return String(raw).trim();
  }
  return String(value).trim();
}

async function assertSalesmanShopInventory(staff, productMap, assignedWarehouseId) {
  const role = String(staff?.role || '').toLowerCase();
  if (role !== ROLES_LIST.SALESMAN) return;

  let shopId = String(assignedWarehouseId || '').trim();
  if (!shopId) {
    const shops = Array.isArray(staff?.assignedShops) ? staff.assignedShops : [];
    if (shops.length === 1) shopId = String(shops[0]);
  }
  if (!shopId) {
    const err = new Error('Select your shop before recording a direct sale.');
    err.status = 400;
    throw err;
  }

  for (const product of productMap.values()) {
    const atShop = warehouseObjectIdString(product.currentWarehouse);
    if (atShop !== shopId) {
      const err = new Error(
        `${product.product_name || 'This product'} is not in your shop inventory. Request it from general inventory instead.`,
      );
      err.status = 400;
      throw err;
    }
  }
}

async function loadProductForDirectSale(productId, session = null) {
  const q = Product.findById(productId);
  if (session) q.session(session);
  const product = await q;
  if (!product) {
    const err = new Error('Product not found.');
    err.status = 404;
    throw err;
  }
  return product;
}

function cloneProductImeState(product) {
  const codes = normalizedImeList(product);
  return {
    imeCodes: [...codes],
    stock: Math.max(0, Number(product.stock) || 0),
  };
}

function resolveProductWholesaleUnitPrice(product) {
  const candidates = [
    product?.wholesalePrice,
    product?.price,
    product?.priceMin,
    product?.priceMax,
  ];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function takeSpecificImeCodes(sim, requestedCodes, qty) {
  const codes = (Array.isArray(requestedCodes) ? requestedCodes : [])
    .map((c) => String(c || '').trim())
    .filter(Boolean);
  const unique = [...new Set(codes)];
  if (unique.length !== codes.length) {
    const err = new Error('Duplicate IME codes in selection.');
    err.status = 400;
    throw err;
  }
  if (unique.length !== qty) {
    const err = new Error(`Select exactly ${qty} IME code(s) for this product line.`);
    err.status = 400;
    throw err;
  }
  for (const code of unique) {
    if (!sim.imeCodes.includes(code)) {
      const err = new Error(`IME ${code} is not available on this product.`);
      err.status = 400;
      throw err;
    }
  }
  sim.imeCodes = sim.imeCodes.filter((c) => !unique.includes(c));
  sim.stock -= unique.length;
  return unique;
}

function buildManifestForSimulatedProduct(product, sim, qty, requestedImes = null) {
  const registered = sim.imeCodes.length ? sim.imeCodes : normalizedImeList(product);
  const hasRegistered = registered.length > 0 || normalizedImeList(product).length > 0;
  const allRegistered = normalizedImeList(product);

  if (hasRegistered) {
    if (Array.isArray(requestedImes) && requestedImes.length) {
      const taken = takeSpecificImeCodes(sim, requestedImes, qty);
      return {
        taken,
        manifest: buildImeManifestLines(product, taken),
        requiresIme: true,
      };
    }
    if (allRegistered.length > 0) {
      const err = new Error(
        `${product.product_name}: select ${qty} IME code(s) before completing the sale.`,
      );
      err.status = 400;
      throw err;
    }
  }

  const virtualProduct = { imeCodes: sim.imeCodes, IME: sim.imeCodes[0] };
  const { taken, remaining } = splitImeCodes(virtualProduct, qty);
  if (registered.length > 0 && taken.length < qty) {
    const err = new Error(
      `${product.product_name}: only ${registered.length} registered IME(s) available, but ${qty} requested.`,
    );
    err.status = 400;
    throw err;
  }
  sim.imeCodes = remaining;
  sim.stock -= qty;
  return {
    taken,
    manifest: buildImeManifestLines(product, taken),
    requiresIme: registered.length > 0,
  };
}

async function processCartItems(items, { session = null, persist = false, productMap = null } = {}) {
  const lines = [];
  const allManifest = [];
  let totalPrice = 0;
  const simState = new Map();

  for (const item of items) {
    let product = productMap?.get(item.productId);
    if (!product) {
      product = await loadProductForDirectSale(item.productId, session);
      productMap?.set(item.productId, product);
    }

    const pid = String(product._id);
    if (!simState.has(pid)) {
      simState.set(pid, cloneProductImeState(product));
    }
    const sim = simState.get(pid);

    if (item.quantity > sim.stock) {
      const err = new Error(
        `${product.product_name}: insufficient stock. Available: ${sim.stock}, requested: ${item.quantity}.`,
      );
      err.status = 400;
      throw err;
    }

    const defaultWholesale = resolveProductWholesaleUnitPrice(product);
    const unitPrice = Number.isFinite(Number(item.unitPrice)) && Number(item.unitPrice) > 0
      ? Number(item.unitPrice)
      : defaultWholesale;
    const wholesaleUnitPrice =
      Number.isFinite(Number(item.wholesaleUnitPrice)) && Number(item.wholesaleUnitPrice) > 0
        ? Number(item.wholesaleUnitPrice)
        : defaultWholesale;
    const lineTotal = unitPrice * item.quantity;
    const requestedImes = item.imeCodes?.length ? item.imeCodes : null;
    const { manifest, requiresIme, taken } = buildManifestForSimulatedProduct(
      product,
      sim,
      item.quantity,
      requestedImes,
    );

    const unitRows = [];
    for (let i = 0; i < item.quantity; i += 1) {
      const m = manifest[i];
      unitRows.push({
        ime: m?.ime || '',
        productName: product.product_name,
        brand: product.brand || '',
        capacity: product.capacity || '',
        color: product.color || '',
        wholesaleUnitPrice,
        unitPrice,
      });
    }

    lines.push({
      productId: product._id,
      productName: product.product_name,
      brand: product.brand,
      capacity: product.capacity,
      color: product.color,
      quantity: item.quantity,
      wholesaleUnitPrice,
      unitPrice,
      lineTotal,
      requiresIme,
      imeCount: taken.length,
      manifest,
      unitRows,
    });

    allManifest.push(...manifest);
    totalPrice += lineTotal;
  }

  if (persist && session) {
    for (const [pid, sim] of simState.entries()) {
      const product = productMap.get(pid);
      applyImeFields(product, sim.imeCodes);
      product.stock = sim.stock;
      await product.save({ session });
    }
  }

  return { lines, manifest: allManifest, totalPrice, simState };
}

/** POST /api/orders/direct-sale/wholesale/preview */
async function previewWholesaleDirectSale(req, res) {
  try {
    const items = normalizeSaleItems(req.body);
    if (!items.length) {
      return res.status(400).json({ success: false, message: 'At least one product line is required.' });
    }

    const handledById = String(req.body?.handledById || resolveStaffUserId(req)).trim();
    const staff = handledById
      ? await User.findById(handledById).select('name role assignedShops')
      : null;
    if (staff) assertStaffRole(staff);

    const productMap = new Map();
    for (const item of items) {
      const product = await loadProductForDirectSale(item.productId);
      productMap.set(String(product._id), product);
    }

    const assignmentFields = staff
      ? await resolveSaleAssignmentFields(req.body, productMap, staff)
      : {};
    if (staff) {
      await assertSalesmanShopInventory(staff, productMap, assignmentFields.assignedWarehouseId);
    }

    const { lines, manifest, totalPrice } = await processCartItems(items, { productMap });

    return res.status(200).json({
      success: true,
      data: {
        items: lines,
        lines,
        manifest,
        unitRows: manifest.map((row, idx) => ({ ...row, rowNumber: idx + 1 })),
        totalPrice,
        lineCount: lines.length,
        unitCount: manifest.length || lines.reduce((s, l) => s + l.quantity, 0),
      },
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('previewWholesaleDirectSale:', err);
    return res.status(status).json({
      success: false,
      message: err.message || 'Failed to preview wholesale direct sale.',
    });
  }
}

/** POST /api/orders/direct-sale/wholesale/confirm */
async function confirmWholesaleDirectSale(req, res) {
  try {
    assertRequestedSaleType(req, DIRECT_SALE_TYPE.WHOLESALE);
    const handledById = String(req.body?.handledById || resolveStaffUserId(req)).trim();
    const buyerUserId = String(req.body?.buyerUserId || '').trim();
    const customerName = String(req.body?.customerName || '').trim();
    const deliveryLocationKey = String(req.body?.deliveryLocationKey || 'Douala').trim();
    const paymentMethod = await assertRequestedPaymentMethod(req);
    const note = String(req.body?.note || '').trim();
    const items = normalizeSaleItems(req.body);

    if (!handledById || !buyerUserId || !customerName || !items.length) {
      return res.status(400).json({
        success: false,
        message: 'customerName, buyerUserId, items, and handledById are required.',
      });
    }

    const data = await runInTransaction((session) =>
      executeWholesaleDirectSaleConfirm({
        session,
        body: req.body,
        handledById,
        buyerUserId,
        customerName,
        deliveryLocationKey,
        paymentMethod,
        note,
        items,
      }),
    );

    return res.status(201).json({
      success: true,
      message: 'Vendor direct sale recorded. IME units marked sold out.',
      data,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('confirmWholesaleDirectSale:', err);
    return res.status(status).json({
      success: false,
      message: friendlySaleErrorMessage(err, 'Failed to confirm vendor direct sale.'),
    });
  }
}

async function executeWholesaleDirectSaleConfirm({
  session,
  body,
  handledById,
  buyerUserId,
  customerName,
  deliveryLocationKey,
  paymentMethod,
  note,
  items,
}) {
  const [staff, buyer] = await Promise.all([
    User.findById(handledById).select('name role assignedShops').session(session),
    User.findById(buyerUserId).session(session),
  ]);

  if (!staff) {
    const err = new Error('Staff user not found.');
    err.status = 404;
    throw err;
  }
  assertStaffRole(staff);

  if (!buyer || String(buyer.role).toLowerCase() !== ROLES_LIST.WHOLESALER) {
    const err = new Error('Select a valid vendor account.');
    err.status = 400;
    throw err;
  }

  const buyerStatus = String(buyer.accountStatus || '').toLowerCase();
  if (buyerStatus === 'suspended' || buyerStatus === 'rejected') {
    const err = new Error('This vendor account cannot be used for sales (suspended or rejected).');
    err.status = 400;
    throw err;
  }

  const productMap = new Map();
  for (const item of items) {
    const product = await loadProductForDirectSale(item.productId, session);
    productMap.set(String(product._id), product);
    product.updatedBy = staff._id;
  }

  const assignmentFields = await resolveSaleAssignmentFields(body, productMap, staff, session);
  await assertSalesmanShopInventory(staff, productMap, assignmentFields.assignedWarehouseId);

  const { lines, manifest, totalPrice } = await processCartItems(items, {
    session,
    persist: true,
    productMap,
  });

  const userNotes = `[Direct sale — In-Shop — Wholesale] Customer: ${customerName}${
    note ? ` — ${note}` : ''
  }`.slice(0, 2000);

  const orderIds = [];
  let soldImeCount = 0;

  for (const line of lines) {
    const product = productMap.get(String(line.productId));
    const taken = (line.manifest || []).map((m) => m.ime).filter(Boolean);

    const orderData = {
      userId: buyer._id,
      businessName: buyer.businessName,
      businessAddress: buyer.businessAddress,
      tel: buyer.tel,
      whatsappNumber: buyer.whatsappNumber,
      productId: product._id,
      productName: product.product_name,
      productPrice: line.unitPrice,
      orderType: ORDER_TYPES.BUY,
      quantity: line.quantity,
      productSource: PRODUCT_SOURCE.CATALOG,
      isCustomProduct: false,
      originalTotal: line.lineTotal,
      finalPrice: line.lineTotal,
      status: ORDER_STATUS.ACCEPTED,
      handledBy: staff._id,
      handledAt: new Date(),
      notifyAudience: 'admin',
      userNotes,
      staffNotes: 'Direct wholesale in-shop sale — confirmed with receipt.',
      soldImeCodes: taken,
      directSale: {
        type: DIRECT_SALE_TYPE.WHOLESALE,
        customerName,
        paymentMethod,
        wholesaleUnitPrice: line.wholesaleUnitPrice,
        soldUnitPrice: line.unitPrice,
        imeManifest: line.manifest,
        cartLineCount: lines.length,
        ...assignmentFields,
      },
      deliveryInfo: {
        deliveryAddress: deliveryAddressFromKey(deliveryLocationKey),
        deliveryStatus: 'pending',
        estimatedDeliveryDate: new Date(),
      },
      metadata: {
        source: 'direct_sale_wholesale',
        priority: 'normal',
        tags: ['direct_sale', 'wholesale', String(paymentMethod).replace(/\s+/g, '_')],
      },
    };

    const saleAt = orderData.handledAt;
    orderData.createdAt = saleAt;
    orderData.orderCode = await allocateOrderDisplayCode({ date: saleAt, session });

    const created = await Order.create([orderData], { session });
    const order = created[0];
    orderIds.push(order._id);

    for (const imeLine of line.manifest || []) {
      if (!imeLine.ime) continue;
      await SoldIme.create(
        [
          soldImeCreatePayload({
            imeLine,
            product,
            staff,
            buyer,
            customerName,
            saleType: DIRECT_SALE_TYPE.WHOLESALE,
            paymentMethod,
            listedPrice: line.wholesaleUnitPrice,
            unitPrice: line.unitPrice,
            orderId: order._id,
            assignmentFields,
          }),
        ],
        { session },
      );
      soldImeCount += 1;
    }
  }

  return {
    orderIds,
    orderId: orderIds[0],
    totalPrice,
    lines,
    manifest,
    soldImeCount,
    lineCount: lines.length,
  };
}

/** POST /api/orders/direct-sale/retail/confirm */
async function confirmRetailDirectSale(req, res) {
  try {
    assertRequestedSaleType(req, DIRECT_SALE_TYPE.RETAIL);
    const handledById = String(req.body?.handledById || resolveStaffUserId(req)).trim();
    const buyerUserId = String(req.body?.buyerUserId || handledById).trim();
    const customerName = String(req.body?.customerName || '').trim();
    const customerPhone = String(req.body?.customerPhone || '').trim();
    const customerEmail = String(req.body?.customerEmail || '').trim();
    const deliveryLocationKey = String(req.body?.deliveryLocationKey || 'Douala').trim();
    const paymentMethod = await assertRequestedPaymentMethod(req);
    const note = String(req.body?.note || '').trim();
    const items = normalizeSaleItems(req.body);

    if (!handledById || !buyerUserId || !customerName || !items.length) {
      return res.status(400).json({
        success: false,
        message: 'customerName, items, and handledById are required.',
      });
    }

    const data = await runInTransaction((session) =>
      executeRetailDirectSaleConfirm({
        session,
        body: req.body,
        handledById,
        buyerUserId,
        customerName,
        customerPhone,
        customerEmail,
        deliveryLocationKey,
        paymentMethod,
        note,
        items,
      }),
    );

    return res.status(201).json({
      success: true,
      message: 'Retail direct sale recorded. Selected IME units marked sold out.',
      data,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('confirmRetailDirectSale:', err);
    return res.status(status).json({
      success: false,
      message: friendlySaleErrorMessage(err, 'Failed to confirm retail direct sale.'),
    });
  }
}

async function executeRetailDirectSaleConfirm({
  session,
  body,
  handledById,
  buyerUserId,
  customerName,
  customerPhone,
  customerEmail,
  deliveryLocationKey,
  paymentMethod,
  note,
  items,
}) {
  const [staff, buyer] = await Promise.all([
    User.findById(handledById).select('name role assignedShops').session(session),
    User.findById(buyerUserId).session(session),
  ]);

  if (!staff) {
    const err = new Error('Staff user not found.');
    err.status = 404;
    throw err;
  }
  assertStaffRole(staff);

  if (!buyer) {
    const err = new Error('Buyer account not found.');
    err.status = 404;
    throw err;
  }

  const productMap = new Map();
  for (const item of items) {
    const product = await loadProductForDirectSale(item.productId, session);
    productMap.set(String(product._id), product);
    product.updatedBy = staff._id;
  }

  const assignmentFields = await resolveSaleAssignmentFields(body, productMap, staff, session);
  await assertSalesmanShopInventory(staff, productMap, assignmentFields.assignedWarehouseId);

  const { lines, manifest, totalPrice } = await processCartItems(items, {
    session,
    persist: true,
    productMap,
  });

  const userNotes = `[Direct sale — In-Shop — Retail] Customer: ${customerName}${
    customerPhone ? ` · Tel: ${customerPhone}` : ''
  }${customerEmail ? ` · Email: ${customerEmail}` : ''}${
    note ? ` — ${note}` : ''
  }`.slice(0, 2000);

  const orderIds = [];
  let soldImeCount = 0;

  for (const line of lines) {
    const product = productMap.get(String(line.productId));
    const taken = (line.manifest || []).map((m) => m.ime).filter(Boolean);

    const orderData = {
      userId: buyer._id,
      businessName: buyer.businessName,
      businessAddress: buyer.businessAddress,
      tel: buyer.tel,
      whatsappNumber: buyer.whatsappNumber,
      productId: product._id,
      productName: product.product_name,
      productPrice: line.unitPrice,
      orderType: ORDER_TYPES.BUY,
      quantity: line.quantity,
      productSource: PRODUCT_SOURCE.CATALOG,
      isCustomProduct: false,
      originalTotal: line.lineTotal,
      finalPrice: line.lineTotal,
      status: ORDER_STATUS.ACCEPTED,
      handledBy: staff._id,
      handledAt: new Date(),
      notifyAudience: 'admin',
      userNotes,
      staffNotes: 'Direct retail in-shop sale — confirmed.',
      soldImeCodes: taken,
      directSale: {
        type: DIRECT_SALE_TYPE.RETAIL,
        customerName,
        customerPhone: customerPhone || null,
        customerEmail: customerEmail || null,
        paymentMethod,
        wholesaleUnitPrice: line.wholesaleUnitPrice,
        soldUnitPrice: line.unitPrice,
        imeManifest: line.manifest,
        cartLineCount: lines.length,
        ...assignmentFields,
      },
      deliveryInfo: {
        deliveryAddress: deliveryAddressFromKey(deliveryLocationKey),
        deliveryStatus: 'pending',
        estimatedDeliveryDate: new Date(),
      },
      metadata: {
        source: 'direct_sale_retail',
        priority: 'normal',
        tags: ['direct_sale', 'retail', String(paymentMethod).replace(/\s+/g, '_')],
      },
    };

    const saleAt = orderData.handledAt;
    orderData.createdAt = saleAt;
    orderData.orderCode = await allocateOrderDisplayCode({ date: saleAt, session });

    const created = await Order.create([orderData], { session });
    const order = created[0];
    orderIds.push(order._id);

    for (const imeLine of line.manifest || []) {
      if (!imeLine.ime) continue;
      await SoldIme.create(
        [
          soldImeCreatePayload({
            imeLine,
            product,
            staff,
            buyer,
            customerName,
            saleType: DIRECT_SALE_TYPE.RETAIL,
            paymentMethod,
            listedPrice: resolveProductRetailUnitPrice(product),
            unitPrice: line.unitPrice,
            orderId: order._id,
            assignmentFields,
          }),
        ],
        { session },
      );
      soldImeCount += 1;
    }
  }

  return {
    orderIds,
    orderId: orderIds[0],
    totalPrice,
    lines,
    manifest,
    soldImeCount,
    lineCount: lines.length,
  };
}

module.exports = {
  previewWholesaleDirectSale,
  confirmWholesaleDirectSale,
  confirmRetailDirectSale,
};
