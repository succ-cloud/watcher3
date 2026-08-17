/** ItemsList schema allows only ASCII city keys; map UI / legacy spellings */
function normalizeProductPhoneLocation(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  const lower = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (lower === 'yaounde') return 'Yaounde';
  return s;
}

module.exports = { normalizeProductPhoneLocation };
