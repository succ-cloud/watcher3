const Cart = require('../models/Cart');
const Product = require('../models/ItemsList');
const User = require('../models/User');

/**
 * @desc    Get user's cart
 * @route   GET /api/cart
 * @access  Private
 */
const getCart = async (req, res) => {
  try {
    const userId = req.user._id || req.userId;
    
    const cart = await Cart.getOrCreateCart(userId);
    const populatedCart = await Cart.findById(cart._id)
      .populate('items.productId', 'product_name price images stock');
    
    const cartSummary = populatedCart.getCartSummary();
    
    res.status(200).json({
      success: true,
      data: cartSummary
    });
  } catch (error) {
    console.error('Get cart error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get cart',
      error: error.message
    });
  }
};

/**
 * @desc    Add item to cart
 * @route   POST /api/cart/items
 * @access  Private
 */
const addToCart = async (req, res) => {
  try {
    const userId = req.user._id || req.userId;
    const {
      productId,
      quantity = 1,
      offeredPrice = null,
      isPreorder = false,
      customProduct = null,
      notes = null
    } = req.body;
    
    if (!productId && !customProduct) {
      return res.status(400).json({
        success: false,
        message: 'Either productId or custom product details are required'
      });
    }
    
    let product = null;
    let itemData = {};
    
    // Handle catalog product
    if (productId) {
      product = await Product.findById(productId);
      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }
      
      // Check stock availability (only for buy orders)
      if (!isPreorder && !offeredPrice && product.stock < quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock. Available: ${product.stock}`,
          availableStock: product.stock
        });
      }
      
      itemData = {
        productId: product._id,
        productName: product.product_name,
        productPrice: product.price,
        quantity: Number(quantity),
        images: product.images.map(img => ({
          url: img.url,
          publicId: img.publicId,
          isPrimary: img.isPrimary
        })),
        offeredPrice: offeredPrice || null,
        isPreorder: isPreorder || false,
        notes: notes || null
      };
    }
    
    // Handle custom product (preorder)
    if (customProduct) {
      itemData = {
        productId: null,
        productName: customProduct.name,
        productPrice: customProduct.targetPriceMin || 0,
        quantity: Number(quantity),
        images: [],
        offeredPrice: null,
        isPreorder: true,
        customProduct: {
          name: customProduct.name,
          description: customProduct.description,
          specifications: customProduct.specifications,
          targetPriceMin: customProduct.targetPriceMin,
          targetPriceMax: customProduct.targetPriceMax,
          color: customProduct.color,
          size: customProduct.size
        },
        notes: notes || customProduct.notes || null
      };
    }
    
    const cart = await Cart.getOrCreateCart(userId);
    await cart.addItem(itemData);
    
    const updatedCart = await Cart.findById(cart._id)
      .populate('items.productId', 'product_name price images stock');
    
    res.status(200).json({
      success: true,
      message: 'Item added to cart successfully',
      data: updatedCart.getCartSummary()
    });
  } catch (error) {
    console.error('Add to cart error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add item to cart',
      error: error.message
    });
  }
};

/**
 * @desc    Update cart item quantity
 * @route   PUT /api/cart/items/:productId
 * @access  Private
 */
const updateCartItem = async (req, res) => {
  try {
    const userId = req.user._id || req.userId;
    const { productId } = req.params;
    const { quantity } = req.body;
    
    if (!productId) {
      return res.status(400).json({
        success: false,
        message: 'Product ID is required'
      });
    }
    
    if (quantity === undefined || quantity < 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid quantity is required'
      });
    }
    
    const cart = await Cart.getOrCreateCart(userId);
    await cart.updateItemQuantity(productId, quantity);
    
    const updatedCart = await Cart.findById(cart._id)
      .populate('items.productId', 'product_name price images stock');
    
    res.status(200).json({
      success: true,
      message: quantity === 0 ? 'Item removed from cart' : 'Cart updated successfully',
      data: updatedCart.getCartSummary()
    });
  } catch (error) {
    console.error('Update cart item error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update cart',
      error: error.message
    });
  }
};

/**
 * @desc    Remove item from cart
 * @route   DELETE /api/cart/items/:productId
 * @access  Private
 */
const removeCartItem = async (req, res) => {
  try {
    const userId = req.user._id || req.userId;
    const { productId } = req.params;
    
    if (!productId) {
      return res.status(400).json({
        success: false,
        message: 'Product ID is required'
      });
    }
    
    const cart = await Cart.getOrCreateCart(userId);
    await cart.removeItem(productId);
    
    const updatedCart = await Cart.findById(cart._id)
      .populate('items.productId', 'product_name price images stock');
    
    res.status(200).json({
      success: true,
      message: 'Item removed from cart',
      data: updatedCart.getCartSummary()
    });
  } catch (error) {
    console.error('Remove cart item error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove item from cart',
      error: error.message
    });
  }
};

/**
 * @desc    Clear entire cart
 * @route   DELETE /api/cart
 * @access  Private
 */
const clearCart = async (req, res) => {
  try {
    const userId = req.user._id || req.userId;
    
    const cart = await Cart.findOne({ userId, status: 'active' });
    if (cart) {
      await cart.clearCart();
    }
    
    res.status(200).json({
      success: true,
      message: 'Cart cleared successfully',
      data: { items: [], summary: { totalItems: 0, totalAmount: 0 } }
    });
  } catch (error) {
    console.error('Clear cart error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to clear cart',
      error: error.message
    });
  }
};

/**
 * @desc    Update delivery information
 * @route   PUT /api/cart/delivery-info
 * @access  Private
 */
const updateDeliveryInfo = async (req, res) => {
  try {
    const userId = req.user._id || req.userId;
    const { deliveryAddress, specialInstructions, contactPhone } = req.body;
    
    const cart = await Cart.getOrCreateCart(userId);
    
    if (deliveryAddress) cart.deliveryInfo.deliveryAddress = deliveryAddress;
    if (specialInstructions) cart.deliveryInfo.specialInstructions = specialInstructions;
    if (contactPhone) cart.deliveryInfo.contactPhone = contactPhone;
    
    await cart.save();
    
    res.status(200).json({
      success: true,
      message: 'Delivery information updated',
      data: cart.deliveryInfo
    });
  } catch (error) {
    console.error('Update delivery info error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update delivery information',
      error: error.message
    });
  }
};

/**
 * @desc    Get cart summary (for checkout)
 * @route   GET /api/cart/summary
 * @access  Private
 */
const getCartSummary = async (req, res) => {
  try {
    const userId = req.user._id || req.userId;
    
    const cart = await Cart.getOrCreateCart(userId);
    const populatedCart = await Cart.findById(cart._id)
      .populate('items.productId', 'product_name price images stock');
    
    res.status(200).json({
      success: true,
      data: {
        items: populatedCart.items.map(item => ({
          productId: item.productId?._id || item.productId,
          productName: item.productName,
          productPrice: item.productPrice,
          quantity: item.quantity,
          offeredPrice: item.offeredPrice,
          isPreorder: item.isPreorder,
          customProduct: item.customProduct,
          notes: item.notes,
          subtotal: (item.offeredPrice || item.productPrice) * item.quantity
        })),
        summary: populatedCart.summary,
        deliveryInfo: populatedCart.deliveryInfo,
        totalAmount: populatedCart.summary.totalAmount
      }
    });
  } catch (error) {
    console.error('Get cart summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get cart summary',
      error: error.message
    });
  }
};

module.exports = {
  getCart,
  addToCart,
  updateCartItem,
  removeCartItem,
  clearCart,
  updateDeliveryInfo,
  getCartSummary
};