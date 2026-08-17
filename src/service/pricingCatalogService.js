const Product = require('../models/ItemsList');
const ProductPricing = require('../models/ProductPricing');
const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_POPULATE } = require('../utils/warehousePopulate');
const { resolveEffectiveLineStock } = require('../utils/productIme');
const {
  buildCatalogKey,
  catalogKeyFromProduct,
  capacitiesMatch,
  normPart,
  normProductName,
  normCapacity,
  nameCapacityKeyFromProduct,
  nameCapacityKeyFromEntry,
  vendorListingStockKeyFromProduct,
} = require('../utils/pricingCatalog');

const MAX_PRICING_IMAGES = 5;

function requestUserId(req) {
  return req?.user?.userId || req?.user?.id || req?.user?._id || null;
}

function normalizePricingImages(source) {
  const doc = source?.toObject ? source.toObject() : source;
  const fromArray = Array.isArray(doc?.images)
    ? doc.images.filter((img) => String(img?.url || '').trim())
    : [];
  if (fromArray.length) {
    return fromArray.map((img, index) => ({
      url: String(img.url).trim(),
      publicId: String(img.publicId || '').trim(),
      isPrimary: Boolean(img.isPrimary) || index === 0,
      alt: String(img.alt || doc?.imageAlt || doc?.productName || 'product image').trim(),
      uploadedAt: img.uploadedAt || null,
    }));
  }

  const url = String(doc?.imageUrl || '').trim();
  if (!url) return [];

  return [
    {
      url,
      publicId: String(doc.imagePublicId || '').trim(),
      isPrimary: true,
      alt: String(doc.imageAlt || doc?.productName || 'product image').trim(),
      uploadedAt: null,
    },
  ];
}

function syncPrimaryImageFields(target) {
  const images = normalizePricingImages(target).slice(0, MAX_PRICING_IMAGES);
  if (!images.length) {
    target.images = [];
    target.imageUrl = '';
    target.imagePublicId = '';
    target.imageAlt = '';
    return;
  }

  if (!images.some((img) => img.isPrimary)) {
    images[0].isPrimary = true;
  }

  const primary = images.find((img) => img.isPrimary) || images[0];
  target.images = images;
  target.imageUrl = primary.url;
  target.imagePublicId = primary.publicId || '';
  target.imageAlt = primary.alt || target.productName || 'product image';
}

function imageDocFromUploadFile(file, altFallback = 'product image') {
  if (!file || typeof file !== 'object') return null;

  const url = String(
    file.path || file.url || file.secure_url || file?.cloudinary?.secure_url || file?.cloudinary?.url || '',
  ).trim();
  if (!url) return null;

  return {
    url,
    publicId: String(file.filename || file.public_id || file?.cloudinary?.public_id || '').trim(),
    alt: String(file.originalname || altFallback).trim() || altFallback,
    isPrimary: false,
    uploadedAt: new Date(),
  };
}

function mergeUploadedFilesIntoRow(row, files, { replace = false } = {}) {
  const incoming = (Array.isArray(files) ? files : [])
    .map((file) => imageDocFromUploadFile(file, row?.productName || 'product image'))
    .filter(Boolean);

  if (!incoming.length) return;

  let images = replace ? [] : normalizePricingImages(row);
  for (const img of incoming) {
    if (images.length >= MAX_PRICING_IMAGES) break;
    images.push({ ...img, isPrimary: images.length === 0 });
  }

  row.images = images;
  syncPrimaryImageFields(row);
}

function parseRemoveImagePublicIds(body) {
  const raw = body?.removeImagePublicIds;
  if (Array.isArray(raw)) {
    return raw.map((id) => String(id || '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((id) => String(id || '').trim()).filter(Boolean);
      }
    } catch {
      return raw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function serializePricingRow(row) {
  if (!row) return null;
  const doc = row.toObject ? row.toObject() : { ...row };
  const payload = { ...doc };
  syncPrimaryImageFields(payload);
  const images = normalizePricingImages(payload);

  return {
    id: String(doc._id),
    productName: doc.productName,
    brand: doc.brand,
    capacity: doc.capacity,
    retailPrice: doc.retailPrice,
    wholesalePrice: doc.wholesalePrice ?? null,
    catalogKey: doc.catalogKey,
    imageUrl: payload.imageUrl,
    imagePublicId: payload.imagePublicId,
    imageAlt: payload.imageAlt,
    images: images.map((img) => ({
      url: img.url,
      publicId: img.publicId,
      isPrimary: Boolean(img.isPrimary),
      alt: img.alt,
      uploadedAt: img.uploadedAt,
    })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function applyImageFieldsToRow(row, body) {
  if (!row || !body || typeof body !== 'object') return;

  const clearImage =
    body.clearImage === true ||
    body.clearImage === 'true' ||
    body.clearImage === '1';

  const removeIds = parseRemoveImagePublicIds(body);
  if (removeIds.length) {
    let images = normalizePricingImages(row).filter((img) => !removeIds.includes(img.publicId));
    if (images.length && !images.some((img) => img.isPrimary)) {
      images[0].isPrimary = true;
    }
    row.images = images;
    syncPrimaryImageFields(row);
  }

  if (clearImage) {
    row.images = [];
    syncPrimaryImageFields(row);
    return;
  }

  if (Array.isArray(body.images) && body.images.length) {
    row.images = body.images
      .filter((img) => String(img?.url || img?.imageUrl || '').trim())
      .slice(0, MAX_PRICING_IMAGES)
      .map((img, index) => ({
        url: String(img.url || img.imageUrl).trim(),
        publicId: String(img.publicId || img.imagePublicId || '').trim(),
        isPrimary: Boolean(img.isPrimary) || index === 0,
        alt: String(img.alt || img.imageAlt || row.productName || 'product image').trim(),
        uploadedAt: img.uploadedAt || new Date(),
      }));
    syncPrimaryImageFields(row);
    return;
  }

  if (body.imageUrl != null && String(body.imageUrl).trim()) {
    row.images = [
      {
        url: String(body.imageUrl).trim(),
        publicId: String(body.imagePublicId || '').trim(),
        isPrimary: true,
        alt: String(body.imageAlt || row.productName || 'product image').trim(),
        uploadedAt: new Date(),
      },
    ];
    syncPrimaryImageFields(row);
    return;
  }

  if (body.imagePublicId != null && body.imagePublicId !== '') {
    row.imagePublicId = String(body.imagePublicId).trim();
  }
  if (body.imageAlt != null) {
    row.imageAlt = String(body.imageAlt).trim();
  }
}

function applyCatalogImageToPayload(productData, entry) {
  const entryImages = normalizePricingImages(entry);
  if (!entryImages.length) {
    return false;
  }
  const existing = Array.isArray(productData?.images) ? productData.images : [];
  if (existing.length > 0) {
    return false;
  }

  productData.images = entryImages.slice(0, MAX_PRICING_IMAGES).map((img, index) => ({
    url: img.url,
    publicId: img.publicId || `pricing-${entry.catalogKey || 'image'}-${index}`,
    isPrimary: index === 0,
    alt: img.alt || productData?.product_name || entry.productName || 'product image',
  }));

  const primary = productData.images[0];
  productData.primaryImage = {
    url: primary.url,
    publicId: primary.publicId,
    alt: primary.alt,
  };
  return true;
}

function buildSearchFilter(search) {
  const q = String(search || '').trim();
  if (!q) return {};
  const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return {
    $or: [{ productName: regex }, { brand: regex }, { capacity: regex }],
  };
}

async function listPricingCatalog({ search } = {}) {
  const filter = buildSearchFilter(search);
  const rows = await ProductPricing.find(filter)
    .sort({ productName: 1, brand: 1, capacity: 1 })
    .lean();
  return rows.map(serializePricingRow);
}

async function createPricingEntry(req, body, files) {
  const productName = String(body?.productName || '').trim();
  const brand = String(body?.brand || '').trim();
  const capacity = String(body?.capacity || '').trim();
  const retailPrice = Number(body?.retailPrice);
  const wholesaleRaw = body?.wholesalePrice;
  const wholesalePrice =
    wholesaleRaw != null && wholesaleRaw !== '' ? Number(wholesaleRaw) : null;

  if (!productName || !brand || !capacity) {
    const err = new Error('Product name, brand, and capacity are required.');
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isFinite(retailPrice) || retailPrice < 0) {
    const err = new Error('Retail price must be a non-negative number.');
    err.statusCode = 400;
    throw err;
  }
  if (wholesalePrice != null && (!Number.isFinite(wholesalePrice) || wholesalePrice < 0)) {
    const err = new Error('Wholesale price must be a non-negative number.');
    err.statusCode = 400;
    throw err;
  }

  const catalogKey = buildCatalogKey({ productName, brand, capacity });
  const existing = await ProductPricing.findOne({ catalogKey });
  if (existing) {
    const err = new Error('A pricing entry already exists for this product variant.');
    err.statusCode = 409;
    throw err;
  }

  const userId = requestUserId(req);
  const createPayload = {
    productName,
    brand,
    capacity,
    retailPrice,
    wholesalePrice,
    createdBy: userId,
    updatedBy: userId,
  };
  applyImageFieldsToRow(createPayload, body);
  if (Array.isArray(files) && files.length) {
    mergeUploadedFilesIntoRow(createPayload, files);
  }
  const row = await ProductPricing.create(createPayload);

  return serializePricingRow(row);
}

async function updatePricingEntry(req, id, body, files) {
  const row = await ProductPricing.findById(id);
  if (!row) {
    const err = new Error('Pricing entry not found.');
    err.statusCode = 404;
    throw err;
  }

  const nextName = body?.productName != null ? String(body.productName).trim() : row.productName;
  const nextBrand = body?.brand != null ? String(body.brand).trim() : row.brand;
  const nextCapacity = body?.capacity != null ? String(body.capacity).trim() : row.capacity;

  if (!nextName || !nextBrand || !nextCapacity) {
    const err = new Error('Product name, brand, and capacity cannot be empty.');
    err.statusCode = 400;
    throw err;
  }

  const nextKey = buildCatalogKey({
    productName: nextName,
    brand: nextBrand,
    capacity: nextCapacity,
  });
  const duplicate = await ProductPricing.findOne({ catalogKey: nextKey, _id: { $ne: row._id } });
  if (duplicate) {
    const err = new Error('Another pricing entry already uses this product variant.');
    err.statusCode = 409;
    throw err;
  }

  row.productName = nextName;
  row.brand = nextBrand;
  row.capacity = nextCapacity;
  row.catalogKey = nextKey;

  if (body?.retailPrice != null && body.retailPrice !== '') {
    const retailPrice = Number(body.retailPrice);
    if (!Number.isFinite(retailPrice) || retailPrice < 0) {
      const err = new Error('Retail price must be a non-negative number.');
      err.statusCode = 400;
      throw err;
    }
    row.retailPrice = retailPrice;
  }

  if (body?.wholesalePrice != null && body.wholesalePrice !== '') {
    const wholesalePrice = Number(body.wholesalePrice);
    if (!Number.isFinite(wholesalePrice) || wholesalePrice < 0) {
      const err = new Error('Wholesale price must be a non-negative number.');
      err.statusCode = 400;
      throw err;
    }
    row.wholesalePrice = wholesalePrice;
  } else if (body?.wholesalePrice === '' || body?.wholesalePrice === null) {
    row.wholesalePrice = null;
  }

  row.updatedBy = requestUserId(req);
  applyImageFieldsToRow(row, body);
  if (Array.isArray(files) && files.length) {
    mergeUploadedFilesIntoRow(row, files);
  }
  syncPrimaryImageFields(row);
  await row.save();

  if (row.wholesalePrice != null) {
    await syncInventoryWholesalePriceForCatalogKey(nextKey, row.wholesalePrice);
  }

  return serializePricingRow(row);
}

async function appendPricingImages(req, id, files) {
  const row = await ProductPricing.findById(id);
  if (!row) {
    const err = new Error('Pricing entry not found.');
    err.statusCode = 404;
    throw err;
  }

  mergeUploadedFilesIntoRow(row, files);
  row.updatedBy = requestUserId(req);
  syncPrimaryImageFields(row);
  await row.save();
  return serializePricingRow(row);
}

async function syncInventoryWholesalePriceForCatalogKey(catalogKey, wholesalePrice) {
  if (!catalogKey || !Number.isFinite(Number(wholesalePrice))) return { modifiedCount: 0 };

  const [namePart, brandPart, capacityPart] = catalogKey.split('|');
  if (!namePart || !brandPart || !capacityPart) return { modifiedCount: 0 };

  const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const products = await Product.find({
    product_name: new RegExp(`^${escapeRegex(namePart)}$`, 'i'),
    brand: new RegExp(`^${escapeRegex(brandPart)}$`, 'i'),
    capacity: new RegExp(`^${escapeRegex(capacityPart)}$`, 'i'),
  })
    .select('_id')
    .lean();

  if (!products.length) return { modifiedCount: 0 };

  const ids = products.map((p) => p._id);
  const result = await Product.updateMany({ _id: { $in: ids } }, { $set: { price: wholesalePrice } });
  return { modifiedCount: result.modifiedCount || 0 };
}

/** @deprecated Use syncInventoryWholesalePriceForCatalogKey */
async function syncInventoryPriceForCatalogKey(catalogKey, wholesalePrice) {
  return syncInventoryWholesalePriceForCatalogKey(catalogKey, wholesalePrice);
}

/**
 * Apply catalog retail price to a plain product payload before save.
 * Returns { applied: boolean, catalogKey, retailPrice }.
 */
async function applyCatalogPricingToPayload(productData) {
  const catalogKey = catalogKeyFromProduct(productData);
  if (!catalogKey.replace(/\|/g, '').length) {
    return { applied: false, catalogKey: '', retailPrice: null, missingCatalog: true };
  }

  const entry = await ProductPricing.findOne({ catalogKey }).lean();
  if (!entry) {
    return { applied: false, catalogKey, retailPrice: null, missingCatalog: true };
  }

  const currentPrice = Number(productData.price);
  if (
    entry.wholesalePrice != null &&
    Number.isFinite(Number(entry.wholesalePrice)) &&
    (!Number.isFinite(currentPrice) || currentPrice <= 0)
  ) {
    productData.price = entry.wholesalePrice;
  }

  const imageApplied = applyCatalogImageToPayload(productData, entry);

  return {
    applied: true,
    catalogKey,
    retailPrice: entry.retailPrice,
    wholesalePrice: entry.wholesalePrice ?? null,
    missingCatalog: false,
    imageApplied,
  };
}

async function listCatalogKeys() {
  const rows = await ProductPricing.find({}).select('catalogKey').lean();
  return new Set(rows.map((r) => r.catalogKey));
}

/**
 * Save retail/wholesale prices from a product upload into the pricing catalog.
 */
async function upsertPricingFromProductUpload(productData, userId) {
  const productName = String(productData?.product_name ?? productData?.productName ?? '').trim();
  const brand = String(productData?.brand ?? '').trim();
  const capacity = String(productData?.capacity ?? '').trim();
  if (!productName || !brand || !capacity) return null;

  const retailRaw = productData?.retailPrice;
  const retailPrice =
    retailRaw != null && retailRaw !== '' && Number.isFinite(Number(retailRaw))
      ? Number(retailRaw)
      : null;
  const wholesaleRaw = productData?.price;
  const wholesalePrice =
    wholesaleRaw != null && wholesaleRaw !== '' && Number.isFinite(Number(wholesaleRaw))
      ? Number(wholesaleRaw)
      : null;

  if (retailPrice == null && wholesalePrice == null) return null;

  const catalogKey = buildCatalogKey({ productName, brand, capacity });
  let row = await ProductPricing.findOne({ catalogKey });

  if (row) {
    if (wholesalePrice != null) row.wholesalePrice = wholesalePrice;
    if (retailPrice != null) row.retailPrice = retailPrice;
    row.updatedBy = userId;
    await row.save();
    return row;
  }

  if (retailPrice == null) return null;

  row = await ProductPricing.create({
    productName,
    brand,
    capacity,
    retailPrice,
    wholesalePrice,
    createdBy: userId,
    updatedBy: userId,
  });
  return row;
}

function productHasOwnImages(product) {
  if (product?.primaryImage?.url && String(product.primaryImage.url).trim()) return true;
  const images = Array.isArray(product?.images) ? product.images : [];
  return images.some((img) => String(img?.url || img || '').trim());
}

function pricingEntryHasImages(entry) {
  return normalizePricingImages(entry).length > 0;
}

async function listUsaWarehouseIds() {
  const rows = await Warehouse.find({ isActive: true, city: 'USA' }).select('_id').lean();
  return rows.map((row) => row._id);
}

/** All Cameroon / shop inventory eligible for the public vendor catalog (not USA or travelling). */
async function loadVisibleShopInventory() {
  const filter = { shipmentStatus: { $ne: 'travelling' } };
  const usaIds = await listUsaWarehouseIds();
  if (usaIds.length) {
    filter.currentWarehouse = { $nin: usaIds };
  }
  return Product.find(filter).populate(WAREHOUSE_POPULATE).lean();
}

function inventoryMatchesPricingEntryStrict(product, entry) {
  if (!product || !entry || !pricingEntryHasImages(entry)) return false;

  const byNameCapacity = nameCapacityKeyFromProduct(product);
  const entryNameCapacity = nameCapacityKeyFromEntry(entry);
  if (byNameCapacity && entryNameCapacity && byNameCapacity === entryNameCapacity) {
    return true;
  }

  const productCatalogKey = catalogKeyFromProduct(product);
  const entryCatalogKey = String(
    entry?.catalogKey
      || buildCatalogKey({
        productName: entry?.productName,
        brand: entry?.brand,
        capacity: entry?.capacity,
      }),
  ).trim();
  return Boolean(productCatalogKey && entryCatalogKey && productCatalogKey === entryCatalogKey);
}

function normBrandCompact(value) {
  return normPart(value).replace(/\s+/g, '');
}

/** Vendor shop — strict match, then same normalized model + brand + capacity. */
function inventoryMatchesPricingEntryForVendorShop(product, entry) {
  if (!product || !entry || !pricingEntryHasImages(entry)) return false;
  if (inventoryMatchesPricingEntryStrict(product, entry)) return true;

  const model = normProductName(product?.product_name ?? product?.productName);
  const entryModel = normProductName(entry?.productName ?? entry?.product_name);
  if (!model || !entryModel || model !== entryModel) return false;

  const brand = normBrandCompact(product?.brand);
  const entryBrand = normBrandCompact(entry?.brand);
  if (!brand || !entryBrand || brand !== entryBrand) return false;

  return capacitiesMatch(product?.capacity, entry?.capacity);
}

function findBestPricingEntryForProduct(product, entries = []) {
  const list = (Array.isArray(entries) ? entries : []).filter(pricingEntryHasImages);
  if (!list.length) return null;

  const strict = list.find((entry) => inventoryMatchesPricingEntryStrict(product, entry));
  if (strict) return strict;

  const model = normProductName(product?.product_name ?? product?.productName);
  const brand = normPart(product?.brand);
  if (!model || !brand) return null;

  const byModelCapacity = list.find(
    (entry) =>
      normProductName(entry?.productName ?? entry?.product_name) === model
      && normPart(entry?.brand) === brand
      && capacitiesMatch(product?.capacity, entry?.capacity),
  );
  if (byModelCapacity) return byModelCapacity;

  return (
    list.find(
      (entry) =>
        normProductName(entry?.productName ?? entry?.product_name) === model
        && normPart(entry?.brand) === brand,
    ) || null
  );
}

function buildVendorListingFromPricingEntry(entry, images, inventory = []) {
  const primary = images[0];
  if (!primary?.url) return null;

  const wholesale = Number(entry?.wholesalePrice);
  if (!Number.isFinite(wholesale) || wholesale <= 0) return null;

  const inventoryStock = (Array.isArray(inventory) ? inventory : [])
    .filter((product) => inventoryMatchesPricingEntryForVendorShop(product, entry))
    .reduce((sum, product) => sum + resolveEffectiveLineStock(product), 0);

  const catalogKey = String(
    entry?.catalogKey
      || buildCatalogKey({
        productName: entry?.productName,
        brand: entry?.brand,
        capacity: entry?.capacity,
      }),
  ).trim();
  const stableId = `pricing:${catalogKey || entry?._id || primary.url}`;

  const listing = {
    _id: stableId,
    id: stableId,
    product_name: entry?.productName ?? '',
    brand: entry?.brand ?? '',
    capacity: entry?.capacity ?? '',
    product_type: 'Smartphone',
    color: 'Standard',
    stock: inventoryStock,
    platformStock: inventoryStock,
    price: wholesale,
    catalogImageUrl: String(primary.url).trim(),
    __pricingCatalogOnly: true,
  };

  if (primary.publicId || entry?.imagePublicId) {
    listing.catalogImagePublicId = String(primary.publicId || entry.imagePublicId).trim();
  }
  if (primary.alt || entry?.imageAlt) {
    listing.catalogImageAlt = String(primary.alt || entry.imageAlt).trim();
  }
  if (images.length > 1) {
    listing.catalogImages = images.map((img) => ({
      url: img.url,
      publicId: img.publicId,
      alt: img.alt,
    }));
  }

  return listing;
}

function buildVendorListingStockMap(inventory = []) {
  const map = new Map();
  for (const product of inventory) {
    const key = vendorListingStockKeyFromProduct(product);
    if (!key.replace(/\|/g, '')) continue;
    map.set(key, (map.get(key) || 0) + resolveEffectiveLineStock(product));
  }
  return map;
}

function applyVendorPlatformStock(product, stockByListingKey) {
  if (!product || !stockByListingKey) return product;
  const key = vendorListingStockKeyFromProduct(product);
  const total = stockByListingKey.get(key);
  if (total == null) return product;
  product.vendorPlatformStock = total;
  product.platformStock = Math.max(Number(product.platformStock) || 0, total);
  return product;
}

function applyPricingEntryToInventoryProduct(product, entry, images) {
  const primary = images[0];
  if (!primary?.url) return null;

  const doc = { ...product };
  doc.catalogImageUrl = String(primary.url).trim();
  if (primary.publicId || entry.imagePublicId) {
    doc.catalogImagePublicId = String(primary.publicId || entry.imagePublicId).trim();
  }
  if (primary.alt || entry.imageAlt) {
    doc.catalogImageAlt = String(primary.alt || entry.imageAlt).trim();
  }
  if (images.length > 1) {
    doc.catalogImages = images.map((img) => ({
      url: img.url,
      publicId: img.publicId,
      alt: img.alt,
    }));
  }

  let price = Number(doc.price) || 0;
  if (price <= 0 && entry.wholesalePrice != null) price = Number(entry.wholesalePrice) || 0;
  if (price <= 0) return null;
  doc.price = price;
  doc.stock = resolveEffectiveLineStock(doc);

  return doc;
}

function inventoryMatchesPricingEntry(product, entry) {
  return inventoryMatchesPricingEntryStrict(product, entry);
}

function findPricingImageEntry(product, entries = []) {
  return findBestPricingEntryForProduct(product, entries);
}

async function loadPricingImageEntries() {
  return ProductPricing.find({
    $or: [{ imageUrl: { $exists: true, $ne: '' } }, { 'images.0.url': { $exists: true, $ne: '' } }],
  })
    .select(
      'catalogKey productName brand capacity imageUrl imagePublicId imageAlt images wholesalePrice retailPrice',
    )
    .lean();
}

/** Attach catalogImageUrl metadata when inventory has no photos but pricing catalog does. */
async function attachPricingCatalogImagesToProducts(products = []) {
  const list = Array.isArray(products) ? products : [];
  if (!list.length) return list;

  const imageEntries = await loadPricingImageEntries();
  if (!imageEntries.length) return list;

  for (const product of list) {
    const entry = findPricingImageEntry(product, imageEntries);
    const images = normalizePricingImages(entry);
    const primary = images[0];
    if (!primary?.url) continue;
    product.catalogImageUrl = String(primary.url).trim();
    const publicId = String(primary.publicId || entry?.imagePublicId || '').trim();
    if (publicId) product.catalogImagePublicId = publicId;
    const alt = String(primary.alt || entry?.imageAlt || product?.product_name || entry?.productName || '').trim();
    if (alt) product.catalogImageAlt = alt;
    if (images.length > 1) {
      product.catalogImages = images.map((img) => ({
        url: img.url,
        publicId: img.publicId,
        alt: img.alt,
      }));
    }
  }

  return list;
}

/** Wholesale shop: inventory row matched a pricing-table photo (product name + capacity). */
function productHasEffectiveShopImage(product) {
  return Boolean(String(product?.catalogImageUrl || '').trim());
}

/**
 * Pricing-first vendor catalog: one shop listing per pricing row with an image
 * (strict name + capacity match to inventory; colors merged on the client).
 */
async function buildVendorShopCatalogFromInventory() {
  const inventory = await loadVisibleShopInventory();
  const stockByListingKey = buildVendorListingStockMap(inventory);
  const imageEntries = await loadPricingImageEntries();
  const listed = [];
  const seen = new Set();

  for (const entry of imageEntries) {
    const images = normalizePricingImages(entry);
    if (!images.length) continue;

    let addedForEntry = false;

    for (const product of inventory) {
      if (!inventoryMatchesPricingEntryForVendorShop(product, entry)) continue;

      const id = String(product._id ?? product.id ?? '');
      if (id && seen.has(id)) continue;

      const doc = applyPricingEntryToInventoryProduct(product, entry, images);
      if (!doc) continue;

      applyVendorPlatformStock(doc, stockByListingKey);

      if (id) seen.add(id);
      listed.push(doc);
      addedForEntry = true;
    }

    if (!addedForEntry) {
      const fallback = buildVendorListingFromPricingEntry(entry, images, inventory);
      if (!fallback) continue;
      applyVendorPlatformStock(fallback, stockByListingKey);
      const key = vendorListingStockKeyFromProduct(fallback);
      const alreadyListed = listed.some((row) => vendorListingStockKeyFromProduct(row) === key);
      if (!alreadyListed) listed.push(fallback);
    }
  }

  return listed;
}

module.exports = {
  MAX_PRICING_IMAGES,
  listPricingCatalog,
  createPricingEntry,
  updatePricingEntry,
  appendPricingImages,
  applyCatalogPricingToPayload,
  applyCatalogImageToPayload,
  upsertPricingFromProductUpload,
  syncInventoryWholesalePriceForCatalogKey,
  listCatalogKeys,
  serializePricingRow,
  attachPricingCatalogImagesToProducts,
  productHasEffectiveShopImage,
  productHasOwnImages,
  buildVendorShopCatalogFromInventory,
  normalizePricingImages,
};
