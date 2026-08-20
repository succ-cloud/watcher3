const mongoose = require('mongoose');
const Product = require('../models/ItemsList');
const { SoldIme, SOLD_IME_STATUS } = require('../models/SoldIme');
const { Order } = require('../models/Order');
const User = require('../models/User');
const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');
const ExchangeRecord = require('../models/ExchangeRecord');
const { runInTransaction } = require('../utils/mongoTransaction');
const { normalizedImeList, takeSpecificImeCodes, applyImeFields } = require('../utils/productIme');
const { WAREHOUSE_POPULATE } = require('../utils/warehousePopulate');

const EXCHANGE_CONDITION_STATUS = ['Normal', 'Faulty'];

function parseMonthKey(raw) {
  const s = String(raw || '').trim();
  const match = /^(\d{4})-(\d{2})$/.exec(s);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthDateRange(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const end = new Date(y, m, 1, 0, 0, 0, 0);
  return { start, end };
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatSoldRow(row) {
  const handledBy =
    row.handledBy && typeof row.handledBy === 'object'
      ? row.handledBy
      : null;
  return {
    id: String(row._id),
    soldDate: row.soldAt || row.createdAt || null,
    soldBy: {
      id: handledBy?._id ? String(handledBy._id) : row.handledBy ? String(row.handledBy) : '',
      name: handledBy?.name || '',
    },
    phoneName: row.productName || '',
    storage: row.capacity || '',
    ime: row.ime || '',
    unitPrice: Number(row.unitPrice) > 0 ? Number(row.unitPrice) : null,
    listedPrice: Number(row.listedPrice) > 0 ? Number(row.listedPrice) : null,
  };
}

function resolveUnitPrice(soldRow, product) {
  if (Number(soldRow?.unitPrice) > 0) return Number(soldRow.unitPrice);
  if (Number(soldRow?.listedPrice) > 0) return Number(soldRow.listedPrice);
  if (Number(product?.price) > 0) return Number(product.price);
  if (Number(product?.discountedPrice) > 0) return Number(product.discountedPrice);
  return null;
}

function resolveProductUnitPrice(product) {
  const discounted = Number(product?.discountedPrice);
  if (Number.isFinite(discounted) && discounted > 0) return discounted;
  const price = Number(product?.price);
  if (Number.isFinite(price) && price > 0) return price;
  return null;
}

function parseOptionalMoney(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n;
}

function resolveExchangePayment(priceDifference, amountCollectedRaw, amountRefundedRaw) {
  const amountCollected = parseOptionalMoney(amountCollectedRaw);
  const amountRefunded = parseOptionalMoney(amountRefundedRaw);

  if (priceDifference == null || !Number.isFinite(priceDifference)) {
    return { amountCollected: null, amountRefunded: null, discountOwed: null };
  }

  if (priceDifference > 0) {
    if (amountCollected == null || Number.isNaN(amountCollected)) {
      const err = new Error(
        `amountCollected is required and must be at least ${priceDifference}.`,
      );
      err.status = 400;
      throw err;
    }
    if (amountCollected < priceDifference) {
      const err = new Error(
        `amountCollected must be at least ${priceDifference} (minimum required for this price difference).`,
      );
      err.status = 400;
      throw err;
    }
    return { amountCollected, amountRefunded: null, discountOwed: null };
  }

  if (priceDifference < 0) {
    const discountOwed = Math.abs(priceDifference);
    if (amountRefundedRaw !== undefined && amountRefundedRaw !== null && amountRefundedRaw !== '') {
      if (Number.isNaN(amountRefunded)) {
        const err = new Error('amountRefunded must be a valid non-negative number when provided.');
        err.status = 400;
        throw err;
      }
    }
    return {
      amountCollected: null,
      amountRefunded: amountRefunded != null && !Number.isNaN(amountRefunded) ? amountRefunded : null,
      discountOwed,
    };
  }

  return { amountCollected: null, amountRefunded: null, discountOwed: null };
}

async function buildAvailableInventoryMatches(excludeIme, filters = {}, session = null) {
  const phoneNameFilter = String(filters.phoneName || '').trim().toLowerCase();
  const imeFilter = String(filters.ime || filters.imeFilter || '').trim().toLowerCase();

  const q = Product.find({
    isActive: { $ne: false },
    stock: { $gt: 0 },
    $or: [{ IME: { $gt: '' } }, { 'imeCodes.0': { $exists: true } }],
  })
    .populate(WAREHOUSE_POPULATE)
    .sort({ product_name: 1, capacity: 1 });
  if (session) q.session(session);
  const candidates = await q.lean();

  const exclude = String(excludeIme || '').trim().toLowerCase();
  const allImes = [];
  for (const product of candidates) {
    for (const ime of normalizedImeList(product)) {
      if (exclude && ime.toLowerCase() === exclude) continue;
      allImes.push(ime);
    }
  }

  const soldSet = await fetchActiveSoldImeSet(allImes, session);
  const availableMatches = [];

  for (const product of candidates) {
    for (const ime of normalizedImeList(product)) {
      if (exclude && ime.toLowerCase() === exclude) continue;
      if (soldSet.has(ime)) continue;

      const phoneName = String(product.product_name || '');
      const storage = String(product.capacity || '');
      if (phoneNameFilter && !phoneName.toLowerCase().includes(phoneNameFilter)) continue;
      if (imeFilter && !ime.toLowerCase().includes(imeFilter)) continue;

      const wh = product.currentWarehouse;
      availableMatches.push({
        ime,
        productId: String(product._id),
        phoneName,
        storage,
        price: resolveProductUnitPrice(product),
        color: product.color || '',
        warehouse: wh && typeof wh === 'object'
          ? { id: String(wh._id || ''), name: wh.name || '', city: wh.city || '' }
          : null,
      });
    }
  }

  return availableMatches;
}

async function fetchActiveSoldImeSet(imeList, session = null) {
  const trimmed = [...new Set(imeList.map((c) => String(c || '').trim()).filter(Boolean))];
  if (!trimmed.length) return new Set();
  const q = SoldIme.find({ ime: { $in: trimmed }, status: SOLD_IME_STATUS.SOLD_OUT }).select('ime');
  if (session) q.session(session);
  const rows = await q.lean();
  return new Set(rows.map((r) => String(r.ime || '').trim()).filter(Boolean));
}

function isImeOnProduct(product, ime) {
  return normalizedImeList(product).includes(String(ime || '').trim());
}

function daysSince(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  const diffMs = Date.now() - d.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

/** GET /api/admin/exchange/sales-by-month */
async function getSalesByMonth(req, res) {
  try {
    const monthKey = parseMonthKey(req.query.month) || currentMonthKey();
    const { start, end } = monthDateRange(monthKey);

    const rows = await SoldIme.find({
      status: SOLD_IME_STATUS.SOLD_OUT,
      soldAt: { $gte: start, $lt: end },
    })
      .populate('handledBy', 'name')
      .sort({ soldAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      month: monthKey,
      count: rows.length,
      data: rows.map(formatSoldRow),
    });
  } catch (error) {
    console.error('getSalesByMonth:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not load sales for this month.',
    });
  }
}

/** GET /api/admin/exchange/sales-by-phone-name */
async function getSalesByPhoneName(req, res) {
  try {
    const phoneName = String(req.query.phoneName || req.query.name || '').trim();
    if (!phoneName) {
      return res.status(400).json({
        success: false,
        message: 'phoneName is required.',
      });
    }

    const monthKey = parseMonthKey(req.query.month);
    const { start, end } = monthKey ? monthDateRange(monthKey) : null;
    const nameRegex = new RegExp(`^${escapeRegex(phoneName)}$`, 'i');

    const rows = await SoldIme.find({
      status: SOLD_IME_STATUS.SOLD_OUT,
      productName: nameRegex,
    })
      .populate('handledBy', 'name')
      .lean();

    rows.sort((a, b) => {
      const aDate = new Date(a.soldAt || a.createdAt || 0).getTime();
      const bDate = new Date(b.soldAt || b.createdAt || 0).getTime();
      if (start && end) {
        const aInMonth = aDate >= start.getTime() && aDate < end.getTime();
        const bInMonth = bDate >= start.getTime() && bDate < end.getTime();
        if (aInMonth !== bInMonth) return aInMonth ? -1 : 1;
      }
      return bDate - aDate;
    });

    return res.status(200).json({
      success: true,
      phoneName,
      month: monthKey,
      count: rows.length,
      data: rows.map(formatSoldRow),
    });
  } catch (error) {
    console.error('getSalesByPhoneName:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not load sales for this phone name.',
    });
  }
}

/** GET /api/admin/exchange/check-ime */
async function checkExchangeIme(req, res) {
  try {
    const query = String(req.query.ime || '').trim();
    if (query.length < 3) {
      return res.status(400).json({
        success: false,
        message: 'Enter at least 3 characters of the IME.',
      });
    }

    const exactRegex = new RegExp(`^${escapeRegex(query)}$`, 'i');
    const soldRecord = await SoldIme.findOne({
      ime: exactRegex,
      status: SOLD_IME_STATUS.SOLD_OUT,
    })
      .populate('handledBy', 'name')
      .lean();

    if (!soldRecord) {
      return res.status(404).json({
        success: false,
        found: false,
        message: 'This IME was not found as a sold unit.',
      });
    }

    const phoneName = String(soldRecord.productName || '').trim();
    const storage = String(soldRecord.capacity || '').trim();
    const replacementPhoneName = String(req.query.replacementPhoneName || req.query.phoneName || '').trim();
    const replacementIme = String(req.query.replacementIme || req.query.replacementImeFilter || '').trim();
    const availableMatches = await buildAvailableInventoryMatches(query, {
      phoneName: replacementPhoneName,
      ime: replacementIme,
    });

    const handledBy =
      soldRecord.handledBy && typeof soldRecord.handledBy === 'object' ? soldRecord.handledBy : null;
    const soldAt = soldRecord.soldAt || soldRecord.createdAt || null;

    return res.status(200).json({
      success: true,
      found: true,
      data: {
        ime: soldRecord.ime,
        phoneName,
        storage,
        soldDate: soldAt,
        daysSinceSold: daysSince(soldAt),
        soldBy: {
          id: handledBy?._id ? String(handledBy._id) : soldRecord.handledBy ? String(soldRecord.handledBy) : '',
          name: handledBy?.name || '',
        },
        originalUnitPrice: resolveUnitPrice(soldRecord),
        availableMatches,
      },
    });
  } catch (error) {
    console.error('checkExchangeIme:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not check this IME.',
    });
  }
}

/** GET /api/admin/exchange/available-replacements — unsold inventory for replacement picker */
async function getAvailableReplacements(req, res) {
  try {
    const excludeIme = String(req.query.excludeIme || req.query.originalIME || '').trim();
    const phoneName = String(req.query.phoneName || req.query.replacementPhoneName || '').trim();
    const ime = String(req.query.ime || req.query.replacementIme || '').trim();

    const availableMatches = await buildAvailableInventoryMatches(excludeIme, { phoneName, ime });

    return res.status(200).json({
      success: true,
      count: availableMatches.length,
      data: availableMatches,
    });
  } catch (error) {
    console.error('getAvailableReplacements:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not load available replacement phones.',
    });
  }
}

async function swapOrderIme(order, originalIme, newIme, newProduct, session) {
  if (!order) return;

  const soldImeCodes = Array.isArray(order.soldImeCodes) ? [...order.soldImeCodes] : [];
  const withoutOriginal = soldImeCodes.filter((code) => String(code || '').trim() !== originalIme);
  if (!withoutOriginal.includes(newIme)) withoutOriginal.push(newIme);
  order.soldImeCodes = withoutOriginal;

  const directSale =
    order.directSale && typeof order.directSale === 'object' && !Array.isArray(order.directSale)
      ? { ...order.directSale }
      : {};
  const imeManifest = Array.isArray(directSale.imeManifest) ? [...directSale.imeManifest] : [];
  const filteredManifest = imeManifest.filter((line) => String(line?.ime || '').trim() !== originalIme);
  filteredManifest.push({
    ime: newIme,
    productName: newProduct?.product_name || '',
    brand: newProduct?.brand || '',
    capacity: newProduct?.capacity || '',
    color: newProduct?.color || '',
    bulkBatchCode: newProduct?.bulkBatchCode || null,
  });
  directSale.imeManifest = filteredManifest;
  order.directSale = directSale;
  await order.save({ session });
}

/** POST /api/admin/exchange/process-exchange */
async function processExchange(req, res) {
  try {
    const originalIME = String(req.body?.originalIME || '').trim();
    const newIME = String(req.body?.newIME || '').trim();
    const status = String(req.body?.status || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const amountCollectedRaw = req.body?.amountCollected;
    const amountRefundedRaw = req.body?.amountRefunded;
    const adminId = req.user?.userId || req.user?.id || req.userId || null;

    if (!originalIME || !newIME) {
      return res.status(400).json({
        success: false,
        message: 'originalIME and newIME are required.',
      });
    }
    if (originalIME.toLowerCase() === newIME.toLowerCase()) {
      return res.status(400).json({
        success: false,
        message: 'Replacement IME must differ from the original IME.',
      });
    }
    if (!EXCHANGE_CONDITION_STATUS.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `status must be one of: ${EXCHANGE_CONDITION_STATUS.join(', ')}.`,
      });
    }
    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: 'Admin user is required to process an exchange.',
      });
    }

    const result = await runInTransaction(async (session) => {
      const exactOriginal = new RegExp(`^${escapeRegex(originalIME)}$`, 'i');
      const exactNew = new RegExp(`^${escapeRegex(newIME)}$`, 'i');

      const sold = await SoldIme.findOne({
        ime: exactOriginal,
        status: SOLD_IME_STATUS.SOLD_OUT,
      }).session(session);
      if (!sold) {
        const err = new Error('Original IME is not an active sold unit.');
        err.status = 404;
        throw err;
      }

      const activeNewSold = await SoldIme.findOne({
        ime: exactNew,
        status: SOLD_IME_STATUS.SOLD_OUT,
      }).session(session);
      if (activeNewSold) {
        const err = new Error('Replacement IME is already marked as sold.');
        err.status = 409;
        throw err;
      }

      const newProduct = await Product.findOne({
        $or: [{ IME: exactNew }, { imeCodes: exactNew }],
        stock: { $gt: 0 },
      }).session(session);
      if (!newProduct || !isImeOnProduct(newProduct, newIME)) {
        const err = new Error('Replacement IME is not available in inventory.');
        err.status = 404;
        throw err;
      }

      const originalPhoneName = String(sold.productName || '').trim();
      const originalStorage = String(sold.capacity || '').trim();

      const originalProduct = await Product.findById(sold.productId).session(session);
      if (!originalProduct) {
        const err = new Error('Original product record was not found.');
        err.status = 404;
        throw err;
      }

      const originalUnitPrice = resolveUnitPrice(sold, originalProduct);
      const newUnitPrice = resolveProductUnitPrice(newProduct);
      const priceDifference =
        originalUnitPrice != null && newUnitPrice != null ? newUnitPrice - originalUnitPrice : null;
      const payment = resolveExchangePayment(priceDifference, amountCollectedRaw, amountRefundedRaw);

      const ime = String(sold.ime || '').trim();
      const currentCodes = normalizedImeList(originalProduct);
      if (!currentCodes.includes(ime)) {
        currentCodes.push(ime);
        originalProduct.imeCodes = currentCodes;
        originalProduct.IME = currentCodes[0] || ime;
        originalProduct.stock = Math.max(0, Number(originalProduct.stock) || 0) + 1;
      }
      originalProduct.conditionStatus = status;

      const assignedWarehouseId = sold.assignedWarehouseId ? String(sold.assignedWarehouseId) : '';
      const assignedWarehouse = assignedWarehouseId
        ? await Warehouse.findById(assignedWarehouseId).select('_id name type').session(session)
        : null;

      if (assignedWarehouse) {
        originalProduct.currentWarehouse = assignedWarehouse._id;
        originalProduct.shipmentStatus = 'arrived';
        originalProduct.arrivedAt = new Date();
        if (String(assignedWarehouse.type || '').toLowerCase() === WAREHOUSE_TYPES.SUB) {
          originalProduct.destinationSubWarehouse = assignedWarehouse._id;
        }
        const history = Array.isArray(originalProduct.locationHistory) ? originalProduct.locationHistory : [];
        history.push({
          warehouse: assignedWarehouse._id,
          status: 'arrived',
          movedAt: new Date(),
          movedBy: adminId,
          note: `Exchange return for IME ${ime} (${status})`,
        });
        originalProduct.locationHistory = history;
      }

      await originalProduct.save({ session });

      const { remaining } = takeSpecificImeCodes(newProduct, [newIME]);
      applyImeFields(newProduct, remaining);
      newProduct.stock = Math.max(0, Number(newProduct.stock) || 0) - 1;
      await newProduct.save({ session });

      let order = null;
      if (sold.orderId) {
        order = await Order.findById(sold.orderId).session(session);
      }
      if (!order && ime) {
        order = await Order.findOne({
          $or: [{ soldImeCodes: ime }, { 'directSale.imeManifest.ime': ime }],
        }).session(session);
      }
      if (order) {
        await swapOrderIme(order, ime, newIME, newProduct, session);
      }

      await SoldIme.deleteOne({ _id: sold._id }).session(session);

      await SoldIme.create(
        [
          {
            ime: newIME,
            productId: newProduct._id,
            orderId: sold.orderId || order?._id || null,
            buyerUserId: sold.buyerUserId || null,
            handledBy: adminId,
            customerName: sold.customerName || '',
            saleType: sold.saleType || 'wholesale',
            paymentMethod: sold.paymentMethod || 'cash',
            status: SOLD_IME_STATUS.SOLD_OUT,
            productName: newProduct.product_name || sold.productName || '',
            brand: newProduct.brand || sold.brand || '',
            capacity: newProduct.capacity || sold.capacity || '',
            color: newProduct.color || sold.color || '',
            bulkBatchCode: newProduct.bulkBatchCode || sold.bulkBatchCode || null,
            listedPrice: sold.listedPrice ?? newUnitPrice,
            unitPrice: sold.unitPrice ?? newUnitPrice,
            assignedWarehouseId: sold.assignedWarehouseId || null,
            assignedWarehouseName: sold.assignedWarehouseName || '',
            soldAt: new Date(),
          },
        ],
        { session },
      );

      const exchangeRecord = await ExchangeRecord.create(
        [
          {
            originalIME: ime,
            newIME,
            phoneName: originalPhoneName,
            storage: originalStorage,
            exchangeDate: new Date(),
            processedBy: adminId,
            priceDifference,
            amountCollected: payment.amountCollected,
            amountRefunded: payment.amountRefunded,
            notes,
          },
        ],
        { session },
      );

      const admin = await User.findById(adminId).select('name').session(session);

      return {
        exchangeId: String(exchangeRecord[0]._id),
        originalIME: ime,
        newIME,
        phoneName: originalPhoneName,
        storage: originalStorage,
        replacementPhoneName: newProduct.product_name || '',
        replacementStorage: newProduct.capacity || '',
        conditionStatus: status,
        priceDifference,
        amountCollected: payment.amountCollected,
        amountRefunded: payment.amountRefunded,
        discountOwed: payment.discountOwed,
        processedBy: {
          id: String(adminId),
          name: admin?.name || '',
        },
      };
    });

    return res.status(200).json({
      success: true,
      message: 'Exchange completed successfully.',
      data: result,
    });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('processExchange:', error);
    return res.status(status).json({
      success: false,
      message: error.message || 'Could not process exchange.',
    });
  }
}

module.exports = {
  getSalesByMonth,
  getSalesByPhoneName,
  checkExchangeIme,
  getAvailableReplacements,
  processExchange,
  EXCHANGE_CONDITION_STATUS,
};
