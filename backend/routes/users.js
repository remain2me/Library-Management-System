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