const mongoose = require('mongoose');
const { Order, ORDER_TYPES, ORDER_STATUS, NOTIFICATION_AUDIENCE, PRODUCT_SOURCE } = require('../models/Order');
const { Notification, NOTIFICATION_TYPES } = require('../models/Notification');
const Product = require('../models/ItemsList');
const User = require('../models/User');
const whatsappService = require('../service/whatsappService');
const orderQueueService = require('../service/orderQueueService');

/**
 * Helper function to determine who should be notified
 */
function getNotifyAudience(orderType) {
  // Preorder should be treated the same as offer - sent to admin
  if (orderType === ORDER_TYPES.BUY) {
    return NOTIFICATION_AUDIENCE.SALESMAN;
  }
  // Both OFFER and PREORDER go to admin
  return NOTIFICATION_AUDIENCE.ADMIN;
}

/**
 * Helper function to get or create placeholder product for custom preorders
 */
async function getPlaceholderProduct() {
  const PLACEHOLDER_NAME = 'Custom Preorder Item';
  const PLACEHOLDER_DESCRIPTION = 'Placeholder product for custom preorder items not in catalog';
  
  try {
    // Try to find existing placeholder
    let placeholder = await Product.findOne({ 
      product_name: { $regex: new RegExp(`^${PLACEHOLDER_NAME}$`, 'i') }
    });
    
    if (!placeholder) {
      // Create placeholder if it doesn't exist
      placeholder = await Product.create({
        product_name: PLACEHOLDER_NAME,
        description: PLACEHOLDER_DESCRIPTION,
        price: 0,
        stock: 999999, // High stock for unlimited custom orders
        category: 'preorder',
        subcategory: 'custom',
        isActive: true,
        images: [],
        specifications: 'Custom product - details provided in preorder request',
        isPlaceholder: true // You might want to add this field to your Product model
      });
      console.log('✅ Created placeholder product for custom preorders:', placeholder._id);
    }
    
    return placeholder;
  } catch (error) {
    console.error('Error getting/creating placeholder product:', error);
    return null;
  }
}

/**
 * Helper function to validate custom product data
 */
function validateCustomProduct(customProduct, orderType) {
  const errors = [];
  
  if (!customProduct || typeof customProduct !== 'object') {
    errors.push('Custom product details are required for custom preorders');
    return errors;
  }
  
  // Required fields
  if (!customProduct.name || customProduct.name.trim().length < 2) {
    errors.push('Custom product name must be at least 2 characters');
  }
  
  if (customProduct.name && customProduct.name.length > 200) {
    errors.push('Custom product name cannot exceed 200 characters');
  }
  
  // Optional field validations
  if (customProduct.description && customProduct.description.length > 1000) {
    errors.push('Product description cannot exceed 1000 characters');
  }
  
  if (customProduct.specifications && customProduct.specifications.length > 2000) {
    errors.push('Product specifications cannot exceed 2000 characters');
  }
  
  // Price range validation
  if (customProduct.targetPriceMin && customProduct.targetPriceMax) {
    if (customProduct.targetPriceMin > customProduct.targetPriceMax) {
      errors.push('Minimum target price cannot be greater than maximum target price');
    }
    if (customProduct.targetPriceMin < 0) {
      errors.push('Minimum target price cannot be negative');
    }
  }
  
  // For preorders, additional validation
  if (orderType === ORDER_TYPES.PREORDER) {
    if (customProduct.quantityNeeded && customProduct.quantityNeeded < 1) {
      errors.push('Quantity needed must be at least 1');
    }
  }
  
  return errors;
}

/**
 * Helper function to validate preorder info
 */
function validatePreorderInfo(preorderInfo) {
  const errors = [];
  
  if (!preorderInfo || typeof preorderInfo !== 'object') {
    return errors; // Preorder info is optional
  }
  
  if (preorderInfo.expectedDeliveryDate) {
    const deliveryDate = new Date(preorderInfo.expectedDeliveryDate);
    if (isNaN(deliveryDate.getTime())) {
      errors.push('Invalid expected delivery date');
    } else if (deliveryDate < new Date()) {
      errors.push('Expected delivery date cannot be in the past');
    }
  }
  
  const validUrgencies = ['low', 'medium', 'high', 'urgent'];
  if (preorderInfo.urgency && !validUrgencies.includes(preorderInfo.urgency)) {
    errors.push(`Urgency must be one of: ${validUrgencies.join(', ')}`);
  }
  
  const validShippingMethods = ['air', 'sea', 'land', 'express'];
  if (preorderInfo.shippingMethod && !validShippingMethods.includes(preorderInfo.shippingMethod)) {
    errors.push(`Shipping method must be one of: ${validShippingMethods.join(', ')}`);
  }
  
  if (preorderInfo.quantityNeeded && preorderInfo.quantityNeeded < 1) {
    errors.push('Quantity needed must be at least 1');
  }
  
  if (preorderInfo.notes && preorderInfo.notes.length > 1000) {
    errors.push('Preorder notes cannot exceed 1000 characters');
  }
  
  return errors;
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
      if (order.orderType === ORDER_TYPES.BUY) {
        staffTitle = `New Buy Order`;
      } else if (order.orderType === ORDER_TYPES.PREORDER) {
        if (order.isCustomProduct) {
          staffTitle = `New Custom Pre-order 🆕`;
        } else {
          staffTitle = `New Pre-order`;
        }
      } else {
        staffTitle = `New Price Offer`;
      }
      
      staffMessage = `${order.productName} - Quantity: ${order.quantity}`;
      if (order.orderType === ORDER_TYPES.OFFER) {
        staffMessage += `, Offered: $${order.offeredPrice}`;
      }
      if (order.orderType === ORDER_TYPES.PREORDER && order.isCustomProduct) {
        staffMessage += `, Custom Product: ${order.customProduct?.name || 'N/A'}`;
      }
      if (order.orderType === ORDER_TYPES.PREORDER) {
        staffMessage += `, Pre-order`;
      }
      
      userTitle = 'Order Received';
      userMessage = `Your ${order.orderType} order for ${order.productName} has been received and is pending review.`;
      
      if (order.orderType === ORDER_TYPES.PREORDER && order.isCustomProduct) {
        userMessage = `Your custom pre-order request for "${order.customProduct?.name}" has been received and is pending review. We'll contact you soon with pricing and availability.`;
      }
      break;
      
    case NOTIFICATION_TYPES.ORDER_ACCEPTED:
      staffTitle = `Order Accepted`;
      staffMessage = `${order.productName} (x${order.quantity}) - Order #${order._id}`;
      if (order.orderType === ORDER_TYPES.PREORDER) {
        userTitle = 'Pre-order Accepted 🎉';
        if (order.isCustomProduct) {
          userMessage = `Great news! Your custom pre-order for "${order.customProduct?.name}" has been accepted! Final price: $${order.finalPrice || order.productPrice || 'to be confirmed'}`;
        } else {
          userMessage = `Your pre-order for ${order.productName} has been accepted!`;
        }
      } else if (order.orderType === ORDER_TYPES.OFFER) {
        userTitle = 'Offer Accepted 🎉';
        userMessage = `Your offer for ${order.productName} has been accepted! Final price: $${order.finalPrice}`;
      } else {
        userTitle = 'Order Accepted 🎉';
        userMessage = `Your order for ${order.productName} has been accepted! Total: $${order.originalTotal}`;
      }
      
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
        isCustomProduct: order.isCustomProduct || false,
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
      isCustomProduct: order.isCustomProduct || false,
      deliveryInfo: order.deliveryInfo || null
    }
  });
  
  await Notification.insertMany(notifications);
}

/**
 * POST /api/orders
 * Create a new order with support for catalog products and custom products (preorders)
 */
async function createOrder(req, res) {
  // Start a mongoose session for transaction
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    console.log('📝 Creating order...');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    const {
      // Basic order info
      userId,
      productId,           // Can be null for custom products
      orderType,
      quantity,
      offeredPrice,
      userNotes,
      deliveryAddress,
      
      // Custom product fields (for preorders)
      isCustomProduct,
      customProduct,
      preorderInfo,
      
      // Additional metadata
      source = 'web',
      priority = 'normal',
      tags = []
    } = req.body;
    
    // ==================== VALIDATION ====================
    
    // Basic required fields validation
    if (!userId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }
    
    if (!orderType) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Order type is required'
      });
    }
    
    // Validate order type
    if (!Object.values(ORDER_TYPES).includes(orderType)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Invalid order type. Must be "buy", "offer", or "preorder"'
      });
    }
    
    // Validate quantity
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty < 1) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Quantity must be a positive number'
      });
    }
    
    // Preorder-specific validation
    if (orderType === ORDER_TYPES.PREORDER) {
      // Check if either productId OR custom product details exist
      const hasCatalogProduct = !!productId;
      const hasCustomProduct = isCustomProduct === true || (customProduct && customProduct.name);
      
      if (!hasCatalogProduct && !hasCustomProduct) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: 'Preorder must specify either a catalog product ID or custom product details'
        });
      }
      
      // Validate custom product if provided
      if (hasCustomProduct) {
        const customProductErrors = validateCustomProduct(customProduct, orderType);
        if (customProductErrors.length > 0) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({
            success: false,
            message: 'Invalid custom product details',
            errors: customProductErrors
          });
        }
      }
      
      // Validate preorder info if provided
      const preorderErrors = validatePreorderInfo(preorderInfo);
      if (preorderErrors.length > 0) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: 'Invalid preorder information',
          errors: preorderErrors
        });
      }
    }
    
    // Offer order validation
    if (orderType === ORDER_TYPES.OFFER) {
      const offerPrice = Number(offeredPrice);
      if (!Number.isFinite(offerPrice) || offerPrice <= 0) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: 'Valid offered price is required for offer orders'
        });
      }
    }
    
    // ==================== CHECK USER ====================
    const user = await User.findById(userId).select('businessName businessAddress tel whatsappNumber name email');
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // ==================== PREPARE ORDER DATA ====================
    let product = null;
    let productName = '';
    let productPrice = null;
    let originalTotal = null;
    let placeholderProductId = null;
    let isCustom = false;
    let customProductData = null;
    let preorderInfoData = null;
    
    // Case 1: Catalog product (existing product in database)
    if (productId && !isCustomProduct) {
      product = await Product.findById(productId);
      if (!product) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }
      
      productName = product.product_name;
      productPrice = product.price;
      originalTotal = product.price * qty;
      isCustom = false;
      
      // Stock check for BUY orders
      if (orderType === ORDER_TYPES.BUY) {
        if (product.stock < qty) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({
            success: false,
            message: `Insufficient stock. Available: ${product.stock}`,
            availableStock: product.stock
          });
        }
      }
      
      // For preorders of catalog products, we don't reduce stock yet
      if (orderType === ORDER_TYPES.PREORDER) {
        // Check if enough stock will be available (optional warning)
        if (product.stock < qty) {
          console.warn(`⚠️ Preorder quantity (${qty}) exceeds current stock (${product.stock}) for product ${product.product_name}`);
          // Don't block, just warn - admin will need to procure more
        }
      }
      
      // For offer orders, validate offered price is less than product price
      if (orderType === ORDER_TYPES.OFFER && offeredPrice >= product.price) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: 'Offered price must be less than the original price to negotiate'
        });
      }
    } 
    // Case 2: Custom product (for preorders)
    else if (isCustomProduct || customProduct) {
      isCustom = true;
      
      // Get or create placeholder product for database reference integrity
      const placeholder = await getPlaceholderProduct();
      if (placeholder) {
        placeholderProductId = placeholder._id;
      } else {
        console.error('Could not create/get placeholder product');
        // Continue anyway - we'll still create the order without placeholder
      }
      
      // Set product name from custom product data
      productName = customProduct.name;
      productPrice = customProduct.targetPriceMin || null;
      originalTotal = null; // No total until price is negotiated
      
      // Prepare custom product data
      customProductData = {
        name: customProduct.name,
        description: customProduct.description || null,
        specifications: customProduct.specifications || null,
        brand: customProduct.brand || null,
        model: customProduct.model || null,
        targetPriceMin: customProduct.targetPriceMin || null,
        targetPriceMax: customProduct.targetPriceMax || null,
        color: customProduct.color || null,
        size: customProduct.size || null,
        weight: customProduct.weight || null,
        condition: customProduct.condition || 'new',
        warranty: customProduct.warranty || null
      };
      
      // Prepare preorder info
      if (preorderInfo) {
        preorderInfoData = {
          expectedDeliveryDate: preorderInfo.expectedDeliveryDate ? new Date(preorderInfo.expectedDeliveryDate) : null,
          sourceCountry: preorderInfo.sourceCountry || null,
          quantityNeeded: preorderInfo.quantityNeeded || qty,
          urgency: preorderInfo.urgency || 'medium',
          preferredSupplier: preorderInfo.preferredSupplier || null,
          shippingMethod: preorderInfo.shippingMethod || null,
          customsClearance: preorderInfo.customsClearance || false,
          qualityRequirements: preorderInfo.qualityRequirements || null,
          certificationNeeded: preorderInfo.certificationNeeded || [],
          notes: preorderInfo.notes || null
        };
      } else {
        preorderInfoData = {
          quantityNeeded: qty,
          urgency: 'medium',
          customsClearance: false,
          certificationNeeded: []
        };
      }
    } 
    else {
      // Neither catalog product nor custom product provided
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Either productId or custom product details are required'
      });
    }
    
    // ==================== CREATE ORDER ====================
    const notifyAudience = getNotifyAudience(orderType);
    
    // Prepare delivery address
    let deliveryAddressFinal = deliveryAddress;
    if (!deliveryAddressFinal && user.businessAddress) {
      deliveryAddressFinal = user.businessAddress;
    }
    
    // Build order data object
    const orderData = {
      // User reference
      userId: user._id,
      
      // Business snapshot
      businessName: user.businessName,
      businessAddress: user.businessAddress,
      tel: user.tel,
      whatsappNumber: user.whatsappNumber,
      
      // Order details
      productId: productId || placeholderProductId,
      productName,
      productPrice,
      orderType,
      quantity: qty,
      
      // Product source tracking
      productSource: isCustom ? PRODUCT_SOURCE.CUSTOM : PRODUCT_SOURCE.CATALOG,
      isCustomProduct: isCustom,
      
      // Price information
      originalTotal,
      finalPrice: null,
      
      // Custom product data (if applicable)
      customProduct: customProductData,
      placeholderProductId: placeholderProductId || null,
      
      // Preorder info (if applicable)
      preorderInfo: preorderInfoData,
      
      // Status and handling
      status: ORDER_STATUS.PENDING,
      notifyAudience,
      userNotes: userNotes || null,
      
      // Delivery info
      deliveryInfo: {
        deliveryAddress: deliveryAddressFinal,
        deliveryStatus: 'pending'
      },
      
      // Metadata
      metadata: {
        source,
        priority: priority || 'normal',
        tags: tags || [],
        userAgent: req.headers['user-agent'] || null,
        ipAddress: req.ip || req.connection.remoteAddress || null
      }
    };
    
    // Add offered price for offer orders
    if (orderType === ORDER_TYPES.OFFER) {
      orderData.offeredPrice = Number(offeredPrice);
    }
    
    // Add expected delivery date to delivery info if provided in preorder
    if (orderType === ORDER_TYPES.PREORDER && preorderInfoData?.expectedDeliveryDate) {
      orderData.deliveryInfo.estimatedDeliveryDate = preorderInfoData.expectedDeliveryDate;
    }
    
    // Create the order
    const order = await Order.create([orderData], { session });
    const createdOrder = order[0];
    
    console.log(`✅ Order created successfully: ${createdOrder._id}`);
    console.log(`   - Type: ${orderType}`);
    console.log(`   - Product source: ${isCustom ? 'Custom' : 'Catalog'}`);
    console.log(`   - Quantity: ${qty}`);
    
    // ==================== CREATE NOTIFICATIONS ====================
    await createOrderNotification(createdOrder, NOTIFICATION_TYPES.ORDER_SUBMITTED);
    
    // ==================== HANDLE STOCK (only for BUY orders) ====================
    if (orderType === ORDER_TYPES.BUY && product) {
      product.stock -= qty;
      await product.save({ session });
      console.log(`📦 Stock reduced for product ${product.product_name}: ${product.stock} remaining`);
    }
    
    // ==================== COMMIT TRANSACTION ====================
    await session.commitTransaction();
    session.endSession();
    
    // ==================== QUEUE WHATSAPP NOTIFICATIONS ====================
    let queueResult = null;
    const businessAddressForQueue = deliveryAddressFinal || user.businessAddress;
    
    try {
      if (orderType === ORDER_TYPES.BUY) {
        // Try to find salesman for this business address
        const salesman = await User.findOne({
          role: 'salesman',
          accountStatus: 'active',
          businessAddress: { $regex: new RegExp(businessAddressForQueue, 'i') }
        }).select('_id name businessAddress whatsappNumber');
        
        if (salesman && salesman.whatsappNumber) {
          // Queue for salesman
          queueResult = orderQueueService.addOrder(
            createdOrder,
            {
              type: 'salesman',
              id: salesman._id.toString(),
              name: salesman.name,
              whatsappNumber: salesman.whatsappNumber
            },
            orderType,
            user,
            businessAddressForQueue
          );
          
          // Also queue for admin
          const admin = await whatsappService.findAdmin();
          if (admin && admin.whatsappNumber) {
            orderQueueService.addOrder(
              createdOrder,
              {
                type: 'admin',
                id: admin._id.toString(),
                name: admin.name,
                whatsappNumber: admin.whatsappNumber
              },
              orderType,
              user,
              businessAddressForQueue
            );
          }
        } else {
          // No salesman found - queue for admin only
          const admin = await whatsappService.findAdmin();
          if (admin && admin.whatsappNumber) {
            queueResult = orderQueueService.addOrder(
              createdOrder,
              {
                type: 'admin',
                id: admin._id.toString(),
                name: admin.name,
                whatsappNumber: admin.whatsappNumber
              },
              orderType,
              user,
              businessAddressForQueue
            );
          }
        }
      } else if (orderType === ORDER_TYPES.OFFER || orderType === ORDER_TYPES.PREORDER) {
        // Queue for admin (both OFFER and PREORDER go to admin)
        const admin = await whatsappService.findAdmin();
        if (admin && admin.whatsappNumber) {
          queueResult = orderQueueService.addOrder(
            createdOrder,
            {
              type: 'admin',
              id: admin._id.toString(),
              name: admin.name,
              whatsappNumber: admin.whatsappNumber
            },
            orderType,
            user,
            businessAddressForQueue
          );
        }
      }
      
      console.log(`📱 WhatsApp notifications queued for user ${user.businessName || user.name}:`, queueResult);
    } catch (whatsappError) {
      console.error('Failed to queue WhatsApp notification:', whatsappError);
      // Don't fail the order creation if WhatsApp queue fails
    }
    
    // ==================== RETURN RESPONSE ====================
    const responseData = {
      success: true,
      message: orderType === ORDER_TYPES.PREORDER 
        ? (isCustom ? 'Custom pre-order created successfully' : 'Pre-order created successfully')
        : (orderType === ORDER_TYPES.OFFER ? 'Offer submitted successfully' : 'Order created successfully'),
      data: {
        order: {
          id: createdOrder._id,
          orderType: createdOrder.orderType,
          status: createdOrder.status,
          productName: createdOrder.productName,
          quantity: createdOrder.quantity,
          isCustomProduct: createdOrder.isCustomProduct,
          createdAt: createdOrder.createdAt
        },
        user: {
          id: user._id,
          name: user.name,
          businessName: user.businessName,
          businessAddress: user.businessAddress,
          tel: user.tel,
          whatsappNumber: user.whatsappNumber
        }
      }
    };
    
    // Add custom product details to response if applicable
    if (isCustom && customProductData) {
      responseData.data.customProduct = {
        name: customProductData.name,
        description: customProductData.description,
        targetPriceRange: customProductData.targetPriceMin && customProductData.targetPriceMax
          ? `${customProductData.targetPriceMin} - ${customProductData.targetPriceMax}`
          : null
      };
    }
    
    // Add preorder info to response if applicable
    if (orderType === ORDER_TYPES.PREORDER && preorderInfoData) {
      responseData.data.preorderInfo = {
        expectedDeliveryDate: preorderInfoData.expectedDeliveryDate,
        urgency: preorderInfoData.urgency,
        quantityNeeded: preorderInfoData.quantityNeeded
      };
    }
    
    // Add WhatsApp queue info if available
    if (queueResult) {
      responseData.data.whatsappQueued = true;
      responseData.data.batchInfo = queueResult;
    }
    
    return res.status(201).json(responseData);
    
  } catch (error) {
    // Rollback transaction on error
    await session.abortTransaction();
    session.endSession();
    
    console.error('❌ Error creating order:', error);
    
    // Handle duplicate key errors or other MongoDB errors
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Duplicate order detected. Please try again.',
        error: error.message
      });
    }
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors
      });
    }
    
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
    
    // Format the response to include businessAddress from the order document
    const formattedOrders = orders.map(order => {
      const orderObj = order.toObject();
      return {
        ...orderObj,
        // Ensure businessAddress is included (it's already in the order document)
        businessAddress: orderObj.businessAddress,
        // Also include other business details if needed
        businessName: orderObj.businessName,
        tel: orderObj.tel,
        whatsappNumber: orderObj.whatsappNumber
      };
    });
    
    return res.json({
      success: true,
      data: formattedOrders,
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
