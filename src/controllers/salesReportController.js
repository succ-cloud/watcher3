const { Order, ORDER_STATUS } = require('../models/Order');
const Warehouse = require('../models/Warehouse');
const User = require('../models/User');
const { ROLES } = require('../models/User');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');

const COMMISSION_PER_UNIT = 3000;

function parseMonthKey(raw) {
  const s = String(raw || '').trim();
  const match = /^(\d{4})-(\d{2})$/.exec(s);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthDateRange(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const end = new Date(y, m, 1, 0, 0, 0, 0);
  return { start, end };
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

const getMonthlySalesReport = async (req, res) => {
  try {
    const monthKey = parseMonthKey(req.query.month) || currentMonthKey();
    const shopId = String(req.query.shopId || req.query.shop || '').trim();
    const staffId = String(req.query.staffId || req.query.salespersonId || '').trim();

    const { start, end } = monthDateRange(monthKey);

    const orderFilter = {
      status: ORDER_STATUS.ACCEPTED,
      $or: [
        { handledAt: { $gte: start, $lt: end } },
        { createdAt: { $gte: start, $lt: end } },
      ],
      'directSale.type': { $in: ['retail', 'wholesale'] },
    };
    if (staffId) orderFilter.handledBy = staffId;

    const [orderRows, shops, staffUsers] = await Promise.all([
      Order.find(orderFilter)
        .populate('handledBy', 'name role assignedShops')
        .sort({ handledAt: -1, createdAt: -1 })
        .lean(),
      Warehouse.find({ type: WAREHOUSE_TYPES.SUB, isActive: { $ne: false } })
        .select('name city')
        .sort({ name: 1 })
        .lean(),
      User.find({
        role: ROLES.SALESMAN,
        accountStatus: { $ne: 'suspended' },
      })
        .select('name assignedShops')
        .sort({ name: 1 })
        .lean(),
    ]);

    const rows = [];
    const shopsById = new Map(shops.map((s) => [String(s._id), s]));
    const shopsByName = new Map(
      shops.map((s) => [String(s?.name || '').trim().toLowerCase(), s]).filter(([k]) => Boolean(k)),
    );

    for (const order of orderRows) {
      const directSale = order?.directSale && typeof order.directSale === 'object' ? order.directSale : {};
      const assignedId = directSale?.assignedWarehouseId
        ? String(
            typeof directSale.assignedWarehouseId === 'object'
              ? directSale.assignedWarehouseId?._id || directSale.assignedWarehouseId?.id || directSale.assignedWarehouseId
              : directSale.assignedWarehouseId,
          )
        : '';
      let assignedName = String(directSale?.assignedWarehouseName || '').trim();
      if (!assignedName && assignedId) {
        assignedName = shopsById.get(assignedId)?.name || '';
      }
      if (!assignedName && assignedId) {
        assignedName = 'Shop';
      }
      if (!assignedId && assignedName) {
        const byName = shopsByName.get(assignedName.toLowerCase());
        if (byName?._id) {
          // normalize id when only name exists in legacy records
          if (shopId && String(byName._id) !== shopId) continue;
        }
      }
      if (shopId && assignedId && assignedId !== shopId) continue;
      if (shopId && !assignedId && assignedName) {
        const byName = shopsByName.get(assignedName.toLowerCase());
        if (!byName || String(byName._id) !== shopId) continue;
      }
      if (shopId && !assignedId && !assignedName) continue;

      const qty = Math.max(1, Number(order?.quantity) || 1);
      const lineTotal = Number(order?.finalPrice ?? order?.productPrice ?? 0);
      const unitPrice = qty > 0 ? (lineTotal > 0 ? Math.round(lineTotal / qty) : Number(order?.productPrice) || 0) : 0;
      const manifest = Array.isArray(directSale?.imeManifest) ? directSale.imeManifest : [];
      const imeCodes = Array.isArray(order?.soldImeCodes) ? order.soldImeCodes : [];
      const firstIme =
        (manifest.find((m) => String(m?.ime || '').trim())?.ime || imeCodes[0] || '').toString().trim();
      const firstManifest = manifest[0] || {};
      const staff = order?.handledBy;
      const rowId = order?._id ? String(order._id) : `${order?.productName || 'order'}-${String(order?.handledAt || order?.createdAt || '')}`;
      rows.push({
        id: rowId,
        rowId,
        orderId: rowId,
        productName: order?.productName || 'Product',
        customerName: directSale?.customerName || '',
        brand: firstManifest?.brand || '',
        capacity: firstManifest?.capacity || '',
        color: firstManifest?.color || '',
        ime: firstIme || '—',
        price: unitPrice,
        quantity: qty,
        soldAt: order?.handledAt || order?.createdAt || null,
        saleType: directSale?.type || '',
        soldBy: {
          id: staff?._id ? String(staff._id) : order?.handledBy ? String(order.handledBy) : '',
          name: staff?.name || 'Staff',
        },
        shop: {
          id: assignedId,
          name: assignedName || '—',
        },
      });
    }

    const totalQuantity = rows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
    const totalRevenue = rows.reduce(
      (sum, row) => sum + (Number(row.price) || 0) * (Number(row.quantity) || 0),
      0,
    );
    const commission =
      shopId || staffId ? totalQuantity * COMMISSION_PER_UNIT : null;

    const shopStaff = shopId
      ? staffUsers
          .filter((u) =>
            (u.assignedShops || []).some((id) => String(id) === shopId),
          )
          .map((u) => ({ id: String(u._id), name: u.name || 'Salesperson' }))
      : staffUsers.map((u) => ({ id: String(u._id), name: u.name || 'Salesperson' }));

    return res.json({
      success: true,
      month: monthKey,
      commissionPerUnit: COMMISSION_PER_UNIT,
      filters: {
        shops: shops.map((s) => ({
          id: String(s._id),
          name: s.name,
          city: s.city || '',
        })),
        staff: shopStaff,
      },
      summary: {
        totalQuantity,
        totalRevenue,
        commission,
        rowCount: rows.length,
       
      },
      data: rows,
    });
  } catch (error) {
    console.error('getMonthlySalesReport error:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not load monthly sales report.',
    });
  }
};

module.exports = {
  getMonthlySalesReport,
  COMMISSION_PER_UNIT,
};
