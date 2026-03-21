const mongoose = require('mongoose');
const { OrderRequest } = require('../models/Order');
const { Notification } = require('../models/Notification');

function notifyAudienceForOrderType(orderType) {
  return orderType === 'buy' ? 'salesman' : 'admin';
}

function buildUserIdFilter(userId) {
  if (!userId) return null;
  if (mongoose.Types.ObjectId.isValid(userId) && String(new mongoose.Types.ObjectId(userId)) === userId) {
    return { userId: new mongoose.Types.ObjectId(userId) };
  }
  return { userRef: String(userId) };
}

/**
 * POST /api/orders
 * Creates a pending order and fan-out notifications (staff + customer).
 */
async function createOrderRequest(req, res) {
  console.log("only joy my bothee ..............")
  console.log(req.body)
  try {
    const {
      userId,       // ← ADD THIS
      userRef,
      productId,
      productName,
      orderType,
      quantity,
      offerAmount,
      notes,
    } = req.body;

    if (!productId || !orderType || quantity == null) {
      return res.status(400).json({ message: 'productId, orderType, and quantity are required' });
    }

    if (!['buy', 'offer'].includes(orderType)) {
      return res.status(400).json({ message: 'orderType must be "buy" or "offer"' });
    }

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty < 1) {
      return res.status(400).json({ message: 'quantity must be a positive number' });
    }

    if (orderType === 'offer') {
      const offer = Number(offerAmount);
      if (!Number.isFinite(offer) || offer < 0) {
        return res.status(400).json({ message: 'offerAmount is required for offer orders' });
      }
    }

    const notifyAudience = notifyAudienceForOrderType(orderType);

    const orderPayload = {
      productId: String(productId).trim(),
      productName: productName ? String(productName).trim() : '',
      orderType,
      quantity: qty,
      notifyAudience,
      notes: notes ? String(notes).trim() : '',
    };

    if (orderType === 'offer') {
      orderPayload.offerAmount = Number(offerAmount);
    }

    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      orderPayload.userId = userId;
    }
    if (userRef != null && String(userRef).trim()) {
      orderPayload.userRef = String(userRef).trim();
    }

    const order = await OrderRequest.create(orderPayload);

    const staffTitle =
      orderType === 'buy' ? 'New buy order (pending)' : 'New price offer (pending)';
    const staffBody = `${productName || productId} · qty ${qty}${
      orderType === 'offer' ? ` · offered ${orderPayload.offerAmount}` : ''
    }`;

    await Notification.create({
      audience: notifyAudience,
      orderRequest: order._id,
      eventType: 'order_submitted',
      title: staffTitle,
      body: staffBody,
    });

    const customerTitle = 'Your order was received';
    const customerBody = `Order ${order._id} is pending review (${orderType}).`;

    const customerNotif = {
      audience: 'user',
      orderRequest: order._id,
      eventType: 'order_submitted',
      title: customerTitle,
      body: customerBody,
    };
    if (order.userId) customerNotif.userId = order.userId;
    if (order.userRef) customerNotif.userRef = order.userRef;

    await Notification.create(customerNotif);

    return res.status(201).json({
      order,
      message: 'Order created; notifications queued for staff and customer',
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: err.message, errors: err.errors });
    }
    console.error('createOrderRequest', err);
    return res.status(500).json({ message: 'Failed to create order' });
  }
}

/**
 * PATCH /api/orders/:id/status
 * Staff accepts/rejects; customer gets status notification.
 */
async function updateOrderStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, handledBy, handledByRef, notes } = req.body;

    if (!['accepted', 'rejected', 'cancelled', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const order = await OrderRequest.findById(id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    order.status = status;
    if (notes != null) order.notes = String(notes).trim() || order.notes;
    if (handledBy && mongoose.Types.ObjectId.isValid(handledBy)) {
      order.handledBy = handledBy;
    }
    if (handledByRef != null && String(handledByRef).trim()) {
      order.handledByRef = String(handledByRef).trim();
    }

    await order.save();

    const customerTitle = 'Order status updated';
    const customerBody = `Order ${order._id} is now "${status}".`;

    const customerNotif = {
      audience: 'user',
      orderRequest: order._id,
      eventType: 'order_status_update',
      title: customerTitle,
      body: customerBody,
    };
    if (order.userId) customerNotif.userId = order.userId;
    if (order.userRef) customerNotif.userRef = order.userRef;

    await Notification.create(customerNotif);

    return res.json({ order, message: 'Status updated; customer notified' });
  } catch (err) {
    console.error('updateOrderStatus', err);
    return res.status(500).json({ message: 'Failed to update order status' });
  }
}

/**
 * GET /api/notifications
 * Query: ?audience=salesman|admin|user&userId=...&read=false
 */
async function listNotifications(req, res) {
  try {
    const { audience, userId, read } = req.query;
    const filter = {};

    if (audience) {
      if (!['salesman', 'admin', 'user'].includes(audience)) {
        return res.status(400).json({ message: 'Invalid audience' });
      }
      filter.audience = audience;
    }

    if (audience === 'user' && userId) {
      const uid = buildUserIdFilter(userId);
      if (uid) Object.assign(filter, uid);
    }

    if (read === 'true') filter.read = true;
    if (read === 'false') filter.read = false;

    const items = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .populate('orderRequest')
      .limit(Math.min(Number(req.query.limit) || 50, 200));

    return res.json({ notifications: items, count: items.length });
  } catch (err) {
    console.error('listNotifications', err);
    return res.status(500).json({ message: 'Failed to list notifications' });
  }
}

/**
 * PATCH /api/notifications/:id/read
 */
async function markNotificationRead(req, res) {
  try {
    const { id } = req.params;
    const doc = await Notification.findByIdAndUpdate(id, { read: true }, { new: true });
    if (!doc) return res.status(404).json({ message: 'Notification not found' });
    return res.json({ notification: doc });
  } catch (err) {
    console.error('markNotificationRead', err);
    return res.status(500).json({ message: 'Failed to update notification' });
  }
}

/**
 * GET /api/orders — optional listing for dashboards (same audience rules)
 */
async function listOrders(req, res) {
  try {
    const { status, notifyAudience, userId } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (notifyAudience) filter.notifyAudience = notifyAudience;
    if (userId) {
      const uid = buildUserIdFilter(userId);
      if (uid) Object.assign(filter, uid);
    }

    const orders = await OrderRequest.find(filter).sort({ createdAt: -1 }).limit(200);
    return res.json({ orders, count: orders.length });
  } catch (err) {
    console.error('listOrders', err);
    return res.status(500).json({ message: 'Failed to list orders' });
  }
}

module.exports = {
  createOrderRequest,
  updateOrderStatus,
  listNotifications,
  markNotificationRead,
  listOrders,
};
