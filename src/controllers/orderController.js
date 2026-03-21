const mongoose = require('mongoose');
const { Order, ORDER_TYPES, ORDER_STATUS, NOTIFICATION_AUDIENCE } = require('../models/Order');
const { Notification, NOTIFICATION_TYPES } = require('../models/Notification');
const Product = require('../models/ItemsList');
const User = require('../models/User');

/**
 * Helper function to determine who should be notified
 */
function getNotifyAudience(orderType) {
  return orderType === ORDER_TYPES.BUY ? NOTIFICATION_AUDIENCE.SALESMAN : NOTIFICATION_AUDIENCE.ADMIN;
}

/**
 * Helper function to create notifications
 */
async function createOrderNotification(order, eventType, customTitle = null, customMessage = null) {
  const notifications = [];
  
  // Determine notification titles and messages based on event type
  let staffTitle, staffMessage, userTitle, userMessage;
  
  switch(eventType) {
    case NOTIFICATION_TYPES.ORDER_SUBMITTED:
      staffTitle = `New ${order.orderType === ORDER_TYPES.BUY ? 'Buy Order' : 'Price Offer'}`;
      staffMessage = `${order.productName} - Quantity: ${order.quantity}${order.orderType === ORDER_TYPES.OFFER ? `, Offered: $${order.offeredPrice}` : ''}`;
      userTitle = 'Order Received';
      userMessage = `Your ${order.orderType} order for ${order.productName} has been received and is pending review.`;
      break;
      
    case NOTIFICATION_TYPES.ORDER_ACCEPTED:
      staffTitle = `Order Accepted`;
      staffMessage = `${order.productName} (x${order.quantity}) - Order #${order._id}`;
      userTitle = 'Order Accepted 🎉';
      userMessage = `Your ${order.orderType} order for ${order.productName} has been accepted! ${order.orderType === ORDER_TYPES.OFFER ? `Final price: $${order.finalPrice}` : `Total: $${order.originalTotal}`}`;
      break;
      
    case NOTIFICATION_TYPES.ORDER_REJECTED:
      staffTitle = `Order Rejected`;
      staffMessage = `${order.productName} - Reason: ${order.rejectionReason || 'No reason provided'}`;
      userTitle = 'Order Declined';
      userMessage = `Your ${order.orderType} order for ${order.productName} was declined. ${order.rejectionReason ? `Reason: ${order.rejectionReason}` : 'Please contact support for more information.'}`;
      break;
      
    case NOTIFICATION_TYPES.ORDER_CANCELLED:
      staffTitle = `Order Cancelled`;
      staffMessage = `${order.productName} - Order #${order._id} was cancelled`;
      userTitle = 'Order Cancelled';
      userMessage = `Your ${order.orderType} order for ${order.productName} has been cancelled.`;
      break;
      
    default:
      staffTitle = customTitle || 'Order Update';
      staffMessage = customMessage || `Order #${order._id} has been updated`;
      userTitle = customTitle || 'Order Update';
      userMessage = customMessage || `Your order for ${order.productName} has been updated. Current status: ${order.status}`;
  }
  
  // Create staff notification (salesman or admin)
  if (order.status === ORDER_STATUS.PENDING || eventType === NOTIFICATION_TYPES.ORDER_SUBMITTED) {
    notifications.push({
      audience: order.notifyAudience,
      orderId: order._id,
      type: eventType,
      title: staffTitle,
      message: staffMessage,
      metadata: {
        orderType: order.orderType,
        quantity: order.quantity,
        productId: order.productId
      }
    });
  }
  
  // Create user notification
  notifications.push({
    audience: NOTIFICATION_AUDIENCE.USER,
    userId: order.userId,
    orderId: order._id,
    type: eventType,
    title: userTitle,
    message: userMessage,
    metadata: {
      orderType: order.orderType,
      status: order.status,
      productId: order.productId
    }
  });
  
  // Create all notifications
  await Notification.insertMany(notifications);
}

/**
 * POST /api/orders
 * Create a new order (buy or offer)
 */
async function createOrder(req, res) {
  try {
    console.log('📝 Creating order...');
    console.log('Request body:', req.body);
    
    const {
      userId,
      productId,
      orderType,
      quantity,
      offeredPrice,
      userNotes
    } = req.body;
    
    // Validation
    if (!userId || !productId || !orderType || !quantity) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: userId, productId, orderType, quantity'
      });
    }
    
    // Validate order type
    if (!Object.values(ORDER_TYPES).includes(orderType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order type. Must be "buy" or "offer"'
      });
    }
    
    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Check if product exists and get details
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    
    // Validate quantity
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty < 1) {
      return res.status(400).json({
        success: false,
        message: 'Quantity must be a positive number'
      });
    }
    
    // Check stock availability for buy orders
    if (orderType === ORDER_TYPES.BUY && product.stock < qty) {
      return res.status(400).json({
        success: false,
        message: `Insufficient stock. Available: ${product.stock}`,
        availableStock: product.stock
      });
    }
    
    // Validate offered price for offer orders
    if (orderType === ORDER_TYPES.OFFER) {
      const offerPrice = Number(offeredPrice);
      if (!Number.isFinite(offerPrice) || offerPrice <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Valid offered price is required for offer orders'
        });
      }
      
      if (offerPrice >= product.price) {
        return res.status(400).json({
          success: false,
          message: 'Offered price must be less than the original price to negotiate'
        });
      }
    }
    
    // Calculate totals
    const originalTotal = product.price * qty;
    const notifyAudience = getNotifyAudience(orderType);
    
    // Create order
    const orderData = {
      userId,
      productId,
      productName: product.product_name,
      productPrice: product.price,
      orderType,
      quantity: qty,
      originalTotal,
      notifyAudience,
      userNotes: userNotes || '',
      status: ORDER_STATUS.PENDING
    };
    
    if (orderType === ORDER_TYPES.OFFER) {
      orderData.offeredPrice = Number(offeredPrice);
    }
    
    const order = await Order.create(orderData);
    
    // Create notifications
    await createOrderNotification(order, NOTIFICATION_TYPES.ORDER_SUBMITTED);
    
    // If buy order, reduce stock
    if (orderType === ORDER_TYPES.BUY) {
      product.stock -= qty;
      await product.save();
    }
    
    return res.status(201).json({
      success: true,
      message: 'Order created successfully',
      data: {
        order,
        notificationsSent: true
      }
    });
    
  } catch (error) {
    console.error('Error creating order:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create order',
      error: error.message
    });
  }
}

/**
 * PATCH /api/orders/:id/accept
 * Accept an order (salesman for buy orders, admin for offer orders)
 */
async function acceptOrder(req, res) {
  try {
    const { id } = req.params;
    const { handledById, finalPrice, staffNotes } = req.body;
    
    if (!handledById) {
      return res.status(400).json({
        success: false,
        message: 'handledById is required'
      });
    }
    
    // Find order
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    // Check if order is pending
    if (order.status !== ORDER_STATUS.PENDING) {
      return res.status(400).json({
        success: false,
        message: `Cannot accept order with status: ${order.status}`
      });
    }
    
    // Check if staff has permission
    const staff = await User.findById(handledById);
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff user not found'
      });
    }
    
    // Verify the staff is authorized for this order type
    if (order.orderType === ORDER_TYPES.BUY && staff.role !== 'salesman' && staff.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only salesmen or admins can accept buy orders'
      });
    }
    
    if (order.orderType === ORDER_TYPES.OFFER && staff.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can accept offer orders'
      });
    }
    
    // Accept the order
    await order.accept(handledById, finalPrice);
    
    // Update staff notes if provided
    if (staffNotes) {
      order.staffNotes = staffNotes;
      await order.save();
    }
    
    // Create notifications
    await createOrderNotification(order, NOTIFICATION_TYPES.ORDER_ACCEPTED);
    
    return res.json({
      success: true,
      message: 'Order accepted successfully',
      data: order
    });
    
  } catch (error) {
    console.error('Error accepting order:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to accept order',
      error: error.message
    });
  }
}

/**
 * PATCH /api/orders/:id/reject
 * Reject an order
 */
async function rejectOrder(req, res) {
  try {
    const { id } = req.params;
    const { handledById, rejectionReason, staffNotes } = req.body;
    
    if (!handledById) {
      return res.status(400).json({
        success: false,
        message: 'handledById is required'
      });
    }
    
    if (!rejectionReason) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required'
      });
    }
    
    // Find order
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    // Check if order is pending
    if (order.status !== ORDER_STATUS.PENDING) {
      return res.status(400).json({
        success: false,
        message: `Cannot reject order with status: ${order.status}`
      });
    }
    
    // Reject the order
    await order.reject(handledById, rejectionReason);
    
    // Update staff notes if provided
    if (staffNotes) {
      order.staffNotes = staffNotes;
      await order.save();
    }
    
    // Create notifications
    await createOrderNotification(order, NOTIFICATION_TYPES.ORDER_REJECTED);
    
    return res.json({
      success: true,
      message: 'Order rejected successfully',
      data: order
    });
    
  } catch (error) {
    console.error('Error rejecting order:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to reject order',
      error: error.message
    });
  }
}

/**
 * PATCH /api/orders/:id/cancel
 * Cancel an order (by user)
 */
async function cancelOrder(req, res) {
  try {
    const { id } = req.params;
    const { userId, reason } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId is required'
      });
    }
    
    // Find order
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    // Verify the user owns this order
    if (order.userId.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'You can only cancel your own orders'
      });
    }
    
    // Check if order can be cancelled
    if (order.status !== ORDER_STATUS.PENDING) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel order with status: ${order.status}`
      });
    }
    
    // Cancel the order
    await order.cancel();
    
    // Add cancellation reason to notes
    if (reason) {
      order.userNotes = reason;
      await order.save();
    }
    
    // Create notifications
    await createOrderNotification(order, NOTIFICATION_TYPES.ORDER_CANCELLED);
    
    // If it was a buy order, restore stock
    if (order.orderType === ORDER_TYPES.BUY) {
      const product = await Product.findById(order.productId);
      if (product) {
        product.stock += order.quantity;
        await product.save();
      }
    }
    
    return res.json({
      success: true,
      message: 'Order cancelled successfully',
      data: order
    });
    
  } catch (error) {
    console.error('Error cancelling order:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to cancel order',
      error: error.message
    });
  }
}

/**
 * GET /api/orders
 * Get orders with filters
 */
async function getOrders(req, res) {
  try {
    const { userId, status, orderType, notifyAudience, limit = 50, page = 1 } = req.query;
    
    const filter = {};
    
    if (userId) filter.userId = userId;
    if (status) filter.status = status;
    if (orderType) filter.orderType = orderType;
    if (notifyAudience) filter.notifyAudience = notifyAudience;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);
    
    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate('userId', 'name businessName tel')
      .populate('productId', 'product_name price images');
    
    const total = await Order.countDocuments(filter);
    
    return res.json({
      success: true,
      data: orders,
      pagination: {
        page: parseInt(page),
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
    
  } catch (error) {
    console.error('Error getting orders:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get orders',
      error: error.message
    });
  }
}

/**
 * GET /api/orders/:id
 * Get a single order by ID
 */
async function getOrderById(req, res) {
  try {
    const { id } = req.params;
    
    const order = await Order.findById(id)
      .populate('userId', 'name businessName tel email')
      .populate('productId', 'product_name price images description')
      .populate('handledBy', 'name role');
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    return res.json({
      success: true,
      data: order
    });
    
  } catch (error) {
    console.error('Error getting order:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get order',
      error: error.message
    });
  }
}

/**
 * GET /api/notifications
 * Get notifications for user or staff
 */
async function getNotifications(req, res) {
  try {
    const { userId, audience, limit = 50, unreadOnly = false } = req.query;
    
    let filter = {};
    
    if (userId) {
      filter.userId = userId;
      filter.audience = NOTIFICATION_AUDIENCE.USER;
    } else if (audience) {
      filter.audience = audience;
    } else {
      return res.status(400).json({
        success: false,
        message: 'Either userId or audience is required'
      });
    }
    
    if (unreadOnly === 'true') {
      filter.read = false;
    }
    
    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .populate('orderId', 'orderType quantity status productName originalTotal finalPrice');
    
    const unreadCount = await Notification.countDocuments({ ...filter, read: false });
    
    return res.json({
      success: true,
      data: notifications,
      unreadCount,
      count: notifications.length
    });
    
  } catch (error) {
    console.error('Error getting notifications:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get notifications',
      error: error.message
    });
  }
}

/**
 * PATCH /api/notifications/:id/read
 * Mark a notification as read
 */
async function markNotificationRead(req, res) {
  try {
    const { id } = req.params;
    
    const notification = await Notification.findById(id);
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }
    
    await notification.markAsRead();
    
    return res.json({
      success: true,
      message: 'Notification marked as read',
      data: notification
    });
    
  } catch (error) {
    console.error('Error marking notification as read:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to mark notification as read',
      error: error.message
    });
  }
}

/**
 * PATCH /api/notifications/mark-all-read
 * Mark all notifications as read for a user
 */
async function markAllNotificationsRead(req, res) {
  try {
    const { userId, audience } = req.body;
    
    let filter = { read: false };
    
    if (userId) {
      filter.userId = userId;
      filter.audience = NOTIFICATION_AUDIENCE.USER;
    } else if (audience) {
      filter.audience = audience;
    } else {
      return res.status(400).json({
        success: false,
        message: 'Either userId or audience is required'
      });
    }
    
    const result = await Notification.updateMany(
      filter,
      { read: true, readAt: new Date() }
    );
    
    return res.json({
      success: true,
      message: `${result.modifiedCount} notifications marked as read`,
      modifiedCount: result.modifiedCount
    });
    
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to mark notifications as read',
      error: error.message
    });
  }
}

module.exports = {
  createOrder,
  acceptOrder,
  rejectOrder,
  cancelOrder,
  getOrders,
  getOrderById,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead
};