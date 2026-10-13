const mongoose = require('mongoose');

const SINGLETON_KEY = 'default';

const pricingCatalogOptionsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: SINGLETON_KEY,
    },
    brands: {
      type: [String],
      default: [],
    },
    productNamesByBrand: {
      type: Map,
      of: [String],
      default: {},
    },
  },
  { timestamps: true },
);

const PricingCatalogOptions =
  mongoose.models.PricingCatalogOptions ||
  mongoose.model('PricingCatalogOptions', pricingCatalogOptionsSchema);

async function getOrCreatePricingCatalogOptions() {
  let doc = await PricingCatalogOptions.findOne({ key: SINGLETON_KEY });
  if (!doc) {
    doc = await PricingCatalogOptions.create({ key: SINGLETON_KEY });
  }
  return doc;
}

module.exports = PricingCatalogOptions;
module.exports.SINGLETON_KEY = SINGLETON_KEY;
module.exports.getOrCreatePricingCatalogOptions = getOrCreatePricingCatalogOptions;
