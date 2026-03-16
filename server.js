// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const corsOptions = require('./src/config/allowedOrigins')
const helmet = require('helmet');
const morgan = require('morgan');
const mongoose = require('mongoose');
const connectDB = require('./src/config/database');
const PORT = process.env.PORT || 5000;

// Initialize Express
const app = express();

// Connect to MongoDB
connectDB();
app.use(cors(corsOptions))
// CORS configuration


// Middleware
app.use(helmet());
app.use(cors(corsOptions));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ==================== ROUTES ====================

// Auth Routes
app.use('/api/auth', require('./src/routes/authRoutes'));

// Product Routes - ADD THIS LINE
app.use('/api/products', require('./src/routes/itemsRoutes'));

// Root route

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Payment Card Platform API',
    version: '1.0.0',
    endpoints: {
      auth: {
        register: 'POST /api/auth/register',
        login: 'POST /api/auth/login',
        test: 'GET /api/auth/test'
      },
      products: {
        getAll: 'GET /api/products',
        getById: 'GET /api/products/:id',
        create: 'POST /api/products',
        update: 'PUT /api/products/:id',
        patch: 'PATCH /api/products/:id',
        delete: 'DELETE /api/products/:id',
        search: 'GET /api/products/search',
        advancedSearch: 'POST /api/products/advanced-search',
        bulkCreate: 'POST /api/products/bulk'
      }
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    database: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected',
    timestamp: new Date().toISOString(),
    services: {
      auth: '✅',
      products: '✅'
    }
  });
});

// 404 handler
// 

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.stack);
  
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal server error';
  
  res.status(statusCode).json({
    success: false,
    message: message,
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Start server when MongoDB is connected
mongoose.connection.once('open', () => {
  console.log('✅ Connected to MongoDB');
  app.listen(PORT, () => {
    console.log('\n=================================');
    console.log(`🚀 Server running on port ${PORT}`);
    console.log('=================================');
    console.log(`🌐 Base URL: http://localhost:${PORT}`);
    console.log(`🔐 Auth API: http://localhost:${PORT}/api/auth`);
    console.log(`📦 Products API: http://localhost:${PORT}/api/products`);
    console.log(`🩺 Health Check: http://localhost:${PORT}/health`);
    console.log('=================================\n');
    
    // Log all available product routes
    // console.log('📋 Available Product Routes:');
    // console.log('   GET    /api/products');
    // console.log('   GET    /api/products/:id');
    // console.log('   POST   /api/products');
    // console.log('   PUT    /api/products/:id');
    // console.log('   PATCH  /api/products/:id');
    // console.log('   DELETE /api/products/:id');
    // console.log('   GET    /api/products/search');
    // console.log('   POST   /api/products/advanced-search');
    // console.log('   POST   /api/products/bulk');
    // console.log('=================================\n');
  });
});

// Handle MongoDB connection errors
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err.message);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.log('❌ UNHANDLED REJECTION! Shutting down...');
  console.log(err.name, err.message);
  server.close(() => {
    process.exit(1);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.log('❌ UNCAUGHT EXCEPTION! Shutting down...');
  console.log(err.name, err.message);
  process.exit(1);
});