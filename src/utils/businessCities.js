const BusinessCity = require('../models/BusinessCity');

const DEFAULT_BUSINESS_CITIES = ['Bamenda', 'Yaounde', 'Douala'];

function normalizeBusinessCityName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function formatBusinessCityName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ');
}

async function listActiveBusinessCities() {
  try {
    const rows = await BusinessCity.find({ isActive: true }).sort({ name: 1 }).lean();
    const names = rows
      .map((r) => formatBusinessCityName(r?.name))
      .filter(Boolean);
    if (names.length) return names;
  } catch {
    // Fall back to defaults when collection is unavailable.
  }
  return [...DEFAULT_BUSINESS_CITIES];
}

async function ensureDefaultBusinessCities() {
  for (const city of DEFAULT_BUSINESS_CITIES) {
    const name = formatBusinessCityName(city);
    const normalizedName = normalizeBusinessCityName(name);
    // eslint-disable-next-line no-await-in-loop
    await BusinessCity.updateOne(
      { normalizedName },
      {
        $setOnInsert: {
          name,
          normalizedName,
          isActive: true,
        },
      },
      { upsert: true },
    );
  }
}

module.exports = {
  DEFAULT_BUSINESS_CITIES,
  normalizeBusinessCityName,
  formatBusinessCityName,
  listActiveBusinessCities,
  ensureDefaultBusinessCities,
};
