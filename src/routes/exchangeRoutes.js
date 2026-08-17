const express = require('express');
const verifyJWT = require('../middleware/verifyJWT');
const verifyRole = require('../middleware/verifyRole');
const { ROLES } = require('../models/User');
const {
  getSalesByMonth,
  getSalesByPhoneName,
  checkExchangeIme,
  processExchange,
} = require('../controllers/exchangeController');

const router = express.Router();

router.use(verifyJWT);
router.use(verifyRole(ROLES.ADMIN));

router.get('/sales-by-month', getSalesByMonth);
router.get('/sales-by-phone-name', getSalesByPhoneName);
router.get('/check-ime', checkExchangeIme);
router.post('/process-exchange', processExchange);

module.exports = router;
