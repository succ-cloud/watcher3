const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const handleLogin = async (req, res) => {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ 'message': 'Username and password are required.' });
    
    const foundUser = await User.findOne({ name: name }).exec();
    if (!foundUser) return res.sendStatus(401); //Unauthorized 
    
    console.log(foundUser);
    const match = await bcrypt.compare(password, foundUser.password);
    console.log(match);
    
    if (match) {
        const role = foundUser.role;
        
        // Create JWTs
        const accessToken = jwt.sign(
            {
                "UserInfo": {
                    "name": foundUser.name,
                    "role": role
                }
            },
            process.env.ACCESS_TOKEN_SECRET,
            { expiresIn: '20s' }
        );
        
        const refreshToken = jwt.sign(
            { "name": foundUser.name },
            process.env.REFRESH_TOKEN_SECRET,
            { expiresIn: '1d' }
        );
        
        // Saving refreshToken with current user
        foundUser.refreshToken = refreshToken;
        await foundUser.save(); // Added await
        console.log('Refresh token saved for user:', foundUser.name);

        // Creates Secure Cookie with refresh token
        res.cookie('jwt', refreshToken, { 
            httpOnly: true, 
            secure: false, // CHANGE TO FALSE FOR DEVELOPMENT
            sameSite: 'Lax', // CHANGE TO LAX FOR DEVELOPMENT
            maxAge: 24 * 60 * 60 * 1000 
        });

        console.log('Cookie set with refresh token');
        
        // Send role and access token to user
        res.json({ role, accessToken }); // Removed refreshToken from response

    } else {
        res.sendStatus(401);
    }
}

module.exports = { handleLogin };