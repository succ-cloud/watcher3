const Subscription = require('../models/Subscription');
const User = require('../models/User');

class NotificationService {
  // Check for expiring subscriptions and send notifications
  async checkExpiringSubscriptions() {
    try {
      const now = new Date();
      const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const oneDayFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // Find subscriptions expiring soon
      const expiringSubscriptions = await Subscription.find({
        plan: { $in: ['business', 'enterprise'] },
        status: 'active',
        currentPeriodEnd: { 
          $gte: now, 
          $lte: sevenDaysFromNow 
        }
      }).populate('userId', 'email phone businessName');

      console.log(`Found ${expiringSubscriptions.length} subscriptions expiring soon`);

      for (const subscription of expiringSubscriptions) {
        const daysRemaining = Math.ceil((subscription.currentPeriodEnd - now) / (1000 * 60 * 60 * 24));
        
        let message = '';
        if (daysRemaining === 7) {
          message = `Your ${subscription.plan} plan expires in 7 days. Renew to keep your payment links active.`;
        } else if (daysRemaining === 3) {
          message = `Your ${subscription.plan} plan expires in 3 days. Renew now to avoid service interruption.`;
        } else if (daysRemaining === 1) {
          message = `Your ${subscription.plan} plan expires TOMORROW. Renew immediately to keep your payment links working.`;
        }

        if (message) {
          await this.sendExpiryNotification(subscription.userId, message, daysRemaining);
        }
      }

      return {
        checked: expiringSubscriptions.length,
        notificationsSent: expiringSubscriptions.length,
        timestamp: new Date()
      };
    } catch (error) {
      console.error('Error checking expiring subscriptions:', error);
      throw error;
    }
  }

  async sendExpiryNotification(user, message, daysRemaining) {
    // In a real application, you would:
    // 1. Send email
    // 2. Send push notification
    // 3. Send SMS
    // For now, we'll just log it
    
    console.log(`EXPIRY NOTIFICATION for ${user.email}: ${message}`);
    
    // You would integrate with your email service (SendGrid, etc.)
    // and SMS service (Twilio, etc.) here
    
    return {
      sent: true,
      userId: user._id,
      message,
      daysRemaining
    };
  }

  async sendDowngradeNotification(user, previousPlan, currentPlan) {
    const message = `Your subscription has been downgraded from ${previousPlan} to ${currentPlan}. Some features may be limited.`;
    
    console.log(`DOWNGRADE NOTIFICATION for ${user.email}: ${message}`);
    
    // Implement actual notification sending here
    
    return {
      sent: true,
      userId: user._id,
      message
    };
  }
}

module.exports = new NotificationService();