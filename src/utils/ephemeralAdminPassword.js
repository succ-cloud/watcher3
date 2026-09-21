const jwt = require('jsonwebtoken');
const normalizeRoleToken = require('./normalizeRoleToken');
const { ROLES } = require('../models/User');

const DEFAULT_TTL_MINUTES = 12 * 60;
const MIN_TTL_MINUTES = 5;
const MAX_TTL_MINUTES = 24 * 60;

function resolveTtlMs() {
  const parsed = parseInt(process.env.ADMIN_EPHEMERAL_PASSWORD_TTL_MINUTES, 10);
  const minutes = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, MIN_TTL_MINUTES), MAX_TTL_MINUTES)
    : DEFAULT_TTL_MINUTES;
  return minutes * 60 * 1000;
}

const TTL_MS = resolveTtlMs();
const vault = new Map();

function vaultKey(adminId, userId) {
  return `${String(adminId)}|${String(userId)}`;
}

function purgeExpiredEntries() {
  const now = Date.now();
  for (const [key, entry] of vault.entries()) {
    if (!entry || entry.expiresAt <= now) {
      vault.delete(key);
    }
  }
}

setInterval(purgeExpiredEntries, 10 * 60 * 1000).unref?.();

/** Mongo / JWT user id of the authenticated admin (from verifyJWT or Bearer on register). */
function resolveRequestUserId(req) {
  const fromMiddleware = String(
    req?.userId || req?.user?.userId || req?.user?.id || req?.user?._id || '',
  ).trim();
  if (fromMiddleware) return fromMiddleware;

  try {
    const authHeader = req?.headers?.authorization || req?.headers?.Authorization;
    if (!authHeader || !String(authHeader).startsWith('Bearer ')) return '';
    const token = String(authHeader).split(' ')[1];
    if (!token || !process.env.ACCESS_TOKEN_SECRET) return '';
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    const info =
      decoded.UserInfo && typeof decoded.UserInfo === 'object'
        ? { ...decoded.UserInfo, role: decoded.UserInfo.role ?? decoded.role }
        : decoded;
    return String(
      info.userId || info.id || info._id || decoded.userId || decoded.sub || '',
    ).trim();
  } catch {
    return '';
  }
}

/**
 * Store a plain password in memory for admin UI only (never persisted).
 * Scoped to the admin who set/created it and the target user.
 */
function setEphemeralAdminPassword(adminId, userId, password) {
  const a = String(adminId || '').trim();
  const u = String(userId || '').trim();
  const pwd = String(password || '').trim();
  if (!a || !u || !pwd) return;
  purgeExpiredEntries();
  vault.set(vaultKey(a, u), {
    password: pwd,
    expiresAt: Date.now() + TTL_MS,
  });
}

/** Returns plain password if this admin still has a non-expired entry for the user. */
function getEphemeralAdminPassword(adminId, userId) {
  const a = String(adminId || '').trim();
  const u = String(userId || '').trim();
  if (!a || !u) return null;
  const entry = vault.get(vaultKey(a, u));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    vault.delete(vaultKey(a, u));
    return null;
  }
  return entry.password;
}

function clearEphemeralAdminPassword(adminId, userId) {
  vault.delete(vaultKey(adminId, userId));
}

/** Prevent non-admins from receiving vault passwords via API helpers. */
function requesterIsAdmin(req) {
  const role = normalizeRoleToken(req?.user?.role ?? req?.role ?? req?.user?.Role);
  return role === ROLES.ADMIN;
}

module.exports = {
  setEphemeralAdminPassword,
  getEphemeralAdminPassword,
  clearEphemeralAdminPassword,
  resolveRequestUserId,
  requesterIsAdmin,
};
