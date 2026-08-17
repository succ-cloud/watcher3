const Subscription = require('../models/Subscription');
const User = require('../models/User');

// Service to check for expired subscriptions and auto-downgrade
class SubscriptionService {
  // Check all subscriptions for expiration and downgrade if needed
  async checkExpiredSubscriptions() {
    try {
      const now = new Date();
      
      // Find all active paid subscriptions that have expired
      const expiredSubscriptions = await Subscription.find({
        plan: { $in: ['business', 'enterprise'] },
        status: 'active',
        currentPeriodEnd: { $lt: now }
      });

      console.log(`Found ${expiredSubscriptions.length} expired subscriptions to downgrade`);

      let downgradedCount = 0;

      for (const subscription of expiredSubscriptions) {
        try {
          const result = await subscription.checkAndHandleExpiration();
          if (result.downgraded) {
            downgradedCount++;
            console.log(`Auto-downgraded subscription for user ${subscription.userId}`);
          }
        } catch (error) {
          console.error(`Error downgrading subscription for user ${subscription.userId}:`, error);
        }
      }

      return {
        checked: expiredSubscriptions.length,
        downgraded: downgradedCount,
        timestamp: new Date()
      };
    } catch (error) {
      console.error('Error checking expired subscriptions:', error);
      throw error;
    }
  }

  // Get subscription statistics
  async getSubscriptionStats() {
    const stats = await Subscription.aggregate([
      {
        $group: {
          _id: '$plan',
          count: { $sum: 1 },
          active: {
            $sum: {
              $cond: [
                { 
                  $and: [
                    { $eq: ['$status', 'active'] },
                    { $gt: ['$currentPeriodEnd', new Date()] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    return stats;
  }
}

module.exports = new SubscriptionService();