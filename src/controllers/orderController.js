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
      
      if (order.deliveryInfo && order.deliveryInfo.estimatedDeliveryDate) {
        const estimatedDate = new Date(order.deliveryInfo.estimatedDeliveryDate).toLocaleDateString();
        userMessage += ` Estimated delivery: ${estimatedDate}.`;
      }
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
      
    case NOTIFICATION_TYPES.DELIVERY_UPDATED:
      staffTitle = 'Delivery Updated';
      staffMessage = `Delivery for ${order.productName} (Order #${order._id}) updated: ${order.deliveryInfo.deliveryStatus}`;
      userTitle = 'Delivery Update 🚚';
      userMessage = `Your order for ${order.productName} delivery has been updated. Status: ${order.deliveryInfo.deliveryStatus}.`;
      
      if (order.deliveryInfo.estimatedDeliveryDate) {
        const estimatedDate = new Date(order.deliveryInfo.estimatedDeliveryDate).toLocaleDateString();
        userMessage += ` Estimated delivery: ${estimatedDate}.`;
      }
      if (order.deliveryInfo.trackingNumber) {
        userMessage += ` Tracking number: ${order.deliveryInfo.trackingNumber}.`;
      }
      if (order.deliveryInfo.courierService) {
        userMessage += ` Courier: ${order.deliveryInfo.courierService}.`;
      }
      break;
      
    default:
      staffTitle = customTitle || 'Order Update';
      staffMessage = customMessage || `Order #${order._id} has been updated`;
      userTitle = customTitle || 'Order Update';
      userMessage = customMessage || `Your order for ${order.productName} has been updated. Current status: ${order.status}`;
  }
  
  // Create staff notification
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
        productId: order.productId,
        deliveryStatus: order.deliveryInfo?.deliveryStatus || null
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
      productId: order.productId,
      deliveryInfo: order.deliveryInfo || null
    }
  });
  
  await Notification.insertMany(notifications);
}

/**
 * POST /api/orders
 * Create a new order
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
      userNotes,
      deliveryAddress
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
    
    // Check if user exists and get WhatsApp number
    const user = await User.findById(userId).select('name businessName tel whatsappNumber businessAddress');
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
    
    // Add delivery address if provided
    if (deliveryAddress) {
      orderData.deliveryInfo = {
        deliveryAddress,
        deliveryStatus: 'pending'
      };
    } else if (user.businessAddress) {
      orderData.deliveryInfo = {
        deliveryAddress: user.businessAddress,
        deliveryStatus: 'pending'
      };
    }
    
    if (orderType === ORDER_TYPES.OFFER) {
      orderData.offeredPrice = Number(offeredPrice);
    }
    
    const order = await Order.create(orderData);
    
    // Create in-app notifications
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
        user: {
          id: user._id,
          name: user.name,
          businessName: user.businessName,
          tel: user.tel,
          whatsappNumber: user.whatsappNumber,
          businessAddress: user.businessAddress
        },
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
 * Accept an order and reduce stock
 */
async function acceptOrder(req, res) {
  try {
    const { id } = req.params;
    const { 
      handledById, 
      finalPrice, 
      staffNotes,
      estimatedDeliveryDate,
      deliveryAddress,
      trackingNumber,
      courierService,
      deliveryNotes
    } = req.body;
    
    if (!handledById) {
      return res.status(400).json({
        success: false,
        message: 'handledById is required'
      });
    }
    
    // Find order and populate user info
    const order = await Order.findById(id).populate('userId', 'name businessName tel whatsappNumber businessAddress');
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
    
    // STOCK DEDUCTION
    const product = await Product.findById(order.productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    
    // Check if enough stock is available
    if (product.stock < order.quantity) {
      return res.status(400).json({
        success: false,
        message: `Insufficient stock. Available: ${product.stock}, Required: ${order.quantity}`,
        availableStock: product.stock,
        requiredQuantity: order.quantity
      });
    }
    
    // Deduct the stock
    product.stock -= order.quantity;
    await product.save();
    
    console.log(`✅ Stock deducted for product ${product.product_name}:`);
    console.log(`   - Order ID: ${order._id}`);
    console.log(`   - Quantity deducted: ${order.quantity}`);
    console.log(`   - Remaining stock: ${product.stock}`);
    
    // Prepare delivery data if provided
    const deliveryData = {};
    if (estimatedDeliveryDate) {
      deliveryData.estimatedDeliveryDate = new Date(estimatedDeliveryDate);
    }
    if (deliveryAddress) {
      deliveryData.deliveryAddress = deliveryAddress;
    }
    if (trackingNumber) {
      deliveryData.trackingNumber = trackingNumber;
    }
    if (courierService) {
      deliveryData.courierService = courierService;
    }
    if (deliveryNotes) {
      deliveryData.deliveryNotes = deliveryNotes;
    }
    if (Object.keys(deliveryData).length > 0) {
      deliveryData.deliveryStatus = 'processing';
    }
    
    // Accept the order with delivery data
    await order.accept(handledById, finalPrice, Object.keys(deliveryData).length > 0 ? deliveryData : null);
    
    // Update staff notes if provided
    if (staffNotes) {
      order.staffNotes = staffNotes;
      await order.save();
    }
    
    // Create in-app notifications
    await createOrderNotification(order, NOTIFICATION_TYPES.ORDER_ACCEPTED);
    
    return res.json({
      success: true,
      message: 'Order accepted successfully',
      data: {
        order,
        user: {
          id: order.userId._id,
          name: order.userId.name,
          businessName: order.userId.businessName,
          tel: order.userId.tel,
          whatsappNumber: order.userId.whatsappNumber,
          businessAddress: order.userId.businessAddress
        },
        staff: {
          id: staff._id,
          name: staff.name,
          role: staff.role
        },
        stockUpdate: {
          productId: product._id,
          productName: product.product_name,
          quantityDeducted: order.quantity,
          remainingStock: product.stock
        }
      }
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
    
    if (!handledById || !rejectionReason) {
      return res.status(400).json({
        success: false,
        message: 'handledById and rejectionReason are required'
      });
    }
    
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    if (order.status !== ORDER_STATUS.PENDING) {
      return res.status(400).json({
        success: false,
        message: `Cannot reject order with status: ${order.status}`
      });
    }
    
    await order.reject(handledById, rejectionReason);
    
    if (staffNotes) {
      order.staffNotes = staffNotes;
      await order.save();
    }
    
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
 * Cancel an order
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
    
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    if (order.userId.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'You can only cancel your own orders'
      });
    }
    
    if (order.status !== ORDER_STATUS.PENDING) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel order with status: ${order.status}`
      });
    }
    
    await order.cancel();
    
    if (reason) {
      order.userNotes = reason;
      await order.save();
    }
    
    await createOrderNotification(order, NOTIFICATION_TYPES.ORDER_CANCELLED);
    
    // Restore stock for cancelled buy orders
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
 * PATCH /api/orders/:id/delivery
 * Update delivery information
 */
async function updateDeliveryInfo(req, res) {
  try {
    const { id } = req.params;
    const { estimatedDeliveryDate, actualDeliveryDate, deliveryAddress, trackingNumber, courierService, deliveryNotes, deliveryStatus } = req.body;
    
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    if (order.status !== ORDER_STATUS.ACCEPTED && order.status !== ORDER_STATUS.DELIVERED) {
      return res.status(400).json({
        success: false,
        message: `Cannot update delivery for order with status: ${order.status}. Order must be accepted first.`
      });
    }
    
    const deliveryData = {};
    if (estimatedDeliveryDate) deliveryData.estimatedDeliveryDate = new Date(estimatedDeliveryDate);
    if (actualDeliveryDate) deliveryData.actualDeliveryDate = new Date(actualDeliveryDate);
    if (deliveryAddress) deliveryData.deliveryAddress = deliveryAddress;
    if (trackingNumber) deliveryData.trackingNumber = trackingNumber;
    if (courierService) deliveryData.courierService = courierService;
    if (deliveryNotes) deliveryData.deliveryNotes = deliveryNotes;
    if (deliveryStatus) deliveryData.deliveryStatus = deliveryStatus;
    
    await order.updateDeliveryInfo(deliveryData);
    await createOrderNotification(order, NOTIFICATION_TYPES.DELIVERY_UPDATED);
    
    return res.json({
      success: true,
      message: 'Delivery information updated successfully',
      data: { orderId: order._id, deliveryInfo: order.deliveryInfo, status: order.status }
    });
    
  } catch (error) {
    console.error('Error updating delivery info:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update delivery information',
      error: error.message
    });
  }
}

/**
 * GET /api/orders/delivery/pending
 * Get orders pending delivery
 */
async function getPendingDeliveryOrders(req, res) {
  try {
    const { limit = 50, page = 1 } = req.query;
    
    const filter = {
      status: ORDER_STATUS.ACCEPTED,
      'deliveryInfo.deliveryStatus': { $in: ['pending', 'processing'] }
    };
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);
    
    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate('userId', 'name businessName tel deliveryAddress')
      .populate('productId', 'product_name');
    
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
    console.error('Error fetching pending delivery orders:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch pending delivery orders',
      error: error.message
    });
  }
}

/**
 * GET /api/orders/stock/low
 * Get low stock alerts
 */
async function getLowStockOrders(req, res) {
  try {
    const threshold = parseInt(req.query.threshold) || 10;
    
    const lowStockProducts = await Product.find({
      stock: { $lte: threshold }
    }).select('_id product_name stock');
    
    const productIds = lowStockProducts.map(p => p._id);
    
    const pendingOrders = await Order.find({
      productId: { $in: productIds },
      status: ORDER_STATUS.PENDING
    }).populate('userId', 'name businessName');
    
    return res.json({
      success: true,
      data: {
        lowStockProducts,
        pendingOrders,
        totalLowStockProducts: lowStockProducts.length,
        totalPendingOrders: pendingOrders.length
      }
    });
    
  } catch (error) {
    console.error('Error getting low stock orders:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get low stock orders',
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
      .populate('userId', 'name businessName tel deliveryAddress')
      .populate('productId', 'product_name price images')
      .populate('handledBy', 'name role');
    
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
 * Get a single order
 */
async function getOrderById(req, res) {
  try {
    const { id } = req.params;
    
    const order = await Order.findById(id)
      .populate('userId', 'name businessName tel email deliveryAddress')
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
 * Get notifications
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
      .populate('orderId', 'orderType quantity status productName originalTotal finalPrice deliveryInfo');
    
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
 * Mark notification as read
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
 * Mark all notifications as read
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

// EXPORT ALL FUNCTIONS
module.exports = {
  createOrder,
  acceptOrder,
  rejectOrder,
  cancelOrder,
  getOrders,
  getOrderById,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  updateDeliveryInfo,
  getPendingDeliveryOrders,
  getLowStockOrders
};
