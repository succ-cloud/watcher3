// Import required models and utilities
const ProductLink = require('../models/ProductLink');
const Subscription = require('../models/Subscription');
const { generateShortCode, normalizePhoneNumber } = require('../utils/helpers');

// @desc    Generate a general link for business/enterprise users
// @route   POST /api/links/generate-general
// @access  Private
const generateGeneralLink = async (req, res) => {
  try {
    const { paymentMethods } = req.body;

    // Check user's subscription
    const subscription = await Subscription.findOne({ userId: req.user.id });
    
    if (!subscription || !subscription.isActive()) {
      return res.status(400).json({
        success: false,
        message: 'Active Business or Enterprise plan required to create general links'
      });
    }

    // Check if user already has a general link
    const existingGeneralLink = await ProductLink.findOne({
      userId: req.user.id,
      linkType: 'general'
    });

    if (existingGeneralLink) {
      return res.status(400).json({
        success: false,
        message: 'You already have a general link. Only one general link allowed per account.'
      });
    }

    // Check general link limit based on plan
    const planDetails = Subscription.getPlanDetails(subscription.plan);
    if (subscription.usage.generalLinksCreated >= planDetails.features.maxGeneralLinks) {
      return res.status(400).json({
        success: false,
        message: `Plan limit reached. Maximum ${planDetails.features.maxGeneralLinks} general links allowed.`
      });
    }

    // Generate unique short code for general link
    const shortCode = `general-${generateShortCode('store')}`;

    // Create the general link
    const generalLink = await ProductLink.create({
      userId: req.user.id,
      shortCode,
      linkType: 'general',
      productName: `${req.user.businessName} - General Shop`,
      productDescription: 'General payment link for your business',
      price: 0, // General links don't have fixed prices
      currency: 'USD',
      paymentMethods: paymentMethods || ['orange', 'mtn', 'card'],
      generatedLink: `${process.env.CLIENT_URL || 'http://localhost:3000'}/pay/${shortCode}`,
      isActive: true,
      isGeneralLink: true
    });

    // Update subscription usage
    subscription.usage.generalLinksCreated += 1;
    await subscription.save();

    res.status(201).json({
      success: true,
      data: generalLink,
      message: 'General payment link created successfully'
    });
  } catch (error) {
    console.error('Generate general link error:', error);
    res.status(500).json({
      success: false,
      message: 'Error generating general payment link'
    });
  }
};

// @desc    Generate a product payment link
// @route   POST /api/links/generate-product
// @access  Private
const generateProductLink = async (req, res) => {
  try {
    const { productName, productDescription, price, currency = 'USD', paymentMethods } = req.body;

    // Validate required fields
    if (!productName || !price) {
      return res.status(400).json({
        success: false,
        message: 'Product name and price are required'
      });
    }

    // Check user's subscription
    const subscription = await Subscription.findOne({ userId: req.user.id });
    
    if (!subscription || !subscription.isActive()) {
      return res.status(400).json({
        success: false,
        message: 'Active Business or Enterprise plan required to create product links'
      });
    }

    // Check if user can create more product links
    const canCreateResult = subscription.canCreateProductLink();
    if (!canCreateResult.canCreate) {
      return res.status(400).json({
        success: false,
        message: canCreateResult.reason
      });
    }

    // Generate unique short code
    const shortCode = generateShortCode(productName);

    // Create the product link
    const productLink = await ProductLink.create({
      userId: req.user.id,
      shortCode,
      linkType: 'product',
      productName,
      productDescription: productDescription || '',
      price: parseFloat(price),
      currency,
      paymentMethods,
      generatedLink: `${process.env.CLIENT_URL || 'http://localhost:3000'}/pay/${shortCode}`,
      isActive: true,
      isGeneralLink: false
    });

    // Update subscription usage
    subscription.usage.productLinksCreated += 1;
    await subscription.save();

    res.status(201).json({
      success: true,
      data: productLink,
      message: 'Product payment link generated successfully'
    });
  } catch (error) {
    console.error('Generate product link error:', error);
    res.status(500).json({
      success: false,
      message: 'Error generating product payment link'
    });
  }
};

// Update the getMyPaymentLinks to handle both link types
const getMyPaymentLinks = async (req, res) => {
  try {
    const { page = 1, limit = 10, linkType, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    // Build query
    const query = { userId: req.user.id };
    if (linkType) {
      query.linkType = linkType;
    }

    // Parse pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build sort
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Get payment links
    const paymentLinks = await ProductLink.find(query)
      .sort(sort)
      .skip(skip)
      .limit(limitNum)
      .lean();

    // Get total count
    const total = await ProductLink.countDocuments(query);

    // Get link type counts
    const typeCounts = await ProductLink.aggregate([
      { $match: { userId: req.user.id } },
      { $group: { _id: '$linkType', count: { $sum: 1 } } }
    ]);

    const totalPages = Math.ceil(total / limitNum);

    res.json({
      success: true,
      data: {
        paymentLinks,
        pagination: {
          currentPage: pageNum,
          totalPages,
          totalItems: total,
          hasNextPage: pageNum < totalPages,
          hasPrevPage: pageNum > 1,
          itemsPerPage: limitNum
        },
        typeCounts: typeCounts.reduce((acc, curr) => {
          acc[curr._id] = curr.count;
          return acc;
        }, {})
      }
    });
  } catch (error) {
    console.error('Get payment links error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching payment links'
    });
  }
};

// Update other functions to handle link types...

module.exports = {
  generateGeneralLink,
  generateProductLink,
  getMyPaymentLinks,
  // ... other existing functions
};