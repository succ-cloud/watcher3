const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Product = require('../models/ItemsList'); // Make sure this path is correct
const { cloudinary } = require('../config/cloudinary');
const productWhatsappService = require('../service/productWhatsapp');
const broadcastQueue = require('../service/whatsappBroadcastQueue');
const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');
const { resolveMainFromSubWarehouse, getMainWarehouseById } = require('../controllers/warehouseController');
const { ROLES } = require('../models/User');
const normalizeRoleToken = require('../utils/normalizeRoleToken');
const BulkShipment = require('../models/BulkShipment');
const { BULK_SHIPMENT_STATUS } = require('../models/BulkShipment');
const { generateBulkBatchCode } = require('../utils/bulkBatchCode');
const { normalizeProductPhoneLocation } = require('../utils/normalizeProductPhoneLocation');
const { applyProductArrival, applyProductReceivedAtWarehouse } = require('../utils/productWarehouseArrival');
const User = require('../models/User');
const { isUsaBusinessAddress } = require('../utils/adminAccountRegion');
const { SoldIme, SOLD_IME_STATUS } = require('../models/SoldIme');
const Order = require('../models/Order').Order;
const { normalizedImeList, resolveEffectiveLineStock } = require('../utils/productIme');
const { vendorListingStockKeyFromProduct } = require('../utils/pricingCatalog');
const { WAREHOUSE_POPULATE, attachResolvedOriginWarehouses } = require('../utils/warehousePopulate');
const { applyCatalogPricingToPayload, upsertPricingFromProductUpload, attachPricingCatalogImagesToProducts, productHasEffectiveShopImage, buildVendorShopCatalogFromInventory } = require('../service/pricingCatalogService');

function isUsaWarehouseCity(city) {
  return String(city || '').trim().toUpperCase() === 'USA';
}

function applyBatteryHealthField(target, fieldName = 'batteryHealth') {
  if (!target || !Object.prototype.hasOwnProperty.call(target, fieldName)) return null;
  const raw = target[fieldName];
  if (raw === '' || raw === null || raw === undefined) {
    target[fieldName] = null;
    return null;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return 'Battery health must be a number from 0 to 100.';
  }
  target[fieldName] = n;
  return null;
}

async function listUsaWarehouseIds() {
  const rows = await Warehouse.find({ isActive: true, city: 'USA' }).select('_id').lean();
  return rows.map((r) => r._id);
}

/** Public shop catalog: Cameroon / shop stock only (not USA or travelling). Price filter is applied client-side with pricing-catalog fallback. */
async function applyPublicCatalogVisibilityFilter(filter) {
  filter.shipmentStatus = { $ne: 'travelling' };
  const usaIds = await listUsaWarehouseIds();
  if (usaIds.length) {
    filter.currentWarehouse = { ...(filter.currentWarehouse || {}), $nin: usaIds };
  }
}

function catalogStockKeyFromFields(fields) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  return [
    norm(fields?.product_name),
    norm(fields?.brand),
    norm(fields?.capacity),
    norm(fields?.color),
    norm(fields?.product_type),
  ].join('|');
}

/** Sum stock for the same SKU across every warehouse/shop (entire on-hand inventory, not travelling). */
async function buildPlatformStockByCatalogKey() {
  const rows = await Product.aggregate([
    { $match: { shipmentStatus: { $ne: 'travelling' } } },
    {
      $addFields: {
        effectiveUnits: {
          $let: {
            vars: {
              imeArraySize: {
                $size: {
                  $cond: [{ $isArray: '$imeCodes' }, '$imeCodes', []],
                },
              },
              singleIme: {
                $trim: {
                  input: {
                    $convert: {
                      input: { $ifNull: ['$IME', ''] },
                      to: 'string',
                      onError: '',
                      onNull: '',
                    },
                  },
                },
              },
              stockVal: { $max: [0, { $ifNull: ['$stock', 0] }] },
            },
            in: {
              $cond: [
                { $gt: ['$$imeArraySize', 0] },
                '$$imeArraySize',
                {
                  $cond: [
                    { $gt: [{ $strLenCP: '$$singleIme' }, 0] },
                    1,
                    '$$stockVal',
                  ],
                },
              ],
            },
          },
        },
      },
    },
    {
      $group: {
        _id: {
          product_name: { $toLower: { $trim: { input: { $ifNull: ['$product_name', ''] } } } },
          brand: { $toLower: { $trim: { input: { $ifNull: ['$brand', ''] } } } },
          capacity: { $toLower: { $trim: { input: { $ifNull: ['$capacity', ''] } } } },
          color: { $toLower: { $trim: { input: { $ifNull: ['$color', ''] } } } },
          product_type: { $toLower: { $trim: { input: { $ifNull: ['$product_type', ''] } } } },
        },
        totalStock: { $sum: '$effectiveUnits' },
      },
    },
  ]);

  const map = new Map();
  for (const row of rows) {
    const key = catalogStockKeyFromFields(row._id);
    if (!key.replace(/\|/g, '').length) continue;
    map.set(key, Math.max(0, Number(row.totalStock) || 0));
  }
  return map;
}

/** Sum units for vendor listings (model + brand + capacity) across all shop-visible inventory. */
async function buildVendorListingStockByKey() {
  const filter = { shipmentStatus: { $ne: 'travelling' } };
  const usaIds = await listUsaWarehouseIds();
  if (usaIds.length) {
    filter.currentWarehouse = { $nin: usaIds };
  }

  const rows = await Product.find(filter)
    .select('product_name brand capacity stock IME imeCodes')
    .lean();

  const map = new Map();
  for (const product of rows) {
    const key = vendorListingStockKeyFromProduct(product);
    if (!key.replace(/\|/g, '').length) continue;
    const units = resolveEffectiveLineStock(product);
    map.set(key, (map.get(key) || 0) + units);
  }
  return map;
}

async function attachPlatformStockToProducts(products) {
  if (!Array.isArray(products) || products.length === 0) return products;
  try {
    const [totals, vendorTotals] = await Promise.all([
      buildPlatformStockByCatalogKey(),
      buildVendorListingStockByKey(),
    ]);
    for (const product of products) {
      const lineStock = resolveEffectiveLineStock(product);
      product.stock = lineStock;
      const key = catalogStockKeyFromFields(product);
      const platformTotal = totals.has(key) ? totals.get(key) : lineStock;
      product.platformStock = Math.max(platformTotal, lineStock);

      const vendorKey = vendorListingStockKeyFromProduct(product);
      const vendorTotal = vendorTotals.get(vendorKey);
      if (vendorTotal != null) {
        product.vendorPlatformStock = vendorTotal;
        product.platformStock = Math.max(product.platformStock, vendorTotal);
      }
    }
  } catch (err) {
    console.error('attachPlatformStockToProducts failed — using line stock only:', err.message);
    for (const product of products) {
      const lineStock = resolveEffectiveLineStock(product);
      product.stock = lineStock;
      product.platformStock = lineStock;
    }
  }
  return products;
}

const BULK_PRODUCT_REQUIRED_FIELDS = [
  'product_name',
  'brand',
  'capacity',
  'country',
  'sim',
  'color',
  'description',
];

/** True when Bearer JWT belongs to an admin (optional auth on public list routes). */
function isAdminRequest(req) {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !String(authHeader).startsWith('Bearer ')) return false;
    const token = String(authHeader).split(' ')[1];
    if (!token || !process.env.ACCESS_TOKEN_SECRET) return false;
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    const info =
      decoded.UserInfo && typeof decoded.UserInfo === 'object'
        ? { ...decoded.UserInfo, role: decoded.UserInfo.role ?? decoded.role }
        : decoded;
    const role = normalizeRoleToken(info.role ?? info.Role ?? decoded.role);
    if (role === ROLES.ADMIN) return true;
    const roles = Array.isArray(info.roles) ? info.roles : Array.isArray(decoded.roles) ? decoded.roles : [];
    return roles.some((r) => normalizeRoleToken(r) === ROLES.ADMIN);
  } catch {
    return false;
  }
}

function pickBodyField(value) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function parseBulkCreatePayload(body) {
  if (!body || typeof body !== 'object') return null;

  const source = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body;

  let products = source.products ?? body.products;

  // Multer occasionally wraps a single text field in an array.
  if (Array.isArray(products) && products.length === 1 && typeof products[0] === 'string') {
    products = products[0];
  }

  if (typeof products === 'string') {
    const trimmed = products.trim();
    if (!trimmed) return null;
    try {
      products = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (Array.isArray(body) && !products) {
    return { mainWarehouse: null, destinationSubWarehouse: null, products: body };
  }
  if (Array.isArray(products)) {
    return {
      mainWarehouse: pickBodyField(source.mainWarehouse ?? body.mainWarehouse),
      uploadWarehouse: pickBodyField(source.uploadWarehouse ?? body.uploadWarehouse),
      destinationSubWarehouse: pickBodyField(source.destinationSubWarehouse ?? body.destinationSubWarehouse),
      products,
    };
  }
  return null;
}

/** Map multer files with field names images_0, images_1, … to product row indexes. */
function groupBulkRowImages(files) {
  const map = {};
  if (!Array.isArray(files)) return map;
  files.forEach((file) => {
    const match = String(file.fieldname || '').match(/^images_(\d+)$/);
    if (!match) return;
    const idx = parseInt(match[1], 10);
    if (!Number.isFinite(idx) || idx < 0) return;
    if (!map[idx]) map[idx] = [];
    map[idx].push(file);
  });
  return map;
}

function attachUploadedImagesToProduct(product, files, productName, primaryNewIdx) {
  if (!files?.length) return;
  files.forEach((file) => {
    product.images.push({
      url: file.path,
      publicId: file.filename,
      isPrimary: false,
      alt: productName || 'product image',
    });
  });
  applyPrimaryToNewBatch(product, files.length, primaryNewIdx);
  syncPrimaryImageRoot(product);
}

/** Drop IME on plain objects when empty so inserts are not indexed as duplicate null. */
function normalizeImeOnPlainObject(obj) {
  if (!obj || typeof obj !== 'object' || !Object.prototype.hasOwnProperty.call(obj, 'IME')) return;
  const raw = obj.IME;
  if (raw == null || String(raw).trim() === '') {
    delete obj.IME;
    return;
  }
  obj.IME = String(raw).trim();
}

function parseImeCodesInput(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean);
    } catch {
      /* fall through */
    }
    return trimmed.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function applyPricingFields(target, body) {
  if (!target || !body || typeof body !== 'object') return;

  if (body.costPrice != null && body.costPrice !== '') {
    target.costPrice = parseFloat(body.costPrice);
  }
  if (body.priceMin != null && body.priceMin !== '') {
    target.priceMin = parseFloat(body.priceMin);
  }
  if (body.priceMax != null && body.priceMax !== '') {
    target.priceMax = parseFloat(body.priceMax);
  }
  if (body.price != null && body.price !== '') {
    target.price = parseFloat(body.price);
  } else if (target.price == null || Number.isNaN(Number(target.price))) {
    target.price = 0;
  }

  const imeCodes = parseImeCodesInput(body.imeCodes);
  if (imeCodes.length) {
    target.imeCodes = imeCodes;
    target.IME = imeCodes[0];
  }
}

async function resolveRequestAdminAddress(req) {
  const userId = req.user?.id || req.user?._id || req.user?.userId;
  if (!userId) return '';
  const user = await User.findById(userId).select('businessAddress role').lean();
  if (!user || normalizeRoleToken(user.role) !== ROLES.ADMIN) return '';
  return String(user.businessAddress || '').trim();
}

async function assertUniqueImeCodes(codes, excludeProductId = null) {
  if (!Array.isArray(codes) || !codes.length) return;
  const filter = {
    $or: [{ IME: { $in: codes } }, { imeCodes: { $in: codes } }],
  };
  if (excludeProductId) {
    filter._id = { $ne: excludeProductId };
  }
  const existing = await Product.findOne(filter)
    .select('_id product_name IME imeCodes')
    .lean();
  if (existing) {
    const err = new Error(
      `IME already registered on product "${existing.product_name || existing._id}".`,
    );
    err.statusCode = 400;
    throw err;
  }
}

async function validateInventoryCreateRules(productData, adminAddress) {
  applyPricingFields(productData, productData);

  if (productData.priceMin != null && productData.priceMax != null) {
    if (Number(productData.priceMin) > Number(productData.priceMax)) {
      const err = new Error('Minimum price cannot exceed maximum price.');
      err.statusCode = 400;
      throw err;
    }
  }

  const isUsa = isUsaBusinessAddress(adminAddress);
  if (isUsa) {
    if (!Number.isFinite(productData.costPrice) || productData.costPrice < 0) {
      const err = new Error('Cost price is required for USA WACHE uploads.');
      err.statusCode = 400;
      throw err;
    }
    const stock = parseInt(productData.stock, 10) || 0;
    const codes = Array.isArray(productData.imeCodes) ? productData.imeCodes : [];
    if (stock <= 0) {
      const err = new Error('Stock must be at least 1 for USA uploads.');
      err.statusCode = 400;
      throw err;
    }
    if (codes.length !== stock) {
      const err = new Error(
        `Register exactly ${stock} IME code(s) — one per unit (received ${codes.length}).`,
      );
      err.statusCode = 400;
      throw err;
    }
    if (new Set(codes).size !== codes.length) {
      const err = new Error('IME codes must be unique.');
      err.statusCode = 400;
      throw err;
    }
    await assertUniqueImeCodes(codes);
  }

  if (productData.price == null || !Number.isFinite(Number(productData.price))) {
    productData.price = 0;
  }
}

async function validateCameroonInventoryCreateRules(productData) {
  applyPricingFields(productData, productData);

  if (productData.priceMin != null && productData.priceMax != null) {
    if (Number(productData.priceMin) > Number(productData.priceMax)) {
      const err = new Error('Minimum price cannot exceed maximum price.');
      err.statusCode = 400;
      throw err;
    }
  }

  const stock = parseInt(productData.stock, 10) || 0;
  const codes = Array.isArray(productData.imeCodes) ? productData.imeCodes : [];
  if (stock <= 0) {
    const err = new Error('Stock must be at least 1.');
    err.statusCode = 400;
    throw err;
  }
  if (codes.length !== stock) {
    const err = new Error(
      `Register exactly ${stock} IME code(s) — one per unit (received ${codes.length}).`,
    );
    err.statusCode = 400;
    throw err;
  }
  if (new Set(codes).size !== codes.length) {
    const err = new Error('IME codes must be unique.');
    err.statusCode = 400;
    throw err;
  }
  await assertUniqueImeCodes(codes);

  if (!Number.isFinite(Number(productData.price)) || Number(productData.price) <= 0) {
    const err = new Error(
      'Selling price is required for Cameroon warehouse uploads so the product is listed on the Shop.',
    );
    err.statusCode = 400;
    throw err;
  }
}

// ----- Primary image helpers (images[].isPrimary + root primaryImage for API clients) -----

/** 0-based index into the newly uploaded file batch; omit for defaults */
function parsePrimaryNewImageIndex(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function extractPrimaryNewImageIndexFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const idx = parsePrimaryNewImageIndex(payload.primaryImageIndex ?? payload.primaryNewImageIndex);
  delete payload.primaryImageIndex;
  delete payload.primaryNewImageIndex;
  return idx;
}

/** After pushing `newFileCount` images at the end of product.images */
function applyPrimaryToNewBatch(product, newFileCount, primaryNewIndex) {
  if (!newFileCount || newFileCount < 1) return;
  const n = newFileCount;
  const start = product.images.length - n;
  if (start < 0) return;

  if (primaryNewIndex != null) {
    const idx = Math.min(Math.max(0, primaryNewIndex), n - 1);
    product.images.forEach((img) => {
      img.isPrimary = false;
    });
    product.images[start + idx].isPrimary = true;
    return;
  }

  if (start > 0) {
    for (let i = start; i < product.images.length; i += 1) {
      product.images[i].isPrimary = false;
    }
    ensureSinglePrimary(product);
    return;
  }

  product.images.forEach((img, i) => {
    img.isPrimary = i === 0;
  });
}

function ensureSinglePrimary(product) {
  if (!product.images?.length) return;
  const primaries = product.images.filter((img) => img.isPrimary);
  if (primaries.length === 0) {
    product.images[0].isPrimary = true;
    return;
  }
  if (primaries.length === 1) return;
  let keep = true;
  product.images.forEach((img) => {
    if (img.isPrimary) {
      if (keep) keep = false;
      else img.isPrimary = false;
    }
  });
}

/** Denormalized field used by storefront (primaryImage.url) */
function syncPrimaryImageRoot(product) {
  if (!product.images?.length) {
    product.primaryImage = undefined;
    return;
  }
  const p = product.images.find((img) => img.isPrimary) || product.images[0];
  product.primaryImage = {
    url: p.url,
    publicId: p.publicId,
    alt: p.alt || product.product_name || 'product image',
  };
}

/** Assign new stock to main warehouse — on hand immediately; send to a shop later. */
async function applyWarehouseOnCreate(productData, userId) {
  const destId = productData.destinationSubWarehouse;
  delete productData.destinationSubWarehouse;

  if (!destId) {
    const err = new Error('destinationSubWarehouse is required when adding products.');
    err.statusCode = 400;
    throw err;
  }

  const { sub, main } = await resolveMainFromSubWarehouse(destId);
  if (!sub) {
    const err = new Error('Invalid destination Shop. Choose an active Shop.');
    err.statusCode = 400;
    throw err;
  }
  if (!main) {
    const err = new Error('The selected Shop has no active regional main Warehouse.');
    err.statusCode = 400;
    throw err;
  }

  productData.currentWarehouse = main._id;
  productData.destinationSubWarehouse = sub._id;
  productData.shipmentStatus = 'arrived';
  productData.arrivedAt = new Date();
  productData.locationHistory = [
    {
      warehouse: main._id,
      status: 'arrived',
      movedAt: new Date(),
      movedBy: userId || null,
      note: `Uploaded at ${main.name} (intended for ${sub.name})`,
    },
  ];

  if (userId) productData.createdBy = userId;
}

/** Bulk intake: stock at regional main warehouse only — sub-warehouse assigned later. */
async function applyBulkWarehouseOnCreate(productData, mainWarehouseId, userId, batchCode) {
  const mainId = pickBodyField(mainWarehouseId) || productData.mainWarehouse;
  delete productData.mainWarehouse;
  delete productData.destinationSubWarehouse;

  const main = await getMainWarehouseById(mainId);
  if (!main) {
    const err = new Error('Invalid main warehouse. Choose an active regional main warehouse.');
    err.statusCode = 400;
    throw err;
  }

  productData.currentWarehouse = main._id;
  productData.destinationSubWarehouse = null;
  productData.shipmentStatus = 'arrived';
  productData.arrivedAt = new Date();
  productData.locationHistory = [
    {
      warehouse: main._id,
      status: 'arrived',
      movedAt: new Date(),
      movedBy: userId || null,
      note: batchCode
        ? `Bulk batch ${batchCode} uploaded at ${main.name}`
        : `Uploaded at ${main.name}`,
    },
  ];

  if (userId) productData.createdBy = userId;
  return main;
}

/** Cameroon warehouse upload: stock is shop-ready and listable when priced. */
async function applyCameroonWarehouseOnCreate(productData, warehouseId, userId) {
  const wh = await Warehouse.findOne({ _id: warehouseId, isActive: true });
  if (!wh) {
    const err = new Error('Invalid warehouse. Choose an active Cameroon warehouse or shop.');
    err.statusCode = 400;
    throw err;
  }
  if (isUsaWarehouseCity(wh.city)) {
    const err = new Error('Use the USA warehouse upload flow for USA stock.');
    err.statusCode = 400;
    throw err;
  }

  delete productData.mainWarehouse;
  delete productData.uploadWarehouse;

  productData.currentWarehouse = wh._id;
  if (wh.type === WAREHOUSE_TYPES.SUB) {
    productData.destinationSubWarehouse = wh._id;
  } else {
    productData.destinationSubWarehouse = null;
  }

  productData.shipmentStatus = 'arrived';
  productData.arrivedAt = new Date();
  productData.locationHistory = [
    {
      warehouse: wh._id,
      status: 'arrived',
      movedAt: new Date(),
      movedBy: userId || null,
      note: `Uploaded at ${wh.name} (${wh.city || 'Cameroon'})`,
    },
  ];

  if (userId) productData.createdBy = userId;
}

// ==================== BASIC CRUD OPERATIONS ====================

// @desc    Create a new product with images
// @route   POST /api/products
// @access  Public
const createProduct = async (req, res) => {
  try {
    let productData = req.body;
    
    // Parse JSON fields if they come as strings (for FormData)
    if (typeof productData === 'string') {
      productData = JSON.parse(productData);
    }

    // Validate required fields
    const requiredFields = ['product_type', 'product_name', 'brand', 'phoneLocation', 'capacity', 
                           'country', 'sim', 'color', 'description'];
    
    const missingFields = requiredFields.filter(field => !productData[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`
      });
    }

    const adminAddress = await resolveRequestAdminAddress(req);
    const userId = req.user?.id || req.user?._id || null;
    const mainWarehouseId = pickBodyField(productData.mainWarehouse);
    const uploadWarehouseId =
      pickBodyField(productData.uploadWarehouse) || mainWarehouseId;
    const hasDestShop = Boolean(pickBodyField(productData.destinationSubWarehouse));

    let directWarehouseUpload = false;
    let cameroonWarehouseUpload = false;
    if (uploadWarehouseId && !hasDestShop) {
      const targetWh = await Warehouse.findOne({ _id: uploadWarehouseId, isActive: true });
      if (!targetWh) {
        return res.status(400).json({
          success: false,
          message: 'Invalid warehouse selected for upload.',
        });
      }
      if (isUsaWarehouseCity(targetWh.city)) {
        directWarehouseUpload = true;
      } else {
        cameroonWarehouseUpload = true;
      }
    }

    if (cameroonWarehouseUpload) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({
          success: false,
          message: 'Only admins can upload inventory to Cameroon warehouses.',
        });
      }
      try {
        await validateCameroonInventoryCreateRules(productData);
      } catch (ruleErr) {
        return res.status(ruleErr.statusCode || 400).json({
          success: false,
          message: ruleErr.message,
        });
      }
    } else if (!isUsaBusinessAddress(adminAddress)) {
      return res.status(403).json({
        success: false,
        message:
          'Product upload is reserved for USA WACHE accounts. Cameroon accounts can edit existing inventory or upload at a Cameroon warehouse.',
      });
    } else {
      try {
        await validateInventoryCreateRules(productData, adminAddress);
      } catch (ruleErr) {
        return res.status(ruleErr.statusCode || 400).json({
          success: false,
          message: ruleErr.message,
        });
      }
    }

    // Convert numeric fields
    if (productData.stock) productData.stock = parseInt(productData.stock, 10);
    const batteryHealthErr = applyBatteryHealthField(productData);
    if (batteryHealthErr) {
      return res.status(400).json({ success: false, message: batteryHealthErr });
    }

    if (productData.phoneLocation != null) {
      productData.phoneLocation = normalizeProductPhoneLocation(productData.phoneLocation);
    }

    normalizeImeOnPlainObject(productData);

    const uploadRetailPrice =
      productData.retailPrice != null && productData.retailPrice !== ''
        ? parseFloat(productData.retailPrice)
        : null;
    if (Object.prototype.hasOwnProperty.call(productData, 'retailPrice')) {
      delete productData.retailPrice;
    }

    const primaryNewIdx = extractPrimaryNewImageIndexFromPayload(productData);

    try {
      if (cameroonWarehouseUpload) {
        await applyCameroonWarehouseOnCreate(productData, uploadWarehouseId, userId);
      } else if (directWarehouseUpload) {
        const usaMain = await getMainWarehouseById(uploadWarehouseId);
        if (!usaMain || !isUsaWarehouseCity(usaMain.city)) {
          return res.status(400).json({
            success: false,
            message: 'Direct warehouse upload is only allowed for the USA main warehouse.',
          });
        }
        await applyBulkWarehouseOnCreate(productData, uploadWarehouseId, userId, null);
      } else {
        await applyWarehouseOnCreate(productData, userId);
      }
    } catch (whErr) {
      return res.status(whErr.statusCode || 400).json({
        success: false,
        message: whErr.message,
      });
    }

    const pricingMeta = await applyCatalogPricingToPayload(productData);

    const hasUploadedImages = req.files && req.files.length > 0;
    if (hasUploadedImages && Array.isArray(productData.images) && productData.images.length) {
      productData.images = [];
      productData.primaryImage = undefined;
    }

    // Create new product
    const product = new Product(productData);

    // Handle uploaded images
    if (hasUploadedImages) {
      req.files.forEach((file) => {
        product.images.push({
          url: file.path,
          publicId: file.filename,
          isPrimary: false,
          alt: productData.product_name || 'product image'
        });
      });
      applyPrimaryToNewBatch(product, req.files.length, primaryNewIdx);
      syncPrimaryImageRoot(product);
    }

    const savedProduct = await product.save();
    const populated = await Product.findById(savedProduct._id).populate(WAREHOUSE_POPULATE);

    if (uploadRetailPrice != null || Number(savedProduct.price) > 0) {
      await upsertPricingFromProductUpload(
        {
          product_name: savedProduct.product_name,
          brand: savedProduct.brand,
          capacity: savedProduct.capacity,
          price: savedProduct.price,
          retailPrice: uploadRetailPrice,
        },
        userId,
      );
    }

    // ========== QUEUE FOR WHATSAPP BROADCAST ==========
    // Add to broadcast queue instead of sending immediately
    broadcastQueue.queueProductForBroadcast(populated || savedProduct);
    
    // Get queue status
    const queueStatus = broadcastQueue.getQueueStatus();
    
    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: populated || savedProduct,
      pricingCatalog: pricingMeta,
      whatsappBroadcast: {
        queued: true,
        queueSize: queueStatus.queueSize,
        nextBroadcastIn: queueStatus.nextBroadcastIn,
        message: `Product will be broadcast to wholesalers in ${Math.round(queueStatus.nextBroadcastIn / 60000)} minutes (batch broadcast)`
      }
    });
  } catch (error) {
    console.error('Create product error:', error);
    if (error.code === 11000 && String(error.message || '').includes('IME')) {
      return res.status(400).json({
        success: false,
        message: 'A product with this IME already exists. Use a different IME or leave IME blank.',
        error: error.message,
      });
    }
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors || {}).map((e) => e.message);
      return res.status(400).json({
        success: false,
        message: messages.length ? messages.join(' ') : error.message,
        error: error.message,
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error creating product',
      error: error.message
    });
  }
};

// Add a new endpoint to check queue status
const getBroadcastQueueStatus = async (req, res) => {
  try {
    const queueStatus = broadcastQueue.getQueueStatus();
    
    res.status(200).json({
      success: true,
      data: queueStatus,
      broadcastIntervalMinutes: broadcastQueue.BROADCAST_INTERVAL / 60000
    });
  } catch (error) {
    console.error('Error getting queue status:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting queue status',
      error: error.message
    });
  }
};

// Add a new endpoint to force broadcast (admin only)
const forceBroadcastNow = async (req, res) => {
  try {
    // You should add admin authentication check here
    const result = await broadcastQueue.forceBroadcast();
    
    res.status(200).json({
      success: result.success,
      message: result.message,
      data: result
    });
  } catch (error) {
    console.error('Error forcing broadcast:', error);
    res.status(500).json({
      success: false,
      message: 'Error forcing broadcast',
      error: error.message
    });
  }
};

// @desc    Get all products with filtering, pagination, and sorting
// @route   GET /api/products
// @access  Public
const getAllProducts = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      product_type,
      minPrice,
      maxPrice,
      country,
      carrier,
      color,
      inStock
    } = req.query;

    // Build filter object
    const filter = {};

    if (product_type) filter.product_type = product_type;
    if (country) filter.country = country;
    if (carrier) filter.carrier = carrier;
    if (color) filter.color = color;
    
    // Price range filter
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    // Stock filter
    if (inStock === 'true') {
      filter.stock = { $gt: 0 };
    } else if (inStock === 'false') {
      filter.stock = { $lte: 0 };
    }

    // Wholesalers / public catalog: shop-ready stock in Cameroon only (not USA or travelling).
    // Admins can pass ?catalog=shop to preview the same listing as the wholesale storefront.
    const wantsShopCatalog =
      String(req.query.catalog || '').toLowerCase() === 'shop' ||
      req.query.shopCatalog === '1';
    const useShopCatalog = !isAdminRequest(req) || wantsShopCatalog;
    if (useShopCatalog) {
      await applyPublicCatalogVisibilityFilter(filter);
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    // Execute query with pagination
    const products = await Product.find(filter)
      .populate(WAREHOUSE_POPULATE)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));

    await attachResolvedOriginWarehouses(products);

    try {
      await attachPricingCatalogImagesToProducts(products);
    } catch (imageErr) {
      console.error('attachPricingCatalogImagesToProducts failed:', imageErr.message);
    }

    if (useShopCatalog) {
      await attachPlatformStockToProducts(products);
    }

    const totalProducts = useShopCatalog
      ? products.length
      : await Product.countDocuments(filter);
    const totalPages = Math.ceil(totalProducts / parseInt(limit));

    res.status(200).json({
      success: true,
      count: products.length,
      totalProducts,
      totalPages,
      currentPage: parseInt(page),
      data: products
    });
  } catch (error) {
    console.error('Get all products error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching products',
      error: error.message
    });
  }
};

/** GET /api/products/vendor-shop — pricing rows with images joined to matching inventory (name + capacity). */
const getVendorShopProducts = async (req, res) => {
  try {
    let listed = await buildVendorShopCatalogFromInventory();
    try {
      await attachResolvedOriginWarehouses(listed);
    } catch (originErr) {
      console.error('attachResolvedOriginWarehouses (vendor-shop) failed:', originErr.message);
    }
    await attachPlatformStockToProducts(listed);

    return res.status(200).json({
      success: true,
      count: listed.length,
      data: listed,
    });
  } catch (error) {
    console.error('getVendorShopProducts error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching vendor shop products',
      error: error.message,
    });
  }
};

/** GET /api/admin/inventory/products — full inventory for admin (no shop catalog filter). */
const getAdminInventoryProducts = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);

    const products = await Product.find({})
      .populate(WAREHOUSE_POPULATE)
      .populate({
        path: 'bulkShipment',
        select: 'mainWarehouse batchCode',
        populate: { path: 'mainWarehouse', select: 'name type city address' },
      })
      .sort({ createdAt: -1 })
      .limit(limit);

    await attachResolvedOriginWarehouses(products);
    await attachPricingCatalogImagesToProducts(products);
    for (const product of products) {
      product.stock = resolveEffectiveLineStock(product);
    }

    const totalProducts = await Product.countDocuments({});

    return res.status(200).json({
      success: true,
      count: products.length,
      totalProducts,
      data: products,
    });
  } catch (error) {
    console.error('getAdminInventoryProducts:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching inventory products',
      error: error.message,
    });
  }
};

// @desc    Get single product by ID
// @route   GET /api/products/:id
// @access  Public
const getProductById = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).populate(WAREHOUSE_POPULATE);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.status(200).json({
      success: true,
      data: product
    });
  } catch (error) {
    console.error('Get product by ID error:', error);
    // Handle invalid ObjectId
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error fetching product',
      error: error.message
    });
  }
};

// @desc    Update product with images
// @route   PUT /api/products/:id
// @access  Public
const updateProduct = async (req, res) => {
  try {
    let updates = req.body;
    
    // Parse JSON fields if they come as strings
    if (typeof updates === 'string') {
      updates = JSON.parse(updates);
    }
    
    // Remove fields that shouldn't be updated directly
    delete updates._id;
    delete updates.createdAt;
    delete updates.__v;
    delete updates.images; // Don't update images directly through this endpoint

    const primaryNewIdx = extractPrimaryNewImageIndexFromPayload(updates);

    // Convert numeric fields
    if (updates.price !== undefined && updates.price !== '') updates.price = parseFloat(updates.price);
    if (updates.stock !== undefined && updates.stock !== '') updates.stock = parseInt(updates.stock, 10);
    if (updates.costPrice !== undefined && updates.costPrice !== '') {
      updates.costPrice = parseFloat(updates.costPrice);
    }
    if (updates.priceMin !== undefined && updates.priceMin !== '') {
      updates.priceMin = parseFloat(updates.priceMin);
    }
    if (updates.priceMax !== undefined && updates.priceMax !== '') {
      updates.priceMax = parseFloat(updates.priceMax);
    }
    const batteryHealthUpdateErr = applyBatteryHealthField(updates);
    if (batteryHealthUpdateErr) {
      return res.status(400).json({ success: false, message: batteryHealthUpdateErr });
    }
    if (updates.imeCodes != null) {
      updates.imeCodes = parseImeCodesInput(updates.imeCodes);
      if (updates.imeCodes.length) updates.IME = updates.imeCodes[0];
    }

    if (updates.priceMin != null && updates.priceMax != null && updates.priceMin > updates.priceMax) {
      return res.status(400).json({
        success: false,
        message: 'Minimum price cannot exceed maximum price.',
      });
    }

    if (updates.phoneLocation != null) {
      updates.phoneLocation = normalizeProductPhoneLocation(updates.phoneLocation);
    }

    const hadImeKey = Object.prototype.hasOwnProperty.call(updates, 'IME');
    normalizeImeOnPlainObject(updates);
    const shouldUnsetIme = hadImeKey && !Object.prototype.hasOwnProperty.call(updates, 'IME');

    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (updates.imeCodes?.length) {
      await assertUniqueImeCodes(updates.imeCodes, product._id);
    } else if (updates.IME) {
      await assertUniqueImeCodes([updates.IME], product._id);
    }

    // Update fields
    Object.keys(updates).forEach(key => {
      product[key] = updates[key];
    });

    if (shouldUnsetIme) {
      product.set('IME', undefined);
    }

    // Handle new images
    if (req.files && req.files.length > 0) {
      req.files.forEach((file) => {
        product.images.push({
          url: file.path,
          publicId: file.filename,
          isPrimary: false,
          alt: product.product_name || 'product image'
        });
      });
      applyPrimaryToNewBatch(product, req.files.length, primaryNewIdx);
    }

    syncPrimaryImageRoot(product);

    const updatedProduct = await product.save();

    res.status(200).json({
      success: true,
      message: 'Product updated successfully',
      data: updatedProduct
    });
  } catch (error) {
    console.error('Update product error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error updating product',
      error: error.message
    });
  }
};

// @desc    Partially update product (JSON or multipart with optional new images)
// @route   PATCH /api/products/:id
// @access  Public
const patchProduct = async (req, res) => {
  try {
    let updates = req.body;

    // Parse JSON fields if they come as strings
    if (typeof updates === 'string') {
      updates = JSON.parse(updates);
    }

    // Remove fields that shouldn't be updated
    delete updates._id;
    delete updates.createdAt;
    delete updates.__v;
    delete updates.images;

    const primaryNewIdx = extractPrimaryNewImageIndexFromPayload(updates);

    // Convert numeric fields
    if (updates.price !== undefined && updates.price !== '') updates.price = parseFloat(updates.price);
    if (updates.stock !== undefined && updates.stock !== '') updates.stock = parseInt(updates.stock, 10);
    if (updates.costPrice !== undefined && updates.costPrice !== '') {
      updates.costPrice = parseFloat(updates.costPrice);
    }
    if (updates.priceMin !== undefined && updates.priceMin !== '') {
      updates.priceMin = parseFloat(updates.priceMin);
    }
    if (updates.priceMax !== undefined && updates.priceMax !== '') {
      updates.priceMax = parseFloat(updates.priceMax);
    }
    const batteryHealthPatchErr = applyBatteryHealthField(updates);
    if (batteryHealthPatchErr) {
      return res.status(400).json({ success: false, message: batteryHealthPatchErr });
    }
    if (updates.imeCodes != null) {
      updates.imeCodes = parseImeCodesInput(updates.imeCodes);
      if (updates.imeCodes.length) updates.IME = updates.imeCodes[0];
    }

    let uploadRetailPrice = null;
    if (updates.retailPrice != null && updates.retailPrice !== '') {
      uploadRetailPrice = parseFloat(updates.retailPrice);
      if (!Number.isFinite(uploadRetailPrice) || uploadRetailPrice < 0) {
        return res.status(400).json({
          success: false,
          message: 'Retail price must be a non-negative number.',
        });
      }
      delete updates.retailPrice;
    }

    if (updates.priceMin != null && updates.priceMax != null && updates.priceMin > updates.priceMax) {
      return res.status(400).json({
        success: false,
        message: 'Minimum price cannot exceed maximum price.',
      });
    }

    if (updates.phoneLocation != null) {
      updates.phoneLocation = normalizeProductPhoneLocation(updates.phoneLocation);
    }

    const hadImeKey = Object.prototype.hasOwnProperty.call(updates, 'IME');
    normalizeImeOnPlainObject(updates);
    const shouldUnsetIme = hadImeKey && !Object.prototype.hasOwnProperty.call(updates, 'IME');

    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    Object.keys(updates).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        product[key] = updates[key];
      }
    });

    if (shouldUnsetIme) {
      product.set('IME', undefined);
    }

    if (req.files && req.files.length > 0) {
      req.files.forEach((file) => {
        product.images.push({
          url: file.path,
          publicId: file.filename,
          isPrimary: false,
          alt: product.product_name || 'product image'
        });
      });
      applyPrimaryToNewBatch(product, req.files.length, primaryNewIdx);
    }

    syncPrimaryImageRoot(product);

    const saved = await product.save();

    if (uploadRetailPrice != null || updates.price != null) {
      const userId = req?.user?.userId || req?.user?.id || req?.user?._id || null;
      await upsertPricingFromProductUpload(
        {
          product_name: saved.product_name,
          brand: saved.brand,
          capacity: saved.capacity,
          retailPrice: uploadRetailPrice,
          price: saved.price,
        },
        userId,
      );
    }

    res.status(200).json({
      success: true,
      message: 'Product updated successfully',
      data: saved
    });
  } catch (error) {
    console.error('Patch product error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error updating product',
      error: error.message
    });
  }
};

// @desc    Delete product
// @route   DELETE /api/products/:id
// @access  Public
const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Delete images from Cloudinary
    if (product.images && product.images.length > 0) {
      for (const image of product.images) {
        try {
          await cloudinary.uploader.destroy(image.publicId);
        } catch (cloudinaryError) {
          console.error('Cloudinary delete error:', cloudinaryError);
          // Continue even if Cloudinary delete fails
        }
      }
    }

    // Delete product from database
    await Product.findByIdAndDelete(req.params.id);

    res.status(200).json({
      success: true,
      message: 'Product deleted successfully',
      data: {}
    });
  } catch (error) {
    console.error('Delete product error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error deleting product',
      error: error.message
    });
  }
};

// ==================== SEARCH OPERATIONS ====================

// @desc    Search products by name
// @route   GET /api/products/search
// @access  Public
const searchProductsByName = async (req, res) => {
  try {
    const { 
      q, // search query
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    if (!q) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required'
      });
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    // Search products by name (case-insensitive)
    const searchRegex = new RegExp(q, 'i');
    
    const products = await Product.find({
      $or: [
        { product_name: searchRegex },
        { description: searchRegex },
        { models: searchRegex },
        { carrier: searchRegex }
      ]
    })
    .sort(sort)
    .skip(skip)
    .limit(parseInt(limit));

    // Get total count for pagination
    const totalProducts = await Product.countDocuments({
      $or: [
        { product_name: searchRegex },
        { description: searchRegex },
        { models: searchRegex },
        { carrier: searchRegex }
      ]
    });

    const totalPages = Math.ceil(totalProducts / parseInt(limit));

    res.status(200).json({
      success: true,
      count: products.length,
      totalProducts,
      totalPages,
      currentPage: parseInt(page),
      searchQuery: q,
      data: products
    });
  } catch (error) {
    console.error('Search products error:', error);
    res.status(500).json({
      success: false,
      message: 'Error searching products',
      error: error.message
    });
  }
};

// @desc    Advanced search with multiple fields and filters
// @route   POST /api/products/advanced-search
// @access  Public
const advancedSearch = async (req, res) => {
  try {
    const {
      searchTerm,
      product_type,
      minPrice,
      maxPrice,
      country,
      carrier,
      color,
      inStock,
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.body;

    // Build search filter
    const filter = {};

    // Text search across multiple fields
    if (searchTerm) {
      const searchRegex = new RegExp(searchTerm, 'i');
      filter.$or = [
        { product_name: searchRegex },
        { description: searchRegex },
        { models: searchRegex },
        { carrier: searchRegex },
        { color: searchRegex }
      ];
    }

    // Apply filters
    if (product_type) filter.product_type = product_type;
    if (country) filter.country = country;
    if (carrier) filter.carrier = carrier;
    if (color) filter.color = color;
    
    // Price range filter
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    // Stock filter
    if (inStock !== undefined) {
      if (inStock === true || inStock === 'true') {
        filter.stock = { $gt: 0 };
      } else if (inStock === false || inStock === 'false') {
        filter.stock = { $lte: 0 };
      }
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    // Execute search
    const products = await Product.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));

    const totalProducts = await Product.countDocuments(filter);
    const totalPages = Math.ceil(totalProducts / parseInt(limit));

    res.status(200).json({
      success: true,
      count: products.length,
      totalProducts,
      totalPages,
      currentPage: parseInt(page),
      filters: {
        searchTerm,
        product_type,
        minPrice,
        maxPrice,
        country,
        carrier,
        color,
        inStock
      },
      data: products
    });
  } catch (error) {
    console.error('Advanced search error:', error);
    res.status(500).json({
      success: false,
      message: 'Error performing advanced search',
      error: error.message
    });
  }
};

// ==================== BULK OPERATIONS ====================

// @desc    Bulk create products at a warehouse (admin) — on hand at upload; photos added later
// @route   POST /api/products/bulk
// @access  Admin
// @body    { mainWarehouse, products } — USA main warehouse bulk upload
// @body    { uploadWarehouse, products } — regional Cameroon warehouse / shop bulk upload
const bulkCreateProducts = async (req, res) => {
  try {
    const parsed = parseBulkCreatePayload(req.body);
    if (!parsed || parsed.products.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          'Provide { mainWarehouse | uploadWarehouse, products: [...] } with at least one product row. Images are added at the warehouse after stock arrives.',
        debug:
          process.env.NODE_ENV === 'development'
            ? { bodyKeys: req.body ? Object.keys(req.body) : [], fileCount: req.files?.length || 0 }
            : undefined,
      });
    }

    const uploadWarehouseId =
      pickBodyField(parsed.uploadWarehouse) ||
      pickBodyField(parsed.products.find((p) => p?.uploadWarehouse)?.uploadWarehouse);
    const mainWarehouseId =
      pickBodyField(parsed.mainWarehouse) ||
      pickBodyField(parsed.products.find((p) => p?.mainWarehouse)?.mainWarehouse);

    if (!uploadWarehouseId && !mainWarehouseId) {
      return res.status(400).json({
        success: false,
        message:
          'mainWarehouse or uploadWarehouse is required — select which warehouse receives this bulk upload.',
      });
    }

    const adminAddress = await resolveRequestAdminAddress(req);
    const userId = req.user?.userId || req.user?.id || req.userId || null;
    let targetWarehouse = null;
    let usaBulk = false;
    let regionalBulk = false;

    if (uploadWarehouseId) {
      targetWarehouse = await Warehouse.findOne({ _id: uploadWarehouseId, isActive: true });
      if (!targetWarehouse) {
        return res.status(400).json({
          success: false,
          message: 'Invalid warehouse. Choose an active regional warehouse or shop.',
        });
      }
      if (isUsaWarehouseCity(targetWarehouse.city)) {
        return res.status(400).json({
          success: false,
          message: 'Use mainWarehouse for USA bulk uploads.',
        });
      }
      regionalBulk = true;
    } else {
      targetWarehouse = await getMainWarehouseById(mainWarehouseId);
      if (!targetWarehouse) {
        return res.status(400).json({
          success: false,
          message: 'Invalid main warehouse. Create or select an active regional main warehouse.',
        });
      }
      if (String(targetWarehouse.city || '').trim() !== 'USA') {
        return res.status(403).json({
          success: false,
          message: 'Bulk upload to a regional warehouse requires uploadWarehouse. Use mainWarehouse for USA only.',
        });
      }
      if (!isUsaBusinessAddress(adminAddress)) {
        return res.status(403).json({
          success: false,
          message:
            'USA bulk upload is reserved for USA WACHE accounts. Use uploadWarehouse for Cameroon warehouses.',
        });
      }
      usaBulk = true;
    }

    const bulkShipmentMainId =
      regionalBulk && targetWarehouse.type === WAREHOUSE_TYPES.SUB && targetWarehouse.parentWarehouse
        ? targetWarehouse.parentWarehouse
        : targetWarehouse._id;

    const created = [];
    const errors = [];

    let bulkShipment = null;
    try {
      bulkShipment = await BulkShipment.create({
        batchCode: generateBulkBatchCode(),
        status: BULK_SHIPMENT_STATUS.ARRIVED,
        mainWarehouse: bulkShipmentMainId,
        destinationSubWarehouse:
          regionalBulk && targetWarehouse.type === WAREHOUSE_TYPES.SUB ? targetWarehouse._id : null,
        productCount: 0,
        arrivedAt: new Date(),
        arrivedBy: userId,
        createdBy: userId,
      });
    } catch (batchErr) {
      console.error('BulkShipment create error:', batchErr);
      return res.status(500).json({
        success: false,
        message: 'Failed to create bulk shipment tracking record.',
      });
    }

    for (let index = 0; index < parsed.products.length; index += 1) {
      const raw = parsed.products[index];
      try {
        const row = { ...raw };
        if (row.phoneLocation != null) {
          row.phoneLocation = normalizeProductPhoneLocation(row.phoneLocation);
        } else {
          row.phoneLocation = regionalBulk && targetWarehouse.city ? targetWarehouse.city : 'Other';
        }
        if (!row.product_type) row.product_type = 'Smartphone';
        row.stock = parseInt(row.stock, 10);
        if (!Number.isFinite(row.stock) || row.stock < 0) {
          throw new Error('stock must be a non-negative integer');
        }

        const uploadRetailPrice =
          row.retailPrice != null && row.retailPrice !== '' ? parseFloat(row.retailPrice) : null;
        if (Object.prototype.hasOwnProperty.call(row, 'retailPrice')) {
          delete row.retailPrice;
        }

        if (usaBulk) {
          try {
            await validateInventoryCreateRules(row, adminAddress);
          } catch (ruleErr) {
            throw new Error(ruleErr.message || 'Invalid inventory row');
          }
        } else {
          applyPricingFields(row, row);
          await applyCatalogPricingToPayload(row);
          try {
            await validateCameroonInventoryCreateRules(row);
          } catch (ruleErr) {
            throw new Error(ruleErr.message || 'Invalid inventory row');
          }
        }

        normalizeImeOnPlainObject(row);

        if (!Array.isArray(row.images)) row.images = [];

        const missing = BULK_PRODUCT_REQUIRED_FIELDS.filter(
          (field) => row[field] == null || String(row[field]).trim() === '',
        );
        if (missing.length) {
          throw new Error(`Missing required fields: ${missing.join(', ')}`);
        }

        if (usaBulk) {
          await applyBulkWarehouseOnCreate(row, targetWarehouse._id, userId, bulkShipment.batchCode);
          await applyCatalogPricingToPayload(row);
        } else {
          await applyCameroonWarehouseOnCreate(row, targetWarehouse._id, userId);
          row.bulkBatchCode = bulkShipment.batchCode;
        }

        row.bulkShipment = bulkShipment._id;
        if (!row.bulkBatchCode) row.bulkBatchCode = bulkShipment.batchCode;

        const product = new Product(row);
        const saved = await product.save();
        const populated = await Product.findById(saved._id).populate(WAREHOUSE_POPULATE);
        const record = populated || saved;

        if (
          regionalBulk &&
          (uploadRetailPrice != null || Number(saved.price) > 0)
        ) {
          await upsertPricingFromProductUpload(
            {
              product_name: saved.product_name,
              brand: saved.brand,
              capacity: saved.capacity,
              price: saved.price,
              retailPrice: uploadRetailPrice,
            },
            userId,
          );
        }

        created.push(record);
        if (Array.isArray(record.images) && record.images.length > 0) {
          broadcastQueue.queueProductForBroadcast(record);
        }
      } catch (rowErr) {
        errors.push({
          index,
          product_name: raw?.product_name ?? null,
          message: rowErr.message || 'Failed to create product',
        });
      }
    }

    if (!created.length) {
      await BulkShipment.findByIdAndDelete(bulkShipment._id);
      return res.status(400).json({
        success: false,
        message: 'No products were created.',
        errors,
      });
    }

    bulkShipment.productCount = created.length;
    await bulkShipment.save();

    const queueStatus = broadcastQueue.getQueueStatus();
    const warehouseLabel = targetWarehouse.name || 'warehouse';

    return res.status(201).json({
      success: true,
      message: usaBulk
        ? `Created ${created.length} product(s) in bulk batch ${bulkShipment.batchCode} at ${warehouseLabel}. Stock is on hand — send to a shop or warehouse when ready.`
        : `Created ${created.length} product(s) in bulk batch ${bulkShipment.batchCode} at ${warehouseLabel}. Add photos when ready to list on the Shop.`,
      count: created.length,
      failed: errors.length,
      batchCode: bulkShipment.batchCode,
      bulkShipmentId: bulkShipment._id,
      data: created,
      errors: errors.length ? errors : undefined,
      warehouse: {
        main: { id: targetWarehouse._id, name: targetWarehouse.name },
      },
      bulkShipment: {
        id: bulkShipment._id,
        batchCode: bulkShipment.batchCode,
        status: bulkShipment.status,
        productCount: bulkShipment.productCount,
      },
      whatsappBroadcast: {
        queued: created.length,
        queueSize: queueStatus.queueSize,
      },
    });
  } catch (error) {
    console.error('Bulk create error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating products in bulk',
      error: error.message,
    });
  }
};

// ==================== STOCK MANAGEMENT ====================

// @desc    Update product stock
// @route   PATCH /api/products/:id/stock
// @access  Public
const updateProductStock = async (req, res) => {
  try {
    const { quantity, operation = 'set' } = req.body;

    if (quantity === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Quantity is required'
      });
    }

    const numQuantity = parseInt(quantity);
    
    if (isNaN(numQuantity)) {
      return res.status(400).json({
        success: false,
        message: 'Quantity must be a number'
      });
    }

    // Get current product before update
    const currentProduct = await Product.findById(req.params.id);
    if (!currentProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    
    const previousStock = currentProduct.stock;
    let updateOperation;
    let newStock;
    
    switch (operation) {
      case 'increment':
        updateOperation = { $inc: { stock: numQuantity } };
        newStock = previousStock + numQuantity;
        break;
      case 'decrement':
        updateOperation = { $inc: { stock: -numQuantity } };
        newStock = previousStock - numQuantity;
        break;
      case 'set':
      default:
        updateOperation = { $set: { stock: numQuantity } };
        newStock = numQuantity;
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      updateOperation,
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // ========== SEND NOTIFICATION ON STOCK INCREASE ==========
    // Only notify if stock increased and it's significant (at least 1 unit)
    if (newStock > previousStock && numQuantity > 0) {
      productWhatsappService.notifyProductStockUpdate(product, previousStock, newStock)
        .then(result => {
          console.log(`Stock update notification result for product ${product._id}:`, result.message);
        })
        .catch(error => {
          console.error(`Failed to send stock update notification for product ${product._id}:`, error);
        });
    }

    res.status(200).json({
      success: true,
      message: 'Product stock updated successfully',
      data: product,
      whatsappNotification: (newStock > previousStock && numQuantity > 0) ? {
        queued: true,
        note: 'Stock increase notification sent to wholesalers'
      } : null
    });
  } catch (error) {
    console.error('Update stock error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error updating product stock',
      error: error.message
    });
  }
};
// @desc    Get low stock products
// @route   GET /api/products/stock/low
// @access  Public
const getLowStockProducts = async (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 5;
    
    const products = await Product.find({
      stock: { $gt: 0, $lte: threshold }
    }).sort({ stock: 1 });

    res.status(200).json({
      success: true,
      count: products.length,
      threshold,
      data: products
    });
  } catch (error) {
    console.error('Get low stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching low stock products',
      error: error.message
    });
  }
};

// @desc    Get out of stock products
// @route   GET /api/products/stock/out
// @access  Public
const getOutOfStockProducts = async (req, res) => {
  try {
    const products = await Product.find({
      stock: { $lte: 0 }
    }).sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: products.length,
      data: products
    });
  } catch (error) {
    console.error('Get out of stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching out of stock products',
      error: error.message
    });
  }
};

// ==================== IMAGE MANAGEMENT ====================

// @desc    Add images to existing product
// @route   POST /api/products/:id/images
// @access  Public
const addProductImages = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No images uploaded'
      });
    }

    const primaryNewIdx = parsePrimaryNewImageIndex(
      req.body?.primaryImageIndex ?? req.body?.primaryNewImageIndex
    );
    const hadNoImages = !Array.isArray(product.images) || product.images.length === 0;

    // Add images
    req.files.forEach((file) => {
      product.images.push({
        url: file.path,
        publicId: file.filename,
        isPrimary: false,
        alt: product.product_name || 'product image'
      });
    });
    applyPrimaryToNewBatch(product, req.files.length, primaryNewIdx);
    syncPrimaryImageRoot(product);

    const updatedProduct = await product.save();

    if (hadNoImages && updatedProduct.images?.length > 0) {
      broadcastQueue.queueProductForBroadcast(updatedProduct);
    }

    res.status(200).json({
      success: true,
      message: `${req.files.length} image(s) added successfully`,
      data: updatedProduct
    });
  } catch (error) {
    console.error('Add images error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error adding images',
      error: error.message
    });
  }
};

// @desc    Delete image from product
// @route   DELETE /api/products/:id/images/:publicId
// @access  Public
const deleteProductImage = async (req, res) => {
  try {
    const { id } = req.params;
    let { publicId } = req.params;
    try {
      publicId = decodeURIComponent(publicId);
    } catch {
      /* keep encoded */
    }

    const product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Find image
    const imageIndex = product.images.findIndex(img => img.publicId === publicId);
    
    if (imageIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Image not found'
      });
    }

    // Delete from Cloudinary
    try {
      await cloudinary.uploader.destroy(publicId);
    } catch (cloudinaryError) {
      console.error('Cloudinary delete error:', cloudinaryError);
      // Continue even if Cloudinary delete fails
    }

    // Check if deleting primary image
    const wasPrimary = product.images[imageIndex].isPrimary;

    // Remove from array
    product.images.splice(imageIndex, 1);

    // If we deleted the primary image and there are other images, set a new primary
    if (wasPrimary && product.images.length > 0) {
      product.images[0].isPrimary = true;
    }

    syncPrimaryImageRoot(product);

    const updatedProduct = await product.save();

    res.status(200).json({
      success: true,
      message: 'Image deleted successfully',
      data: updatedProduct
    });
  } catch (error) {
    console.error('Delete image error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error deleting image',
      error: error.message
    });
  }
};

// @desc    Set primary image
// @route   PATCH /api/products/:id/images/:publicId/primary
// @access  Public
const setPrimaryImage = async (req, res) => {
  try {
    const { id } = req.params;
    let { publicId } = req.params;
    try {
      publicId = decodeURIComponent(publicId);
    } catch {
      /* keep encoded */
    }

    const product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Check if image exists
    const imageExists = product.images.some(img => img.publicId === publicId);
    
    if (!imageExists) {
      return res.status(404).json({
        success: false,
        message: 'Image not found'
      });
    }

    // Set primary
    product.images.forEach(img => {
      img.isPrimary = img.publicId === publicId;
    });
    syncPrimaryImageRoot(product);

    const updatedProduct = await product.save();

    res.status(200).json({
      success: true,
      message: 'Primary image updated',
      data: updatedProduct
    });
  } catch (error) {
    console.error('Set primary image error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error setting primary image',
      error: error.message
    });
  }
};

// @desc    Set primary image (body.publicId — supports Cloudinary ids with slashes)
// @route   PATCH /api/products/:id/images/primary
// @access  Private
const setPrimaryImageFromBody = async (req, res) => {
  try {
    const { id } = req.params;
    const publicId = String(req.body?.publicId ?? '').trim();

    if (!publicId) {
      return res.status(400).json({
        success: false,
        message: 'publicId is required in request body',
      });
    }

    const product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    const imageExists = product.images.some((img) => img.publicId === publicId);

    if (!imageExists) {
      return res.status(404).json({
        success: false,
        message: 'Image not found',
      });
    }

    product.images.forEach((img) => {
      img.isPrimary = img.publicId === publicId;
    });
    syncPrimaryImageRoot(product);

    const updatedProduct = await product.save();

    res.status(200).json({
      success: true,
      message: 'Primary image updated',
      data: updatedProduct,
    });
  } catch (error) {
    console.error('Set primary image (body) error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format',
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error setting primary image',
      error: error.message,
    });
  }
};

// @desc    Get product images
// @route   GET /api/products/:id/images
// @access  Public
const getProductImages = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).select('images product_name');

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.status(200).json({
      success: true,
      count: product.images.length,
      data: {
        productId: product._id,
        productName: product.product_name,
        images: product.images
      }
    });
  } catch (error) {
    console.error('Get images error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error fetching images',
      error: error.message
    });
  }
};

// @desc    Bulk upload images for multiple products
// @route   POST /api/products/images/bulk-upload
// @access  Public
const bulkUploadImages = async (req, res) => {
  try {
    const { productIds } = req.body;
    
    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide an array of product IDs'
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No images uploaded'
      });
    }

    const results = [];
    const errors = [];

    // For each product, assign images (round-robin if multiple products)
    for (let i = 0; i < productIds.length; i++) {
      const productId = productIds[i];
      
      try {
        const product = await Product.findById(productId);
        
        if (!product) {
          errors.push({ productId, error: 'Product not found' });
          continue;
        }

        // Assign images to this product (round-robin distribution)
        const imagesForProduct = req.files.filter((_, index) => index % productIds.length === i);
        
        imagesForProduct.forEach(file => {
          product.images.push({
            url: file.path,
            publicId: file.filename,
            isPrimary: product.images.length === 0,
            alt: product.product_name || 'product image'
          });
        });

        syncPrimaryImageRoot(product);
        await product.save();
        results.push({ 
          productId, 
          imagesAdded: imagesForProduct.length 
        });
      } catch (error) {
        errors.push({ productId, error: error.message });
      }
    }

    res.status(200).json({
      success: true,
      message: 'Bulk upload completed',
      results,
      errors
    });
  } catch (error) {
    console.error('Bulk upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Error in bulk upload',
      error: error.message
    });
  }
};

// ==================== FILTERS & CATEGORIES ====================

// @desc    Get all product types
// @route   GET /api/products/filters/types
// @access  Public
const getProductTypes = async (req, res) => {
  try {
    const types = await Product.distinct('product_type');
    res.status(200).json({
      success: true,
      data: types
    });
  } catch (error) {
    console.error('Get product types error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching product types',
      error: error.message
    });
  }
};

// @desc    Get all carriers
// @route   GET /api/products/filters/carriers
// @access  Public
const getAllCarriers = async (req, res) => {
  try {
    const carriers = await Product.distinct('carrier');
    res.status(200).json({
      success: true,
      data: carriers
    });
  } catch (error) {
    console.error('Get carriers error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching carriers',
      error: error.message
    });
  }
};

// @desc    Get all countries
// @route   GET /api/products/filters/countries
// @access  Public
const getAllCountries = async (req, res) => {
  try {
    const countries = await Product.distinct('country');
    res.status(200).json({
      success: true,
      data: countries
    });
  } catch (error) {
    console.error('Get countries error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching countries',
      error: error.message
    });
  }
};

// @desc    Get all colors
// @route   GET /api/products/filters/colors
// @access  Public
const getAllColors = async (req, res) => {
  try {
    const colors = await Product.distinct('color');
    res.status(200).json({
      success: true,
      data: colors
    });
  } catch (error) {
    console.error('Get colors error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching colors',
      error: error.message
    });
  }
};

// ==================== STATISTICS ====================

// @desc    Get inventory statistics
// @route   GET /api/products/stats/inventory
// @access  Public
const getInventoryStats = async (req, res) => {
  try {
    const totalProducts = await Product.countDocuments();
    const totalStock = await Product.aggregate([
      { $group: { _id: null, total: { $sum: '$stock' } } }
    ]);
    const averagePrice = await Product.aggregate([
      { $group: { _id: null, avg: { $avg: '$price' } } }
    ]);
    const outOfStock = await Product.countDocuments({ stock: 0 });
    const lowStock = await Product.countDocuments({ stock: { $gt: 0, $lte: 5 } });

    res.status(200).json({
      success: true,
      data: {
        totalProducts,
        totalStock: totalStock[0]?.total || 0,
        averagePrice: averagePrice[0]?.avg || 0,
        outOfStock,
        lowStock
      }
    });
  } catch (error) {
    console.error('Get inventory stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching inventory statistics',
      error: error.message
    });
  }
};

// @desc    Get price range statistics
// @route   GET /api/products/stats/price-range
// @access  Public
const getPriceRangeStats = async (req, res) => {
  try {
    const priceStats = await Product.aggregate([
      {
        $group: {
          _id: null,
          minPrice: { $min: '$price' },
          maxPrice: { $max: '$price' },
          avgPrice: { $avg: '$price' }
        }
      }
    ]);

    const priceRanges = await Product.aggregate([
      {
        $bucket: {
          groupBy: '$price',
          boundaries: [0, 100, 500, 1000, 2000, 5000],
          default: '5000+',
          output: {
            count: { $sum: 1 },
            products: { $push: '$product_name' }
          }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        summary: priceStats[0] || { minPrice: 0, maxPrice: 0, avgPrice: 0 },
        ranges: priceRanges
      }
    });
  } catch (error) {
    console.error('Get price stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching price statistics',
      error: error.message
    });
  }
};

// @desc    Get products by type
// @route   GET /api/products/stats/by-type
// @access  Public
const getProductsByType = async (req, res) => {
  try {
    const stats = await Product.aggregate([
      {
        $group: {
          _id: '$product_type',
          count: { $sum: 1 },
          totalStock: { $sum: '$stock' },
          averagePrice: { $avg: '$price' }
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.status(200).json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Get products by type error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching products by type',
      error: error.message
    });
  }
};

// ==================== FEATURED & RECOMMENDED ====================

// @desc    Get featured products
// @route   GET /api/products/featured
// @access  Public
const getFeaturedProducts = async (req, res) => {
  try {
    const filter = {
      stock: { $gt: 0 },
      isActive: true,
    };
    await applyPublicCatalogVisibilityFilter(filter);

    const products = await Product.find(filter)
      .populate(WAREHOUSE_POPULATE)
      .limit(10)
      .sort({ createdAt: -1 });

    await attachPricingCatalogImagesToProducts(products);
    const visible = products.filter((product) => productHasEffectiveShopImage(product));

    res.status(200).json({
      success: true,
      count: visible.length,
      data: visible,
    });
  } catch (error) {
    console.error('Get featured products error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching featured products',
      error: error.message
    });
  }
};

// @desc    Get recommended products based on current product
// @route   GET /api/products/recommended/:id
// @access  Public
const getRecommendedProducts = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Find similar products based on type, carrier, or price range
    const recommended = await Product.find({
      _id: { $ne: product._id },
      $or: [
        { product_type: product.product_type },
        { carrier: product.carrier },
        {
          price: {
            $gte: product.price * 0.7,
            $lte: product.price * 1.3
          }
        }
      ]
    })
    .limit(6)
    .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: recommended.length,
      data: recommended
    });
  } catch (error) {
    console.error('Get recommended products error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error fetching recommended products',
      error: error.message
    });
  }
};

// @desc    Get new arrivals
// @route   GET /api/products/new-arrivals
// @access  Public
const getNewArrivals = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const date = new Date();
    date.setDate(date.getDate() - days);

    const products = await Product.find({
      createdAt: { $gte: date }
    })
    .limit(20)
    .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: products.length,
      days,
      data: products
    });
  } catch (error) {
    console.error('Get new arrivals error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching new arrivals',
      error: error.message
    });
  }
};

// ==================== DUPLICATE & CLONE ====================

// @desc    Clone an existing product
// @route   POST /api/products/:id/clone
// @access  Public
const cloneProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Create a clone (exclude _id and timestamps)
    const productData = product.toObject();
    delete productData._id;
    delete productData.createdAt;
    delete productData.updatedAt;
    delete productData.__v;

    // Modify name to indicate it's a copy
    productData.product_name = `${productData.product_name} (Copy)`;

    normalizeImeOnPlainObject(productData);

    // Don't clone images (optional - you can decide to clone or not)
    // productData.images = []; // Uncomment if you don't want to clone images

    const clonedProduct = new Product(productData);
    await clonedProduct.save();

    res.status(201).json({
      success: true,
      message: 'Product cloned successfully',
      data: clonedProduct
    });
  } catch (error) {
    console.error('Clone product error:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error cloning product',
      error: error.message
    });
  }
};

// ==================== EXPORT FUNCTIONS ====================

// @desc    Export products to CSV
// @route   GET /api/products/export/csv
// @access  Public
const exportProductsToCSV = async (req, res) => {
  try {
    const products = await Product.find({}).lean();

    if (products.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No products to export'
      });
    }

    // Define CSV headers
    const headers = ['_id', 'product_name', 'product_type', 'models', 'capacity', 
                    'country', 'sim', 'carrier', 'color', 'price', 'stock', 
                    'description', 'createdAt'];

    // Create CSV rows
    const csvRows = [];
    csvRows.push(headers.join(','));

    for (const product of products) {
      const row = headers.map(header => {
        const value = product[header] || '';
        // Escape commas and quotes
        return `"${String(value).replace(/"/g, '""')}"`;
      });
      csvRows.push(row.join(','));
    }

    const csvString = csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=products.csv');
    res.status(200).send(csvString);
  } catch (error) {
    console.error('Export CSV error:', error);
    res.status(500).json({
      success: false,
      message: 'Error exporting products',
      error: error.message
    });
  }
};

// @desc    Export products to JSON
// @route   GET /api/products/export/json
// @access  Public
const exportProductsToJSON = async (req, res) => {
  try {
    const products = await Product.find({}).lean();

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=products.json');
    res.status(200).json(products);
  } catch (error) {
    console.error('Export JSON error:', error);
    res.status(500).json({
      success: false,
      message: 'Error exporting products',
      error: error.message
    });
  }
};

// ==================== MAINTENANCE ====================

// @desc    Clean up old products
// @route   DELETE /api/products/cleanup/old
// @access  Public (Should be protected in production)
const cleanupOldProducts = async (req, res) => {
  try {
    const { days = 365 } = req.query;
    const date = new Date();
    date.setDate(date.getDate() - parseInt(days));

    const result = await Product.deleteMany({
      createdAt: { $lt: date },
      stock: 0 // Only delete products that are out of stock
    });

    res.status(200).json({
      success: true,
      message: `Cleaned up ${result.deletedCount} old products`,
      data: result
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({
      success: false,
      message: 'Error cleaning up products',
      error: error.message
    });
  }
};

// @desc    Reindex products for search
// @route   POST /api/products/maintenance/reindex
// @access  Public (Should be protected in production)
const reindexProducts = async (req, res) => {
  try {
    // This is a placeholder - actual reindexing depends on your search solution
    // For MongoDB text search, you might need to recreate indexes
    await Product.collection.dropIndexes();
    await Product.ensureIndexes();
    
    res.status(200).json({
      success: true,
      message: 'Products reindexed successfully'
    });
  } catch (error) {
    console.error('Reindex error:', error);
    res.status(500).json({
      success: false,
      message: 'Error reindexing products',
      error: error.message
    });
  }
};

// ==================== VALIDATION & CHECK ====================

// @desc    Check if IMEI exists
// @route   GET /api/products/check/imei/:imei
// @access  Public
const checkIMEIExists = async (req, res) => {
  try {
    const { imei } = req.params;
    
    const product = await Product.findOne({ IME: imei });

    res.status(200).json({
      success: true,
      exists: !!product,
      data: product ? { productId: product._id, productName: product.product_name } : null
    });
  } catch (error) {
    console.error('Check IMEI error:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking IMEI',
      error: error.message
    });
  }
};

function resolveSoldImeListedPrice(row, orderDirect = {}, orderDoc = null) {
  if (Number(row?.listedPrice) > 0) return Number(row.listedPrice);
  if (Number(orderDoc?.productPrice) > 0) return Number(orderDoc.productPrice);
  if (Number(orderDirect?.wholesaleUnitPrice) > 0) return Number(orderDirect.wholesaleUnitPrice);
  return null;
}

function resolveSoldImeSoldPrice(row, orderDirect = {}, orderDoc = null) {
  if (Number(row?.unitPrice) > 0) return Number(row.unitPrice);
  if (Number(orderDirect?.soldUnitPrice) > 0) return Number(orderDirect.soldUnitPrice);
  const qty = Math.max(1, Number(orderDoc?.quantity) || 1);
  if (Number(orderDoc?.finalPrice) > 0) return Number(orderDoc.finalPrice) / qty;
  return null;
}

/** GET /api/admin/inventory/sold-out — sold IME units for admin inventory tab */
const listSoldOutInventory = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 250, 1), 500);
    const search = String(req.query.search || req.query.q || '').trim();

    const filter = { status: SOLD_IME_STATUS.SOLD_OUT };

    if (search.length >= 2) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [
        { ime: regex },
        { productName: regex },
        { brand: regex },
        { customerName: regex },
        { assignedWarehouseName: regex },
      ];
    }

    const [rows, total] = await Promise.all([
      SoldIme.find(filter)
        .populate('handledBy', 'name')
        .populate('assignedWarehouseId', 'name city')
        .populate('orderId', 'directSale productPrice finalPrice quantity')
        .sort({ soldAt: -1 })
        .limit(limit)
        .lean(),
      SoldIme.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      total,
      count: rows.length,
      data: rows.map((row) => {
        const warehouse =
          row.assignedWarehouseId && typeof row.assignedWarehouseId === 'object'
            ? row.assignedWarehouseId
            : null;
        const orderDirect = row.orderId?.directSale || {};
        const orderDoc =
          row.orderId && typeof row.orderId === 'object' && row.orderId._id ? row.orderId : null;
        const shopId =
          (row.assignedWarehouseId && typeof row.assignedWarehouseId === 'object'
            ? String(row.assignedWarehouseId._id || '')
            : row.assignedWarehouseId
              ? String(row.assignedWarehouseId)
              : '') ||
          (orderDirect.assignedWarehouseId ? String(orderDirect.assignedWarehouseId) : '');
        const shopName =
          row.assignedWarehouseName ||
          warehouse?.name ||
          orderDirect.assignedWarehouseName ||
          '';
        const shopCity = warehouse?.city || orderDirect.assignedWarehouseCity || '';

        return {
          id: String(row._id),
          ime: row.ime || '',
          productName: row.productName || 'Product',
          brand: row.brand || '',
          capacity: row.capacity || '',
          color: row.color || '',
          saleType: row.saleType || '',
          listedPrice: resolveSoldImeListedPrice(row, orderDirect, orderDoc),
          unitPrice: resolveSoldImeSoldPrice(row, orderDirect, orderDoc),
          customerName: row.customerName || '',
          soldAt: row.soldAt || row.createdAt || null,
          shop: {
            id: shopId,
            name: shopName,
            city: shopCity,
          },
          soldBy: {
            id: row.handledBy?._id
              ? String(row.handledBy._id)
              : row.handledBy
                ? String(row.handledBy)
                : '',
            name: row.handledBy?.name || '',
          },
        };
      }),
    });
  } catch (error) {
    console.error('listSoldOutInventory error:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not load sold-out inventory.',
    });
  }
};

/** GET /api/admin/inventory/ime-lookup?ime= — find product by IME; include sale details if sold out */
const lookupInventoryByIme = async (req, res) => {
  try {
    const query = String(req.query.ime || req.query.q || '').trim();
    if (query.length < 3) {
      return res.status(400).json({
        success: false,
        message: 'Enter at least 3 characters of the IME to search.',
      });
    }

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactRegex = new RegExp(`^${escaped}$`, 'i');
    const partialRegex = new RegExp(escaped, 'i');

    let soldRecord = await SoldIme.findOne({ ime: exactRegex, status: SOLD_IME_STATUS.SOLD_OUT }).lean();
    if (!soldRecord) {
      soldRecord = await SoldIme.findOne({ ime: partialRegex, status: SOLD_IME_STATUS.SOLD_OUT })
        .sort({ soldAt: -1 })
        .lean();
    }

    if (soldRecord) {
      const [product, order, handledBy, buyer] = await Promise.all([
        soldRecord.productId
          ? Product.findById(soldRecord.productId).populate(WAREHOUSE_POPULATE).lean()
          : null,
        soldRecord.orderId ? Order.findById(soldRecord.orderId).lean() : null,
        soldRecord.handledBy
          ? User.findById(soldRecord.handledBy).select('name user businessName').lean()
          : null,
        soldRecord.buyerUserId
          ? User.findById(soldRecord.buyerUserId).select('name businessName tel').lean()
          : null,
      ]);

      const directSale =
        order?.directSale && typeof order.directSale === 'object' ? order.directSale : {};
      const delivery =
        order?.deliveryInfo && typeof order.deliveryInfo === 'object' ? order.deliveryInfo : {};

      const soldWhereParts = [];
      if (directSale.assignedWarehouseName) {
        soldWhereParts.push(
          directSale.assignedWarehouseCity
            ? `${directSale.assignedWarehouseName} (${directSale.assignedWarehouseCity})`
            : directSale.assignedWarehouseName,
        );
      }
      if (delivery.deliveryAddress) {
        soldWhereParts.push(String(delivery.deliveryAddress));
      }

      const listedPrice =
        resolveSoldImeListedPrice(soldRecord, directSale, order) ??
        (Number(product?.price) > 0 ? Number(product.price) : null);
      const soldPrice = resolveSoldImeSoldPrice(soldRecord, directSale, order);

      return res.status(200).json({
        success: true,
        data: {
          query,
          status: 'sold_out',
          ime: soldRecord.ime,
          product: {
            productId: soldRecord.productId || product?._id || null,
            productName: soldRecord.productName || product?.product_name || 'Product',
            brand: soldRecord.brand || product?.brand || '',
            capacity: soldRecord.capacity || product?.capacity || '',
            color: soldRecord.color || product?.color || '',
            bulkBatchCode: soldRecord.bulkBatchCode || product?.bulkBatchCode || null,
            price: listedPrice ?? product?.price ?? null,
            phoneLocation: product?.phoneLocation || null,
            currentWarehouse: product?.currentWarehouse || null,
          },
          sale: {
            customerName: soldRecord.customerName || directSale.customerName || '',
            saleType: soldRecord.saleType || directSale.type || '',
            soldAt: soldRecord.soldAt || soldRecord.createdAt || null,
            orderId: soldRecord.orderId || null,
            listedPrice,
            soldPrice,
            assignedWarehouseName: directSale.assignedWarehouseName || null,
            assignedWarehouseCity: directSale.assignedWarehouseCity || null,
            assignedWarehouseType: directSale.assignedWarehouseType || null,
            deliveryAddress: delivery.deliveryAddress || null,
            soldWhereLabel: soldWhereParts.filter(Boolean).join(' · ') || null,
            handledByName: String(handledBy?.name || handledBy?.user || '').trim() || null,
            buyerName: String(buyer?.businessName || buyer?.name || '').trim() || null,
            buyerTel: buyer?.tel || null,
            orderStatus: order?.status || null,
          },
        },
      });
    }

    const products = await Product.find({
      $or: [{ IME: partialRegex }, { imeCodes: partialRegex }],
    })
      .populate(WAREHOUSE_POPULATE)
      .sort({ updatedAt: -1 })
      .limit(100);

    const results = [];
    for (const p of products) {
      const codes = normalizedImeList(p);
      const matching = codes.filter((code) => partialRegex.test(code));
      for (const ime of matching) {
        const wh = p.currentWarehouse;
        const shop = p.destinationSubWarehouse;
        results.push({
          ime,
          status: Number(p.stock) > 0 ? 'available' : 'out_of_stock',
          productId: p._id,
          productName: p.product_name,
          brand: p.brand,
          capacity: p.capacity,
          color: p.color,
          stock: Number(p.stock) || 0,
          price: p.price,
          shipmentStatus: p.shipmentStatus,
          phoneLocation: p.phoneLocation || null,
          bulkBatchCode: p.bulkBatchCode || null,
          currentWarehouse: wh
            ? { name: wh.name, city: wh.city, type: wh.type }
            : null,
          destinationShop: shop ? { name: shop.name, city: shop.city, type: shop.type } : null,
        });
      }
    }

    if (!results.length) {
      return res.status(404).json({
        success: false,
        message: 'No product found for this IME.',
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        query,
        status: 'in_inventory',
        count: results.length,
        results,
      },
    });
  } catch (error) {
    console.error('lookupInventoryByIme:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to search inventory by IME.',
      error: error.message,
    });
  }
};

/** PATCH /api/admin/inventory/sold-out/:soldImeId/revoke — restore one sold IME back to stock */
const revokeSoldOutInventoryUnit = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const soldImeId = String(req.params.soldImeId || '').trim();
    const revokeReason = String(req.body?.reason || '').trim();
    const adminId = req.user?.userId || req.user?.id || req.userId || null;
    if (!soldImeId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'soldImeId is required.',
      });
    }

    const sold = await SoldIme.findById(soldImeId).session(session);
    if (!sold) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: 'Sold unit record not found.',
      });
    }
    if (sold.status !== SOLD_IME_STATUS.SOLD_OUT) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({
        success: false,
        message: 'This sold unit is no longer active and cannot be revoked again.',
      });
    }

    const product = await Product.findById(sold.productId).session(session);
    if (!product) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: 'Original product record was not found.',
      });
    }

    const ime = String(sold.ime || '').trim();
    if (!ime) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Sold unit does not contain an IME code.',
      });
    }

    const assignedWarehouseId = sold.assignedWarehouseId ? String(sold.assignedWarehouseId) : '';
    const assignedWarehouse = assignedWarehouseId
      ? await Warehouse.findById(assignedWarehouseId).select('_id name type').session(session)
      : null;

    const currentCodes = normalizedImeList(product);
    if (!currentCodes.includes(ime)) {
      currentCodes.push(ime);
      product.imeCodes = currentCodes;
      product.IME = currentCodes[0] || ime;
      product.stock = Math.max(0, Number(product.stock) || 0) + 1;
    }

    if (assignedWarehouse) {
      product.currentWarehouse = assignedWarehouse._id;
      product.shipmentStatus = 'arrived';
      product.arrivedAt = new Date();
      if (String(assignedWarehouse.type || '').toLowerCase() === WAREHOUSE_TYPES.SUB) {
        product.destinationSubWarehouse = assignedWarehouse._id;
      }
      const history = Array.isArray(product.locationHistory) ? product.locationHistory : [];
      history.push({
        warehouse: assignedWarehouse._id,
        status: 'arrived',
        movedAt: new Date(),
        movedBy: adminId || null,
        note: revokeReason
          ? `Sale revoked for IME ${ime}: ${revokeReason}`
          : `Sale revoked for IME ${ime}`,
      });
      product.locationHistory = history;
    }
    await product.save({ session });

    let order = null;
    if (sold.orderId) {
      order = await Order.findById(sold.orderId).session(session);
    }
    if (!order && ime) {
      order = await Order.findOne({
        $or: [{ soldImeCodes: ime }, { 'directSale.imeManifest.ime': ime }],
      }).session(session);
    }
    if (order) {
      const soldImeCodes = Array.isArray(order.soldImeCodes) ? order.soldImeCodes : [];
      order.soldImeCodes = soldImeCodes.filter((code) => String(code || '').trim() !== ime);

      const directSale =
        order.directSale && typeof order.directSale === 'object' && !Array.isArray(order.directSale)
          ? { ...order.directSale }
          : {};
      const imeManifest = Array.isArray(directSale.imeManifest) ? directSale.imeManifest : [];
      directSale.imeManifest = imeManifest.filter(
        (line) => String(line?.ime || '').trim() !== ime,
      );

      const effectiveRemaining = Math.max(
        order.soldImeCodes.length,
        directSale.imeManifest.filter((line) => String(line?.ime || '').trim()).length,
      );

      if (effectiveRemaining <= 0) {
        await Order.deleteOne({ _id: order._id }).session(session);
      } else {
        const unitPriceFromOrder =
          Number(sold.unitPrice) ||
          Number(directSale.soldUnitPrice) ||
          Number(order.productPrice) ||
          0;
        order.quantity = effectiveRemaining;
        order.finalPrice = unitPriceFromOrder > 0 ? unitPriceFromOrder * effectiveRemaining : Math.max(0, Number(order.finalPrice) || 0);
        order.originalTotal = order.finalPrice;
        order.directSale = directSale;
        await order.save({ session });
      }
    }

    const deletedSoldImeId = String(sold._id);
    await SoldIme.deleteOne({ _id: sold._id }).session(session);

    await session.commitTransaction();
    session.endSession();
    return res.status(200).json({
      success: true,
      message: 'Sale revoked. Unit restored to shop inventory. Sold record and order removed when no units remain.',
      data: {
        soldImeId: deletedSoldImeId,
        ime,
        productId: String(product._id),
        productStock: Number(product.stock) || 0,
      },
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('revokeSoldOutInventoryUnit:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not revoke sold unit.',
      error: error.message,
    });
  }
};

// @desc    Check if SKU exists (using models as SKU)
// @route   GET /api/products/check/sku/:sku
// @access  Public
const checkSKUExists = async (req, res) => {
  try {
    const { sku } = req.params;
    
    const product = await Product.findOne({ models: sku });

    res.status(200).json({
      success: true,
      exists: !!product,
      data: product ? { productId: product._id, productName: product.product_name } : null
    });
  } catch (error) {
    console.error('Check SKU error:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking SKU',
      error: error.message
    });
  }
};

// @desc    Mark a travelling product as arrived at its destination sub-warehouse
// @route   PATCH /api/products/:id/arrive
// @access  Admin (JWT required on route)
const markProductArrived = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    if (product.shipmentStatus === 'arrived') {
      return res.status(400).json({
        success: false,
        message: 'This product is already marked as arrived.',
      });
    }

    const userId = req.user?.userId || req.user?.id || req.userId || null;

    if (!product.destinationSubWarehouse) {
      const currentWh = await Warehouse.findOne({
        _id: product.currentWarehouse,
        isActive: true,
      });
      if (!currentWh) {
        return res.status(400).json({
          success: false,
          message: 'This product has no current warehouse to receive stock at.',
        });
      }

      if (product.bulkShipment && product.bulkBatchCode) {
        return res.status(400).json({
          success: false,
          message: `Use batch receive for ${product.bulkBatchCode} (warehouse hub or inventory travelling tab).`,
          batchCode: product.bulkBatchCode,
        });
      }

      await applyProductReceivedAtWarehouse(
        product,
        currentWh,
        userId,
        `Received at ${currentWh.name}`,
      );

      const populated = await Product.findById(product._id).populate(WAREHOUSE_POPULATE);

      return res.status(200).json({
        success: true,
        message: `Product marked as received at ${currentWh.name}.`,
        data: populated,
      });
    }

    const sub = await Warehouse.findOne({
      _id: product.destinationSubWarehouse,
      type: WAREHOUSE_TYPES.SUB,
      isActive: true,
    });
    if (!sub) {
      return res.status(400).json({
        success: false,
        message: 'Destination Shop no longer exists or is inactive.',
      });
    }

    if (product.bulkShipment) {
      return res.status(400).json({
        success: false,
        message: `This product belongs to bulk batch ${product.bulkBatchCode || 'unknown'}. Mark the entire batch instead.`,
        batchCode: product.bulkBatchCode || null,
      });
    }

    await applyProductArrival(
      product,
      sub,
      userId,
      `Arrived at ${sub.name}`,
    );

    const populated = await Product.findById(product._id).populate(WAREHOUSE_POPULATE);

    return res.status(200).json({
      success: true,
      message: `Product marked as arrived at ${sub.name}.`,
      data: populated,
    });
  } catch (error) {
    console.error('markProductArrived:', error);
    return res.status(500).json({
      success: false,
      message: 'Error marking product as arrived.',
      error: error.message,
    });
  }
};

// Export all functions
module.exports = {
  // Basic CRUD
  createProduct,
  getAllProducts,
  getVendorShopProducts,
  getAdminInventoryProducts,
  getProductById,
  updateProduct,
  patchProduct,
  deleteProduct,
  
  // WhatsApp Broadcast Queue
  getBroadcastQueueStatus,
  forceBroadcastNow,  // ✅ Make sure this is forceBroadcastNow (not forceBroadcastNo)
  
  // Search
  searchProductsByName,
  advancedSearch,
  
  // Bulk Operations
  bulkCreateProducts,
  
  // Stock Management
  updateProductStock,
  markProductArrived,
  getLowStockProducts,
  getOutOfStockProducts,
  
  // Image Management
  addProductImages,
  deleteProductImage,
  setPrimaryImage,
  setPrimaryImageFromBody,
  getProductImages,
  bulkUploadImages,
  
  // Filters & Categories
  getProductTypes,
  getAllCarriers,
  getAllCountries,
  getAllColors,
  
  // Statistics
  getInventoryStats,
  getPriceRangeStats,
  getProductsByType,
  
  // Featured & Recommended
  getFeaturedProducts,
  getRecommendedProducts,
  getNewArrivals,
  
  // Duplicate & Clone
  cloneProduct,
  
  // Export Functions
  exportProductsToCSV,
  exportProductsToJSON,
  
  // Maintenance
  cleanupOldProducts,
  reindexProducts,
  
  // Validation & Check
  checkIMEIExists,
  checkSKUExists,
  listSoldOutInventory,
  lookupInventoryByIme,
  revokeSoldOutInventoryUnit,
};
