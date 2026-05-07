/** Normalize role strings from JWT / DB so Admin, wholesale, etc. match allow-lists. */
function normalizeRoleToken(r) {
  const s = String(r || '').toLowerCase().trim();
  if (!s) return '';
  if (s === 'administrator' || s === 'superadmin') return 'admin';
  if (s === 'wholesale') return 'wholesaler';
  return s;
}

/**
 * @param {string|string[]} allowedRoles — role name(s) allowed (case-insensitive)
 */
function verifyRole(allowedRoles) {
  const list = [].concat(allowedRoles || []).map((r) => normalizeRoleToken(r)).filter(Boolean);

  return (req, res, next) => {
    const fromUser = req.user?.role ?? req.user?.Role ?? req.user?.userRole ?? req.role;
    const fromArr = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const candidates = [fromUser, ...fromArr].map((r) => normalizeRoleToken(r)).filter(Boolean);
    const ok = list.some((allowed) => candidates.includes(allowed));
    if (!ok) {
      return res.status(403).json({
        message:
          list.length > 0
            ? `Forbidden — requires one of these roles: ${list.join(',')}`
            : 'Forbidden',
        success: false,
      });
    }
    next();
  };
}

module.exports = verifyRole;
