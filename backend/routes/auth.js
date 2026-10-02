const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../db");
const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

const LOGIN_ROLES = ["MEMBER", "LIBRARIAN", "RECEPTIONIST"];

router.post("/login", async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const loginName = String(email).trim().toLowerCase();
    let user;

    if (loginName === "admin") {
      // Admin can click any role button; the role is ignored
      user = await prisma.user.findFirst({ where: { role: "ADMIN" } });
      if (!user) {
        return res.status(404).json({ message: "Admin account not found" });
      }
    } else {
      if (!LOGIN_ROLES.includes(role)) {
        return res.status(400).json({ message: "Please choose a role" });
      }
      user = await prisma.user.findFirst({ where: { email: loginName, role } });
      if (!user) {
        return res.status(404).json({
          message: `Couldn't find a ${role.toLowerCase()} account with this email`,
        });
      }
    }

    if (!user.isActive) {
      return res.status(403).json({ message: "This account has been deactivated" });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// Returns whoever the token belongs to (used to test the middleware)
router.get("/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;