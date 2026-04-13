const axios = require('axios');
const whatsappConfig = require('../config/whatsapp');
const User = require('../models/User');

class WhatsAppService {
  constructor() {
    this.phoneNumberId = whatsappConfig.phoneNumberId;
    this.accessToken = whatsappConfig.accessToken;
    this.apiVersion = whatsappConfig.apiVersion || 'v25.0';
    this.baseUrl = 'https://graph.facebook.com';
    this.enabled = whatsappConfig.enabled;
  }

  /**
   * Format phone number for WhatsApp (ensure it has country code without +)
   */
  formatPhoneNumber(phone) {
    if (!phone) return null;
    
    // Remove all spaces and special characters
    let formatted = phone.replace(/\s/g, '').replace(/[()\-]/g, '');
    
    // If number starts with 0, replace with 237 (Cameroon)
    if (formatted.startsWith('0')) {
      formatted = '237' + formatted.substring(1);
    }
    // If number is 9 digits without country code
    else if (formatted.length === 9 && !formatted.startsWith('237')) {
      formatted = '237' + formatted;
    }
    // If number starts with +237, remove the +
    else if (formatted.startsWith('+237')) {
      formatted = formatted.substring(1);
    }
    // If number starts with 00237, replace with 237
    else if (formatted.startsWith('00237')) {
      formatted = formatted.substring(3);
    }
    
    return formatted;
  }

  /**
   * Find salesman by business address (returns the salesman object)
   */
  async findSalesmanByBusinessAddress(businessAddress) {
    try {
      // Find active salesman whose business address matches the order's address
      const salesman = await User.findOne({
        role: 'salesman',
        accountStatus: 'active',
        businessAddress: { $regex: new RegExp(businessAddress, 'i') }
      }).select('name businessAddress whatsappNumber tel');
      
      if (salesman && salesman.whatsappNumber) {
        console.log(`✅ Found salesman for address "${businessAddress}": ${salesman.name} - ${salesman.whatsappNumber}`);
        return salesman;
      }
      
      console.log(`⚠️ No active salesman found for business address: ${businessAddress}`);
      return null;
    } catch (error) {
      console.error('Error finding salesman by business address:', error);
      return null;
    }
  }

  /**
   * Find all active salesmen (for broadcasting if needed)
   */
  async findAllSalesmen() {
    try {
      const salesmen = await User.find({
        role: 'salesman',
        accountStatus: 'active'
      }).select('name businessAddress whatsappNumber tel');
      
      console.log(`✅ Found ${salesmen.length} active salesmen`);
      return salesmen;
    } catch (error) {
      console.error('Error finding salesmen:', error);
      return [];
    }
  }

  /**
   * Find admin (returns the admin object)
   */
  async findAdmin() {
    try {
      const admin = await User.findOne({
        role: 'admin',
        accountStatus: 'active'
      }).select('name businessAddress whatsappNumber tel');
      
      if (admin && admin.whatsappNumber) {
        console.log(`✅ Found admin: ${admin.name} - ${admin.whatsappNumber}`);
        return admin;
      }
      
      console.log('⚠️ No active admin found');
      return null;
    } catch (error) {
      console.error('Error finding admin:', error);
      return null;
    }
  }

  /**
   * Send WhatsApp message using Cloud API
   */
  async sendMessage(to, message, options = {}) {
    if (!this.enabled) {
      console.log('WhatsApp notifications are disabled. Message would be sent:', { to, message });
      return { success: true, mock: true, message: 'WhatsApp disabled' };
    }

    if (!this.phoneNumberId || !this.accessToken) {
      console.error('WhatsApp configuration missing. PhoneNumberId or AccessToken not set.');
      return { success: false, error: 'WhatsApp not configured' };
    }

    if (!to) {
      console.error('No recipient number provided');
      return { success: false, error: 'No recipient number' };
    }

    try {
      const formattedNumber = this.formatPhoneNumber(to);
      const url = `${this.baseUrl}/${this.apiVersion}/${this.phoneNumberId}/messages`;
      
      let requestBody;
      
      // If using a template
      if (options.template) {
        requestBody = {
          messaging_product: 'whatsapp',
          to: 675106585,
          type: 'template',
          template: {
            name: "hello_world",
            language: { code:  'en_US' },
            components: options.template.components || []
          }
        };
      } 
      // Regular text message
      else {
        requestBody = {
          messaging_product: 'whatsapp',
          to: 675106585,
          type: 'text',
          text: {
            preview_url: options.previewUrl || false,
            body: message
          }
        };
      }

      const response = await axios.post(url, requestBody, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      console.log(`✅ WhatsApp message sent to ${formattedNumber}:`, response.data.messages?.[0]?.id);
      return { 
        success: true, 
        messageId: response.data.messages?.[0]?.id, 
        to: formattedNumber,
        recipientName: options.recipientName || 'Unknown'
      };
    } catch (error) {
      console.error('WhatsApp API error:', error.response?.data || error.message);
      return { 
        success: false, 
        error: error.response?.data?.error?.message || error.message,
        details: error.response?.data,
        to: to
      };
    }
  }

  /**
   * Send template message
   */
  async sendTemplateMessage(to, templateName, language = 'en_US', components = []) {
    return await this.sendMessage(to, null, {
      template: {
        name: templateName,
        language: language,
        components: components
      }
    });
  }

  /**
   * Format order message body (for text messages)
   */
  formatOrderMessageBody(order, user, eventType, staffName = null, staffRole = null) {
    const orderTypeLabel = order.orderType === 'buy' ? '🛒 BUY ORDER' : '💰 PRICE OFFER';
    const orderTypeEmoji = order.orderType === 'buy' ? '📦' : '🤝';
    const currency = 'XAF';
    const orderDate = new Date(order.createdAt).toLocaleString();
    
    switch(eventType) {
      case 'new_order':
        if (order.orderType === 'buy') {
          return `🔔 NEW BUY ORDER - Action Required

${orderTypeEmoji} ${orderTypeLabel}

Order ID: ${order._id}
Date: ${orderDate}
Customer: ${user.businessName || user.name}
Phone: ${user.tel}
Address: ${order.deliveryInfo?.deliveryAddress || user.businessAddress}

Product Details:
• Name: ${order.productName}
• Quantity: ${order.quantity}
• Unit Price: ${order.productPrice.toLocaleString()} ${currency}
• Total: ${order.originalTotal.toLocaleString()} ${currency}

Customer Notes: ${order.userNotes || 'None'}

⚠️ Please review and respond to this order through the dashboard.
Order ID: ${order._id}`;
        } else {
          return `🔔 NEW PRICE OFFER - Review Required

${orderTypeEmoji} ${orderTypeLabel}

Order ID: ${order._id}
Date: ${orderDate}
Customer: ${user.businessName || user.name}
Phone: ${user.tel}

Product Details:
• Name: ${order.productName}
• Quantity: ${order.quantity}
• Original Price: ${order.productPrice.toLocaleString()} ${currency}
• Offered Price: ${order.offeredPrice.toLocaleString()} ${currency}
• Savings: ${(order.productPrice - order.offeredPrice).toLocaleString()} ${currency}

Customer Notes: ${order.userNotes || 'None'}

⚠️ Please review this offer and respond through the dashboard.
Order ID: ${order._id}`;
        }
        
      case 'order_accepted':
        if (order.orderType === 'buy') {
          return `✅ ORDER ACCEPTED - ${staffName || 'Staff'}

✅ ORDER ACCEPTED

Order ID: ${order._id}
Product: ${order.productName}
Quantity: ${order.quantity}
Total: ${(order.finalPrice || order.originalTotal).toLocaleString()} ${currency}

Status: Your order has been accepted and is being processed.
Processed by: ${staffName || 'Staff'} (${staffRole || 'Salesman'})

Thank you for your business! We'll keep you updated on delivery.`;
        } else {
          return `🎉 OFFER ACCEPTED - ${staffName || 'Admin'}

🎉 OFFER ACCEPTED

Order ID: ${order._id}
Product: ${order.productName}
Quantity: ${order.quantity}
Final Price: ${order.finalPrice.toLocaleString()} ${currency}
You saved: ${(order.productPrice - order.finalPrice).toLocaleString()} ${currency}

Processed by: ${staffName || 'Admin'}

Your offer has been accepted! Please proceed with payment to complete your order.`;
        }
        
      case 'order_rejected':
        return `❌ ORDER DECLINED

Order ID: ${order._id}
Product: ${order.productName}
Reason: ${order.rejectionReason || 'We cannot fulfill this order at this time'}

Processed by: ${staffName || 'Staff'}

Please contact us for more information or to discuss alternatives.`;
        
      case 'delivery_update':
        return `🚚 DELIVERY UPDATE

Order ID: ${order._id}
Product: ${order.productName}
Delivery Status: ${order.deliveryInfo?.deliveryStatus || 'Processing'}
${order.deliveryInfo?.trackingNumber ? `Tracking Number: ${order.deliveryInfo.trackingNumber}\n` : ''}
${order.deliveryInfo?.courierService ? `Courier: ${order.deliveryInfo.courierService}\n` : ''}
${order.deliveryInfo?.estimatedDeliveryDate ? `Estimated Delivery: ${new Date(order.deliveryInfo.estimatedDeliveryDate).toLocaleDateString()}\n` : ''}

Track your order status in the dashboard.`;
        
      default:
        return `📋 ORDER UPDATE

Order ID: ${order._id}
Product: ${order.productName}
Status: ${order.status}

Check your dashboard for more details.`;
    }
  }

  /**
   * Send order notification to salesman based on business address match
   * This dynamically finds the right salesman for each order
   */
  async notifySalesmanByAddress(order, user) {
    const businessAddress = order.businessAddress || user.businessAddress;
    
    if (!businessAddress) {
      console.log('No business address found in order');
      return { success: false, error: 'No business address found' };
    }
    
    // Find the salesman assigned to this business address
    const salesman = await this.findSalesmanByBusinessAddress(businessAddress);
    
    if (!salesman || !salesman.whatsappNumber) {
      console.log(`No salesman found with WhatsApp for address: ${businessAddress}`);
      return { 
        success: false, 
        error: 'No salesman found for this address',
        businessAddress: businessAddress
      };
    }
    
    const messageBody = this.formatOrderMessageBody(order, user, 'new_order');
    const fullMessage = `${messageBody}\n\n---\n📍 Assigned Region: ${businessAddress}\n👤 Assigned Salesman: ${salesman.name}\n💡 Action Required: Please log in to the dashboard to respond to this order.`;
    
    // Send to the specific salesman's WhatsApp number
    const result = await this.sendMessage(salesman.whatsappNumber, fullMessage);
    
    return {
      ...result,
      recipient: {
        name: salesman.name,
        role: 'salesman',
        businessAddress: salesman.businessAddress,
        whatsappNumber: salesman.whatsappNumber
      }
    };
  }

  /**
   * Send order notification to admin for offer orders
   * This dynamically finds the admin from the database
   */
  async notifyAdminForOffer(order, user) {
    // Find admin from database (not hardcoded)
    const admin = await this.findAdmin();
    
    if (!admin || !admin.whatsappNumber) {
      console.log('No admin found with WhatsApp number');
      return { success: false, error: 'No admin found' };
    }
    
    const messageBody = this.formatOrderMessageBody(order, user, 'new_order');
    const fullMessage = `${messageBody}\n\n---\n👤 Admin: ${admin.name}\n💡 Action Required: Please review this offer and respond through the dashboard.`;
    
    // Send to the admin's WhatsApp number from database
    const result = await this.sendMessage(admin.whatsappNumber, fullMessage);
    
    return {
      ...result,
      recipient: {
        name: admin.name,
        role: 'admin',
        whatsappNumber: admin.whatsappNumber
      }
    };
  }

  /**
   * Send order notification to customer
   */
  async notifyCustomer(order, user, eventType, staffName = null, staffRole = null) {
    if (!user.whatsappNumber) {
      console.log(`Customer ${user._id} has no WhatsApp number`);
      return { success: false, error: 'Customer has no WhatsApp number' };
    }
    
    const messageBody = this.formatOrderMessageBody(order, user, eventType, staffName, staffRole);
    const result = await this.sendMessage(user.whatsappNumber, messageBody);
    
    return {
      ...result,
      recipient: {
        name: user.businessName || user.name,
        role: 'customer',
        whatsappNumber: user.whatsappNumber
      }
    };
  }

  /**
   * Broadcast message to all salesmen (optional feature)
   */
  async broadcastToSalesmen(message) {
    const salesmen = await this.findAllSalesmen();
    const results = [];
    
    for (const salesman of salesmen) {
      if (salesman.whatsappNumber) {
        const result = await this.sendMessage(salesman.whatsappNumber, message);
        results.push({
          salesman: salesman.name,
          whatsappNumber: salesman.whatsappNumber,
          success: result.success,
          error: result.error
        });
      }
    }
    
    return {
      total: salesmen.length,
      results: results
    };
  }

  /**
   * Test WhatsApp connection using the hello_world template
   * This sends to the first admin found in the database
   */
  async testConnection() {
    if (!this.enabled) {
      return { success: false, message: 'WhatsApp disabled' };
    }
    
    const admin = await this.findAdmin();
    if (!admin || !admin.whatsappNumber) {
      return { success: false, message: 'No admin found to test' };
    }
    
    console.log(`Testing WhatsApp connection to admin: ${admin.name} (${admin.whatsappNumber})`);
    return await this.sendTemplateMessage(admin.whatsappNumber, 'hello_world', 'en_US');
  }

  /**
   * Get recipient info for debugging
   */
  async getRecipientInfo(role, businessAddress = null) {
    if (role === 'admin') {
      return await this.findAdmin();
    } else if (role === 'salesman' && businessAddress) {
      return await this.findSalesmanByBusinessAddress(businessAddress);
    }
    return null;
  }
}

module.exports = new WhatsAppService();
