const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

/** Login — POST only. GET hits here when someone opens /api/auth in a browser tab. */
router.get('/', (_req, res) => {
  res.status(405).json({
    success: false,
    message: 'Use POST /api/auth with JSON body { "name": "...", "password": "..." } to sign in.',
  });
});

router.post('/', authController.handleLogin);

module.exports = router;