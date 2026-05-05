const Cart = require('../models/Cart');
const Product = require('../models/ItemsList');

const MIN_BUY_QTY = 4;

function resolveUserId(req) {
  const u = req.user;
  return (
    req.userId ||
    u?.userId ||
    u?._id ||
    u?.id ||
    null
  );
}

function deriveLineKey(body) {
  if (body.lineKey) return String(body.lineKey).trim();
  const pid = body.productId;
  if (!pid) return null;
  const isOffer =
    String(body.orderType || '').toLowerCase() === 'offer' ||
    body.offeredPrice != null;
  if (isOffer) {
    const p = Number(body.offeredPrice);
    return `${String(pid)}::offer::${Number.isFinite(p) ? p : 0}`;
  }
  return `${String(pid)}::buy`;
}

/**
 * @desc    Get user's cart
 * @route   GET /api/cart
 * @access  Private
 */
const getCart = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User id missing from token' });
    }

    const cart = await Cart.getOrCreateCart(userId);
    const populatedCart = await Cart.findById(cart._id).populate(
      'items.productId',
      'product_name price images stock',
    );

    res.status(200).json({
      success: true,
      data: populatedCart.getCartSummary(),
    });
  } catch (error) {
    console.error('Get cart error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get cart',
      error: error.message,
    });
  }
};

/**
 * @desc    Add or merge cart line (persist before checkout)
 * @route   POST /api/cart/items
 * @access  Private
 */
const addToCart = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User id missing from token' });
    }

    const {
      productId,
      quantity = 1,
      offeredPrice = null,
      orderType: orderTypeRaw,
      isPreorder = false,
      customProduct = null,
      notes = null,
    } = req.body;

    const lineKey = deriveLineKey(req.body);
    if (!lineKey) {
      return res.status(400).json({
        success: false,
        message: 'lineKey or productId is required',
      });
    }

    const orderType =
      String(orderTypeRaw || '').toLowerCase() === 'offer' || offeredPrice != null
        ? 'offer'
        : 'buy';

    let itemData = {};

    if (productId) {
      const product = await Product.findById(productId);
      if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }

      const qty = Math.max(1, Math.floor(Number(quantity) || 1));
      const stock = Number(product.stock) || 0;

      if (!isPreorder && orderType === 'buy' && stock > 0 && stock < qty) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock. Available: ${stock}`,
          availableStock: stock,
        });
      }

      const imgs = Array.isArray(product.images) ? product.images : [];
      itemData = {
        lineKey,
        orderType,
        productId: product._id,
        productName: product.product_name,
        productPrice: Number(product.price) || 0,
        quantity: qty,
        images: imgs.map((img) => ({
          url: img.url,
          publicId: img.publicId,
          isPrimary: img.isPrimary,
        })),
        offeredPrice:
          orderType === 'offer' && offeredPrice != null ? Number(offeredPrice) : null,
        isPreorder: !!isPreorder,
        notes: notes || null,
      };
    } else if (customProduct) {
      itemData = {
        lineKey,
        orderType: 'buy',
        productName: customProduct.name,
        productPrice: Number(customProduct.targetPriceMin) || 0,
        quantity: Math.max(1, Math.floor(Number(quantity) || 1)),
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
          size: customProduct.size,
        },
        notes: notes || customProduct.notes || null,
      };
    } else {
      return res.status(400).json({
        success: false,
        message: 'Either productId or custom product details are required',
      });
    }

    if (itemData.orderType === 'buy' && !itemData.isPreorder && itemData.quantity < MIN_BUY_QTY) {
      return res.status(400).json({
        success: false,
        message: `Buy lines require at least ${MIN_BUY_QTY} units`,
      });
    }

    const cart = await Cart.getOrCreateCart(userId);
    await cart.addItem(itemData);

    const updatedCart = await Cart.findById(cart._id).populate(
      'items.productId',
      'product_name price images stock',
    );

    res.status(200).json({
      success: true,
      message: 'Item added to cart successfully',
      data: updatedCart.getCartSummary(),
    });
  } catch (error) {
    console.error('Add to cart error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add item to cart',
      error: error.message,
    });
  }
};

/**
 * @desc    Set quantity for a line (0 removes)
 * @route   PUT /api/cart/items
 * @body    { lineKey, quantity }
 * @access  Private
 */
const updateCartItem = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User id missing from token' });
    }

    const lineKey = String(req.body.lineKey || '').trim();
    const { quantity } = req.body;

    if (!lineKey) {
      return res.status(400).json({ success: false, message: 'lineKey is required' });
    }
    if (quantity === undefined || quantity === null) {
      return res.status(400).json({ success: false, message: 'quantity is required' });
    }

    const cart = await Cart.getOrCreateCart(userId);
    const q = Number(quantity);
    const existing = cart.items.find((i) => String(i.lineKey) === lineKey);
    if (
      existing &&
      String(existing.orderType || 'buy') === 'buy' &&
      !existing.isPreorder &&
      Number.isFinite(q) &&
      q > 0 &&
      q < MIN_BUY_QTY
    ) {
      return res.status(400).json({
        success: false,
        message: `Buy lines require at least ${MIN_BUY_QTY} units`,
      });
    }

    await cart.updateItemQuantity(lineKey, quantity);

    const updatedCart = await Cart.findById(cart._id).populate(
      'items.productId',
      'product_name price images stock',
    );

    res.status(200).json({
      success: true,
      message: Number(quantity) <= 0 ? 'Item removed from cart' : 'Cart updated successfully',
      data: updatedCart.getCartSummary(),
    });
  } catch (error) {
    console.error('Update cart item error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update cart',
      error: error.message,
    });
  }
};

/**
 * @desc    Remove one line
 * @route   DELETE /api/cart/items
 * @body    { lineKey }
 * @access  Private
 */
const removeCartItem = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User id missing from token' });
    }

    const lineKey = String(req.body.lineKey || req.query.lineKey || '').trim();
    if (!lineKey) {
      return res.status(400).json({ success: false, message: 'lineKey is required' });
    }

    const cart = await Cart.getOrCreateCart(userId);
    await cart.removeItem(lineKey);

    const updatedCart = await Cart.findById(cart._id).populate(
      'items.productId',
      'product_name price images stock',
    );

    res.status(200).json({
      success: true,
      message: 'Item removed from cart',
      data: updatedCart.getCartSummary(),
    });
  } catch (error) {
    console.error('Remove cart item error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove item from cart',
      error: error.message,
    });
  }
};

/**
 * @desc    Clear entire cart (e.g. after successful checkout)
 * @route   DELETE /api/cart
 * @access  Private
 */
const clearCart = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User id missing from token' });
    }

    const cart = await Cart.findOne({ userId });
    if (cart) {
      await cart.clearCart();
    }

    res.status(200).json({
      success: true,
      message: 'Cart cleared successfully',
      data: { items: [], summary: { totalItems: 0, totalAmount: 0 } },
    });
  } catch (error) {
    console.error('Clear cart error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to clear cart',
      error: error.message,
    });
  }
};

const updateDeliveryInfo = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User id missing from token' });
    }

    const { deliveryAddress, specialInstructions, contactPhone } = req.body;
    const cart = await Cart.getOrCreateCart(userId);

    if (deliveryAddress) cart.deliveryInfo.deliveryAddress = deliveryAddress;
    if (specialInstructions) cart.deliveryInfo.specialInstructions = specialInstructions;
    if (contactPhone) cart.deliveryInfo.contactPhone = contactPhone;

    await cart.save();

    res.status(200).json({
      success: true,
      message: 'Delivery information updated',
      data: cart.deliveryInfo,
    });
  } catch (error) {
    console.error('Update delivery info error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update delivery information',
      error: error.message,
    });
  }
};

const getCartSummary = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User id missing from token' });
    }

    const cart = await Cart.getOrCreateCart(userId);
    const populatedCart = await Cart.findById(cart._id).populate(
      'items.productId',
      'product_name price images stock',
    );

    res.status(200).json({
      success: true,
      data: {
        items: populatedCart.items.map((item) => ({
          lineKey: item.lineKey,
          orderType: item.orderType,
          productId: item.productId?._id || item.productId,
          productName: item.productName,
          productPrice: item.productPrice,
          quantity: item.quantity,
          offeredPrice: item.offeredPrice,
          isPreorder: item.isPreorder,
          customProduct: item.customProduct,
          notes: item.notes,
          subtotal:
            (String(item.orderType || 'buy') === 'offer' && item.offeredPrice != null
              ? Number(item.offeredPrice)
              : Number(item.productPrice)) * item.quantity,
        })),
        summary: populatedCart.summary,
        deliveryInfo: populatedCart.deliveryInfo,
        totalAmount: populatedCart.summary.totalAmount,
      },
    });
  } catch (error) {
    console.error('Get cart summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get cart summary',
      error: error.message,
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
  getCartSummary,
};
