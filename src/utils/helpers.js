// Standard response format
const sendResponse = (res, statusCode, success, message, data = null, error = null) => {
  const response = {
    success,
    message,
    timestamp: new Date().toISOString()
  };

  if (data) response.data = data;
  if (error && process.env.NODE_ENV === 'development') response.error = error;

  return res.status(statusCode).json(response);
};

// Custom error class
class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Async wrapper to avoid try-catch blocks
const catchAsync = (fn) => {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
};

// Generate random string
const generateRandomString = (length = 6) => {
  return Math.random().toString(36).substring(2, 2 + length).toUpperCase();
};

// Format phone number
const formatPhoneNumber = (phone) => {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 9) {
    return `+237 ${cleaned.substring(0, 3)} ${cleaned.substring(3, 6)} ${cleaned.substring(6)}`;
  }
  return phone;
};

// Validate email
const isValidEmail = (email) => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
};

// Sanitize object (remove specified fields)
const sanitizeObject = (obj, fieldsToRemove) => {
  const sanitized = { ...obj };
  fieldsToRemove.forEach(field => delete sanitized[field]);
  return sanitized;
};

// Pagination helper
const getPagination = (page, limit, total) => {
  const currentPage = parseInt(page) || 1;
  const itemsPerPage = parseInt(limit) || 10;
  const totalPages = Math.ceil(total / itemsPerPage);
  const skip = (currentPage - 1) * itemsPerPage;

  return {
    currentPage,
    itemsPerPage,
    totalPages,
    total,
    skip,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1
  };
};

module.exports = {
  sendResponse,
  AppError,
  catchAsync,
  generateRandomString,
  formatPhoneNumber,
  isValidEmail,
  sanitizeObject,
  getPagination
};