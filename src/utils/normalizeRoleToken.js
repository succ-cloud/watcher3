/** Normalize role strings from JWT / DB so Admin, wholesale, etc. match allow-lists. */
function normalizeRoleToken(r) {
  const s = String(r || '').toLowerCase().trim();
  if (!s) return '';
  if (s === 'administrator' || s === 'superadmin') return 'admin';
  if (s === 'wholesale') return 'wholesaler';
  return s;
}

module.exports = normalizeRoleToken;
