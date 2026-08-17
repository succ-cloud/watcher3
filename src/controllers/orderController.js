const mongoose = require('mongoose');
const { Order, ORDER_TYPES, ORDER_STATUS, NOTIFICATION_AUDIENCE, PRODUCT_SOURCE } = require('../models/Order');
const { Notification, NOTIFICATION_TYPES } = require('../models/Notification');
const Product = require('../models/ItemsList');
const User = require('../models/User');
const Warehouse = require('../models/Warehouse');
const { WAREHOUSE_TYPES } = require('../models/Warehouse');
const Cart = require('../models/Cart');
const whatsappService = require('../service/whatsappService');
const orderQueueService = require('../service/orderQueueService');
const { findSalespeopleForOrderAddress, resolveVendorOrderFulfillmentShop, buildVendorWebDirectSale, ensureVendorBuyOrderFulfillment } = require('../utils/salesmanShopRouting');
const normalizeRoleToken = require('../utils/normalizeRoleToken');
const {
  buildSalesmanOrdersFilter,
  loadSalesmanWithShops,
  orderMatchesAssignedShops,
} = require('../utils/salesmanShopAccess');
const { reconcileOrdersForResponse } = require('../utils/reconcileOrderSoldImes');
const {
  normalizeDirectSalePaymentMethod,
} = require('../utils/directSalePaymentMethod');
const {
  applyVendorOrderImeFulfillment,
  findShopMatchesForOrder,
  resolveFulfillmentShopProduct,
  shopRequiresImeSelectionForOrder,
} = require('../utils/vendorOrderFulfillment');
const { allocateOrderDisplayCode, scheduleOrderCodeBackfill } = require('../utils/orderDisplayCode');

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
        stock: 999999,
        category: 'preorder',
        subcategory: 'custom',
        isActive: true,
        images: [],
        specifications: 'Custom product - details provided in preorder request',
        isPlaceholder: true
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
  
  if (!customProduct.name || customProduct.name.trim().length < 2) {
    errors.push('Custom product name must be at least 2 characters');
  }
  
  if (customProduct.name && customProduct.name.length > 200) {
    errors.push('Custom product name cannot exceed 200 characters');
  }
  
  if (customProduct.description && customProduct.description.length > 1000) {
    errors.push('Product description cannot exceed 1000 characters');
  }
  
  if (customProduct.specifications && customProduct.specifications.length > 2000) {
    errors.push('Product specifications cannot exceed 2000 characters');
  }
  
  if (customProduct.targetPriceMin && customProduct.targetPriceMax) {
    if (customProduct.targetPriceMin > customProduct.targetPriceMax) {
      errors.push('Minimum target price cannot be greater than maximum target price');
    }
    if (customProduct.targetPriceMin < 0) {
      errors.push('Minimum target price cannot be negative');
    }
  }
  
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
    return errors;
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
      
      if (order.staffNotes) {
        userMessage += ` Message from our team: ${order.staffNotes}`;
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
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    console.log('📝 Creating order...');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    const {
      userId,
      productId,
      orderType,
      quantity,
      offeredPrice,
      userNotes,
      deliveryAddress,
      isCustomProduct,
      customProduct,
      preorderInfo,
      source = 'web',
      priority = 'normal',
      tags = []
    } = req.body;
    
    // Basic validation
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
    
    if (!Object.values(ORDER_TYPES).includes(orderType)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Invalid order type. Must be "buy", "offer", or "preorder"'
      });
    }
    
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty < 1) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Quantity must be a positive number'
      });
    }
    
    // Preorder validation
    if (orderType === ORDER_TYPES.PREORDER) {
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
    
    const user = await User.findById(userId).select('businessName businessAddress tel whatsappNumber name email');
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    let product = null;
    let productName = '';
    let productPrice = null;
    let originalTotal = null;
    let placeholderProductId = null;
    let isCustom = false;
    let customProductData = null;
    let preorderInfoData = null;
    
    // Catalog product
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
      
      if (orderType === ORDER_TYPES.OFFER && offeredPrice >= product.price) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: 'Offered price must be less than the original price to negotiate'
        });
      }
    } 
    // Custom product
    else if (isCustomProduct || customProduct) {
      isCustom = true;
      
      const placeholder = await getPlaceholderProduct();
      if (placeholder) {
        placeholderProductId = placeholder._id;
      }
      
      productName = customProduct.name;
      productPrice = customProduct.targetPriceMin || null;
      originalTotal = null;
      
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
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Either productId or custom product details are required'
      });
    }
    
    const notifyAudience = getNotifyAudience(orderType);
    
    let deliveryAddressFinal = deliveryAddress;
    if (!deliveryAddressFinal && user.businessAddress) {
      deliveryAddressFinal = user.businessAddress;
    }

    let fulfillmentAssignment = null;
    if (orderType === ORDER_TYPES.BUY) {
      fulfillmentAssignment = await resolveVendorOrderFulfillmentShop(deliveryAddressFinal || user.businessAddress);
    }

    let fulfillmentProduct = product;
    if (fulfillmentAssignment?.shop && product && orderType === ORDER_TYPES.BUY) {
      const atShop = await resolveFulfillmentShopProduct({
        shopId: fulfillmentAssignment.shop._id,
        referenceProduct: product,
        order,
        quantity: qty,
      });
      if (atShop) {
        fulfillmentProduct = atShop;
        productName = fulfillmentProduct.product_name;
        productPrice = fulfillmentProduct.price;
        originalTotal = fulfillmentProduct.price * qty;
      }

      if (fulfillmentProduct.stock < qty) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: atShop
            ? `Insufficient stock at ${fulfillmentAssignment.shop.name}. Available: ${fulfillmentProduct.stock}`
            : `Insufficient stock. Available: ${fulfillmentProduct.stock}`,
          availableStock: fulfillmentProduct.stock,
        });
      }
    } else if (orderType === ORDER_TYPES.BUY && product && product.stock < qty) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: `Insufficient stock. Available: ${product.stock}`,
        availableStock: product.stock,
      });
    }
    
    const orderData = {
      userId: user._id,
      businessName: user.businessName,
      businessAddress: user.businessAddress,
      tel: user.tel,
      whatsappNumber: user.whatsappNumber,
      productId: fulfillmentProduct?._id || productId || placeholderProductId,
      productName,
      productPrice,
      orderType,
      quantity: qty,
      productSource: isCustom ? PRODUCT_SOURCE.CUSTOM : PRODUCT_SOURCE.CATALOG,
      isCustomProduct: isCustom,
      originalTotal,
      finalPrice: null,
      customProduct: customProductData,
      placeholderProductId: placeholderProductId || null,
      preorderInfo: preorderInfoData,
      status: ORDER_STATUS.PENDING,
      notifyAudience,
      userNotes: userNotes || null,
      deliveryInfo: {
        deliveryAddress: deliveryAddressFinal,
        deliveryStatus: 'pending'
      },
      metadata: {
        source,
        priority: priority || 'normal',
        tags: tags || [],
        userAgent: req.headers['user-agent'] || null,
        ipAddress: req.ip || req.connection.remoteAddress || null
      }
    };
    
    if (orderType === ORDER_TYPES.OFFER) {
      orderData.offeredPrice = Number(offeredPrice);
    }

    if (fulfillmentAssignment?.shop && orderType === ORDER_TYPES.BUY) {
      const directSale = buildVendorWebDirectSale(fulfillmentAssignment);
      if (directSale) orderData.directSale = directSale;
    }
    
    if (orderType === ORDER_TYPES.PREORDER && preorderInfoData?.expectedDeliveryDate) {
      orderData.deliveryInfo.estimatedDeliveryDate = preorderInfoData.expectedDeliveryDate;
    }

    const createdAt = new Date();
    orderData.createdAt = createdAt;
    orderData.orderCode = await allocateOrderDisplayCode({ date: createdAt, session });
    
    const order = await Order.create([orderData], { session });
    const createdOrder = order[0];
    
    console.log(`✅ Order created successfully: ${createdOrder._id}`);
    console.log(`   - Type: ${orderType}`);
    console.log(`   - Product source: ${isCustom ? 'Custom' : 'Catalog'}`);
    console.log(`   - Quantity: ${qty}`);
    
    await createOrderNotification(createdOrder, NOTIFICATION_TYPES.ORDER_SUBMITTED);
    
    if (orderType === ORDER_TYPES.BUY && fulfillmentProduct) {
      fulfillmentProduct.stock -= qty;
      await fulfillmentProduct.save({ session });
      console.log(`📦 Stock reduced for product ${fulfillmentProduct.product_name}: ${fulfillmentProduct.stock} remaining`);
    }
    
    await session.commitTransaction();
    session.endSession();
    
    // ==================== CLEAR CART AFTER ORDER CREATION ====================
    // Import Cart model at the top of your file
    const Cart = require('../models/Cart');
    
    try {
      await Cart.convertCartToOrder(userId);
      console.log(`🛒 Cart converted to order for user ${userId}`);
    } catch (cartError) {
      console.error('Error clearing cart:', cartError);
      // Don't fail the order if cart clear fails - just log
    }
    // ==================== END CLEAR CART ====================
    
    let queueResult = null;
    const businessAddressForQueue = deliveryAddressFinal || user.businessAddress;
    
    try {
      if (orderType === ORDER_TYPES.BUY) {
        const salesmen = await findSalespeopleForOrderAddress(businessAddressForQueue);

        for (const salesman of salesmen) {
          queueResult = orderQueueService.addOrder(
            createdOrder,
            {
              type: 'salesman',
              id: salesman._id.toString(),
              name: salesman.name,
              whatsappNumber: salesman.whatsappNumber,
            },
            orderType,
            user,
            businessAddressForQueue,
          );
        }

        const admin = await whatsappService.findAdmin();
        if (admin && admin.whatsappNumber) {
          queueResult = orderQueueService.addOrder(
            createdOrder,
            {
              type: 'admin',
              id: admin._id.toString(),
              name: admin.name,
              whatsappNumber: admin.whatsappNumber,
            },
            orderType,
            user,
            businessAddressForQueue,
          );
        } else if (!salesmen.length) {
          console.warn('No salesperson or admin WhatsApp recipient for buy order', createdOrder._id);
        }
      } else if (orderType === ORDER_TYPES.OFFER || orderType === ORDER_TYPES.PREORDER) {
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
    }
    
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
    
    if (isCustom && customProductData) {
      responseData.data.customProduct = {
        name: customProductData.name,
        description: customProductData.description,
        targetPriceRange: customProductData.targetPriceMin && customProductData.targetPriceMax
          ? `${customProductData.targetPriceMin} - ${customProductData.targetPriceMax}`
          : null
      };
    }
    
    if (orderType === ORDER_TYPES.PREORDER && preorderInfoData) {
      responseData.data.preorderInfo = {
        expectedDeliveryDate: preorderInfoData.expectedDeliveryDate,
        urgency: preorderInfoData.urgency,
        quantityNeeded: preorderInfoData.quantityNeeded
      };
    }
    
    if (queueResult) {
      responseData.data.whatsappQueued = true;
      responseData.data.batchInfo = queueResult;
    }
    
    return res.status(201).json(responseData);
    
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    
    console.error('❌ Error creating order:', error);
    
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Duplicate order detected. Please try again.',
        error: error.message
      });
    }
    
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
 * Accept an order and reduce stock (handles both catalog and custom products)
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
      deliveryNotes,
      imeCodes,
    } = req.body;
    
    if (!handledById) {
      return res.status(400).json({
        success: false,
        message: 'handledById is required'
      });
    }
    
    const order = await Order.findById(id).populate('userId', 'name businessName tel whatsappNumber businessAddress');
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    if (order.status !== ORDER_STATUS.PENDING) {
      return res.status(400).json({
        success: false,
        message: `Cannot accept order with status: ${order.status}`
      });
    }
    
    const staff = await User.findById(handledById);
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff user not found'
      });
    }
    
    if (order.orderType === ORDER_TYPES.BUY && staff.role !== 'salesman' && staff.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only salesmen or admins can accept buy orders'
      });
    }

    if (order.orderType === ORDER_TYPES.BUY && staff.role === 'salesman') {
      const salesman = await loadSalesmanWithShops(staff._id);
      if (!orderMatchesAssignedShops(order, salesman?.assignedShops || [])) {
        return res.status(403).json({
          success: false,
          message: 'This order is outside your assigned Shop locations.',
        });
      }
    }
    
    if ((order.orderType === ORDER_TYPES.OFFER || order.orderType === ORDER_TYPES.PREORDER) && staff.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can accept offer or preorder requests'
      });
    }
    
    let product = null;
    let stockUpdateInfo = null;
    let shopMatchingLines = [];

    const assignedShopId = String(
      order?.directSale?.assignedWarehouseId?._id ??
        order?.directSale?.assignedWarehouseId ??
        '',
    ).trim();
    const isVendorWebBuy =
      String(order?.directSale?.source || '').toLowerCase() === 'vendor_web'
      || String(order?.metadata?.source || '').toLowerCase() === 'web'
      || Boolean(assignedShopId);

    /** Catalog BUY: `createOrder` already decremented stock — do not deduct again on accept. */
    const skipStockDeductionOnAccept =
      order.orderType === ORDER_TYPES.BUY && !order.isCustomProduct;
    
    if (!order.isCustomProduct && order.productId && order.productSource === 'catalog') {
      product = await Product.findById(order.productId);
      
      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found in catalog'
        });
      }

      if (isVendorWebBuy && assignedShopId) {
        shopMatchingLines = await findShopMatchesForOrder(assignedShopId, order);
        if (!shopMatchingLines.length) {
          return res.status(400).json({
            success: false,
            message: 'No matching product (name + capacity) was found in this shop inventory.',
          });
        }
        product = shopMatchingLines[0];
      }
      
      if (skipStockDeductionOnAccept) {
        console.log(
          `📝 Buy order ${order._id}: stock was already reduced when the order was created; skipping accept-time deduction.`,
        );
      } else {
        if (product.stock < order.quantity) {
          return res.status(400).json({
            success: false,
            message: `Insufficient stock. Available: ${product.stock}, Required: ${order.quantity}`,
            availableStock: product.stock,
            requiredQuantity: order.quantity
          });
        }
        
        product.stock -= order.quantity;
        await product.save();
        
        stockUpdateInfo = {
          productId: product._id,
          productName: product.product_name,
          quantityDeducted: order.quantity,
          remainingStock: product.stock
        };
        
        console.log(`✅ Stock deducted for product ${product.product_name}:`);
        console.log(`   - Order ID: ${order._id}`);
        console.log(`   - Quantity deducted: ${order.quantity}`);
        console.log(`   - Remaining stock: ${product.stock}`);
      }
    } else {
      console.log(`📝 Custom preorder accepted - no stock deduction required`);
      console.log(`   - Order ID: ${order._id}`);
      console.log(`   - Custom Product: ${order.customProduct?.name || order.productName}`);
    }
    
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
    
    if (order.isCustomProduct && !estimatedDeliveryDate && order.preorderInfo?.expectedDeliveryDate) {
      deliveryData.estimatedDeliveryDate = order.preorderInfo.expectedDeliveryDate;
    }
    
    if (isVendorWebBuy && order.orderType === ORDER_TYPES.BUY && !estimatedDeliveryDate) {
      return res.status(400).json({
        success: false,
        message: 'Estimated delivery date is required before accepting a vendor site order.',
      });
    }

    let finalPriceToUse = finalPrice;
    
    if (order.isCustomProduct && !finalPriceToUse) {
      if (order.customProduct?.targetPriceMin) {
        finalPriceToUse = order.customProduct.targetPriceMin;
        console.log(`⚠️ No final price provided for custom preorder, using minimum target price: ${finalPriceToUse}`);
      } else {
        console.log(`⚠️ No final price provided for custom preorder, admin should update price later`);
      }
    }

    let imeFulfillment = null;
    const orderQty = Math.max(1, Number(order?.quantity) || 1);
    const vendorListedUnitPrice =
      Number(order?.productPrice) > 0
        ? Number(order.productPrice)
        : Number(product?.price) > 0
          ? Number(product.price)
          : null;
    const vendorSoldUnitPrice =
      Number(finalPriceToUse) > 0
        ? Number(finalPriceToUse) / orderQty
        : vendorListedUnitPrice;

    if (
      isVendorWebBuy
      && order.orderType === ORDER_TYPES.BUY
      && !order.isCustomProduct
      && shopMatchingLines.length
      && shopRequiresImeSelectionForOrder(shopMatchingLines)
    ) {
      try {
        imeFulfillment = await applyVendorOrderImeFulfillment({
          order,
          product,
          matchingLines: shopMatchingLines,
          staff,
          imeCodes,
          listedUnitPrice: vendorListedUnitPrice,
          soldUnitPrice: vendorSoldUnitPrice,
        });
      } catch (imeErr) {
        return res.status(imeErr.statusCode || 400).json({
          success: false,
          message: imeErr.message || 'Invalid IME selection for this order.',
        });
      }
    } else if (
      isVendorWebBuy
      && order.orderType === ORDER_TYPES.BUY
      && !order.isCustomProduct
      && shopMatchingLines.length
      && shopRequiresImeSelectionForOrder(shopMatchingLines) === false
    ) {
      const { buildVendorFulfillmentPreview } = require('../utils/vendorOrderInventoryMatch');
      const preview = buildVendorFulfillmentPreview({
        order,
        shopProducts: shopMatchingLines,
        platformProducts: [],
        shopId: assignedShopId,
      });
      if (!preview.canFulfillFromShop) {
        return res.status(400).json({
          success: false,
          message: `This shop does not have enough stock for this order. Available: ${preview.shopStockUnits}, required: ${preview.quantity}. Request stock from a warehouse.`,
        });
      }
    }
    
    await order.accept(handledById, finalPriceToUse, Object.keys(deliveryData).length > 0 ? deliveryData : null);
    
    if (imeFulfillment) {
      order.soldImeCodes = imeFulfillment.soldImeCodes;
      order.directSale = {
        ...(order.directSale && typeof order.directSale === 'object' ? order.directSale : {}),
        type: 'wholesale',
        source: order.directSale?.source || 'vendor_web',
        paymentMethod: 'cash',
        imeManifest: imeFulfillment.manifest,
        fulfilledAt: new Date(),
      };
      await order.save();
    }
    
    if (staffNotes) {
      order.staffNotes = staffNotes;
      await order.save();
    }
    
    await createOrderNotification(order, NOTIFICATION_TYPES.ORDER_ACCEPTED);
    
    const responseData = {
      success: true,
      message: order.isCustomProduct 
        ? 'Custom pre-order accepted successfully' 
        : 'Order accepted successfully',
      data: {
        order: {
          id: order._id,
          orderType: order.orderType,
          status: order.status,
          productName: order.productName,
          quantity: order.quantity,
          isCustomProduct: order.isCustomProduct,
          finalPrice: order.finalPrice,
          originalTotal: order.originalTotal
        },
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
        }
      }
    };
    
    if (stockUpdateInfo) {
      responseData.data.stockUpdate = stockUpdateInfo;
    }
    
    if (order.isCustomProduct && order.customProduct) {
      responseData.data.customProduct = {
        name: order.customProduct.name,
        description: order.customProduct.description,
        targetPriceRange: order.customProduct.targetPriceMin && order.customProduct.targetPriceMax
          ? `${order.customProduct.targetPriceMin} - ${order.customProduct.targetPriceMax}`
          : null,
        finalPrice: order.finalPrice
      };
    }
    
    if (Object.keys(deliveryData).length > 0) {
      responseData.data.deliveryInfo = order.deliveryInfo;
    }
    
    return res.json(responseData);
    
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
 * Reject an order (handles both catalog products and custom preorders)
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
    
    const order = await Order.findById(id).populate('userId', 'name businessName tel whatsappNumber businessAddress');
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    if (order.status !== ORDER_STATUS.PENDING) {
      return res.status(400).json({
        success: false,
        message: `Cannot reject order with status: ${order.status}. Only pending orders can be rejected.`
      });
    }
    
    const staff = await User.findById(handledById);
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff user not found'
      });
    }
    
    if (order.orderType === ORDER_TYPES.BUY && staff.role !== 'salesman' && staff.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only salesmen or admins can reject buy orders'
      });
    }

    if (order.orderType === ORDER_TYPES.BUY && staff.role === 'salesman') {
      const salesman = await loadSalesmanWithShops(staff._id);
      if (!orderMatchesAssignedShops(order, salesman?.assignedShops || [])) {
        return res.status(403).json({
          success: false,
          message: 'This order is outside your assigned Shop locations.',
        });
      }
    }
    
    if ((order.orderType === ORDER_TYPES.OFFER || order.orderType === ORDER_TYPES.PREORDER) && staff.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can reject offer or preorder requests'
      });
    }
    
    if (order.isCustomProduct) {
      console.log(`📝 Custom preorder rejected - no stock to restore`);
      console.log(`   - Order ID: ${order._id}`);
      console.log(`   - Custom Product: ${order.customProduct?.name || order.productName}`);
      console.log(`   - Rejection reason: ${rejectionReason}`);
    } else if (order.orderType === ORDER_TYPES.BUY) {
      console.log(`📝 Buy order rejected - no stock to restore (stock not deducted yet)`);
      console.log(`   - Order ID: ${order._id}`);
      console.log(`   - Product: ${order.productName}`);
      console.log(`   - Rejection reason: ${rejectionReason}`);
    } else {
      console.log(`📝 ${order.orderType} order rejected - no stock changes needed`);
      console.log(`   - Order ID: ${order._id}`);
      console.log(`   - Rejection reason: ${rejectionReason}`);
    }
    
    await order.reject(handledById, rejectionReason);
    
    if (staffNotes) {
      order.staffNotes = staffNotes;
      await order.save();
    }
    
    await createOrderNotification(order, NOTIFICATION_TYPES.ORDER_REJECTED);
    
    const responseData = {
      success: true,
      message: order.isCustomProduct 
        ? 'Custom pre-order rejected successfully' 
        : (order.orderType === ORDER_TYPES.PREORDER 
          ? 'Pre-order rejected successfully' 
          : 'Order rejected successfully'),
      data: {
        order: {
          id: order._id,
          orderType: order.orderType,
          status: order.status,
          productName: order.productName,
          quantity: order.quantity,
          isCustomProduct: order.isCustomProduct || false,
          rejectionReason: order.rejectionReason,
          rejectedAt: order.handledAt
        },
        staff: {
          id: staff._id,
          name: staff.name,
          role: staff.role
        }
      }
    };
    
    if (order.isCustomProduct && order.customProduct) {
      responseData.data.customProduct = {
        name: order.customProduct.name,
        description: order.customProduct.description,
        requestedQuantity: order.quantity,
        targetPriceRange: order.customProduct.targetPriceMin && order.customProduct.targetPriceMax
          ? `${order.customProduct.targetPriceMin} - ${order.customProduct.targetPriceMax}`
          : null
      };
    }
    
    if (order.orderType === ORDER_TYPES.PREORDER && order.preorderInfo) {
      responseData.data.preorderInfo = {
        urgency: order.preorderInfo.urgency,
        expectedDeliveryDate: order.preorderInfo.expectedDeliveryDate,
        quantityNeeded: order.preorderInfo.quantityNeeded
      };
    }
    
    if (staffNotes) {
      responseData.data.staffNotes = staffNotes;
    }
    
    return res.json(responseData);
    
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
 * Cancel an order (handles stock restoration for catalog products only)
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
        message: `Cannot cancel order with status: ${order.status}. Only pending orders can be cancelled.`
      });
    }
    
    let stockRestoreInfo = null;
    
    if (!order.isCustomProduct && order.orderType === ORDER_TYPES.BUY && order.productId) {
      const product = await Product.findById(order.productId);
      if (product) {
        product.stock += order.quantity;
        await product.save();
        
        stockRestoreInfo = {
          productId: product._id,
          productName: product.product_name,
          quantityRestored: order.quantity,
          newStockLevel: product.stock
        };
        
        console.log(`✅ Stock restored for product ${product.product_name}:`);
        console.log(`   - Order ID: ${order._id}`);
        console.log(`   - Quantity restored: ${order.quantity}`);
        console.log(`   - New stock level: ${product.stock}`);
      } else {
        console.warn(`⚠️ Product not found for stock restoration: ${order.productId}`);
      }
    } else if (order.isCustomProduct) {
      console.log(`📝 Custom preorder cancelled - no stock to restore`);
    } else if (order.orderType !== ORDER_TYPES.BUY) {
      console.log(`📝 ${order.orderType} order cancelled - no stock to restore (stock not deducted until acceptance)`);
    }
    
    await order.cancel();
    
    if (reason) {
      order.userNotes = reason;
      await order.save();
    }
    
    await createOrderNotification(order, NOTIFICATION_TYPES.ORDER_CANCELLED);
    
    const responseData = {
      success: true,
      message: order.isCustomProduct 
        ? 'Custom pre-order cancelled successfully' 
        : 'Order cancelled successfully',
      data: {
        order: {
          id: order._id,
          orderType: order.orderType,
          status: order.status,
          productName: order.productName,
          quantity: order.quantity,
          isCustomProduct: order.isCustomProduct,
          cancelledAt: order.updatedAt
        },
        cancellationReason: reason || null
      }
    };
    
    if (stockRestoreInfo) {
      responseData.data.stockRestore = stockRestoreInfo;
    }
    
    if (order.isCustomProduct && order.customProduct) {
      responseData.data.customProduct = {
        name: order.customProduct.name,
        description: order.customProduct.description
      };
    }
    
    return res.json(responseData);
    
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
    scheduleOrderCodeBackfill();

    const { userId, status, orderType, notifyAudience, limit = 50, page = 1 } = req.query;

    const filter = {};
    const requesterRole = normalizeRoleToken(req.user?.role);
    const requesterId = String(req.userId || req.user?.userId || req.user?.id || '').trim();

    if (requesterRole === 'salesman') {
      const scoped = await buildSalesmanOrdersFilter(requesterId);
      Object.assign(filter, scoped);
    }

    if (userId) filter.userId = userId;
    if (status) filter.status = status;
    if (orderType && requesterRole !== 'salesman') filter.orderType = orderType;
    if (notifyAudience) filter.notifyAudience = notifyAudience;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);
    const skip = (pageNum - 1) * limitNum;

    const populateOpts = { strictPopulate: false };
    let orders;
    try {
      orders = await Order.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate({ path: 'userId', select: 'name businessName tel deliveryAddress', ...populateOpts })
        .populate({ path: 'productId', select: 'product_name price images capacity brand', ...populateOpts })
        .populate({ path: 'handledBy', select: 'name role', ...populateOpts });
    } catch (populateErr) {
      console.warn('getOrders populate failed, listing without populate:', populateErr.message || populateErr);
      orders = await Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum);
    }

    const total = await Order.countDocuments(filter);

    let orderObjects = orders.map((order) => (typeof order?.toObject === 'function' ? order.toObject() : order));

    // Avoid mutating orders on admin/report list reads — fulfillment backfill is for salesman views only.
    if (requesterRole === 'salesman') {
      const backfilled = [];
      for (const orderObj of orderObjects) {
        try {
          backfilled.push(await ensureVendorBuyOrderFulfillment(orderObj));
        } catch (fulfillmentErr) {
          console.warn(
            `ensureVendorBuyOrderFulfillment skipped for order ${orderObj?._id}:`,
            fulfillmentErr.message || fulfillmentErr,
          );
          backfilled.push(orderObj);
        }
      }
      orderObjects = backfilled;
    }

    const formattedOrders = orderObjects.map((orderObj) => ({
      ...orderObj,
      businessAddress: orderObj.businessAddress,
      businessName: orderObj.businessName,
      tel: orderObj.tel,
      whatsappNumber: orderObj.whatsappNumber,
    }));

    return res.json({
      success: true,
      data: formattedOrders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.max(1, Math.ceil(total / limitNum)),
      },
    });
  } catch (error) {
    console.error('Error getting orders:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get orders',
      error: error.message,
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
      .populate('productId', 'product_name price images description capacity brand')
      .populate('handledBy', 'name role');
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const requesterRole = normalizeRoleToken(req.user?.role);
    const requesterId = String(req.userId || req.user?.userId || req.user?.id || '').trim();
    if (requesterRole === 'salesman') {
      await ensureVendorBuyOrderFulfillment(order);
    }
    
    if (requesterRole === 'salesman') {
      const salesman = await loadSalesmanWithShops(requesterId);
      if (!orderMatchesAssignedShops(order, salesman?.assignedShops || [])) {
        return res.status(403).json({
          success: false,
          message: 'You do not have access to this order.',
        });
      }
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
 * DELETE /api/orders/:id
 * Permanently delete an order from the database
 * Access: Admin only (or user who owns the order)
 */
async function deleteOrder(req, res) {
  try {
    const { id } = req.params;
    const { userId, reason } = req.body;
    const currentUser = req.user || req.userId;
    
    // Check if user is authenticated
    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }
    
    // Find the order
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }
    
    // Check permissions: Admin can delete any order, users can only delete their own orders
    const isAdmin = req.user?.role === 'admin' || req.role === 'admin';
    const isOwner = order.userId.toString() === (userId || currentUser._id || currentUser);
    
    if (!isAdmin && !isOwner) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to delete this order'
      });
    }
    
    // Log deletion for audit purposes
    console.log(`🗑️ Deleting order ${id}:`);
    console.log(`   - Order Type: ${order.orderType}`);
    console.log(`   - Customer: ${order.businessName}`);
    console.log(`   - Product: ${order.productName}`);
    console.log(`   - Quantity: ${order.quantity}`);
    console.log(`   - Status: ${order.status}`);
    console.log(`   - Deleted by: ${isAdmin ? 'Admin' : 'User'}`);
    
    // If order was accepted and stock was deducted, we need to restore stock
    if (order.status === ORDER_STATUS.ACCEPTED && !order.isCustomProduct && order.productId) {
      const product = await Product.findById(order.productId);
      if (product) {
        product.stock += order.quantity;
        await product.save();
        console.log(`🔄 Stock restored for product ${product.product_name}: +${order.quantity}, New stock: ${product.stock}`);
      }
    }
    
    // Delete associated notifications
    await Notification.deleteMany({ orderId: order._id });
    console.log(`📧 Deleted ${await Notification.countDocuments({ orderId: order._id })} associated notifications`);
    
    // Delete the order
    await Order.findByIdAndDelete(id);
    
    // If there was an associated cart item for this order, we don't restore it (order already processed)
    
    return res.status(200).json({
      success: true,
      message: 'Order deleted successfully',
      data: {
        deletedOrderId: id,
        orderDetails: {
          orderType: order.orderType,
          productName: order.productName,
          quantity: order.quantity,
          status: order.status
        },
        stockRestored: order.status === ORDER_STATUS.ACCEPTED && !order.isCustomProduct
      }
    });
    
  } catch (error) {
    console.error('Error deleting order:', error);
    
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID format'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Failed to delete order',
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

function updateCustomerInUserNotes(userNotes, customerName) {
  const notes = String(userNotes || '');
  const trimmed = String(customerName || '').trim();
  if (!trimmed) return notes;
  if (/Customer:\s*/i.test(notes)) {
    return notes.replace(/(Customer:\s*)([^—\n]+)/i, `$1${trimmed}`);
  }
  return notes;
}

function parseReceiptPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function normalizeReceiptUnitRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((row, idx) => ({
    rowNumber: Number(row?.rowNumber) > 0 ? Number(row.rowNumber) : idx + 1,
    ime: String(row?.ime || '').trim(),
    unitPrice: parseReceiptPrice(row?.unitPrice),
  }));
}

function normalizeReceiptPurchaseLines(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((line) => {
    const quantity = Math.max(0, Math.floor(Number(line?.quantity) || 0));
    const unitPrice = parseReceiptPrice(line?.unitPrice);
    const lineTotal = parseReceiptPrice(line?.lineTotal);
    return {
      quantity,
      unitPrice,
      lineTotal:
        lineTotal != null
          ? lineTotal
          : unitPrice != null && quantity > 0
            ? unitPrice * quantity
            : null,
    };
  });
}

function applyReceiptPricing(order, { unitRows, purchaseLines, grandTotal }) {
  const rows = normalizeReceiptUnitRows(unitRows);
  const lines = normalizeReceiptPurchaseLines(purchaseLines);

  let total = parseReceiptPrice(grandTotal);
  if (total == null) {
    if (rows.some((row) => row.unitPrice == null) || lines.some((line) => line.unitPrice == null)) {
      return { ok: false, message: 'All unit prices must be zero or greater.' };
    }
    if (rows.length) {
      total = rows.reduce((sum, row) => sum + (row.unitPrice || 0), 0);
    } else if (lines.length) {
      total = lines.reduce((sum, line) => sum + (line.lineTotal || 0), 0);
    }
  }
  if (total == null) {
    return { ok: false, message: 'Could not calculate receipt total.' };
  }

  const qty = Math.max(
    1,
    rows.length ||
      lines.reduce((sum, line) => sum + (line.quantity || 0), 0) ||
      Number(order.quantity) ||
      1,
  );
  const avgUnit = Math.round(total / qty);
  const uniformUnit =
    rows.length > 0 && rows.every((row) => row.unitPrice === rows[0].unitPrice)
      ? rows[0].unitPrice
      : avgUnit;

  order.productPrice = uniformUnit;
  order.finalPrice = total;
  order.originalTotal = total;
  if (order.totalAmount != null) order.totalAmount = total;
  if (order.total != null) order.total = total;
  if (order.amount != null) order.amount = total;

  const existing =
    order.directSale && typeof order.directSale === 'object' && !Array.isArray(order.directSale)
      ? order.directSale
      : {};
  const directSale =
    existing && typeof existing.toObject === 'function' ? existing.toObject() : { ...existing };

  directSale.soldUnitPrice = uniformUnit;
  directSale.receiptGrandTotal = total;

  if (Array.isArray(directSale.imeManifest) && directSale.imeManifest.length) {
    if (rows.length) {
      directSale.imeManifest = directSale.imeManifest.map((entry, idx) => {
        const entryIme = String(entry?.ime || '').trim();
        const match =
          rows.find((row) => row.ime && entryIme && row.ime === entryIme) ||
          rows[idx] ||
          null;
        if (!match || match.unitPrice == null) {
          return { ...entry, unitPrice: uniformUnit };
        }
        return { ...entry, unitPrice: match.unitPrice };
      });
    } else {
      directSale.imeManifest = directSale.imeManifest.map((entry) => ({
        ...(entry && typeof entry === 'object' ? entry : {}),
        unitPrice: uniformUnit,
      }));
    }
  }

  order.directSale = directSale;
  order.markModified('directSale');
  order.markModified('finalPrice');
  order.markModified('originalTotal');

  return { ok: true, total, rows, avgUnit, uniformUnit };
}

function resolveExistingReceiptShopId(order) {
  const ds = order.directSale && typeof order.directSale === 'object' ? order.directSale : {};
  const raw = ds.assignedWarehouseId ?? order.assignedWarehouseId ?? '';
  if (raw && typeof raw === 'object') {
    return String(raw._id ?? raw.id ?? '').trim();
  }
  return String(raw || '').trim();
}

function resolveExistingHandledById(order) {
  const hb = order.handledBy;
  if (hb && typeof hb === 'object') {
    return String(hb._id ?? hb.id ?? '').trim();
  }
  return String(hb || '').trim();
}

/**
 * Try to apply shop + salesperson on a receipt. Returns null on success or an error message.
 */
async function tryApplyReceiptAssignment(order, assignedWarehouseId, handledById, hasPricingPayload) {
  const assignedWarehouse = await Warehouse.findById(assignedWarehouseId).select('name city type isActive');
  if (!assignedWarehouse || assignedWarehouse.isActive === false) {
    return 'Selected shop not found or inactive.';
  }
  if (String(assignedWarehouse.type || '').toLowerCase() !== WAREHOUSE_TYPES.SUB) {
    return 'Receipts must be assigned to a shop.';
  }

  const assignedStaff = await User.findById(handledById).select('name role assignedShops accountStatus');
  if (!assignedStaff) {
    return 'Selected salesperson not found.';
  }

  const staffRole = normalizeRoleToken(assignedStaff.role);
  const isExistingHandler = handledById === resolveExistingHandledById(order);
  if (staffRole !== 'salesman' && !(isExistingHandler && hasPricingPayload)) {
    return 'Select a salesperson assigned to this shop.';
  }

  if (String(assignedStaff.accountStatus || '').toLowerCase() !== 'active' && !isExistingHandler) {
    return 'Selected salesperson is not active.';
  }

  const shopKey = String(assignedWarehouse._id);
  const assignedToShop = (Array.isArray(assignedStaff.assignedShops) ? assignedStaff.assignedShops : []).some(
    (shopRef) => String(shopRef?._id ?? shopRef ?? '').trim() === shopKey,
  );
  if (!assignedToShop && !(isExistingHandler && hasPricingPayload)) {
    return 'Selected salesperson is not assigned to this shop.';
  }

  const directSale =
    order.directSale && typeof order.directSale === 'object' && !Array.isArray(order.directSale)
      ? { ...order.directSale }
      : {};

  directSale.assignedWarehouseId = assignedWarehouse._id;
  directSale.assignedWarehouseName = assignedWarehouse.name;
  directSale.assignedWarehouseCity = assignedWarehouse.city || null;
  directSale.assignedWarehouseType = assignedWarehouse.type || WAREHOUSE_TYPES.SUB;

  order.handledBy = assignedStaff._id;
  order.directSale = directSale;
  order.markModified('directSale');

  return {
    assignedWarehouse,
    assignedStaff,
  };
}

function isReceiptEditableStatus(status) {
  const s = String(status || '').toLowerCase().trim();
  return (
    s === ORDER_STATUS.ACCEPTED ||
    s === ORDER_STATUS.DELIVERED ||
    s === 'approved' ||
    s === 'fulfilled' ||
    s === 'completed'
  );
}

/**
 * PATCH /api/orders/:id/receipt
 * Update shop, salesperson, and pricing on an accepted order receipt (admin only).
 */
async function updateOrderReceipt(req, res) {
  try {
    const requesterRole = normalizeRoleToken(req.user?.role ?? req.role);
    if (requesterRole !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can edit order receipts.',
      });
    }

    const { id } = req.params;
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    if (!isReceiptEditableStatus(order.status)) {
      return res.status(400).json({
        success: false,
        message: `Receipts can only be edited for accepted orders (current status: ${order.status || 'unknown'}).`,
      });
    }

    let assignedWarehouseId = String(req.body?.assignedWarehouseId || '').trim();
    let handledById = String(req.body?.handledById || '').trim();
    if (!assignedWarehouseId) assignedWarehouseId = resolveExistingReceiptShopId(order);
    if (!handledById) handledById = resolveExistingHandledById(order);

    const hasPricingPayload =
      Array.isArray(req.body?.unitRows) ||
      Array.isArray(req.body?.purchaseLines) ||
      req.body?.grandTotal != null;

    let pricingResult = null;
    let assignmentApplied = false;
    let assignedWarehouse = null;
    let assignedStaff = null;
    let assignmentSkippedMessage = '';

    if (hasPricingPayload) {
      pricingResult = applyReceiptPricing(order, {
        unitRows: req.body?.unitRows,
        purchaseLines: req.body?.purchaseLines,
        grandTotal: req.body?.grandTotal,
      });
      if (!pricingResult.ok) {
        return res.status(400).json({
          success: false,
          message: pricingResult.message || 'Invalid receipt pricing.',
        });
      }
    }

    if (assignedWarehouseId && handledById) {
      const assignmentResult = await tryApplyReceiptAssignment(
        order,
        assignedWarehouseId,
        handledById,
        hasPricingPayload,
      );
      if (typeof assignmentResult === 'string') {
        if (!pricingResult) {
          return res.status(400).json({
            success: false,
            message: assignmentResult,
          });
        }
        assignmentSkippedMessage = assignmentResult;
      } else {
        assignedWarehouse = assignmentResult.assignedWarehouse;
        assignedStaff = assignmentResult.assignedStaff;
        assignmentApplied = true;
      }
    } else if (!pricingResult) {
      return res.status(400).json({
        success: false,
        message: 'Shop and salesperson are required.',
      });
    }

    await order.save();

    if (pricingResult?.total != null) {
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            finalPrice: pricingResult.total,
            originalTotal: pricingResult.total,
            productPrice: pricingResult.uniformUnit,
            'directSale.receiptGrandTotal': pricingResult.total,
            'directSale.soldUnitPrice': pricingResult.uniformUnit,
          },
        },
      );
    }

    console.log(
      `updateOrderReceipt ok: order=${order._id} finalPrice=${order.finalPrice} receiptGrandTotal=${order.directSale?.receiptGrandTotal}`,
    );

    try {
      const { SoldIme } = require('../models/SoldIme');
      if (assignmentApplied && assignedStaff && assignedWarehouse) {
        await SoldIme.updateMany(
          { orderId: order._id },
          {
            $set: {
              handledBy: assignedStaff._id,
              assignedWarehouseId: assignedWarehouse._id,
              assignedWarehouseName: assignedWarehouse.name,
            },
          },
        );
      }

      if (pricingResult?.rows?.length) {
        for (const row of pricingResult.rows) {
          const ime = String(row.ime || '').trim();
          if (!ime || row.unitPrice == null) continue;
          await SoldIme.updateOne({ orderId: order._id, ime }, { $set: { unitPrice: row.unitPrice } });
        }
      } else if (pricingResult?.uniformUnit != null) {
        await SoldIme.updateMany(
          { orderId: order._id },
          { $set: { unitPrice: pricingResult.uniformUnit } },
        );
      }
    } catch (soldImeErr) {
      console.warn('updateOrderReceipt SoldIme sync skipped:', soldImeErr.message || soldImeErr);
    }

    let responseOrder = order;
    try {
      const populated = await Order.findById(order._id)
        .populate('handledBy', 'name role')
        .populate('userId', 'name businessName tel')
        .populate('productId', 'product_name price brand');
      if (populated) responseOrder = populated;
    } catch {
      /* return saved order */
    }

    const data =
      responseOrder && typeof responseOrder.toObject === 'function'
        ? responseOrder.toObject({ virtuals: true })
        : { ...(responseOrder || {}) };

    if (pricingResult?.total != null) {
      data.finalPrice = pricingResult.total;
      data.originalTotal = pricingResult.total;
      data.productPrice = pricingResult.uniformUnit;
      const ds =
        data.directSale && typeof data.directSale === 'object' && !Array.isArray(data.directSale)
          ? { ...data.directSale }
          : {};
      ds.receiptGrandTotal = pricingResult.total;
      ds.soldUnitPrice = pricingResult.uniformUnit;
      data.directSale = ds;
    }

    return res.json({
      success: true,
      message: assignmentSkippedMessage
        ? `Receipt price updated. Shop assignment unchanged (${assignmentSkippedMessage})`
        : hasPricingPayload
          ? 'Receipt updated.'
          : 'Receipt assignment updated.',
      data,
    });
  } catch (error) {
    console.error('Error updating order receipt:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update order receipt',
      error: error.message,
    });
  }
}

// EXPORT ALL FUNCTIONS
module.exports = {
  createOrder,
  acceptOrder,
  rejectOrder,
  cancelOrder,
  deleteOrder,  
  getOrders,
  getOrderById,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  updateDeliveryInfo,
  updateOrderReceipt,
  getPendingDeliveryOrders,
  getLowStockOrders
};
