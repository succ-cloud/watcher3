/** True when businessAddress indicates a USA-based admin account. */
function isUsaBusinessAddress(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return false;
  const lower = s.toLowerCase();

  if (/^(usa|u\.?\s*s\.?\s*a\.?|united states( of america)?)$/.test(lower)) return true;
  if (/\b(united states( of america)?|u\.?\s*s\.?\s*a\.?)\b/.test(lower)) return true;
  if (/\busa\b/.test(lower) && !/\bcameroon\b/.test(lower)) return true;
  if (/,?\s*usa\s*$/i.test(s)) return true;
  if (/\b(us|u\.s\.)\b/.test(lower) && !/\bcameroon\b/.test(lower)) return true;

  if (/\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/.test(s)) return true;

  if (
    /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/.test(
      s,
    ) &&
    !/\bcameroon\b/.test(lower)
  ) {
    return true;
  }

  return false;
}

function getAdminAccountRegion(raw) {
  return isUsaBusinessAddress(raw) ? 'usa' : 'cameroon';
}

function getAdminAccountLabel(raw) {
  return isUsaBusinessAddress(raw) ? 'USA WACHE' : 'Cameroon account';
}

module.exports = {
  isUsaBusinessAddress,
  getAdminAccountRegion,
  getAdminAccountLabel,
};
