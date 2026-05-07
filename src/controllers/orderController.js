const mongoose = require('mongoose');
const { Order, ORDER_TYPES, ORDER_STATUS, NOTIFICATION_AUDIENCE, PRODUCT_SOURCE } = require('../models/Order');
const { Notification, NOTIFICATION_TYPES } = require('../models/Notification');
const Product = require('../models/ItemsList');
const User = require('../models/User');
const Cart = require('../models/Cart');
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
    
    const orderData = {
      userId: user._id,
      businessName: user.businessName,
      businessAddress: user.businessAddress,
      tel: user.tel,
      whatsappNumber: user.whatsappNumber,
      productId: productId || placeholderProductId,
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
    
    if (orderType === ORDER_TYPES.PREORDER && preorderInfoData?.expectedDeliveryDate) {
      orderData.deliveryInfo.estimatedDeliveryDate = preorderInfoData.expectedDeliveryDate;
    }
    
    const order = await Order.create([orderData], { session });
    const createdOrder = order[0];
    
    console.log(`✅ Order created successfully: ${createdOrder._id}`);
    console.log(`   - Type: ${orderType}`);
    console.log(`   - Product source: ${isCustom ? 'Custom' : 'Catalog'}`);
    console.log(`   - Quantity: ${qty}`);
    
    await createOrderNotification(createdOrder, NOTIFICATION_TYPES.ORDER_SUBMITTED);
    
    if (orderType === ORDER_TYPES.BUY && product) {
      product.stock -= qty;
      await product.save({ session });
      console.log(`📦 Stock reduced for product ${product.product_name}: ${product.stock} remaining`);
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
        const salesman = await User.findOne({
          role: 'salesman',
          accountStatus: 'active',
          businessAddress: { $regex: new RegExp(businessAddressForQueue, 'i') }
        }).select('_id name businessAddress whatsappNumber');
        
        if (salesman && salesman.whatsappNumber) {
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
      deliveryNotes
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
    
    if ((order.orderType === ORDER_TYPES.OFFER || order.orderType === ORDER_TYPES.PREORDER) && staff.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can accept offer or preorder requests'
      });
    }
    
    let product = null;
    let stockUpdateInfo = null;

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
    
    let finalPriceToUse = finalPrice;
    
    if (order.isCustomProduct && !finalPriceToUse) {
      if (order.customProduct?.targetPriceMin) {
        finalPriceToUse = order.customProduct.targetPriceMin;
        console.log(`⚠️ No final price provided for custom preorder, using minimum target price: ${finalPriceToUse}`);
      } else {
        console.log(`⚠️ No final price provided for custom preorder, admin should update price later`);
      }
    }
    
    await order.accept(handledById, finalPriceToUse, Object.keys(deliveryData).length > 0 ? deliveryData : null);
    
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
    
    const formattedOrders = orders.map(order => {
      const orderObj = order.toObject();
      return {
        ...orderObj,
        businessAddress: orderObj.businessAddress,
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
  getPendingDeliveryOrders,
  getLowStockOrders
};
