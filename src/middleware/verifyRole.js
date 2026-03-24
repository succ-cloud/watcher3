const verifyRoles = (...allowedRoles) => {
  return (req, res, next) => {
      // Check if user exists and has role information
      if (!req || !req.role) {
          console.log('No role information found in request');
          return res.status(401).json({ 
              message: 'Unauthorized - No role information' 
          });
      }
      
      // Get the user's role (either from req.role or req.roles)
      const userRole = req.role || (req.roles && req.roles[0]);
      
      if (!userRole) {
          console.log('No role assigned to user');
          return res.status(403).json({ 
              message: 'Forbidden - No role assigned' 
          });
      }
      
      // Check if user's role is in the allowed roles
      const isAllowed = allowedRoles.includes(userRole);
      
      if (!isAllowed) {
          console.log(`Access denied. User role: ${userRole}, Required roles: ${allowedRoles}`);
          return res.status(403).json({ 
              message: `Forbidden - Requires one of these roles: ${allowedRoles.join(', ')}` 
          });
      }
      
      console.log(`Access granted for role: ${userRole}`);
      next();
  };
};

module.exports = verifyRoles;
