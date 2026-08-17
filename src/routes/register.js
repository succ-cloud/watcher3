const express = require('express');
const router = express.Router()
const registerControl= require('../controllers/registerController');

router.post('/' , registerControl.handleNewUser);
 
module.exports=router;