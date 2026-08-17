require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const uri = String(process.env.MONGODB_URI || '').trim();
if (!uri) {
  console.error('MONGODB_URI is not set in server/.env');
  process.exit(1);
}

const safe = uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
console.log('Testing:', safe);
if (uri !== String(process.env.MONGODB_URI || '')) {
  console.warn('Warning: MONGODB_URI had leading/trailing spaces — trim the line in .env (no space after =)');
}

mongoose
  .connect(uri, { serverSelectionTimeoutMS: 20000 })
  .then(() => {
    console.log('SUCCESS — connected to', mongoose.connection.host);
    console.log('Database name:', mongoose.connection.name);
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAILED —', err.name);
    console.error(err.message);
    process.exit(1);
  });
