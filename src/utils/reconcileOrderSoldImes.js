const { SoldIme, SOLD_IME_STATUS } = require('../models/SoldIme');
const { Order } = require('../models/Order');

function collectOrderImes(orderObj) {
  const set = new Set();
  for (const code of orderObj?.soldImeCodes || []) {
    const ime = String(code || '').trim();
    if (ime) set.add(ime);
  }
  for (const line of orderObj?.directSale?.imeManifest || []) {
    const ime = String(line?.ime || '').trim();
    if (ime) set.add(ime);
  }
  return [...set];
}

/** Orders that track individual sold IMEs (direct / in-shop sales). */
function orderTracksSoldImes(orderObj) {
  const directSale =
    orderObj?.directSale && typeof orderObj.directSale === 'object' && !Array.isArray(orderObj.directSale)
      ? orderObj.directSale
      : null;

  if (directSale) {
    const directSaleSource = String(directSale.source || '').toLowerCase();
    // Vendor web buy orders carry shop routing in directSale — not IME-tracked sales.
    if (directSaleSource !== 'vendor_web') {
      const manifestHasImes = (Array.isArray(directSale.imeManifest) ? directSale.imeManifest : []).some(
        (line) => String(line?.ime || '').trim(),
      );
      if (manifestHasImes) return true;

      const directSaleType = String(directSale.type || '').toLowerCase();
      if (directSaleType === 'retail' || directSaleType === 'wholesale') return true;

      if (
        ['direct', 'direct_sale', 'in_store', 'direct_sale_wholesale', 'direct_sale_retail'].includes(
          directSaleSource,
        )
      ) {
        return true;
      }
    }
  }

  if (Array.isArray(orderObj?.soldImeCodes) && orderObj.soldImeCodes.some((code) => String(code || '').trim())) {
    return true;
  }

  const src = String(orderObj?.metadata?.source || '').toLowerCase();
  return (
    src === 'direct' ||
    src === 'direct_sale' ||
    src === 'in_store' ||
    src === 'direct_sale_wholesale' ||
    src === 'direct_sale_retail'
  );
}

async function fetchActiveSoldImeSet(imeList) {
  if (!imeList.length) return new Set();
  const rows = await SoldIme.find({
    ime: { $in: imeList },
    status: SOLD_IME_STATUS.SOLD_OUT,
  })
    .select('ime')
    .lean();
  return new Set(rows.map((row) => String(row.ime || '').trim()).filter(Boolean));
}

function effectiveSoldUnitCount(orderObj) {
  const soldImeCount = (Array.isArray(orderObj?.soldImeCodes) ? orderObj.soldImeCodes : [])
    .map((code) => String(code || '').trim())
    .filter(Boolean).length;
  const manifestCount = (Array.isArray(orderObj?.directSale?.imeManifest)
    ? orderObj.directSale.imeManifest
    : []
  ).filter((line) => String(line?.ime || '').trim()).length;
  return Math.max(soldImeCount, manifestCount);
}

/** Direct / in-shop sale with no remaining sold units — safe to remove from the system. */
function isEmptySoldOrder(orderObj) {
  if (!orderTracksSoldImes(orderObj)) return false;
  return effectiveSoldUnitCount(orderObj) <= 0;
}

/** Drop revoked IMEs from an order payload using the active SoldIme set. */
function reconcileOrderSoldImesInMemory(orderObj, activeImeSet) {
  const o = { ...orderObj };
  if (!orderTracksSoldImes(o)) return o;

  const soldImeCodes = (Array.isArray(o.soldImeCodes) ? o.soldImeCodes : [])
    .map((code) => String(code || '').trim())
    .filter(Boolean)
    .filter((ime) => activeImeSet.has(ime));

  const directSale =
    o.directSale && typeof o.directSale === 'object' && !Array.isArray(o.directSale)
      ? { ...o.directSale }
      : null;
  if (directSale && Array.isArray(directSale.imeManifest)) {
    directSale.imeManifest = directSale.imeManifest.filter((line) =>
      activeImeSet.has(String(line?.ime || '').trim()),
    );
    o.directSale = directSale;
  }

  o.soldImeCodes = soldImeCodes;

  const manifestCount = Array.isArray(o.directSale?.imeManifest)
    ? o.directSale.imeManifest.filter((line) => String(line?.ime || '').trim()).length
    : 0;
  const effectiveCount = Math.max(soldImeCodes.length, manifestCount);

  if (effectiveCount <= 0) {
    o.quantity = 0;
    o.finalPrice = 0;
    o.originalTotal = 0;
  } else if (effectiveCount !== Number(o.quantity)) {
    o.quantity = effectiveCount;
  }

  return o;
}

async function reconcileOrdersForResponse(orders) {
  const list = orders.map((order) => (typeof order?.toObject === 'function' ? order.toObject() : { ...order }));
  const allImes = new Set();
  for (const order of list) {
    if (!orderTracksSoldImes(order)) continue;
    for (const ime of collectOrderImes(order)) allImes.add(ime);
  }
  const activeSet = await fetchActiveSoldImeSet([...allImes]);

  const kept = [];
  const deleteIds = [];

  for (const order of list) {
    const reconciled = reconcileOrderSoldImesInMemory(order, activeSet);
    if (isEmptySoldOrder(reconciled)) {
      const id = order?._id ?? order?.id;
      if (id) deleteIds.push(id);
      continue;
    }
    kept.push(reconciled);
  }

  if (deleteIds.length) {
    try {
      await Order.deleteMany({ _id: { $in: deleteIds } });
    } catch (deleteErr) {
      console.warn('reconcileOrdersForResponse delete skipped:', deleteErr.message || deleteErr);
    }
  }

  return kept;
}

module.exports = {
  collectOrderImes,
  orderTracksSoldImes,
  effectiveSoldUnitCount,
  isEmptySoldOrder,
  reconcileOrderSoldImesInMemory,
  reconcileOrdersForResponse,
};
