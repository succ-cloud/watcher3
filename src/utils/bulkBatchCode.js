const crypto = require('crypto');

/** Generate a unique bulk shipment tracking code, e.g. BULK-20260530-A1B2C3 */
function generateBulkBatchCode(date = new Date()) {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `BULK-${ymd}-${suffix}`;
}

module.exports = { generateBulkBatchCode };
