// Import mongoose to create our database schema
const mongoose = require('mongoose');

// Define the Subscription schema
const SubscriptionSchema = new mongoose.Schema({
  // Link to the user who owns this subscription
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Reference to User model
    required: [true, 'User ID is required'],
    unique: true, // Each user can have only one active subscription
  },

  // Subscription plan details
  plan: {
    type: String,
    enum: ['starter', 'business', 'enterprise'], // Only these plans allowed
    required: [true, 'Plan type is required'],
    default: 'starter',
  },

  // Pricing information
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: 0, // Price can't be negative
  },

  currency: {
    type: String,
    enum: ['XAF'], // Supported currencies
    default: 'XAF',
  },

  // Billing cycle
  billingCycle: {
    type: String,
    enum: ['monthly', 'yearly'],
    default: 'monthly',
  },

  // Subscription status
  status: {
    type: String,
    enum: ['active', 'inactive', 'canceled', 'expired', 'pending'],
    default: 'inactive',
  },

  // Subscription periods
  currentPeriodStart: {
    type: Date,
    required: true,
    default: Date.now,
  },

  currentPeriodEnd: {
    type: Date,
    required: true,
  },

  // Track when subscription was canceled
  canceledAt: {
    type: Date,
  },

  // Will the subscription renew automatically?
  cancelAtPeriodEnd: {
    type: Boolean,
    default: false, // By default, subscriptions auto-renew
  },

  // Payment method used for this subscription
  paymentMethod: {
    type: String,
    enum: ['orange', 'mtn', 'card', 'free'],
    default: 'free',
  },

  // Reference to the payment transaction
  paymentTransactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
  },

  // Features included in this plan (for easy access)
  features: {
    maxProductLinks: {
      type: Number,
      required: true,
      default: 10, // Starter plan default
    },
    availablePaymentMethods: [{
      type: String,
      enum: ['orange', 'mtn', 'card'],
    }],
    hasAnalytics: {
      type: Boolean,
      default: false,
    },
    hasPrioritySupport: {
      type: Boolean,
      default: false,
    },
    canCreateCustomLinks: {
      type: Boolean,
      default: false,
    },
  },

  // Track usage for this billing period
  usage: {
    productLinksCreated: {
      type: Number,
      default: 0,
    },
    transactionsThisMonth: {
      type: Number,
      default: 0,
    },
    revenueThisMonth: {
      type: Number,
      default: 0,
    },
    lastResetDate: {
      type: Date,
      default: Date.now,
    },
  },

  // Audit fields
  createdAt: {
    type: Date,
    default: Date.now,
  },

  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Update the updatedAt field before saving
SubscriptionSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

// Static method to get plan details
SubscriptionSchema.statics.getPlanDetails = function (planName) {
  const plans = {
    starter: {
      name: 'starter',
      price: 0,
      billingCycle: 'monthly',
      features: {
        maxProductLinks: 10,
        availablePaymentMethods: ['orange', 'mtn'],
        hasAnalytics: false,
        hasPrioritySupport: false,
        canCreateCustomLinks: false,
      }
    },
    business: {
      name: 'business',
      price: 9.99,
      billingCycle: 'monthly',
      features: {
        maxProductLinks: 50,
        availablePaymentMethods: ['orange', 'mtn', 'card'],
        hasAnalytics: true,
        hasPrioritySupport: false,
        canCreateCustomLinks: true,
      }
    },
    enterprise: {
      name: 'enterprise',
      price: 29.99,
      billingCycle: 'monthly',
      features: {
        maxProductLinks: -1, // -1 means unlimited
        availablePaymentMethods: ['orange', 'mtn', 'card'],
        hasAnalytics: true,
        hasPrioritySupport: true,
        canCreateCustomLinks: true,
      }
    }
  };

  return plans[planName] || plans.starter;
};



// Enhanced method to check and handle subscription expiration with link management
SubscriptionSchema.methods.checkAndHandleExpiration = async function() {
  const now = new Date();
  const twoDaysAfterExpiry = new Date(this.currentPeriodEnd);
  twoDaysAfterExpiry.setDate(twoDaysAfterExpiry.getDate() + 2);
  
  // If subscription expired more than 2 days ago, deactivate all links
  if (this.status === 'active' && now > twoDaysAfterExpiry && this.plan !== 'starter') {
    console.log(`Deactivating all links for user ${this.userId} (plan expired 2+ days ago)`);
    
    // Deactivate all user's links
    await mongoose.model('ProductLink').updateMany(
      { userId: this.userId },
      { isActive: false }
    );
    
    // Store previous plan for reference
    const previousPlan = this.plan;
    
    // Downgrade to starter plan
    this.plan = 'starter';
    this.price = 0;
    this.currency = 'USD';
    this.status = 'expired';
    this.paymentMethod = 'free';
    this.features = Subscription.getPlanDetails('starter').features;
    
    // Reset usage
    this.usage.productLinksCreated = 0;
    this.usage.transactionsThisMonth = 0;
    this.usage.revenueThisMonth = 0;
    this.usage.lastResetDate = now;
    
    await this.save();
    
    // Update user's subscription info
    await mongoose.model('User').findByIdAndUpdate(this.userId, {
      'subscription.plan': 'starter',
      'subscription.status': 'expired',
    });
    
    return {
      downgraded: true,
      from: previousPlan,
      to: 'starter',
      linksDeactivated: true,
      message: `Automatically downgraded from ${previousPlan} to starter plan and deactivated all links`
    };
  }
  
  // If subscription just expired (within 2 days), just deactivate links but don't downgrade yet
  if (this.status === 'active' && now > this.currentPeriodEnd && now <= twoDaysAfterExpiry && this.plan !== 'starter') {
    console.log(`Deactivating links for user ${this.userId} (grace period)`);
    
    // Deactivate all user's links
    await mongoose.model('ProductLink').updateMany(
      { userId: this.userId },
      { isActive: false }
    );
    
    this.status = 'expired';
    await this.save();
    
    // Update user's subscription status
    await mongoose.model('User').findByIdAndUpdate(this.userId, {
      'subscription.status': 'expired',
    });
    
    return {
      downgraded: false,
      linksDeactivated: true,
      message: 'Subscription expired. Links deactivated. 2-day grace period before downgrade.'
    };
  }
  
  return { downgraded: false, linksDeactivated: false };
};

// Enhanced method to handle downgrade from enterprise to business
SubscriptionSchema.methods.handleEnterpriseToBusinessDowngrade = async function() {
  const ProductLink = mongoose.model('ProductLink');
  
  // Get user's links sorted by usage (most used first)
  const userLinks = await ProductLink.find({ 
    userId: this.userId,
    linkType: 'product'
  }).sort({ 
    successfulPayments: -1, 
    totalClicks: -1 
  });
  
  // Keep only the top 19 most used product links + general link
  const linksToKeep = userLinks.slice(0, 19);
  const linksToDeactivate = userLinks.slice(19);
  
  // Deactivate less-used links
  if (linksToDeactivate.length > 0) {
    const linkIdsToDeactivate = linksToDeactivate.map(link => link._id);
    await ProductLink.updateMany(
      { _id: { $in: linkIdsToDeactivate } },
      { isActive: false }
    );
  }
  
  // Ensure general link is active
  await ProductLink.updateOne(
    { userId: this.userId, linkType: 'general' },
    { isActive: true }
  );
  
  // Update subscription usage count
  this.usage.productLinksCreated = linksToKeep.length;
  
  return {
    keptLinks: linksToKeep.length,
    deactivatedLinks: linksToDeactivate.length,
    message: `Kept ${linksToKeep.length} most used product links and general link`
  };
};

// Update the isActive method to check expiration
SubscriptionSchema.methods.isActive = function () {
  const now = new Date();

  // If subscription is expired and it's a paid plan, it's not active
  if (now > this.currentPeriodEnd && this.plan !== 'starter') {
    return false;
  }

  return this.status === 'active' && now < this.currentPeriodEnd;
};

// ... rest of the existing methods ...
// Method to check if subscription is active
SubscriptionSchema.methods.isActive = function () {
  const now = new Date();
  return this.status === 'active' && now < this.currentPeriodEnd;
};

// Method to check if user can create more product links
SubscriptionSchema.methods.canCreateProductLink = function () {
  if (!this.isActive()) {
    return { canCreate: false, reason: 'Subscription is not active' };
  }

  // If maxProductLinks is -1, it means unlimited
  if (this.features.maxProductLinks === -1) {
    return { canCreate: true };
  }

  if (this.usage.productLinksCreated >= this.features.maxProductLinks) {
    return {
      canCreate: false,
      reason: `Plan limit reached. Maximum ${this.features.maxProductLinks} product links allowed.`
    };
  }

  return { canCreate: true };
};

// Method to upgrade subscription
SubscriptionSchema.methods.upgrade = function (newPlan) {
  const planDetails = this.constructor.getPlanDetails(newPlan);

  this.plan = newPlan;
  this.price = planDetails.price;
  this.features = planDetails.features;
  this.status = 'active';

  return this;
};

// Method to cancel subscription
SubscriptionSchema.methods.cancel = function () {
  this.cancelAtPeriodEnd = true;
  this.canceledAt = new Date();
  return this;
};

// Method to renew subscription
SubscriptionSchema.methods.renew = function () {
  if (this.cancelAtPeriodEnd) {
    throw new Error('Cannot renew a canceled subscription');
  }

  const now = new Date();
  const nextPeriod = new Date(this.currentPeriodEnd);

  // Add one month to the current period end
  nextPeriod.setMonth(nextPeriod.getMonth() + 1);

  this.currentPeriodStart = this.currentPeriodEnd;
  this.currentPeriodEnd = nextPeriod;
  this.status = 'active';

  // Reset usage for new billing period
  this.usage.productLinksCreated = 0;
  this.usage.transactionsThisMonth = 0;
  this.usage.revenueThisMonth = 0;
  this.usage.lastResetDate = now;

  return this;
};

// Method to check if subscription is about to expire (within 7 days)
SubscriptionSchema.methods.isExpiringSoon = function () {
  if (!this.isActive()) return false;

  const now = new Date();
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  return this.currentPeriodEnd <= sevenDaysFromNow;
};

// Method to get days remaining in subscription
SubscriptionSchema.methods.getDaysRemaining = function () {
  if (!this.isActive()) return 0;

  const now = new Date();
  const end = new Date(this.currentPeriodEnd);
  const diffTime = end - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return Math.max(0, diffDays);
};

// Create and export the Subscription model
module.exports = mongoose.model('Subscription', SubscriptionSchema);