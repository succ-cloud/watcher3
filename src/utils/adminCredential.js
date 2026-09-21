const CREDENTIAL_PREFIX = '__pwd__:';

/** Remove legacy plain-text password markers from adminNotes. */
function stripLegacyPasswordFromAdminNotes(adminNotes) {
  const legacy = String(adminNotes ?? '').trim();
  if (legacy.startsWith(CREDENTIAL_PREFIX)) {
    return '';
  }
  return legacy;
}

/**
 * Sanitize user doc for API responses. Passwords are never read from the database.
 * ephemeralPassword is supplied only from in-memory admin vault or right after create/reset.
 */
function attachPasswordDisplay(doc, { ephemeralPassword = null } = {}) {
  const row = doc?.toObject ? doc.toObject() : { ...doc };
  delete row.password;
  delete row.adminCredentialNote;
  delete row.refreshToken;

  const adminNotes = stripLegacyPasswordFromAdminNotes(row.adminNotes);
  const display = ephemeralPassword ? String(ephemeralPassword).trim() : '';

  return {
    ...row,
    adminNotes: adminNotes || undefined,
    passwordDisplay: display || null,
  };
}

/** Strip legacy DB fields that once stored plain-text passwords (hashed password unchanged). */
async function clearPlaintextCredentials(User, userId) {
  if (!userId) return;
  const user = await User.findById(userId).select('adminNotes').lean();
  if (!user) return;

  const update = { $unset: { adminCredentialNote: '' } };
  const cleanedNotes = stripLegacyPasswordFromAdminNotes(user.adminNotes);
  const notesChanged = cleanedNotes !== String(user.adminNotes ?? '').trim();

  if (notesChanged) {
    update.$set = { adminNotes: cleanedNotes || '' };
  }

  await User.updateOne({ _id: userId }, update);
}

/** Remove legacy plain-text password data from all user documents (safe to run repeatedly). */
async function purgePlaintextCredentialsFromDatabase(User) {
  await User.updateMany(
    { adminCredentialNote: { $exists: true } },
    { $unset: { adminCredentialNote: '' } },
  );

  const withLegacyNotes = await User.find({
    adminNotes: { $regex: `^${CREDENTIAL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
  })
    .select('_id adminNotes')
    .lean();

  for (const row of withLegacyNotes) {
    const cleaned = stripLegacyPasswordFromAdminNotes(row.adminNotes);
    await User.updateOne({ _id: row._id }, { $set: { adminNotes: cleaned || '' } });
  }
}

module.exports = {
  CREDENTIAL_PREFIX,
  stripLegacyPasswordFromAdminNotes,
  attachPasswordDisplay,
  clearPlaintextCredentials,
  purgePlaintextCredentialsFromDatabase,
};
