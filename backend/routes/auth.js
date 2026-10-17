const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const prisma = require("../db");
const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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

// Google sign-in. The frontend sends the token Google gave the user.
// New people get an account with NO role (pending) until a librarian verifies them.
router.post("/google", async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ message: "Google token is required" });
    }

    // Ask Google: is this token real, and was it made for OUR app?
    let info;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      info = ticket.getPayload();
    } catch (err) {
      return res.status(401).json({ message: "Google sign-in failed" });
    }

    if (!info.email || !info.email_verified) {
      return res.status(401).json({ message: "Google account email is not verified" });
    }

    const email = info.email.trim().toLowerCase();

    let user = await prisma.user.findUnique({
      where: { email },
      include: { role: true },
    });

    // First time here: create the account with no role
    if (!user) {
      user = await prisma.user.create({
        data: { name: info.name || email, email },
        include: { role: true },
      });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: "This account has been deactivated" });
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
      pending: !user.role,
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