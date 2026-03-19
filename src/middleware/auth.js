const jwt= require("jsonwebtoken")

const authMiddleware = async(req,res,next)=>{
    const{token}=req.headers;
    if(!token){
        return res.json({success:false, message:"Not Authorized Login Again"})
    }
    try{
        const token_decode = jwt.verify(token,process.env.ACCESS_TOKEN_SECRET)
        req.body.id = token_decode.id;
        next()
    }catch(err){
        console.log(error)
        res.json({success:false,message:"error"})
    }
    
} 
module.exports = authMiddleware

