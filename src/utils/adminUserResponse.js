const { attachPasswordDisplay } = require('./adminCredential');
const {
  getEphemeralAdminPassword,
  resolveRequestUserId,
  requesterIsAdmin,
} = require('./ephemeralAdminPassword');

/**
 * User payload for admin APIs: bcrypt hash never included; plain password only from
 * in-memory vault (same admin, TTL) or immediately after create/reset (justSetPassword).
 */
function attachAdminUserResponse(doc, req, { justSetPassword = null } = {}) {
  if (!requesterIsAdmin(req)) {
    return attachPasswordDisplay(doc);
  }

  const adminId = resolveRequestUserId(req);
  const userId = String(doc?._id ?? doc?.id ?? '');
  let ephemeral = justSetPassword ? String(justSetPassword).trim() : '';
  if (!ephemeral && adminId && userId) {
    ephemeral = getEphemeralAdminPassword(adminId, userId) || '';
  }

  return attachPasswordDisplay(doc, { ephemeralPassword: ephemeral || null });
}

module.exports = {
  attachAdminUserResponse,
};
