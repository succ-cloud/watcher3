const PricingCatalogOptions = require('../models/PricingCatalogOptions');
const { getOrCreatePricingCatalogOptions } = require('../models/PricingCatalogOptions');

function normalizeBrand(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeProductName(value) {
  return String(value || '').trim();
}

function serializeProductNamesByBrand(mapOrObj) {
  const out = {};
  if (!mapOrObj) return out;
  if (mapOrObj instanceof Map) {
    for (const [key, list] of mapOrObj.entries()) {
      const brand = normalizeBrand(key);
      if (!brand) continue;
      out[brand] = [...new Set((Array.isArray(list) ? list : []).map(normalizeProductName).filter(Boolean))];
    }
    return out;
  }
  if (typeof mapOrObj === 'object') {
    for (const [key, list] of Object.entries(mapOrObj)) {
      const brand = normalizeBrand(key);
      if (!brand) continue;
      out[brand] = [...new Set((Array.isArray(list) ? list : []).map(normalizeProductName).filter(Boolean))];
    }
  }
  return out;
}

async function getPricingCatalogOptionsPayload() {
  const doc = await getOrCreatePricingCatalogOptions();
  const brands = [...new Set((doc.brands || []).map(normalizeBrand).filter(Boolean))].sort();
  const productNamesByBrand = serializeProductNamesByBrand(doc.productNamesByBrand);
  return { brands, productNamesByBrand };
}

async function addPricingCatalogBrand(rawBrand) {
  const brand = normalizeBrand(rawBrand);
  if (!brand) {
    const err = new Error('Brand name is required.');
    err.statusCode = 400;
    throw err;
  }
  if (brand.length > 120) {
    const err = new Error('Brand name is too long.');
    err.statusCode = 400;
    throw err;
  }

  const doc = await getOrCreatePricingCatalogOptions();
  const brands = [...new Set([...(doc.brands || []).map(normalizeBrand), brand])];
  doc.brands = brands;
  if (!doc.productNamesByBrand) {
    doc.productNamesByBrand = new Map();
  }
  if (!doc.productNamesByBrand.get(brand)) {
    doc.productNamesByBrand.set(brand, []);
  }
  doc.markModified('productNamesByBrand');
  await doc.save();

  return getPricingCatalogOptionsPayload();
}

async function addPricingCatalogProductName(rawBrand, rawName) {
  const brand = normalizeBrand(rawBrand);
  const name = normalizeProductName(rawName);
  if (!brand) {
    const err = new Error('Brand is required.');
    err.statusCode = 400;
    throw err;
  }
  if (!name) {
    const err = new Error('Product name is required.');
    err.statusCode = 400;
    throw err;
  }
  if (name.length > 200) {
    const err = new Error('Product name is too long.');
    err.statusCode = 400;
    throw err;
  }

  const doc = await getOrCreatePricingCatalogOptions();
  const brands = [...new Set([...(doc.brands || []).map(normalizeBrand), brand])];
  doc.brands = brands;

  if (!doc.productNamesByBrand) {
    doc.productNamesByBrand = new Map();
  }
  const prev = doc.productNamesByBrand.get(brand) || [];
  const next = [...new Set([...(Array.isArray(prev) ? prev : []), name])];
  doc.productNamesByBrand.set(brand, next);
  doc.markModified('productNamesByBrand');
  await doc.save();

  return getPricingCatalogOptionsPayload();
}

module.exports = {
  getPricingCatalogOptionsPayload,
  addPricingCatalogBrand,
  addPricingCatalogProductName,
};
