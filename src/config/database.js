// Import mongoose - this is our database library
const mongoose = require('mongoose');
const { scheduleOrderCodeBackfill } = require('../utils/orderDisplayCode');

// Function to connect to MongoDB
const connectDB = async () => {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) {
    console.error('MONGODB_URI is missing in server/.env');
    process.exit(1);
  }
  try {
    const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    scheduleOrderCodeBackfill();
  } catch (error) {
    const msg = String(error.message || error);
    console.error('Database connection error:', msg);
    if (msg.includes('querySrv ECONNREFUSED') || msg.includes('ECONNREFUSED')) {
      console.error('\n⛔ Cannot reach MongoDB (DNS or network block — not an IP whitelist issue).');
      console.error('   Try:');
      console.error('   1. Atlas → Connect → Drivers → copy the STANDARD connection string (not mongodb+srv)');
      console.error('      and replace MONGODB_URI in server/.env');
      console.error('   2. Windows Settings → Network → DNS → use 8.8.8.8 and 1.1.1.1');
      console.error('   3. Try a phone hotspot, or disable VPN/firewall temporarily');
      console.error('   4. Confirm 0.0.0.0/0 is on the SAME Atlas project as cluster0.0ngrrfn\n');
    } else if (msg.includes('whitelist') || error.name === 'MongooseServerSelectionError') {
      console.error('\n⛔ MongoDB Atlas blocked this connection.');
      console.error('   Fix: https://cloud.mongodb.com → Network Access → Add IP Address');
      console.error('   • Use 0.0.0.0/0 for development, wait 1–2 minutes, then retry\n');
    }
    process.exit(1);
  }
};

// Export the function so we can use it in server.js
module.exports = connectDB;