const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
require('dotenv').config();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure storage for product images
const productStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'products',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    transformation: [{ width: 1000, height: 1000, crop: 'limit' }],
    format: 'jpg'
  }
});

// Configure storage for temporary uploads (if needed)
const tempStorage = multer.memoryStorage();

// File filter — accept common image types; many browsers use `blob` (no extension) or octet-stream
const fileFilter = (req, file, cb) => {
  const name = String(file.originalname || '').toLowerCase();
  const rawMime = String(file.mimetype || '').toLowerCase();
  const mime = rawMime.split(';')[0].trim();

  const extOk = /\.(jpe?g|png|gif|webp)$/i.test(name);
  const mimeOk =
    /^image\/(jpeg|pjpeg|png|gif|webp)$/i.test(mime) ||
    mime === 'image/jpg' ||
    mime === 'image/x-png' ||
    mime === 'image/apng';
  const octetOk = mime === 'application/octet-stream' && extOk;

  if (mimeOk || extOk || octetOk) {
    return cb(null, true);
  }
  cb(
    new Error(
      'Only image files are allowed (JPEG, PNG, GIF, WebP). If your file is valid, try renaming it to end in .jpg, .png, or .webp.',
    ),
  );
};

// Create multer upload instances
const uploadProductImages = multer({
  storage: productStorage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

const uploadMemory = multer({
  storage: tempStorage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

module.exports = {
  cloudinary,
  uploadProductImages,
  uploadMemory
};
