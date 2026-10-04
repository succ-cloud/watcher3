const { Order } = require('../models/Order');

function normalizeIme(value) {
  return String(value || '').trim();
}

function orderOwnsImeOnLine(order, ime) {
  if (!order || !ime) return false;
  const inCodes = (Array.isArray(order.soldImeCodes) ? order.soldImeCodes : []).some(
    (code) => normalizeIme(code) === ime,
  );
  const inManifest = (Array.isArray(order.directSale?.imeManifest) ? order.directSale.imeManifest : []).some(
    (line) => normalizeIme(line?.ime) === ime,
  );
  return inCodes || inManifest;
}

function countLineRemainingUnits(soldImeCodes, imeManifest) {
  const manifestImes = (Array.isArray(imeManifest) ? imeManifest : [])
    .map((line) => normalizeIme(line?.ime))
    .filter(Boolean);
  if (manifestImes.length) return manifestImes.length;
  return (Array.isArray(soldImeCodes) ? soldImeCodes : [])
    .map((code) => normalizeIme(code))
    .filter(Boolean).length;
}

function patchReceiptSnapshotForRevokedUnit(directSale, { revokedIme, productName, productId, unitPrice }) {
  const ds =
    directSale && typeof directSale === 'object' && !Array.isArray(directSale) ? { ...directSale } : {};
  const ime = normalizeIme(revokedIme);

  if (Array.isArray(ds.receiptUnitRows)) {
    ds.receiptUnitRows = ds.receiptUnitRows.filter((row) => normalizeIme(row?.ime) !== ime);
  }

  const revokedPrice = Math.max(0, Number(unitPrice) || 0);
  if (Number.isFinite(Number(ds.receiptGrandTotal)) && revokedPrice > 0) {
    ds.receiptGrandTotal = Math.max(0, Number(ds.receiptGrandTotal) - revokedPrice);
  }

  if (Array.isArray(ds.receiptLines) && ds.receiptLines.length) {
    const soldName = String(productName || '').trim().toLowerCase();
    const soldPid = productId ? String(productId) : '';
    ds.receiptLines = ds.receiptLines
      .map((line) => {
        const lineName = String(line?.productName || '').trim().toLowerCase();
        const linePid = line?.productId ? String(line.productId) : '';
        const nameMatch = soldName && lineName && lineName === soldName;
        const idMatch = soldPid && linePid && linePid === soldPid;
        if (!nameMatch && !idMatch) return { ...line };

        const qty = Math.max(0, Number(line.quantity) || 0);
        if (qty <= 1) return null;
        const nextQty = qty - 1;
        const unit = Number(line.unitPrice) || revokedPrice || 0;
        return {
          ...line,
          quantity: nextQty,
          lineTotal: unit > 0 ? unit * nextQty : Math.max(0, Number(line.lineTotal) - unit),
        };
      })
      .filter(Boolean);
  }

  return ds;
}

function stripImeFromLineOrder(order, revokedIme) {
  const ime = normalizeIme(revokedIme);
  const soldImeCodes = (Array.isArray(order.soldImeCodes) ? order.soldImeCodes : [])
    .map((code) => normalizeIme(code))
    .filter(Boolean)
    .filter((code) => code !== ime);

  const directSale =
    order.directSale && typeof order.directSale === 'object' && !Array.isArray(order.directSale)
      ? { ...order.directSale }
      : {};
  const imeManifest = Array.isArray(directSale.imeManifest) ? directSale.imeManifest : [];
  directSale.imeManifest = imeManifest.filter((line) => normalizeIme(line?.ime) !== ime);

  return { soldImeCodes, directSale };
}

async function resolveOrderForSoldIme(session, sold, ime) {
  if (sold.orderId) {
    const byId = await Order.findById(sold.orderId).session(session);
    if (byId && orderOwnsImeOnLine(byId, ime)) return byId;
  }

  const candidates = await Order.find({
    $or: [{ soldImeCodes: ime }, { 'directSale.imeManifest.ime': ime }],
  }).session(session);

  return candidates.find((row) => orderOwnsImeOnLine(row, ime)) || null;
}

/**
 * After one IME is restored to stock: update or remove only the owning line order;
 * sync shared batch receipt fields on sibling orders without touching their sold units.
 */
async function applyDirectSaleRevokeToOrders(session, sold, ime) {
  const order = await resolveOrderForSoldIme(session, sold, ime);
  if (!order) return { orderUpdated: false, orderDeleted: false };

  const { soldImeCodes, directSale: lineDirectSale } = stripImeFromLineOrder(order, ime);
  const receiptPatch = patchReceiptSnapshotForRevokedUnit(lineDirectSale, {
    revokedIme: ime,
    productName: sold.productName,
    productId: sold.productId,
    unitPrice: sold.unitPrice,
  });

  const remainingOnLine = countLineRemainingUnits(soldImeCodes, receiptPatch.imeManifest);
  const unitPriceFromSale =
    Number(sold.unitPrice) ||
    Number(receiptPatch.soldUnitPrice) ||
    Number(order.productPrice) ||
    0;

  const batchId = receiptPatch.saleBatchId ? String(receiptPatch.saleBatchId) : '';

  if (batchId) {
    const batchOrders = await Order.find({ 'directSale.saleBatchId': batchId }).session(session);
    let orderDeleted = false;

    for (const batchOrder of batchOrders) {
      const isOwner = String(batchOrder._id) === String(order._id);

      if (isOwner) {
        if (remainingOnLine <= 0) {
          await Order.deleteOne({ _id: batchOrder._id }).session(session);
          orderDeleted = true;
          continue;
        }

        batchOrder.soldImeCodes = soldImeCodes;
        batchOrder.quantity = remainingOnLine;
        batchOrder.finalPrice =
          unitPriceFromSale > 0
            ? unitPriceFromSale * remainingOnLine
            : Math.max(0, Number(batchOrder.finalPrice) || 0);
        batchOrder.originalTotal = batchOrder.finalPrice;
        batchOrder.directSale = receiptPatch;
        batchOrder.markModified('directSale');
        await batchOrder.save({ session });
        continue;
      }

      const siblingDirect =
        batchOrder.directSale && typeof batchOrder.directSale === 'object' && !Array.isArray(batchOrder.directSale)
          ? { ...batchOrder.directSale }
          : {};
      batchOrder.directSale = {
        ...siblingDirect,
        receiptUnitRows: receiptPatch.receiptUnitRows,
        receiptLines: receiptPatch.receiptLines,
        receiptGrandTotal: receiptPatch.receiptGrandTotal,
      };
      batchOrder.markModified('directSale');
      await batchOrder.save({ session });
    }

    return { orderUpdated: !orderDeleted && remainingOnLine > 0, orderDeleted };
  }

  if (remainingOnLine <= 0) {
    await Order.deleteOne({ _id: order._id }).session(session);
    return { orderUpdated: false, orderDeleted: true };
  }

  order.soldImeCodes = soldImeCodes;
  order.quantity = remainingOnLine;
  order.finalPrice =
    unitPriceFromSale > 0
      ? unitPriceFromSale * remainingOnLine
      : Math.max(0, Number(order.finalPrice) || 0);
  order.originalTotal = order.finalPrice;
  order.directSale = receiptPatch;
  order.markModified('directSale');
  await order.save({ session });

  return { orderUpdated: true, orderDeleted: false };
}

module.exports = {
  normalizeIme,
  orderOwnsImeOnLine,
  applyDirectSaleRevokeToOrders,
  resolveOrderForSoldIme,
};
