const CREDENTIAL_PREFIX = '__pwd__:';

/**
 * Persist a login password for admin account directory visibility.
 * Writes adminCredentialNote and a legacy adminNotes fallback (__pwd__:...)
 * so credentials survive partial deploys where the new schema field is not yet active.
 */
function buildAdminNotesPasswordValue(password) {
  return `${CREDENTIAL_PREFIX}${String(password)}`;
}

function resolvePasswordOnFile(doc) {
  if (!doc || typeof doc !== 'object') return '';

  const note = String(doc.adminCredentialNote ?? '').trim();
  if (note) return note;

  const legacy = String(doc.adminNotes ?? '').trim();
  if (legacy.startsWith(CREDENTIAL_PREFIX)) {
    return legacy.slice(CREDENTIAL_PREFIX.length).trim();
  }

  return '';
}

function attachPasswordDisplay(doc) {
  const row = doc?.toObject ? doc.toObject() : { ...doc };
  const passwordDisplay = resolvePasswordOnFile(row);
  return {
    ...row,
    passwordDisplay: passwordDisplay || null,
    passwordOnFile: passwordDisplay || null,
  };
}

async function recordPasswordForAdmin(User, userId, password) {
  const pw = String(password);
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        adminCredentialNote: pw,
        adminNotes: buildAdminNotesPasswordValue(pw),
      },
    },
  );
}

module.exports = {
  CREDENTIAL_PREFIX,
  buildAdminNotesPasswordValue,
  resolvePasswordOnFile,
  attachPasswordDisplay,
  recordPasswordForAdmin,
};
