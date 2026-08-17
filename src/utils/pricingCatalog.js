/**
 * Shared helpers for the central retail pricing catalog.
 * Products match on product name + brand + capacity (case-insensitive).
 */

function normPart(value) {
  return String(value ?? '').trim().toLowerCase();
}

const LEADING_BRAND_PREFIXES = [
  'google',
  'samsung',
  'apple',
  'honor',
  'huawei',
  'xiaomi',
  'oneplus',
  'motorola',
  'nokia',
  'oppo',
  'vivo',
  'realme',
];

function stripLeadingBrandPrefix(normalizedCompactName) {
  let s = String(normalizedCompactName || '');
  for (const prefix of LEADING_BRAND_PREFIXES) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }
  return s;
}

/** Product names for pricing ↔ inventory matching (ignore case, spaces, symbols, leading brand). */
function normProductName(value) {
  const compact = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[®™©'’`"]/g, '')
    .replace(/\s+/g, '');
  return stripLeadingBrandPrefix(compact);
}

/** Normalize storage labels so "64 GB", "64GB", and "64" compare equal. */
function normCapacity(value) {
  const compact = normPart(value).replace(/\s+/g, '');
  if (!compact) return '';
  const exact = compact.match(/^(\d+)(tb|gb|mb)?$/);
  if (exact) return `${exact[1]}${exact[2] || 'gb'}`;
  const embedded = compact.match(/(\d+)(tb|gb|mb)/);
  if (embedded) return `${embedded[1]}${embedded[2]}`;
  const digitsOnly = compact.match(/^(\d+)$/);
  if (digitsOnly) return `${digitsOnly[1]}gb`;
  return compact;
}

function capacitiesMatch(a, b) {
  const ca = normCapacity(a);
  const cb = normCapacity(b);
  if (ca && cb) return ca === cb;
  return normPart(a) === normPart(b);
}

function buildCatalogKey({ productName, brand, capacity }) {
  return [normPart(productName), normPart(brand), normPart(capacity)].join('|');
}

function catalogKeyFromProduct(product) {
  if (!product) return '';
  return buildCatalogKey({
    productName: product.product_name ?? product.productName,
    brand: product.brand,
    capacity: product.capacity,
  });
}

function hasCatalogIdentity({ productName, brand, capacity }) {
  return Boolean(normPart(productName) && normPart(brand) && normPart(capacity));
}

function nameBrandKeyFromProduct(product) {
  return [normPart(product?.product_name ?? product?.productName), normPart(product?.brand)].join('|');
}

function nameBrandKeyFromEntry(entry) {
  return [normPart(entry?.productName ?? entry?.product_name), normPart(entry?.brand)].join('|');
}

function nameCapacityKeyFromProduct(product) {
  const productName = normProductName(product?.product_name ?? product?.productName);
  const capacity = normCapacity(product?.capacity);
  if (!productName || !capacity) return '';
  return [productName, capacity].join('|');
}

function nameCapacityKeyFromEntry(entry) {
  const productName = normProductName(entry?.productName ?? entry?.product_name);
  const capacity = normCapacity(entry?.capacity);
  if (!productName || !capacity) return '';
  return [productName, capacity].join('|');
}

/** Vendor shop listing stock — same model + brand + capacity across all colors/locations. */
function vendorListingStockKeyFromProduct(product) {
  const productName = normProductName(product?.product_name ?? product?.productName);
  const brand = normPart(product?.brand);
  const capacity = normCapacity(product?.capacity);
  if (!productName) {
    return [normPart(product?.product_name), brand, normPart(product?.capacity)].join('|');
  }
  return [productName, brand, capacity].join('|');
}

module.exports = {
  buildCatalogKey,
  catalogKeyFromProduct,
  hasCatalogIdentity,
  normPart,
  normProductName,
  normCapacity,
  capacitiesMatch,
  nameBrandKeyFromProduct,
  nameBrandKeyFromEntry,
  nameCapacityKeyFromProduct,
  nameCapacityKeyFromEntry,
  vendorListingStockKeyFromProduct,
};
