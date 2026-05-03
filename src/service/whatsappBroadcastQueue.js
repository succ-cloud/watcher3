// service/whatsappBroadcastQueue.js
const mongoose = require('mongoose');
const User = require('../models/User');
const { ROLES, ACCOUNT_STATUS } = require('../models/User');
const whatsappService = require('./whatsappService');

// In-memory queue for products pending broadcast
let broadcastQueue = [];
let isProcessing = false;
let lastBroadcastTime = null;
const BROADCAST_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds

// Track products that have been queued (to avoid duplicates)
const queuedProductIds = new Set();

/**
 * Format product details for WhatsApp message
 */
function formatProductMessage(product, queuePosition = null, totalInQueue = null) {
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
  }).format(product.currentPrice || product.price);
  
  // Build message
  let message = `🆕 *NEW PRODUCT AVAILABLE!*\n\n`;
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
  message += `🔗 *To order:*\n`;
  message += `Reply to this message or contact our sales team.\n\n`;
  
  // Add queue info if there are multiple products
  if (queuePosition !== null && totalInQueue !== null && totalInQueue > 1) {
    message += `\n---\n`;
    message += `📦 *Product ${queuePosition} of ${totalInQueue} in this update*\n`;
    message += `_More products available. Ask us for the full list!_`;
  }
  
  message += `\n\n_Act fast - limited stock available!_`;
  
  return { message, imageUrl };
}

/**
 * Send a single product notification to all wholesalers
 */
async function sendProductToWholesalers(product, queuePosition = null, totalInQueue = null) {
  try {
    console.log(`📢 Broadcasting product: ${product.product_name}`);
    
    // Get all active wholesalers
    const wholesalers = await User.find({
      role: ROLES.WHOLESALER,
      accountStatus: ACCOUNT_STATUS.ACTIVE,
      whatsappNumber: { $exists: true, $ne: null, $ne: '' }
    }).select('_id name businessName whatsappNumber tel');
    
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
    
    const { message, imageUrl } = formatProductMessage(product, queuePosition, totalInQueue);
    
    // Send to all wholesalers in parallel with batching
    const batchSize = 5;
    const results = [];
    
    for (let i = 0; i < wholesalers.length; i += batchSize) {
      const batch = wholesalers.slice(i, i + batchSize);
      const batchPromises = batch.map(async (wholesaler) => {
        try {
          // Normalize phone number
          let whatsappNumber = wholesaler.whatsappNumber.replace(/\s/g, '');
          if (/^\d{9}$/.test(whatsappNumber)) {
            whatsappNumber = `237${whatsappNumber}`;
          }
          if (whatsappNumber.startsWith('00237')) {
            whatsappNumber = whatsappNumber.substring(2);
          }
          if (!whatsappNumber.startsWith('+')) {
            whatsappNumber = `+${whatsappNumber}`;
          }
          
          const result = await whatsappService.sendWhatsAppMessage(
            whatsappNumber,
            message,
            imageUrl
          );
          
          return {
            success: true,
            wholesalerId: wholesaler._id,
            wholesalerName: wholesaler.businessName || wholesaler.name,
            whatsappNumber: wholesaler.whatsappNumber
          };
        } catch (error) {
          console.error(`Failed to send to ${wholesaler.businessName}:`, error);
          return {
            success: false,
            wholesalerId: wholesaler._id,
            wholesalerName: wholesaler.businessName || wholesaler.name,
            error: error.message
          };
        }
      });
      
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
      
      // Delay between batches
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
    console.error('Error broadcasting product:', error);
    return {
      success: false,
      message: 'Failed to broadcast product notification',
      error: error.message
    };
  }
}

/**
 * Queue a product for broadcast
 */
function queueProductForBroadcast(product) {
  // Check if product is already in queue
  if (queuedProductIds.has(product._id.toString())) {
    console.log(`Product ${product.product_name} already in queue, skipping`);
    return false;
  }
  
  // Don't queue placeholder products
  if (product.isPlaceholder) {
    console.log(`Product ${product.product_name} is a placeholder, skipping broadcast`);
    return false;
  }
  
  // Add to queue
  broadcastQueue.push({
    product,
    queuedAt: new Date(),
    productId: product._id.toString()
  });
  
  queuedProductIds.add(product._id.toString());
  
  console.log(`✅ Product "${product.product_name}" added to broadcast queue`);
  console.log(`Queue size: ${broadcastQueue.length}`);
  
  // Start processing if not already processing
  if (!isProcessing) {
    processBroadcastQueue();
  }
  
  return true;
}

/**
 * Process the broadcast queue
 */
async function processBroadcastQueue() {
  if (isProcessing) {
    console.log('Already processing queue, skipping...');
    return;
  }
  
  if (broadcastQueue.length === 0) {
    console.log('Broadcast queue is empty');
    return;
  }
  
  isProcessing = true;
  
  try {
    // Check if we should broadcast now
    const now = new Date();
    const timeSinceLastBroadcast = lastBroadcastTime ? now - lastBroadcastTime : Infinity;
    
    if (timeSinceLastBroadcast >= BROADCAST_INTERVAL) {
      // Time to broadcast!
      console.log(`⏰ Broadcasting ${broadcastQueue.length} queued product(s)...`);
      console.log(`Time since last broadcast: ${Math.round(timeSinceLastBroadcast / 60000)} minutes`);
      
      // Get all products in queue
      const productsToBroadcast = [...broadcastQueue];
      
      // Clear the queue
      broadcastQueue = [];
      queuedProductIds.clear();
      
      // Update last broadcast time
      lastBroadcastTime = now;
      
      // Send combined broadcast
      await sendBatchBroadcast(productsToBroadcast);
      
    } else {
      // Wait until next broadcast time
      const waitTime = BROADCAST_INTERVAL - timeSinceLastBroadcast;
      console.log(`⏳ Next broadcast in ${Math.round(waitTime / 60000)} minutes`);
      console.log(`${broadcastQueue.length} product(s) waiting in queue`);
      
      // Schedule next check
      setTimeout(() => {
        isProcessing = false;
        processBroadcastQueue();
      }, Math.min(waitTime, 60000)); // Check every minute or at next broadcast time
    }
    
  } catch (error) {
    console.error('Error processing broadcast queue:', error);
  } finally {
    isProcessing = false;
    
    // If there are still items in queue, process again
    if (broadcastQueue.length > 0) {
      setTimeout(() => {
        processBroadcastQueue();
      }, 5000);
    }
  }
}

/**
 * Send a batch broadcast with multiple products
 */
async function sendBatchBroadcast(productsToBroadcast) {
  try {
    console.log(`📦 Preparing batch broadcast for ${productsToBroadcast.length} product(s)`);
    
    // Get all active wholesalers
    const wholesalers = await User.find({
      role: ROLES.WHOLESALER,
      accountStatus: ACCOUNT_STATUS.ACTIVE,
      whatsappNumber: { $exists: true, $ne: null, $ne: '' }
    }).select('_id name businessName whatsappNumber tel');
    
    if (wholesalers.length === 0) {
      console.log('No active wholesalers found');
      return;
    }
    
    // Create a combined message for all products
    const combinedMessage = createCombinedProductMessage(productsToBroadcast);
    const primaryImage = productsToBroadcast[0]?.product?.primaryImage || 
                        (productsToBroadcast[0]?.product?.images && productsToBroadcast[0]?.product?.images[0]);
    const imageUrl = primaryImage?.url || null;
    
    // Send to all wholesalers
    const batchSize = 5;
    let successfulCount = 0;
    let failedCount = 0;
    
    for (let i = 0; i < wholesalers.length; i += batchSize) {
      const batch = wholesalers.slice(i, i + batchSize);
      const batchPromises = batch.map(async (wholesaler) => {
        try {
          let whatsappNumber = wholesaler.whatsappNumber.replace(/\s/g, '');
          if (/^\d{9}$/.test(whatsappNumber)) {
            whatsappNumber = `237${whatsappNumber}`;
          }
          if (whatsappNumber.startsWith('00237')) {
            whatsappNumber = whatsappNumber.substring(2);
          }
          if (!whatsappNumber.startsWith('+')) {
            whatsappNumber = `+${whatsappNumber}`;
          }
          
          await whatsappService.sendWhatsAppMessage(
            whatsappNumber,
            combinedMessage,
            imageUrl
          );
          return true;
        } catch (error) {
          console.error(`Failed to send to ${wholesaler.businessName}:`, error);
          return false;
        }
      });
      
      const results = await Promise.all(batchPromises);
      successfulCount += results.filter(r => r).length;
      failedCount += results.filter(r => !r).length;
      
      if (i + batchSize < wholesalers.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`✅ Batch broadcast complete: ${successfulCount} successful, ${failedCount} failed`);
    
    // Mark all products as notified
    for (const item of productsToBroadcast) {
      if (item.product && typeof item.product.markWhatsappNotificationSent === 'function') {
        await item.product.markWhatsappNotificationSent();
        console.log(`✅ Marked "${item.product.product_name}" as notified`);
      }
    }
    
  } catch (error) {
    console.error('Error sending batch broadcast:', error);
  }
}

/**
 * Create a combined message for multiple products
 */
function createCombinedProductMessage(productsToBroadcast) {
  const productCount = productsToBroadcast.length;
  const totalStock = productsToBroadcast.reduce((sum, item) => sum + (item.product?.stock || 0), 0);
  
  let message = `🆕 *NEW PRODUCTS AVAILABLE!*\n\n`;
  message += `📦 *${productCount} New Product(s) Just Added*\n`;
  message += `📊 Total Units: ${totalStock}\n\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  // List first 3 products with details
  const productsToList = productsToBroadcast.slice(0, 3);
  for (let i = 0; i < productsToList.length; i++) {
    const item = productsToList[i];
    const product = item.product;
    const formattedPrice = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(product.currentPrice || product.price);
    
    message += `${i + 1}. *${product.product_name}*\n`;
    message += `   💰 ${formattedPrice} | 📦 ${product.stock} units\n`;
    if (product.brand) message += `   🏭 ${product.brand}\n`;
    if (product.phoneLocation) message += `   📍 ${product.phoneLocation}\n`;
    message += `\n`;
  }
  
  // If more than 3 products
  if (productCount > 3) {
    message += `✨ *And ${productCount - 3} more product(s)*\n`;
    message += `📞 *Contact us for complete list and details!*\n\n`;
  }
  
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  message += `🔗 *To place an order:*\n`;
  message += `Reply to this message or contact our sales team.\n\n`;
  message += `_Hurry! Limited stock available for these new arrivals._`;
  
  return message;
}

/**
 * Get queue status
 */
function getQueueStatus() {
  return {
    queueSize: broadcastQueue.length,
    queuedProducts: broadcastQueue.map(item => ({
      productId: item.productId,
      productName: item.product.product_name,
      queuedAt: item.queuedAt
    })),
    lastBroadcastTime: lastBroadcastTime,
    nextBroadcastIn: lastBroadcastTime 
      ? Math.max(0, BROADCAST_INTERVAL - (Date.now() - lastBroadcastTime))
      : 0,
    isProcessing: isProcessing
  };
}

/**
 * Force immediate broadcast (for admin use)
 */
async function forceBroadcast() {
  if (broadcastQueue.length === 0) {
    return { success: false, message: 'No products in queue' };
  }
  
  const productsToBroadcast = [...broadcastQueue];
  broadcastQueue = [];
  queuedProductIds.clear();
  lastBroadcastTime = new Date();
  
  await sendBatchBroadcast(productsToBroadcast);
  
  return {
    success: true,
    message: `Forced broadcast of ${productsToBroadcast.length} product(s)`,
    productsBroadcast: productsToBroadcast.length
  };
}

module.exports = {
  queueProductForBroadcast,
  getQueueStatus,
  forceBroadcast,
  BROADCAST_INTERVAL
};