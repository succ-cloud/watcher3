const mongoose = require('mongoose');
const Order = require('../models/Order').Order;
const OrderSequence = require('../models/OrderSequence');

function dateFromObjectId(id) {
  if (!id) return null;
  try {
    const s = String(id);
    if (/^[a-f0-9]{24}$/i.test(s)) {
      const seconds = parseInt(s.slice(0, 8), 16);
      const d = new Date(seconds * 1000);
      if (!Number.isNaN(d.getTime())) return d;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function orderDateForCode(order) {
  const candidates = [order?.createdAt, order?.handledAt, order?.updatedAt];
  for (const value of candidates) {
    if (!value) continue;
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return dateFromObjectId(order?._id ?? order?.id) || new Date();
}

function formatSequenceNumber(seq) {
  const n = Math.max(1, Number(seq) || 1);
  if (n <= 999999) return String(n).padStart(6, '0');
  return String(n);
}

function formatOrderDisplayCode(year, month, seq) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    throw new Error('Invalid year or month for order code.');
  }
  return `${y}/${String(m).padStart(2, '0')}/${formatSequenceNumber(seq)}`;
}

function parseOrderDisplayCode(code) {
  const match = String(code || '').trim().match(/^(\d{4})\/(\d{2})\/(\d+)$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    seq: Number(match[3]),
  };
}

async function allocateOrderDisplayCode({ date = new Date(), session = null } = {}) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;

  const options = { upsert: true, new: true, setDefaultsOnInsert: true };
  if (session) options.session = session;

  const counter = await OrderSequence.findOneAndUpdate(
    { year, month },
    { $inc: { seq: 1 } },
    options,
  );

  return formatOrderDisplayCode(year, month, counter.seq);
}

async function syncSequenceCounter(year, month, seq) {
  const n = Math.max(0, Number(seq) || 0);
  await OrderSequence.findOneAndUpdate(
    { year, month },
    { $max: { seq: n } },
    { upsert: true, setDefaultsOnInsert: true },
  );
}

let backfillInFlight = null;

async function backfillMissingOrderCodes() {
  if (backfillInFlight) return backfillInFlight;

  backfillInFlight = (async () => {
  const missing = await Order.find({
    $or: [{ orderCode: { $exists: false } }, { orderCode: null }, { orderCode: '' }],
  })
    .select('_id createdAt handledAt updatedAt')
    .lean();

  if (!missing.length) return 0;

  const existing = await Order.find({
    orderCode: { $exists: true, $nin: [null, ''] },
  })
    .select('orderCode')
    .lean();

  const maxSeqByMonth = new Map();
  for (const row of existing) {
    const parsed = parseOrderDisplayCode(row.orderCode);
    if (!parsed) continue;
    const key = `${parsed.year}-${parsed.month}`;
    maxSeqByMonth.set(key, Math.max(maxSeqByMonth.get(key) || 0, parsed.seq));
  }

  const groups = new Map();
  for (const order of missing) {
    const d = orderDateForCode(order);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const key = `${year}-${month}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...order, sortDate: d });
  }

  let updated = 0;
  for (const [key, rows] of groups.entries()) {
    const [year, month] = key.split('-').map(Number);
    let seq = maxSeqByMonth.get(key) || 0;
    rows.sort((a, b) => a.sortDate - b.sortDate || String(a._id).localeCompare(String(b._id)));

    for (const row of rows) {
      seq += 1;
      const orderCode = formatOrderDisplayCode(year, month, seq);
      await Order.updateOne({ _id: row._id }, { $set: { orderCode } });
      updated += 1;
    }

    await syncSequenceCounter(year, month, seq);
    maxSeqByMonth.set(key, seq);
  }

  return updated;
  })();

  try {
    return await backfillInFlight;
  } finally {
    backfillInFlight = null;
  }
}

async function attachOrderCodesToOrders(orders = [], { backfillAll = false } = {}) {
  if (!Array.isArray(orders) || !orders.length) return orders;

  const needsCodes = orders.some((o) => !String(o?.orderCode || '').trim());
  if (!needsCodes) return orders;

  if (backfillAll) {
    try {
      await backfillMissingOrderCodes();
    } catch (err) {
      console.warn('attachOrderCodesToOrders backfill skipped:', err.message || err);
    }
  }

  const missingIds = orders
    .filter((o) => !String(o?.orderCode || '').trim())
    .map((o) => o._id ?? o.id)
    .filter(Boolean);

  if (!missingIds.length) return orders;

  const rows = await Order.find({ _id: { $in: missingIds } })
    .select('_id orderCode')
    .lean();
  const codeById = new Map(rows.map((r) => [String(r._id), String(r.orderCode || '').trim()]));

  return orders.map((o) => {
    const stored = String(o?.orderCode || '').trim();
    if (stored) return o;
    const id = String(o._id ?? o.id ?? '');
    const orderCode = codeById.get(id);
    return orderCode ? { ...o, orderCode } : o;
  });
}

let backfillScheduled = false;
let backfillPromise = null;

function scheduleOrderCodeBackfill() {
  if (mongoose.connection.readyState !== 1) return;
  if (backfillPromise) return;
  backfillScheduled = true;
  backfillPromise = backfillMissingOrderCodes()
    .then((count) => {
      if (count > 0) {
        console.log(`Order display codes backfilled for ${count} order(s).`);
      }
      return count;
    })
    .catch((err) => {
      console.error('Order display code backfill failed:', err.message || err);
      backfillScheduled = false;
      backfillPromise = null;
    });
}

module.exports = {
  formatOrderDisplayCode,
  parseOrderDisplayCode,
  allocateOrderDisplayCode,
  backfillMissingOrderCodes,
  attachOrderCodesToOrders,
  scheduleOrderCodeBackfill,
  orderDateForCode,
};
