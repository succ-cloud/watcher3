const whatsappService = require('./whatsappService');
const { ORDER_TYPES } = require('../models/Order');

class OrderQueueService {
  constructor() {
    this.orderQueue = new Map(); // Store pending orders by recipient key
    this.processingTimers = new Map(); // Store timers for each recipient
    this.batchDelay = 10000; // 10 seconds delay to collect multiple orders
  }

  /**
   * Generate a unique key for a recipient
   */
  getRecipientKey(recipientType, recipientId, region = null) {
    if (recipientType === 'admin') {
      return `admin_${recipientId}`;
    } else if (recipientType === 'salesman') {
      return `salesman_${recipientId}_${region || 'all'}`;
    }
    return `${recipientType}_${recipientId}`;
  }

  /**
   * Add an order to the queue for batching
   */
  addOrder(order, recipient, orderType, user, region = null) {
    const recipientKey = this.getRecipientKey(
      recipient.type, 
      recipient.id, 
      region
    );
    
    if (!this.orderQueue.has(recipientKey)) {
      this.orderQueue.set(recipientKey, {
        recipient: recipient,
        orders: [],
        orderTypes: new Set(),
        regions: new Set(),
        totalQuantity: 0,
        totalAmount: 0,
        customers: new Map(),
        products: new Map()
      });
    }
    
    const queueItem = this.orderQueue.get(recipientKey);
    
    // Add order to the batch
    queueItem.orders.push({
      order: order,
      user: user,
      orderType: orderType,
      region: region,
      createdAt: new Date()
    });
    
    queueItem.orderTypes.add(orderType);
    if (region) queueItem.regions.add(region);
    queueItem.totalQuantity += order.quantity;
    queueItem.totalAmount += order.originalTotal;
    
    // Track unique customers
    const customerKey = user._id.toString();
    if (!queueItem.customers.has(customerKey)) {
      queueItem.customers.set(customerKey, {
        name: user.businessName || user.name,
        phone: user.tel,
        address: user.businessAddress
      });
    }
    
    // Track products
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
    
    // Schedule processing for this recipient
    this.scheduleProcessing(recipientKey);
    
    return { queued: true, batchKey: recipientKey, batchSize: queueItem.orders.length };
  }

  /**
   * Schedule processing of batched orders for a recipient
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
    
    console.log(`📦 Processing batch for ${queueItem.recipient.name}: ${queueItem.orders.length} orders`);
    
    // Format consolidated message
    const message = this.formatBatchMessage(queueItem);
    
    // Send WhatsApp message
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
   * Format consolidated message for a batch of orders
   */
  formatBatchMessage(queueItem) {
    const { recipient, orders, orderTypes, regions, totalQuantity, totalAmount, customers, products } = queueItem;
    const orderCount = orders.length;
    const isMultipleOrders = orderCount > 1;
    const currency = 'XAF';
    const date = new Date().toLocaleString();
    
    let message = '';
    
    // Header
    if (recipient.type === 'admin') {
      message = `🔔 *BATCH ORDER NOTIFICATION - ADMIN*\n\n`;
    } else if (recipient.type === 'salesman') {
      message = `🔔 *BATCH ORDER NOTIFICATION - ${recipient.name.toUpperCase()}*\n\n`;
    }
    
    message += `📊 *Summary*\n`;
    message += `• Total Orders: ${orderCount}\n`;
    message += `• Order Types: ${Array.from(orderTypes).join(', ')}\n`;
    message += `• Total Items: ${totalQuantity}\n`;
    message += `• Total Value: ${totalAmount.toLocaleString()} ${currency}\n`;
    message += `• Time Window: ${date}\n\n`;
    
    if (regions.size > 0) {
      message += `📍 *Regions Covered*\n`;
      Array.from(regions).forEach(region => {
        message += `• ${region}\n`;
      });
      message += `\n`;
    }
    
    // Customers section
    message += `👥 *Customers (${customers.size})*\n`;
    Array.from(customers.values()).forEach(customer => {
      message += `• ${customer.name} - ${customer.phone}\n`;
      message += `  Address: ${customer.address}\n`;
    });
    message += `\n`;
    
    // Products section
    message += `📦 *Products Ordered*\n`;
    Array.from(products.values()).forEach(product => {
      message += `• ${product.name}: ${product.quantity} units (${product.totalValue.toLocaleString()} ${currency})\n`;
    });
    message += `\n`;
    
    // Individual orders (if not too many)
    if (orderCount <= 5) {
      message += `📋 *Individual Orders*\n`;
      orders.forEach((item, index) => {
        const order = item.order;
        const user = item.user;
        message += `${index + 1}. Order #${order._id.toString().slice(-8)}\n`;
        message += `   Customer: ${user.businessName || user.name}\n`;
        message += `   Product: ${order.productName}\n`;
        message += `   Quantity: ${order.quantity}\n`;
        message += `   Amount: ${order.originalTotal.toLocaleString()} ${currency}\n`;
        if (order.orderType === 'offer') {
          message += `   Offered: ${order.offeredPrice.toLocaleString()} ${currency}\n`;
        }
      });
      message += `\n`;
    } else {
      message += `📋 *First 5 of ${orderCount} Orders*\n`;
      orders.slice(0, 5).forEach((item, index) => {
        const order = item.order;
        const user = item.user;
        message += `${index + 1}. ${user.businessName || user.name} - ${order.productName} (${order.quantity}x)\n`;
      });
      if (orderCount > 5) {
        message += `... and ${orderCount - 5} more orders\n`;
      }
      message += `\n`;
    }
    
    // Action required
    message += `---\n`;
    message += `💡 *Action Required*: Please log in to the dashboard to review and respond to these orders.\n`;
    message += `🔗 View all orders: [Dashboard Link]`;
    
    return message;
  }

  /**
   * Send a copy of the batch notification to admin
   */
  async sendCopyToAdmin(queueItem) {
    try {
      const admin = await whatsappService.findAdmin();
      if (admin && admin.whatsappNumber) {
        const adminMessage = `📋 *COPY - Order Batch Summary*\n\n` +
          `Recipient: ${queueItem.recipient.name} (${queueItem.recipient.type})\n` +
          `Orders: ${queueItem.orders.length}\n` +
          `Total Value: ${queueItem.totalAmount.toLocaleString()} XAF\n\n` +
          `This is a copy of the notification sent to the ${queueItem.recipient.type}.`;
        
        await whatsappService.sendMessage(admin.whatsappNumber, adminMessage);
        console.log(`📧 Copy sent to admin for batch to ${queueItem.recipient.name}`);
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
}

module.exports = new OrderQueueService();