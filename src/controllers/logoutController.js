const User = require('../models/User') 
const bcrypt = require('bcrypt');




// handeliing the logout rooute here

const handelLogout =async(req,res)=>{

    // onclient it also delete the accessT oken
    const cookies=req.cookies
    if(!cookies?.jwt)return res.status(204);//no content to send back

    const refreshToken= cookies.jwt

    // is refreshtoken in DB
    const foundUsers = await User.findOne({refreshToken}).exec();
    if(!foundUsers){ 
        res.clearCookie('jwt',{httpOnly:true, sameSite:'None',secure:true})
        return res.sendStatus(204);
    
    }
    
//    delete the refresh token in the database
     foundUsers.refreshToken ="";
     const result = await foundUsers.save()
     console.log(result); 

     res.clearCookie('jwt',{httpOnly:true, sameSite:'None',secure:true});//
     res.sendStatus(204);
   
}
module.exports={
    handelLogout
}