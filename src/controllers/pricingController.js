const {
  MAX_PRICING_IMAGES,
  listPricingCatalog,
  createPricingEntry,
  updatePricingEntry,
  appendPricingImages,
  normalizePricingImages,
} = require('../service/pricingCatalogService');

function uploadedFiles(req) {
  if (Array.isArray(req?.files) && req.files.length) return req.files;
  if (req?.file) return [req.file];
  return [];
}

const listPricing = async (req, res) => {
  try {
    const search = req.query.search || req.query.q || '';
    const rows = await listPricingCatalog({ search });
    return res.json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error('listPricing error:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not load pricing catalog.',
    });
  }
};

/** Pricing catalog rows with images + prices — for vendor shop matching (any logged-in user). */
const listShopPricingImages = async (req, res) => {
  try {
    const rows = await listPricingCatalog({});
    const images = rows
      .filter((row) => normalizePricingImages(row).length > 0)
      .map((row) => {
        const rowImages = normalizePricingImages(row);
        const primary = rowImages[0] || {};
        return {
          productName: row.productName,
          brand: row.brand,
          capacity: row.capacity,
          imageUrl: primary.url || row.imageUrl,
          imagePublicId: primary.publicId || row.imagePublicId || '',
          imageAlt: primary.alt || row.imageAlt || row.productName || '',
          images: rowImages.map((img) => ({
            url: img.url,
            publicId: img.publicId,
            alt: img.alt,
            isPrimary: Boolean(img.isPrimary),
          })),
          wholesalePrice: row.wholesalePrice ?? null,
          retailPrice: row.retailPrice ?? null,
        };
      });
    return res.json({ success: true, count: images.length, data: images });
  } catch (error) {
    console.error('listShopPricingImages error:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not load pricing catalog images.',
    });
  }
};

const createPricing = async (req, res) => {
  try {
    const row = await createPricingEntry(req, req.body, uploadedFiles(req));
    return res.status(201).json({
      success: true,
      message: 'Pricing entry created.',
      data: row,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('createPricing error:', error);
    return res.status(status).json({
      success: false,
      message: error.message || 'Could not create pricing entry.',
    });
  }
};

const updatePricing = async (req, res) => {
  try {
    const isMultipart = String(req.headers['content-type'] || '').includes('multipart/form-data');
    if (isMultipart && !uploadedFiles(req).length) {
      console.warn(
        'updatePricing: multipart request without uploaded files — use POST /api/pricing/:id/image for photos',
      );
    }
    const row = await updatePricingEntry(req, req.params.id, req.body, uploadedFiles(req));
    return res.json({
      success: true,
      message: 'Pricing entry updated.',
      data: row,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('updatePricing error:', error);
    return res.status(status).json({
      success: false,
      message: error.message || 'Could not update pricing entry.',
    });
  }
};

const uploadPricingImage = async (req, res) => {
  try {
    const files = uploadedFiles(req);
    if (!files.length) {
      return res.status(400).json({
        success: false,
        message: 'Select at least one image file to upload.',
      });
    }

    const row = await appendPricingImages(req, req.params.id, files);
    const imageCount = normalizePricingImages(row).length;
    return res.json({
      success: true,
      message:
        imageCount >= MAX_PRICING_IMAGES
          ? `Pricing images saved (${MAX_PRICING_IMAGES} maximum).`
          : 'Pricing images saved.',
      data: row,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('uploadPricingImage error:', error);
    return res.status(status).json({
      success: false,
      message: error.message || 'Could not save pricing images.',
    });
  }
};

module.exports = {
  listPricing,
  listShopPricingImages,
  createPricing,
  updatePricing,
  uploadPricingImage,
};
