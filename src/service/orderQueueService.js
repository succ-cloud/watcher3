const whatsappService = require('./whatsappService');
const { ORDER_TYPES } = require('../models/Order');

class OrderQueueService {
  constructor() {
    this.orderQueue = new Map(); // Store pending orders by recipient key + userId
    this.processingTimers = new Map(); // Store timers for each recipient + userId
    this.batchDelay = 10000; // 10 seconds delay to collect multiple orders from SAME USER
  }

  /**
   * Generate a unique key for a recipient + user combination
   * This ensures orders from different users are NEVER batched together
   */
  getRecipientKey(recipientType, recipientId, userId, region = null) {
    // Include userId to separate different customers
    if (recipientType === 'admin') {
      return `admin_${recipientId}_user_${userId}`;
    } else if (recipientType === 'salesman') {
      return `salesman_${recipientId}_user_${userId}_${region || 'all'}`;
    }
    return `${recipientType}_${recipientId}_user_${userId}`;
  }

  /**
   * Add an order to the queue for batching (only batches orders from SAME user)
   */
  addOrder(order, recipient, orderType, user, region = null) {
    const userId = user._id.toString();
    const recipientKey = this.getRecipientKey(
      recipient.type, 
      recipient.id, 
      userId,
      region
    );
    
    if (!this.orderQueue.has(recipientKey)) {
      this.orderQueue.set(recipientKey, {
        recipient: recipient,
        user: {
          id: userId,
          name: user.businessName || user.name,
          phone: user.tel,
          address: user.businessAddress
        },
        orders: [],
        orderTypes: new Set(),
        regions: new Set(),
        totalQuantity: 0,
        totalAmount: 0,
        products: new Map(),
        createdAt: new Date()
      });
    }
    
    const queueItem = this.orderQueue.get(recipientKey);
    
    // Add order to the batch
    queueItem.orders.push({
      order: order,
      orderType: orderType,
      region: region,
      createdAt: new Date()
    });
    
    queueItem.orderTypes.add(orderType);
    if (region) queueItem.regions.add(region);
    queueItem.totalQuantity += order.quantity;
    queueItem.totalAmount += order.originalTotal;
    
    // Track products for this user's batch
    const productKey = order.productId.toString();
    if (!queueItem.products.has(productKey)) {
      queueItem.products.set(productKey, {
        name: order.productName,
        quantity: 0,
        totalValue: 0
      });
    }
    const product = queueItem.products.get(productKey);
    product.quantity += order.quantity;
    product.totalValue += order.originalTotal;
    
    // Schedule processing for this recipient + user combination
    this.scheduleProcessing(recipientKey);
    
    return { 
      queued: true, 
      batchKey: recipientKey, 
      batchSize: queueItem.orders.length,
      userId: userId,
      customerName: queueItem.user.name
    };
  }

  /**
   * Schedule processing of batched orders for a recipient + user
   */
  scheduleProcessing(recipientKey) {
    if (this.processingTimers.has(recipientKey)) {
      clearTimeout(this.processingTimers.get(recipientKey));
    }
    
    const timer = setTimeout(() => {
      this.processBatch(recipientKey);
    }, this.batchDelay);
    
    this.processingTimers.set(recipientKey, timer);
  }

  /**
   * Process a batch of orders and send consolidated WhatsApp message
   */
  async processBatch(recipientKey) {
    const queueItem = this.orderQueue.get(recipientKey);
    if (!queueItem || queueItem.orders.length === 0) {
      this.orderQueue.delete(recipientKey);
      this.processingTimers.delete(recipientKey);
      return;
    }
    
    console.log(`📦 Processing batch for ${queueItem.recipient.name} (Customer: ${queueItem.user.name}): ${queueItem.orders.length} orders`);
    
    // Format consolidated message for this specific customer
    const message = this.formatBatchMessage(queueItem);
    
    // Send WhatsApp message to the recipient (salesman or admin)
    const result = await whatsappService.sendMessage(
      queueItem.recipient.whatsappNumber,
      message,
      { recipientName: queueItem.recipient.name }
    );
    
    // Also send copy to admin if this is not already an admin recipient
    if (queueItem.recipient.type !== 'admin') {
      await this.sendCopyToAdmin(queueItem);
    }
    
    // Clear processed batch
    this.orderQueue.delete(recipientKey);
    this.processingTimers.delete(recipientKey);
    
    return result;
  }

  /**
   * Format consolidated message for a batch of orders from a SINGLE customer
   */
  formatBatchMessage(queueItem) {
    const { recipient, user, orders, orderTypes, totalQuantity, totalAmount, products } = queueItem;
    const orderCount = orders.length;
    const isMultipleOrders = orderCount > 1;
    const currency = 'XAF';
    const date = new Date().toLocaleString();
    
    let message = '';
    
    // Header - indicates this is from a single customer
    if (recipient.type === 'admin') {
      message = `🔔 *ORDER BATCH NOTIFICATION - ADMIN*\n\n`;
    } else if (recipient.type === 'salesman') {
      message = `🔔 *ORDER BATCH NOTIFICATION - ${recipient.name.toUpperCase()}*\n\n`;
    }
    
    // Customer Information
    message += `👤 *Customer Information*\n`;
    message += `• Name: ${user.name}\n`;
    message += `• Phone: ${user.phone}\n`;
    message += `• Address: ${user.address}\n\n`;
    
    // Batch Summary
    message += `📊 *Order Summary*\n`;
    message += `• Number of Orders: ${orderCount}\n`;
    message += `• Order Types: ${Array.from(orderTypes).join(', ')}\n`;
    message += `• Total Items: ${totalQuantity}\n`;
    message += `• Total Value: ${totalAmount.toLocaleString()} ${currency}\n`;
    message += `• Time Window: ${date}\n\n`;
    
    // Products Ordered (consolidated)
    message += `📦 *Products Ordered (Consolidated)*\n`;
    Array.from(products.values()).forEach(product => {
      message += `• ${product.name}: ${product.quantity} units (${product.totalValue.toLocaleString()} ${currency})\n`;
    });
    message += `\n`;
    
    // Individual Orders (detailed)
    if (orderCount === 1) {
      // Single order - show details
      const order = orders[0].order;
      message += `📋 *Order Details*\n`;
      message += `• Order ID: ${order._id.toString().slice(-8)}\n`;
      message += `• Product: ${order.productName}\n`;
      message += `• Quantity: ${order.quantity}\n`;
      message += `• Unit Price: ${order.productPrice.toLocaleString()} ${currency}\n`;
      message += `• Total: ${order.originalTotal.toLocaleString()} ${currency}\n`;
      if (order.orderType === 'offer') {
        message += `• Offered Price: ${order.offeredPrice.toLocaleString()} ${currency}\n`;
        message += `• Savings: ${(order.productPrice - order.offeredPrice).toLocaleString()} ${currency}\n`;
      }
      message += `\n`;
    } else {
      // Multiple orders - show list
      message += `📋 *Individual Orders (${orderCount} orders)*\n`;
      orders.forEach((item, index) => {
        const order = item.order;
        message += `${index + 1}. Order #${order._id.toString().slice(-8)}\n`;
        message += `   Product: ${order.productName}\n`;
        message += `   Quantity: ${order.quantity}\n`;
        message += `   Amount: ${order.originalTotal.toLocaleString()} ${currency}\n`;
        if (order.orderType === 'offer') {
          message += `   Offered: ${order.offeredPrice.toLocaleString()} ${currency}\n`;
        }
      });
      message += `\n`;
    }
    
    // Customer Notes (if any)
    const hasNotes = orders.some(item => item.order.userNotes);
    if (hasNotes) {
      message += `📝 *Customer Notes*\n`;
      orders.forEach((item, index) => {
        if (item.order.userNotes) {
          message += `Order #${item.order._id.toString().slice(-8)}: ${item.order.userNotes}\n`;
        }
      });
      message += `\n`;
    }
    
    // Action required
    message += `---\n`;
    message += `💡 *Action Required*: Please log in to the dashboard to review and respond to this customer's orders.\n`;
    message += `🔗 Customer: ${user.name} | Orders: ${orderCount}\n`;
    
    return message;
  }

  /**
   * Send a copy of the batch notification to admin (for buy orders)
   */
  async sendCopyToAdmin(queueItem) {
    try {
      const admin = await whatsappService.findAdmin();
      if (admin && admin.whatsappNumber) {
        const adminMessage = `📋 *COPY - Customer Order Batch*\n\n` +
          `Customer: ${queueItem.user.name}\n` +
          `Phone: ${queueItem.user.phone}\n` +
          `Orders: ${queueItem.orders.length}\n` +
          `Total Value: ${queueItem.totalAmount.toLocaleString()} XAF\n\n` +
          `Recipient: ${queueItem.recipient.name} (${queueItem.recipient.type})\n\n` +
          `This is a copy of the notification sent to the ${queueItem.recipient.type}.`;
        
        await whatsappService.sendMessage(admin.whatsappNumber, adminMessage);
        console.log(`📧 Copy sent to admin for batch to ${queueItem.recipient.name} (Customer: ${queueItem.user.name})`);
      }
    } catch (error) {
      console.error('Failed to send copy to admin:', error);
    }
  }

  /**
   * Process all pending batches immediately (for testing or shutdown)
   */
  async processAllBatches() {
    const keys = Array.from(this.orderQueue.keys());
    for (const key of keys) {
      if (this.processingTimers.has(key)) {
        clearTimeout(this.processingTimers.get(key));
      }
      await this.processBatch(key);
    }
  }

  /**
   * Get queue statistics
   */
  getQueueStats() {
    const stats = {
      totalBatches: this.orderQueue.size,
      batches: []
    };
    
    for (const [key, value] of this.orderQueue) {
      stats.batches.push({
        recipient: value.recipient.name,
        recipientType: value.recipient.type,
        customer: value.user.name,
        orderCount: value.orders.length,
        totalAmount: value.totalAmount,
        waitTime: Date.now() - value.createdAt.getTime()
      });
    }
    
    return stats;
  }
}

module.exports = new OrderQueueService();
