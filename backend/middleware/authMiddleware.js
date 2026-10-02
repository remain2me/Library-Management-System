const jwt = require("jsonwebtoken");
const prisma = require("../db");

async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ message: "Please log in first" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.id } });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Account not available" });
    }

    req.user = { id: user.id, name: user.name, role: user.role };
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

function authorize(...allowedRoles) {
  return (req, res, next) => {
    const role = req.user && req.user.role;

    // Admin has access to everything
    if (role === "ADMIN" || allowedRoles.includes(role)) {
      return next();
    }
    return res.status(403).json({ message: "You don't have permission to do this" });
  };
}

module.exports = { authenticate, authorize };