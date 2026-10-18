const express = require("express");
const prisma = require("../db");
const { authenticate, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

// Everything here is for staff. The Admin always passes authorize().
const staffOnly = [authenticate, authorize("LIBRARIAN")];

// Which roles can this person hand out?
// Admin: any role except ADMIN and REVOKED (revoke has its own screen).
// Others: only roles whose "grantedByRank" matches their own rank.
function canGrantRole(actor, role) {
  if (role.name === "ADMIN" || role.name === "REVOKED") return false;
  if (actor.role === "ADMIN") return true;
  return role.grantedByRank === actor.rank;
}

// People who signed in but have no role yet
router.get("/pending", ...staffOnly, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { roleId: null, isActive: true },
      select: { id: true, name: true, email: true, institutionId: true, department: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    res.json({ users });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// The roles the logged-in person is allowed to give (for a dropdown)
router.get("/assignable-roles", ...staffOnly, async (req, res) => {
  try {
    const roles = await prisma.role.findMany({ orderBy: { rank: "asc" } });
    res.json({
      roles: roles.filter((r) => canGrantRole(req.user, r)).map((r) => ({ id: r.id, name: r.name })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// Give someone a role (verify a pending user, or change a role)
async function assignRole(req, res) {
  try {
    const targetId = Number(req.params.id);
    const { roleName, reason, institutionId, department } = req.body;

    if (!Number.isInteger(targetId) || !roleName) {
      return res.status(400).json({ message: "User id and roleName are required" });
    }

    const newRole = await prisma.role.findFirst({
      where: { name: String(roleName).trim().toUpperCase() },
    });
    if (!newRole) {
      return res.status(400).json({ message: "That role does not exist" });
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      include: { role: true },
    });
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }

    if (target.id === req.user.id) {
      return res.status(403).json({ message: "You cannot change your own role" });
    }
    if (target.role && target.role.name === "ADMIN") {
      return res.status(403).json({ message: "The Admin account cannot be changed" });
    }
    if (target.role && target.role.name === "REVOKED") {
      return res.status(400).json({ message: "This person is revoked. Use the revoke screen to restore them" });
    }
    if (!canGrantRole(req.user, newRole)) {
      return res.status(403).json({ message: "You are not allowed to give the " + newRole.name + " role" });
    }
    // Changing someone who already has a role: you must be allowed to give that role too
    if (target.role && !canGrantRole(req.user, target.role)) {
      return res.status(403).json({ message: "You are not allowed to change this person's role" });
    }
    if (target.roleId === newRole.id) {
      return res.status(400).json({ message: "They already have that role" });
    }

    const data = { roleId: newRole.id, verifiedById: req.user.id, verifiedAt: new Date() };
    if (institutionId) data.institutionId = String(institutionId).trim();
    if (department) data.department = String(department).trim();

    const [updated] = await prisma.$transaction([
      prisma.user.update({ where: { id: targetId }, data, include: { role: true } }),
      prisma.roleChange.create({
        data: {
          userId: targetId,
          fromRoleId: target.roleId,
          toRoleId: newRole.id,
          changedById: req.user.id,
          reason: reason || (target.roleId ? "Role changed" : "Account verified"),
        },
      }),
    ]);

    res.json({
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role.name,
      },
    });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ message: "That institution ID is already used by someone else" });
    }
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
}

router.patch("/:id/role", ...staffOnly, assignRole);
router.patch("/:id/verify", ...staffOnly, assignRole);

module.exports = router;

// ---------- REVOKE ----------

const REVOKE_REASONS = ["INDISCIPLINE", "OVERDUE", "LOST", "DAMAGED"];

// Read "MIN_REVOKE_DAYS" from the Setting table (7 if missing)
async function getMinRevokeDays() {
  const setting = await prisma.setting.findUnique({ where: { key: "MIN_REVOKE_DAYS" } });
  const n = Number(setting && setting.value);
  return Number.isFinite(n) ? n : 7;
}

// "2026-11-05" means the END of that day in India. A full date-time is used as given.
function parseEndDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(text + "T23:59:59+05:30")
    : new Date(text);
  return isNaN(date.getTime()) ? null : date;
}

// Revoke someone (punishment role)
router.post("/:id/revoke", ...staffOnly, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const { reason, endDate, note } = req.body;

    if (!Number.isInteger(targetId)) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    if (!REVOKE_REASONS.includes(reason)) {
      return res.status(400).json({ message: "Reason must be one of: " + REVOKE_REASONS.join(", ") });
    }

    const end = parseEndDate(endDate);
    if (!end) {
      return res.status(400).json({ message: "A valid endDate is required (for example 2026-11-05)" });
    }
    const minDays = await getMinRevokeDays();
    const earliest = new Date(Date.now() + minDays * 24 * 60 * 60 * 1000);
    if (end < earliest) {
      return res.status(400).json({ message: "A revocation must last at least " + minDays + " days" });
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      include: { role: true },
    });
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }
    if (target.id === req.user.id) {
      return res.status(403).json({ message: "You cannot revoke yourself" });
    }
    if (!target.role) {
      return res.status(400).json({ message: "This person has no role yet, so there is nothing to revoke" });
    }
    if (target.role.name === "ADMIN") {
      return res.status(403).json({ message: "The Admin account cannot be revoked" });
    }
    if (target.role.name === "REVOKED") {
      return res.status(400).json({ message: "This person is already revoked. You can extend the revocation instead" });
    }
    // Librarians can only revoke members (Faculty and below). Only the Admin can revoke a Librarian.
    if (req.user.role !== "ADMIN" && target.role.rank < 3) {
      return res.status(403).json({ message: "You are not allowed to revoke this person" });
    }

    const revokedRole = await prisma.role.findFirst({ where: { name: "REVOKED" } });
    if (!revokedRole) {
      return res.status(500).json({ message: "The Revoked role is missing. Run the seed script" });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: targetId },
        data: {
          roleId: revokedRole.id,
          previousRoleId: target.roleId,
          revokedUntil: end,
          revokeReason: reason,
          revokedById: req.user.id,
        },
      }),
      // Cancel their holds and take them out of every queue
      prisma.hold.updateMany({
        where: { userId: targetId, status: "ACTIVE" },
        data: { status: "CANCELLED" },
      }),
      prisma.reservation.updateMany({
        where: { userId: targetId, status: { in: ["WAITING", "READY"] } },
        data: { status: "CANCELLED" },
      }),
      prisma.roleChange.create({
        data: {
          userId: targetId,
          fromRoleId: target.roleId,
          toRoleId: revokedRole.id,
          changedById: req.user.id,
          reason: "Revoked (" + reason + ")" + (note ? ": " + String(note).trim() : ""),
        },
      }),
    ]);

    res.json({
      message: "User revoked",
      user: { id: target.id, name: target.name, email: target.email, role: "REVOKED", revokedUntil: end, reason },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// Extend a revocation (set a later end date)
router.patch("/:id/revoke", ...staffOnly, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const { endDate, note } = req.body;

    if (!Number.isInteger(targetId)) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const end = parseEndDate(endDate);
    if (!end) {
      return res.status(400).json({ message: "A valid endDate is required (for example 2026-11-05)" });
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      include: { role: true, previousRole: true },
    });
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }
    if (!target.role || target.role.name !== "REVOKED") {
      return res.status(400).json({ message: "This person is not revoked" });
    }
    // Librarians can only extend revocations on members
    if (req.user.role !== "ADMIN" && target.previousRole && target.previousRole.rank < 3) {
      return res.status(403).json({ message: "You are not allowed to change this revocation" });
    }
    if (target.revokedUntil && end <= target.revokedUntil) {
      return res.status(400).json({ message: "The new end date must be later than the current one" });
    }

    await prisma.$transaction([
      prisma.user.update({ where: { id: targetId }, data: { revokedUntil: end } }),
      prisma.roleChange.create({
        data: {
          userId: targetId,
          fromRoleId: target.roleId,
          toRoleId: target.roleId,
          changedById: req.user.id,
          reason: "Revocation extended" + (note ? ": " + String(note).trim() : ""),
        },
      }),
    ]);

    res.json({ message: "Revocation extended", revokedUntil: end });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// Everyone who is currently revoked
router.get("/revoked", ...staffOnly, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { role: { name: "REVOKED" } },
      select: {
        id: true,
        name: true,
        email: true,
        revokeReason: true,
        revokedUntil: true,
        previousRole: { select: { name: true } },
        revokedBy: { select: { name: true } },
      },
      orderBy: { revokedUntil: "asc" },
    });
    res.json({ users });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
});