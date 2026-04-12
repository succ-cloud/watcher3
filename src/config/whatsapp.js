require('dotenv').config();

const whatsappConfig = {
  // WhatsApp Cloud API Configuration
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
  apiVersion: process.env.WHATSAPP_API_VERSION || 'v17.0',
  baseUrl: 'https://graph.facebook.com',
  
  // Enable/disable WhatsApp notifications
  enabled: process.env.ENABLE_WHATSAPP === 'true',
  
  // Note: ADMIN_WHATSAPP_NUMBER and SALESMAN_WHATSAPP_NUMBER are no longer needed
  // because admins and salesmen are fetched from the database based on:
  // - role: 'admin' or 'salesman'
  // - accountStatus: 'active'
  // - For salesmen: businessAddress matching the order's businessAddress
};

module.exports = whatsappConfig;