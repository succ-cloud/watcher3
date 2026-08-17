const mongoose = require('mongoose');
const BulkShipment = require('../models/BulkShipment');
const { BULK_SHIPMENT_STATUS } = require('../models/BulkShipment');
const Product = require('../models/ItemsList');
const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');
const { applyProductArrival, applyProductReceivedAtWarehouse } = require('../utils/productWarehouseArrival');

const SHIPMENT_POPULATE = [
  { path: 'mainWarehouse', select: 'name type city address' },
  { path: 'destinationSubWarehouse', select: 'name type city address' },
  { path: 'createdBy', select: 'name businessName' },
  { path: 'arrivedBy', select: 'name businessName' },
];

function isObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ''));
}

async function findBulkShipmentByIdOrCode(idOrCode) {
  const key = String(idOrCode || '').trim();
  if (!key) return null;
  if (isObjectId(key)) {
    const byId = await BulkShipment.findById(key);
    if (byId) return byId;
  }
  return BulkShipment.findOne({ batchCode: key.toUpperCase() });
}

/** GET /api/admin/bulk-shipments */
async function listBulkShipments(req, res) {
  try {
    const { status } = req.query;
    const filter = {};
    if (status && ['travelling', 'arrived'].includes(String(status))) {
      filter.status = status;
    }

    const shipments = await BulkShipment.find(filter)
      .populate(SHIPMENT_POPULATE)
      .sort({ createdAt: -1 })
      .limit(Math.min(parseInt(req.query.limit, 10) || 100, 200));

    return res.status(200).json({
      success: true,
      count: shipments.length,
      data: shipments,
    });
  } catch (err) {
    console.error('listBulkShipments:', err);
    return res.status(500).json({ success: false, message: 'Failed to load bulk shipments.' });
  }
}

/** GET /api/admin/bulk-shipments/:idOrCode */
async function getBulkShipment(req, res) {
  try {
    const shipment = await findBulkShipmentByIdOrCode(req.params.idOrCode);
    if (!shipment) {
      return res.status(404).json({ success: false, message: 'Bulk shipment not found.' });
    }

    await shipment.populate(SHIPMENT_POPULATE);

    const products = await Product.find({ bulkShipment: shipment._id })
      .select('product_name brand capacity color stock price shipmentStatus bulkBatchCode createdAt')
      .sort({ createdAt: -1 })
      .limit(500);

    return res.status(200).json({
      success: true,
      data: {
        shipment,
        products,
      },
    });
  } catch (err) {
    console.error('getBulkShipment:', err);
    return res.status(500).json({ success: false, message: 'Failed to load bulk shipment.' });
  }
}

/** PATCH /api/admin/bulk-shipments/:idOrCode/arrive — mark entire batch delivered to sub-warehouse */
async function markBulkShipmentArrived(req, res) {
  try {
    const shipment = await findBulkShipmentByIdOrCode(req.params.idOrCode);
    if (!shipment) {
      return res.status(404).json({ success: false, message: 'Bulk shipment not found.' });
    }

    if (shipment.status === BULK_SHIPMENT_STATUS.ARRIVED) {
      return res.status(400).json({
        success: false,
        message: `Batch ${shipment.batchCode} is already marked as delivered to the warehouse.`,
      });
    }

    const userId = req.user?.userId || req.user?.id || req.userId || null;

    if (!shipment.destinationSubWarehouse) {
      const main = await Warehouse.findOne({
        _id: shipment.mainWarehouse,
        type: WAREHOUSE_TYPES.MAIN,
        isActive: true,
      });
      if (!main) {
        return res.status(400).json({
          success: false,
          message: 'Main warehouse for this batch is missing or inactive.',
        });
      }

      const travellingAtMain = await Product.find({
        bulkShipment: shipment._id,
        currentWarehouse: main._id,
        shipmentStatus: 'travelling',
      });

      if (!travellingAtMain.length) {
        return res.status(400).json({
          success: false,
          message: `Batch ${shipment.batchCode} has no travelling products to receive at the main warehouse.`,
        });
      }

      const note = `Bulk batch ${shipment.batchCode} received at ${main.name}`;
      for (const product of travellingAtMain) {
        await applyProductReceivedAtWarehouse(product, main, userId, note);
      }

      await shipment.populate(SHIPMENT_POPULATE);

      return res.status(200).json({
        success: true,
        message: `Batch ${shipment.batchCode}: ${travellingAtMain.length} product(s) marked as received at ${main.name}. Assign a shop, then transfer when ready.`,
        data: {
          shipment,
          updatedCount: travellingAtMain.length,
          batchCode: shipment.batchCode,
          receivedAtMain: true,
        },
      });
    }

    const sub = await Warehouse.findOne({
      _id: shipment.destinationSubWarehouse,
      type: WAREHOUSE_TYPES.SUB,
      isActive: true,
    });
    if (!sub) {
      return res.status(400).json({
        success: false,
        message: 'Destination Shop no longer exists or is inactive.',
      });
    }

    const travellingProducts = await Product.find({
      bulkShipment: shipment._id,
      shipmentStatus: { $in: ['travelling', 'arrived'] },
      currentWarehouse: shipment.mainWarehouse,
    });

    if (!travellingProducts.length) {
      const anyLeft = await Product.countDocuments({
        bulkShipment: shipment._id,
        shipmentStatus: 'travelling',
      });
      if (!anyLeft) {
        shipment.status = BULK_SHIPMENT_STATUS.ARRIVED;
        shipment.arrivedAt = shipment.arrivedAt || new Date();
        shipment.arrivedBy = userId;
        await shipment.save();
      }
      await shipment.populate(SHIPMENT_POPULATE);

      return res.status(200).json({
        success: true,
        message: `Batch ${shipment.batchCode} was already delivered (no stock left at main).`,
        data: { shipment, updatedCount: 0 },
      });
    }

    const note = `Bulk batch ${shipment.batchCode} delivered to ${sub.name}`;
    for (const product of travellingProducts) {
      await applyProductArrival(product, sub, userId, note);
    }

    shipment.status = BULK_SHIPMENT_STATUS.ARRIVED;
    shipment.arrivedAt = new Date();
    shipment.arrivedBy = userId;
    shipment.destinationSubWarehouse = sub._id;
    shipment.productCount = Math.max(shipment.productCount, travellingProducts.length);
    await shipment.save();
    await shipment.populate(SHIPMENT_POPULATE);

    return res.status(200).json({
      success: true,
      message: `Batch ${shipment.batchCode}: ${travellingProducts.length} product(s) marked as delivered to ${sub.name}.`,
      data: {
        shipment,
        updatedCount: travellingProducts.length,
        batchCode: shipment.batchCode,
      },
    });
  } catch (err) {
    console.error('markBulkShipmentArrived:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to mark bulk shipment as delivered.',
      error: err.message,
    });
  }
}

module.exports = {
  listBulkShipments,
  getBulkShipment,
  markBulkShipmentArrived,
  findBulkShipmentByIdOrCode,
};
