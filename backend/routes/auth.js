const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../db");
const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

// Password login. Only accounts that have a password (the Admin) can use it.
// Everyone else will sign in with Google.
router.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const loginName = String(email).trim().toLowerCase();

    const user = await prisma.user.findUnique({
      where: { email: loginName },
      include: { role: true },
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ message: "Incorrect email or password" });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: "This account has been deactivated" });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json({ message: "Incorrect email or password" });
    }

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || "8h",
    });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role ? user.role.name : null,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// Returns whoever the token belongs to
router.get("/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;