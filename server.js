// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const connectDB = require('./src/config/database');
const errorHandler = require('./src/middleware/errorHandler');
const { sendResponse } = require('./src/utils/helpers');
const corsOptions = require('./src/config/corsOptions'); // Make sure path is correct
const verifyJWT = require('./src/middleware/verifyJWT');
const credentials = require('./src/middleware/credentials'); // Import credentials middleware
const { logger } = require('./src/middleware/logEvent');

const PORT = process.env.PORT || 5000;
const app = express();

// Parse bodies first — before any route or logger that might confuse debugging.
// JSON routes require header: Content-Type: application/json
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

connectDB();

app.use(logger);

// Handle options credentials check - BEFORE CORS!
app.use(credentials);

// CORS middleware
app.use(cors(corsOptions));

app.use(cookieParser());

app.use((req, res, next) => {
  console.log('\n🔍 REQUEST DEBUG:');
  console.log('  Method:', req.method);
  console.log('  URL:', req.url);
  console.log('  Content-Type:', req.headers['content-type']);
  console.log('  Body:', req.body);
  console.log('  Raw Body?', req.headers['content-type'] === 'application/json' ? 'Should parse' : 'Not JSON');
  next();
});


// ==================== ROUTES ====================
app.use('/api/auth', require('./src/routes/authRoutes'));
app.use('/api/register', require('./src/routes/register'));
app.use('/api/logout', require('./src/routes/logOut'));
app.use('/api/refresh', require('./src/routes/refresh'));
// Admin routes
app.use('/api/admin', require('./src/routes/adminRoutes'));


// Protect product routes with JWT
// app.use(verifyJWT);
app.use('/api', require('./src/routes/odersRoutes'));
app.use('/api', require('./src/routes/itemsRoutes'));



// Root route
app.get('/', (req, res) => {
  sendResponse(res, 200, true, 'Product Management API', {
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    documentation: '/api-docs',
    endpoints: {
      auth: {
        register: 'POST /api/auth/register',
        login: 'POST /api/auth/login',
        refreshToken: 'POST /api/auth/refresh-token',
        logout: 'POST /api/auth/logout',
        me: 'GET /api/auth/me',
        changePassword: 'POST /api/auth/change-password',
        forgotPassword: 'POST /api/auth/forgot-password',
        resetPassword: 'POST /api/auth/reset-password'
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
        bulkCreate: 'POST /api/products/bulk',
        stock: 'PATCH /api/products/:id/stock',
        images: {
          add: 'POST /api/products/:id/images',
          delete: 'DELETE /api/products/:id/images/:publicId',
          setPrimary: 'PATCH /api/products/:id/images/:publicId/primary',
          getAll: 'GET /api/products/:id/images'
        }
      },
      health: 'GET /health'
    }
  });
});

// Health check endpoint with detailed status
app.get('/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };

  res.status(200).json({
    success: true,
    message: 'Server is healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    database: {
      status: dbStatus[dbState] || 'unknown',
      state: dbState,
      name: mongoose.connection.name,
      host: mongoose.connection.host
    },
    memory: process.memoryUsage(),
    services: {
      auth: '✅',
      products: '✅',
      images: '✅'
    }
  });
});

// API test route (for development)
if (process.env.NODE_ENV === 'development') {
  app.get('/api/test', (req, res) => {
    sendResponse(res, 200, true, 'API is working', {
      timestamp: new Date().toISOString(),
      headers: req.headers,
      query: req.query,
      body: req.body
    });
  });
}

// 404 handler for undefined routes
// app.use('*', (req, res) => {
//   sendResponse(res, 404, false, `Route ${req.method} ${req.originalUrl} not found`, null, {
//     method: req.method,
//     path: req.originalUrl,
//     availableEndpoints: {
//       auth: '/api/auth',
//       products: '/api/products',
//       health: '/health'
//     }
//   });
// });

// Error handling middleware (should be last)
app.use(errorHandler);

// Graceful shutdown handler
const gracefulShutdown = async (signal) => {
  console.log(`\n👋 ${signal} received. Closing server gracefully...`);
  
  try {
    await mongoose.connection.close(false);
    console.log('✅ MongoDB connection closed');
    
    server.close(() => {
      console.log('✅ HTTP server closed');
      process.exit(0);
    });
  } catch (error) {
    console.error('❌ Error during graceful shutdown:', error);
    process.exit(1);
  }
};

// Start server when MongoDB is connected
let server;
mongoose.connection.once('open', () => {
  console.log('✅ Connected to MongoDB');
  
  server = app.listen(PORT, () => {
    console.log('\n=================================');
   
  
    console.log('=================================\n');
  });

  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use`);
      process.exit(1);
    }
  });
});

// Handle MongoDB connection events
mongoose.connection.on('connected', () => {
  console.log('✅ MongoDB connected');
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err.message);
  if (err.message.includes('ECONNREFUSED')) {
    console.error('⚠️ Make sure MongoDB is running');
  }
});

// Handle process termination
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('❌ UNHANDLED REJECTION! Shutting down...');
  console.error('Error:', err);
  console.error('Stack:', err.stack);
  
  if (server) {
    server.close(() => {
      console.log('HTTP server closed due to unhandled rejection');
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION! Shutting down...');
  console.error('Error:', err);
  console.error('Stack:', err.stack);
  process.exit(1);
});

// Export app for testing
module.exports = app;
