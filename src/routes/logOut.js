const express = require('express');
const router = express.Router()
const logoutcontrollerr= require('../controllers/logoutController');

router.get('/', logoutcontrollerr.handelLogout);
 
module.exports=router;