const jwt = require("jsonwebtoken");
const prisma = require("../db");
const { restoreIfExpired } = require("../helpers/revoke");

async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ message: "Please log in first" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    let user = await prisma.user.findUnique({
      where: { id: payload.id },
      include: { role: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Account not available" });
    }

    // If a Revoke has run out, the old role comes back here
    user = await restoreIfExpired(user);

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role ? user.role.name : null,
      rank: user.role ? user.role.rank : null,
    };
    next();
  } catch (error) {
    if (error.name !== "JsonWebTokenError" && error.name !== "TokenExpiredError") {
      console.error(error);
    }
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

// Usage: authorize("LIBRARIAN") lets Librarians in. The Admin always gets in.
function authorize(...allowedRoles) {
  return (req, res, next) => {
    const role = req.user && req.user.role;

    if (!role) {
      return res
        .status(403)
        .json({ message: "Your account is waiting to be verified by the librarian" });
    }

    if (role === "ADMIN" || allowedRoles.includes(role)) {
      return next();
    }

    return res.status(403).json({ message: "You don't have permission to do this" });
  };
}

module.exports = { authenticate, authorize };