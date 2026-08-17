// service/productWhatsappService.js
const whatsappService = require('./whatsappService');
const User = require('../models/User');
const { ROLES, ACCOUNT_STATUS } = require('../models/User');

/**
 * Format product details for WhatsApp message
 */
function formatProductMessage(product, isNewProduct = true) {
  const primaryImage = product.primaryImage || (product.images && product.images[0]);
  const imageUrl = primaryImage?.url || null;
  
  // Get the first line of description (truncated)
  const shortDescription = product.description 
    ? product.description.substring(0, 100) + (product.description.length > 100 ? '...' : '')
    : 'No description available';
  
  // Format price
  const formattedPrice = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(product.price);
  
  // Build message based on product type
  let message = '';
  
  if (isNewProduct) {
    message = `🆕 *NEW PRODUCT ALERT!*\n\n`;
  } else {
    message = `🔄 *STOCK UPDATE!*\n\n`;
  }
  
  message += `📱 *${product.product_name}*\n`;
  message += `🏷️ Type: ${product.product_type || 'N/A'}\n`;
  
  if (product.brand) message += `🏭 Brand: ${product.brand}\n`;
  if (product.capacity) message += `💾 Capacity: ${product.capacity}\n`;
  if (product.color) message += `🎨 Color: ${product.color}\n`;
  if (product.country) message += `🌍 Origin: ${product.country}\n`;
  if (product.sim) message += `📡 SIM: ${product.sim}\n`;
  if (product.phoneLocation) message += `📍 Location: ${product.phoneLocation}\n`;
  
  message += `💰 Price: ${formattedPrice}\n`;
  message += `📦 Stock: ${product.stock} units\n\n`;
  
  message += `📝 *Description:*\n${shortDescription}\n\n`;
  message += `🔗 *To order or inquire:*\n`;
  message += `Reply to this message or contact our sales team.\n\n`;
  message += `_Act fast - limited stock available!_`;
  
  return { message, imageUrl };
}

/**
 * Get all active wholesalers with WhatsApp numbers
 */
async function getActiveWholesalers() {
  try {
    const wholesalers = await User.find({
      role: ROLES.WHOLESALER,
      accountStatus: ACCOUNT_STATUS.ACTIVE,
      whatsappNumber: { $exists: true, $ne: null, $ne: '' }
    }).select('_id name businessName whatsappNumber tel');
    
    // Normalize phone numbers
    const normalizedWholesalers = wholesalers.map(wholesaler => ({
      ...wholesaler.toObject(),
      whatsappNumber: normalizePhoneNumber(wholesaler.whatsappNumber)
    })).filter(w => w.whatsappNumber); // Filter out invalid numbers
    
    return normalizedWholesalers;
  } catch (error) {
    console.error('Error fetching active wholesalers:', error);
    return [];
  }
}

/**
 * Normalize phone number to international format
 */
function normalizePhoneNumber(phone) {
  if (!phone) return null;
  
  // Remove all spaces
  let normalized = String(phone).replace(/\s/g, '');
  
  // Check if it's a Cameroon number
  if (/^\d{9}$/.test(normalized)) {
    return `237${normalized}`;
  }
  
  // Remove 00 prefix if present
  if (normalized.startsWith('00237')) {
    return normalized.substring(2);
  }
  
  // Remove + if present
  if (normalized.startsWith('+')) {
    return normalized.substring(1);
  }
  
  return normalized;
}

/**
 * Send product notification to a single wholesaler
 */
async function sendProductNotificationToWholesaler(wholesaler, product, isNewProduct = true) {
  try {
    const { message, imageUrl } = formatProductMessage(product, isNewProduct);
    
    // Send WhatsApp message
    const result = await whatsappService.sendWhatsAppMessage(
      wholesaler.whatsappNumber,
      message,
      imageUrl // Optional image
    );
    
    return {
      success: true,
      wholesalerId: wholesaler._id,
      wholesalerName: wholesaler.businessName || wholesaler.name,
      whatsappNumber: wholesaler.whatsappNumber,
      result
    };
  } catch (error) {
    console.error(`Failed to send notification to ${wholesaler.businessName}:`, error);
    return {
      success: false,
      wholesalerId: wholesaler._id,
      wholesalerName: wholesaler.businessName || wholesaler.name,
      whatsappNumber: wholesaler.whatsappNumber,
      error: error.message
    };
  }
}

/**
 * Send product notification to ALL active wholesalers
 */
async function broadcastProductToWholesalers(product, isNewProduct = true) {
  try {
    console.log(`📢 Broadcasting product to wholesalers: ${product.product_name}`);
    
    // Get all active wholesalers
    const wholesalers = await getActiveWholesalers();
    
    if (wholesalers.length === 0) {
      console.log('No active wholesalers found to notify');
      return {
        success: false,
        message: 'No active wholesalers found',
        totalWholesalers: 0,
        results: []
      };
    }
    
    console.log(`Found ${wholesalers.length} active wholesalers to notify`);
    
    // Send notifications in parallel (with a limit to avoid rate limiting)
    const batchSize = 5; // Send 5 at a time to avoid overwhelming the API
    const results = [];
    
    for (let i = 0; i < wholesalers.length; i += batchSize) {
      const batch = wholesalers.slice(i, i + batchSize);
      const batchPromises = batch.map(wholesaler => 
        sendProductNotificationToWholesaler(wholesaler, product, isNewProduct)
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      batchResults.forEach(result => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({
            success: false,
            error: result.reason?.message || 'Unknown error'
          });
        }
      });
      
      // Small delay between batches to avoid rate limiting
      if (i + batchSize < wholesalers.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    const successfulCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;
    
    console.log(`✅ Broadcast complete: ${successfulCount} successful, ${failedCount} failed`);
    
    return {
      success: true,
      message: `Broadcast sent to ${successfulCount} out of ${wholesalers.length} wholesalers`,
      totalWholesalers: wholesalers.length,
      successfulCount,
      failedCount,
      results
    };
    
  } catch (error) {
    console.error('Error broadcasting product to wholesalers:', error);
    return {
      success: false,
      message: 'Failed to broadcast product notification',
      error: error.message,
      totalWholesalers: 0,
      results: []
    };
  }
}

/**
 * Format and send product update notification (for stock updates)
 */
async function notifyProductStockUpdate(product, previousStock, newStock) {
  try {
    console.log(`📢 Notifying about stock update for: ${product.product_name}`);
    console.log(`   Previous stock: ${previousStock}, New stock: ${newStock}`);
    
    // Only notify if stock increased (new stock arrived)
    if (newStock <= previousStock) {
      console.log('Stock not increased - skipping notification');
      return {
        success: false,
        message: 'Stock did not increase, notification skipped'
      };
    }
    
    // Get all active wholesalers
    const wholesalers = await getActiveWholesalers();
    
    if (wholesalers.length === 0) {
      return {
        success: false,
        message: 'No active wholesalers found',
        totalWholesalers: 0
      };
    }
    
    // Create special message for stock update
    const stockIncrease = newStock - previousStock;
    const extraMessage = `\n\n🔄 *STOCK UPDATE!*\n➕ ${stockIncrease} new units added!\n📦 Total available: ${newStock} units\n`;
    
    const { message: baseMessage, imageUrl } = formatProductMessage(product, false);
    const message = baseMessage + extraMessage;
    
    // Send to all wholesalers
    const results = [];
    for (const wholesaler of wholesalers) {
      try {
        const result = await whatsappService.sendWhatsAppMessage(
          wholesaler.whatsappNumber,
          message,
          imageUrl
        );
        results.push({
          success: true,
          wholesalerName: wholesaler.businessName || wholesaler.name,
          whatsappNumber: wholesaler.whatsappNumber
        });
      } catch (error) {
        results.push({
          success: false,
          wholesalerName: wholesaler.businessName || wholesaler.name,
          error: error.message
        });
      }
    }
    
    return {
      success: true,
      message: `Stock update notification sent to ${results.filter(r => r.success).length} wholesalers`,
      results
    };
    
  } catch (error) {
    console.error('Error sending stock update notification:', error);
    return {
      success: false,
      message: 'Failed to send stock update notification',
      error: error.message
    };
  }
}

module.exports = {
  broadcastProductToWholesalers,
  notifyProductStockUpdate,
  getActiveWholesalers,
  formatProductMessage,
  sendProductNotificationToWholesaler
};
